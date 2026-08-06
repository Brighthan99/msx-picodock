#!/usr/bin/env python3
"""pd_port.py - the USB CDC link to the cartridge, on pyserial.

Why pyserial, and why through this module
-----------------------------------------
This was briefly reimplemented on termios/os.read to avoid the one `pip install`
(macOS ships no pyserial, and Raspberry Pi OS refuses pip outside a venv under
PEP 668). That worked, and was verified on hardware - but it also reproduced two
defects pyserial had already solved:

  * a zero-byte read means both "nothing yet" and "the device is gone" under
    VMIN=0, so a disconnect has to be told apart with select();
  * without an exclusive lock two servers can open the same cartridge, and they
    do not fail visibly - they interleave reads and shred each other's frames,
    which reads as a flaky cable.

Two in 250 lines is the argument against writing the 251st. pyserial has had
those edges worn off by far more use than this project will ever see, and its
macOS port discovery calls IOKit directly rather than parsing `ioreg` output,
which is the one part here that could break on an OS update.

The module stays as the seam. Everything else - the server, the TUI, the printer
daemon - imports SerialPort/PortError/find_port from here and does
not know what is behind them. That is also why the interpreter hunt below lives
in one place instead of being copy-pasted into every entry point.

Two settings are load-bearing; neither is cosmetic:

  * **DTR.** TinyUSB reports tud_cdc_connected() straight from the host's DTR
    line, and the firmware gates everything on it - pd_usb_write() returns 0
    without it and the mailbox and printer relays stay disabled (pd_usb.c).
    pyserial asserts DTR on open by default. Do not "tidy" that away with
    dsrdtr=True or dtr=False: the result is a cartridge that enumerates, opens
    without complaint, and then says nothing, which reads exactly like a
    firmware bug and is not one.
  * **exclusive=True.** See the shredded-frames case above.

(c) 2026 - part of the msx-serial project
"""

import os
import subprocess
import sys

BAUD = 115200          # USB CDC carries no UART, so the device ignores this -
                       # but never pick 1200: the RP2040 bootrom reads a
                       # 1200-baud open as "reboot into BOOTSEL".
WRITE_TIMEOUT = 5.0    # a link that will not drain this long is a dead link


_INSTALL_HELP = """\
[-] pyserial is required and was not found.

    macOS (the python3 that comes with the command line tools):
        /usr/bin/python3 -m pip install --user pyserial

    Raspberry Pi OS / Debian - use apt, not pip:
        sudo apt install python3-serial
      (pip refuses to install here: PEP 668, "externally-managed-environment")

    Homebrew python, or any other externally-managed one:
        pipx install pyserial
        # or a virtualenv:  python3 -m venv ~/.venvs/msx && ~/.venvs/msx/bin/pip install pyserial

    Then check which interpreter actually has it:
        python3 -c "import sys, serial; print(sys.executable, serial.VERSION)"

    To force one:  PYTHON=/path/to/python3 <command>
"""


def _reexec_with_pyserial():
    """Re-run this program under an interpreter that has pyserial.

    `python3` resolves to different interpreters depending on the shell and the
    PATH (pyenv shim, Homebrew, /usr/bin), and pyserial is usually installed in
    exactly one of them. Rather than making that the user's problem, look for
    one that works. Returns only on failure; on success this process is replaced.

    Unix only. Windows has one interpreter per install and no convention about
    where it lives, so there is nothing to guess at; the message below tells the
    reader to pip install pyserial, which is the whole answer there.
    """
    if os.name != "posix":
        return
    if os.environ.get("PD_REEXEC"):
        return                                  # already tried; do not loop
    script = sys.argv[0] if sys.argv else ""
    if not script or not os.path.isfile(script):
        return                                  # `python -c`, a REPL: nothing to re-run
    env = dict(os.environ, PD_REEXEC="1")
    for cand in [os.environ.get("PYTHON"),
                 os.path.expanduser("~/.pyenv/shims/python3"),
                 "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
                 "/usr/bin/python3"]:
        if not cand or not os.path.exists(cand):
            continue
        try:
            if os.path.samefile(cand, sys.executable):
                continue                        # the one that just failed
        except OSError:
            continue
        # subprocess, not os.system: os.system goes through a shell, and the
        # ">/dev/null" that silences it is shell syntax rather than something
        # every platform has. DEVNULL is the portable way to say the same thing.
        if subprocess.call([cand, "-c", "import serial"],
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL) == 0:
            os.execve(cand, [cand, os.path.abspath(script)] + sys.argv[1:], env)


try:
    import serial
    import serial.tools.list_ports
except ImportError:
    _reexec_with_pyserial()
    sys.exit(_INSTALL_HELP)


# Same role serial.SerialException already plays - kept as a name so callers do
# not have to import pyserial themselves just to catch a failure. It is an
# OSError either way, so `except OSError` keeps working.
PortError = serial.SerialException


# ---------------------------------------------------------------------------
# Finding the cartridge
# ---------------------------------------------------------------------------
def find_devices(vid, pid, serial_number=None):
    """Every cartridge plugged in, as [(device, serial), ...], sorted by device.

    Matching on the USB IDs rather than the device name is what makes this work
    unchanged across platforms: macOS calls it /dev/cu.usbmodem1234561 and Linux
    calls it /dev/ttyACM0, and neither name says anything about what it is.

    The device path is not an identity, though. It is assigned by whichever
    kernel enumerated the thing, changes when you replug, and says nothing about
    *which* cartridge answered. The USB serial number does, so that is what
    `serial_number` filters on - a prefix is enough, since the full 16 hex
    digits are tedious to type and any unique prefix names one board.

    Firmware older than v0.38.0 reported "123456" on every board, so two of
    those are genuinely indistinguishable here. Callers should say so rather
    than pick one.
    """
    out = []
    for p in serial.tools.list_ports.comports():
        if (p.vid, p.pid) != (vid, pid):
            continue
        sn = p.serial_number or ""
        if serial_number and not sn.lower().startswith(serial_number.lower()):
            continue
        out.append((p.device, sn))
    return sorted(out)


def describe(device):
    """What USB says about the board on `device`: {product, vendor, vid, pid,
    serial}, or {} if it is not there any more.

    Only what the descriptors carry - the firmware version is not among them,
    which is why the Status pane does not claim to know it. Reading it back is
    a thing the frame protocol would have to be taught.
    """
    for p in serial.tools.list_ports.comports():
        if p.device != device:
            continue
        return {"product": p.product or p.description or "",
                "vendor": p.manufacturer or "",
                "vid": p.vid, "pid": p.pid,
                "serial": p.serial_number or ""}
    return {}


def find_port(vid, pid, serial_number=None):
    """One cartridge's device path, or None.

    Kept for callers that only ever expect one. When several are plugged in this
    returns the first, which is a coin toss - anything that cares should use
    find_devices() and make the ambiguity the user's decision.
    """
    found = find_devices(vid, pid, serial_number)
    return found[0][0] if found else None


def short_serials(found, minimum=4):
    """[(device, serial, shortest-prefix-that-names-only-it), ...].

    Truncating to a fixed width does not work. RP2040 board IDs come from the
    flash chip, and boards from the same batch share a long leading run - two
    cartridges here differed only in the last six of sixteen hex digits, so a
    tidy 8-character hint named *both* and following it would have failed with
    "matches more than one". So grow the prefix until it is unique, then stop.

    `minimum` keeps the common case readable rather than emitting a 1-character
    prefix just because it happens to be unique today.
    """
    out = []
    for dev, sn in found:
        if not sn:
            out.append((dev, sn, ""))
            continue
        others = [o for d, o in found if d != dev and o]
        n = minimum
        while n < len(sn) and any(o.lower().startswith(sn[:n].lower())
                                  for o in others):
            n += 1
        out.append((dev, sn, sn[:n]))
    return out


def ambiguous(found):
    """True when a list from find_devices() cannot be resolved by serial number.

    More than one match is not by itself ambiguous - two boards with two serials
    are fine, the user just has to say which. It is ambiguous when `--serial`
    could not do the job even if they tried:

      * two boards reporting the same serial - the pre-v0.38.0 firmware case,
        where every board answers "123456";
      * any board reporting no serial at all, which cannot be named at all, so
        the set as a whole is not addressable even though the others are.

    Either way the answer is --port (or reflashing), not a better guess.
    """
    if len(found) < 2:
        return False
    serials = [sn for _, sn in found]
    if any(not sn for sn in serials):
        return True
    return len(set(serials)) < len(serials)


def list_candidates():
    """Every USB serial port we can see, so an unrecognised cartridge can be
    reported by name instead of the server just saying nothing is there."""
    return sorted(p.device for p in serial.tools.list_ports.comports()
                  if p.vid is not None)


def describe_candidates():
    """(device, "VID:PID description") for each USB serial port - enough for a
    human to tell whether the thing they plugged in is the one being looked for."""
    out = []
    for p in sorted(serial.tools.list_ports.comports(), key=lambda p: p.device):
        if p.vid is None:
            continue
        sn = (" serial %s" % p.serial_number) if p.serial_number else ""
        out.append((p.device, "%04X:%04X %s%s"
                    % (p.vid, p.pid, p.description or "", sn)))
    return out


# ---------------------------------------------------------------------------
# The port
# ---------------------------------------------------------------------------
class SerialPort(serial.Serial):
    """The cartridge link, opened the way this project needs it.

    A subclass rather than a wrapper: read() and write() are on the path of every
    sector, and there is no reason to add a Python frame to each one.

    timeout=0 makes read() return whatever has arrived and never block, which is
    what the server's poll loop is built on; write_timeout turns a link that has
    stopped draining into a reconnect instead of a hang.
    """

    def __init__(self, path):
        try:
            super().__init__(path, BAUD, timeout=0, write_timeout=WRITE_TIMEOUT,
                             exclusive=True)
        except TypeError:
            # exclusive= arrived in pyserial 3.3. On something older, open it
            # anyway rather than refuse to run - but say so, because two servers
            # on one cartridge will then corrupt each other silently.
            super().__init__(path, BAUD, timeout=0, write_timeout=WRITE_TIMEOUT)
            sys.stderr.write("[!] pyserial %s is too old for exclusive port "
                             "locking; do not run two servers at once\n"
                             % serial.VERSION)

    @property
    def closed(self):
        return not self.is_open
