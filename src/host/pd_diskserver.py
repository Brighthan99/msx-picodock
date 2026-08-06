#!/usr/bin/env python3
"""pd_diskserver.py - serve a disk image to the MSX as a hard disk (D4b).

    ./src/host/pd_diskserver.py msxdisk.dmg
    ./src/host/pd_diskserver.py msxdisk.dmg --readonly

The cartridge emulates a Sunrise IDE interface; Nextor on the MSX drives it with
ordinary ATA commands. Sector requests come here over USB CDC and are answered
from the image file, so the MSX sees a normal hard disk. Frame format:
../pd_protocol.md.

Create an image with ./src/host/make_disk.sh.

IMPORTANT: never have the image mounted on this machine while serving it. Both
sides would write the same filesystem and corrupt it. The server checks for this
and refuses to start.
"""

import argparse
import os
import select
import subprocess
import sys
import threading
import time

# Nothing here prints. Everything the server has to say is emitted as a
# structured event on a channel, and views subscribe - see pd_hub.py.
from pd_hub import (HUB, emit, TextView,
                       CH_LINK, CH_DISK, CH_IO, CH_PRINT, CH_ASK)

# CALL PDASK("..."): the mailbox side of the pipe. Imported unconditionally - it
# is a few hundred lines of standard library and the feature is on by default
# (answered by whoever is sitting here, which needs nothing installed).
import pd_ask
from pd_version import VERSION, DISPLAY

# The link. pd_port is the only place that knows it is pyserial underneath,
# and the only place that knows DTR is what the firmware gates on.
from pd_port import (SerialPort, find_devices, ambiguous, short_serials,
                        list_candidates, describe_candidates, describe)

# Where print jobs go by default. Script-relative rather than cwd-relative: a
# bare "output" meant "wherever the shell was", so the same server started from
# the repository root and from dist/disk/ wrote to two folders while the printer
# pane listed one of them. --output overrides it; dist/disk/serve.sh passes
# ../output, which is how the shipped layout puts jobs in dist/output/.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "printer"))
from msx_printer_paths import rel, script_output          # noqa: E402

DEFAULT_OUTPUT = script_output(__file__)

VID, PID = 0x2E8A, 0x000A

SOF = 0x5A
BLK_INFO_REQ, BLK_INFO_RESP = 0x20, 0x21
BLK_READ_REQ, BLK_READ_RESP = 0x22, 0x23
BLK_WRITE_REQ, BLK_WRITE_RESP = 0x24, 0x25
MB_TO_HOST, MB_TO_MSX = 0x30, 0x31        # mailbox, multiplexed onto this pipe
PRINT_DATA = 0x40                         # printer bytes, cart -> host

SECTOR = 512
ST_OK, ST_ERR = 0x00, 0x01
MAX_PAYLOAD = 1 + SECTOR * 4      # generous; requests are one sector today


def build_frame(cmd, payload=b""):
    body = bytes([cmd, len(payload) & 0xFF, (len(payload) >> 8) & 0xFF]) + payload
    chk = 0
    for b in body:
        chk ^= b
    return bytes([SOF]) + body + bytes([chk])


class FrameParser:
    """Byte-at-a-time frame assembler. Resyncs on SOF, so a truncated or noisy
    stream recovers on the next frame instead of jamming."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.state = "sof"
        self.cmd = 0
        self.length = 0
        self.payload = bytearray()
        self.chk = 0

    def feed(self, data):
        """Yield (cmd, payload) for every complete, checksum-valid frame."""
        for b in data:
            if self.state == "sof":
                if b == SOF:
                    self.state = "cmd"
            elif self.state == "cmd":
                self.cmd = b
                self.chk = b
                self.state = "len_lo"
            elif self.state == "len_lo":
                self.length = b
                self.chk ^= b
                self.state = "len_hi"
            elif self.state == "len_hi":
                self.length |= b << 8
                self.chk ^= b
                self.payload = bytearray()
                if self.length > MAX_PAYLOAD:
                    self.reset()                 # implausible length: resync
                else:
                    self.state = "payload" if self.length else "chk"
            elif self.state == "payload":
                self.payload.append(b)
                self.chk ^= b
                if len(self.payload) >= self.length:
                    self.state = "chk"
            elif self.state == "chk":
                if b == self.chk:
                    yield self.cmd, bytes(self.payload)
                self.reset()


def is_mounted(path):
    """Best-effort check that the image is not currently mounted here.

    Serving an image that is also mounted locally means two independent writers
    on one filesystem - near-certain corruption. Worth refusing loudly.
    """
    ap = os.path.abspath(path)
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["hdiutil", "info"], capture_output=True,
                                 text=True, timeout=10).stdout
            return ap in out
        out = subprocess.run(["losetup", "-j", ap], capture_output=True,
                             text=True, timeout=10).stdout
        return bool(out.strip())
    except Exception:
        return False        # cannot tell; do not block the user


def mount_points(path):
    """Where the image is currently attached, so the error can name it."""
    out = []
    try:
        if sys.platform == "darwin":
            info = subprocess.run(["hdiutil", "info"], capture_output=True,
                                  text=True, timeout=10).stdout
            # Blocks are separated by a line of "=" and list image-path then mounts
            for block in info.split("================================================"):
                if os.path.abspath(path) in block:
                    for line in block.splitlines():
                        if "\t/" in line and "image-path" not in line and "icon-path" not in line:
                            out.append(line.split("\t")[-1].strip())
    except Exception:
        pass
    return [m for m in out if m.startswith("/")]


MOUNT_POLL_SEC = 2.0    # how often to check whether the image got mounted here


class Disk:
    """The served image file, with a pause/resume so it can be mounted here.

    The image cannot be mounted on this machine while it is being served - two
    writers on one filesystem would corrupt it. When the server notices a mount
    it pauses (lets go of the handle) and resumes on eject. To add files, mount
    the image in Finder (the server pauses), copy, eject (the server resumes and
    normalises names), then run PDSYNC on the MSX. Or use disk_put.sh while the
    server is stopped.
    """

    def __init__(self, path, readonly):
        self.path = path
        self.mode = "rb" if readonly else "r+b"
        self.f = open(path, self.mode)
        self.paused = False

    def close(self):
        try:
            if self.f:
                self.f.close()
        except Exception:
            pass
        self.f = None

    def pause(self):
        """Let go of the image so it can be mounted here safely."""
        self.close()
        self.paused = True

    def resume(self):
        self.f = open(self.path, self.mode)
        self.paused = False


def normalize_quiet(image):
    """Run disk_normalize on the image, reporting only if it changed something."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        r = subprocess.run([sys.executable, os.path.join(here, "disk_normalize.py"), image],
                           capture_output=True, text=True, timeout=60)
        out = (r.stdout or "").strip()
        if r.returncode == 0 and out:
            emit(CH_DISK, "normalized", text=out.lstrip("[*] "))
        elif r.returncode != 0:
            emit(CH_DISK, "normalize_failed", error=(r.stdout + r.stderr).strip())
    except Exception as e:
        emit(CH_DISK, "normalize_failed", error=str(e))


# Sidecar files next to the image, used so disk_put.sh can borrow the image
# without stopping the server:
#   <image>.srv    the running server's PID (so disk_put knows it is there)
#   <image>.hold   disk_put created this to request a pause
#   <image>.held   the server created this to confirm it let go of the handle
def srv_path(image):  return os.path.abspath(image) + ".srv"
def hold_path(image): return os.path.abspath(image) + ".hold"
def held_path(image): return os.path.abspath(image) + ".held"


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True             # exists, just not ours
    return True


def hold_active(image):
    """True while a *live* disk_put.sh is asking for a pause.

    The .hold file carries the requester's PID. If that process died (SIGKILL,
    crash) the file is stale - honouring it would leave the server paused
    forever - so it is removed and treated as no request. A freshly created but
    not-yet-written file (empty/unreadable) is honoured, since that only happens
    in the tiny window before disk_put writes its PID.
    """
    hp = hold_path(image)
    try:
        with open(hp) as f:
            text = f.read().strip()
    except OSError:
        return False            # no file
    if not text:
        return True             # just created; PID not written yet
    try:
        pid = int(text)
    except ValueError:
        return True             # unexpected content; play it safe and pause
    if pid_alive(pid):
        return True
    try:
        os.remove(hp)           # requester is gone: drop the stale request
    except OSError:
        pass
    return False


def update_pause(disk, image, mounted):
    """Pause the served image while it is borrowed, resume when handed back.

    Two things can borrow it, and both would corrupt the filesystem if they wrote
    while the server also holds the handle:

      * a Finder mount (the manual flow) - detected via `mounted`, refreshed
        on a timer by the caller because the check is a subprocess call;
      * disk_put.sh, which drops a `.hold` file. That path is race-free: the
        server pauses and writes `.held`, and disk_put does not touch the image
        until it sees `.held`.

    Pausing turns what would be silent corruption into a plain, recoverable disk
    error on the MSX.
    """
    held_requested = hold_active(image)
    want_pause = held_requested or mounted

    if want_pause and not disk.paused:
        disk.pause()
        if held_requested:
            open(held_path(image), "w").close()     # tell disk_put it may proceed
            emit(CH_DISK, "paused", path=image, reason="disk_put")
        else:
            emit(CH_DISK, "paused", path=image, reason="mounted",
                 at=mount_points(image))
    elif not want_pause and disk.paused:
        # Tidy up before handing the image back: macOS (and any 8.3-unaware tool)
        # leaves ._ sidecars and long-name records the MSX would show as junk.
        # The handle is still closed here - exactly when rewriting entries is safe.
        normalize_quiet(image)
        disk.resume()
        try:
            os.remove(held_path(image))
        except OSError:
            pass
        emit(CH_DISK, "resumed", path=image)


def wait_for_port(args, disk=None, ui=None):
    """Block until the cartridge appears. It comes and goes constantly in normal
    use (reflashing, MSX resets, cable), so the server sits through all of it.
    """
    announced = False
    while True:
        if disk:
            # No cartridge yet, so honour a Finder mount or a disk_put.sh hold
            # here too - files can be swapped in while the MSX is switched off.
            update_pause(disk, args.image, is_mounted(args.image))

        port, sn = args.port, None
        if not port:
            # Once we have talked to a cartridge, stay with that one. Otherwise
            # unplugging A and plugging in B would silently hand B the disk
            # image that belongs to A - the server has no way to notice, because
            # at the wire level one Sunrise IDE looks like any other.
            want = args.serial or wait_for_port.locked_serial
            found = find_devices(VID, PID, want)
            if ambiguous(found):
                if not announced:
                    emit(CH_LINK, "ambiguous",
                         devices=[d for d, _ in found],
                         reason="same serial on every board - firmware older "
                                "than v0.38.0. Reflash, or pick one with --port")
                    announced = True
                found = []               # never guess between them
            elif len(found) > 1:
                if not announced:
                    emit(CH_LINK, "several", devices=short_serials(found))
                    announced = True
                found = []               # --serial is the answer, not a guess
            if found:
                port, sn = found[0]
        if port:
            try:
                ser = SerialPort(port)
                if sn:
                    wait_for_port.locked_serial = sn
                # What USB knows about the board, passed on rather than looked
                # up again by whoever draws it: this is the one moment the
                # device is certainly there.
                emit(CH_LINK, "connected", port=port, serial=sn,
                     usb=describe(port))
                return ser
            except OSError:
                pass
        if not announced:
            # Name any port we can see but could not identify: on macOS the
            # device name carries no VID/PID, so an unreadable ioreg with two
            # cartridge-like ports plugged in is genuinely ambiguous, and
            # --port is the answer rather than a guess.
            emit(CH_LINK, "waiting", vid=VID, pid=PID,
                 candidates=[c for c in list_candidates() if c != port])
            announced = True

        # Keep a view alive while we wait. This is exactly the screen someone is
        # looking at as they plug the cartridge in, and a split view that only
        # starts drawing once the link is up is a black screen at the one moment
        # it has something to say. Keystrokes have nowhere to go yet, so they
        # are dropped rather than saved up to arrive in a burst later.
        deadline = time.time() + 0.5
        while time.time() < deadline:
            if ui is not None:
                ui.read()
            time.sleep(0.02)


#: The serial number of the cartridge this run has talked to, once it has talked
#: to one. Kept on the function rather than in a global so the two live together,
#: and initialised here because the first read (above) happens before the first
#: write - without this line the server raises AttributeError the moment it is
#: started without --port, which is the normal way to start it.
wait_for_port.locked_serial = None


class Ui:
    """Gives the TUI its turn to redraw, from inside the serial loop.

    This used to be a terminal <-> mailbox bridge as well: keystrokes out to the
    MSX, its bytes back. That was the remote keyboard, which is not part of a
    disk + printer build, so all that is left is the half that matters here -
    calling the view often enough that it draws.

    It has to happen on this thread. curses is not thread-safe and the serial
    loop is the only thread, so the redraw rides along with the poll.
    """

    def __init__(self, ui=None):
        self.ui = ui

    @property
    def enabled(self):
        return self.ui is not None

    def restore(self):
        if self.ui is not None:
            self.ui.restore()

    def read(self):
        """Let the view redraw. The return value is vestigial - the TUI has no
        host -> MSX direction to feed - but serve() still calls it every pass,
        which is exactly the pacing the redraw wants."""
        if self.ui is not None:
            return self.ui.read()
        return b""


class Printer:
    """Collects printer bytes into jobs and saves them (B/D + printer merge).

    In the standalone virtual-printer firmware these bytes were a raw CDC
    stream; here they arrive framed (PRINT_DATA) so they can share the pipe with
    the disk and mailbox. Job separation is unchanged: a gap of `timeout`
    seconds with no printer bytes ends the current job, because MSX printing has
    no explicit "job done" signal.

    The actual saving/rendering (text/raw/pdf/cups) is reused from
    msx_printer_render.py rather than duplicated - that module keeps its
    standalone role for the separate printer firmware.

    With `spool` on, every byte is additionally appended to a capture on disk
    and the job boundary is recorded there instead of only ending an in-memory
    buffer. That decouples "the job ended" from "a file was written", which is
    what an MSX that prints a page every few hours needs: nothing is rendered
    until asked, and nothing is lost if the server is restarted meanwhile.
    See printer/msx_printer_spool.py.
    """

    def __init__(self, mode, timeout, base_name="msx_print", charset="cp437",
                 glyphs="msx", spool=False, spool_dir=None, out_dir=None):
        self.mode = mode                 # off | text | raw | pdf | raster | escp | cups
        self.timeout = timeout
        self.base_name = base_name
        self.charset = charset           # text-mode decode charset (cp437/shift_jis/...)
        self.glyphs = glyphs             # raster glyph set (msx/msx-jp/fx80/cp437)
        self.buf = bytearray()
        self.last = None
        self._save = None
        self.spool = None
        self.out_dir = out_dir or DEFAULT_OUTPUT
        self.spool_dir = spool_dir or os.path.join(self.out_dir, "spool")
        if spool:
            self._open_spool()
        if mode != "off":
            self._load_saver()

    def _open_spool(self):
        _printer_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "printer")
        if _printer_dir not in sys.path:
            sys.path.insert(0, _printer_dir)
        import msx_printer_spool
        self.spool = msx_printer_spool.SpoolWriter(self.base_name, self.spool_dir)
        emit(CH_PRINT, "spool_open", path=rel(self.spool.prn_path))

    def _load_saver(self):
        """Bring in the saving/rendering module, once and on demand.

        Deferred so a disk-only run needs nothing printer-related - and done
        here rather than in __init__ because the TUI can turn the printer on
        later, and a server started with --print off must still be able to
        save once someone switches the mode."""
        if self._save is not None:
            return
        # The printer modules live in host/printer/ (msx_printer_*).
        _printer_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "printer")
        if _printer_dir not in sys.path:
            sys.path.insert(0, _printer_dir)
        import msx_printer_render
        # Its own [+]/[-] lines would bypass the hub (and shred a
        # split-screen view), so take delivery of them instead.
        msx_printer_render.set_report_sink(
            lambda level, text: emit(CH_PRINT, "msg", level=level, text=text))
        self._save = msx_printer_render.save_print_job

    @property
    def enabled(self):
        # Spooling alone is reason enough to keep the bytes: the mode can be
        # `off` and the capture still has to be complete, because the whole
        # point is deciding the format afterwards.
        return self.mode != "off" or self.spool is not None

    def feed(self, payload):
        if not self.enabled:
            return                       # firmware still sent it; just drop it
        if not self.buf:
            emit(CH_PRINT, "job_start", mode=self.mode)
        self.buf.extend(payload)
        if self.spool:
            self.spool.write(payload)
        self.last = time.time()

    def flush_if_idle(self):
        if self.buf and self.last and time.time() - self.last > self.timeout:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        size = len(self.buf)
        if self.spool:
            # The boundary is recorded, not acted on. Rendering is somebody
            # else's decision, later - that is the whole point of a spool.
            rec = self.spool.mark("idle")
            emit(CH_PRINT, "spool_job", seq=rec["seq"], size=size)
        if self.mode != "off":
            self._load_saver()           # the mode may have been switched on live
            self._save(bytes(self.buf), self.mode, self.base_name, self.charset,
                       self.glyphs, out_dir=self.out_dir)
        emit(CH_PRINT, "job_end", mode=self.mode, size=size)
        self.buf.clear()
        self.last = None

    def close(self):
        """Shutting down: close the open job so its bytes are indexed, not
        left as an unclosed tail for the reader to recover."""
        if self.spool:
            self.spool.close("shutdown")
            self.spool = None


class Typist(threading.Thread):
    """The person at this keyboard, answering the MSX (plain-terminal runs).

    Manual typing is the default answerer, so in a plain terminal something has
    to read stdin - and it cannot be the serial loop, which must keep answering
    sector reads while a human thinks. So: one daemon thread, blocking on a
    line, handing it to the service. The TUI has its own input line and does not
    use this (curses owns the keyboard there).

    A line beginning with `/` is an instruction to the server rather than an
    answer, which is how the answerer gets switched without restarting:

        /m  answer by hand    /g  answer by search    /x  refuse this one
    """

    HELP = "/m type answers   /g search them   /x refuse this one   /? this"

    def __init__(self, ask):
        threading.Thread.__init__(self, name="pd-typist", daemon=True)
        self.ask = ask

    def run(self):
        for line in sys.stdin:
            line = line.rstrip("\n")
            if line.startswith("/"):
                self._command(line[1:].strip())
            elif line.strip():
                # "\n" typed literally is a line break in the answer: one line
                # of typing is the natural unit here, but a haiku is three.
                self.ask.submit(line.replace("\\n", "\n"))

    def _command(self, cmd):
        word = cmd.split(" ")[0]
        word = word.lower()
        if word in ("m", "manual"):
            self.ask.set_mode("manual")
        elif word in ("g", "google", "search"):
            self.ask.set_mode("google")
        elif word in ("x", "cancel"):
            self.ask.cancel()
        else:
            emit(CH_ASK, "note", text=self.HELP)


def serve(ser, disk, blocks, args, ui, printer, ask):
    """Answer block requests until the link drops (then raise so main reconnects)."""
    parser = FrameParser()

    # The mailbox side of the wire. pd_ask never sees the serial port: it hands
    # payloads to this, and only this thread ever writes to `ser`.
    def to_msx(payload):
        ser.write(build_frame(MB_TO_MSX, payload))

    ask.link_reset()
    stats = {"r": 0, "w": 0}
    last_report = time.time()
    last_mount_check = 0.0
    mounted = False

    while True:
        ui.read()                    # the view's turn to redraw
        ask.pump(to_msx)             # ...and CALL PDASK's turn to send a chunk

        data = ser.read(8192)
        if not data:
            time.sleep(0.002)
            printer.flush_if_idle()      # end a print job after its idle gap
            # periodic throughput line, only while something is happening
            if (stats["r"] or stats["w"]) and time.time() - last_report > 2.0:
                emit(CH_IO, "stats", reads=stats["r"], writes=stats["w"])
                last_report = time.time()

            # is_mounted() is a subprocess call, so poll it on a timer; the
            # .hold file check inside update_pause is cheap and runs every pass,
            # so a disk_put.sh pause takes effect almost immediately.
            if time.time() - last_mount_check > MOUNT_POLL_SEC:
                last_mount_check = time.time()
                mounted = is_mounted(args.image)
            update_pause(disk, args.image, mounted)
            continue

        for cmd, payload in parser.feed(data):
            # Printer and mailbox traffic are independent of the disk, so both
            # are handled even while the image is paused for a Finder mount.
            # Mailbox frames (0x30) are CALL PDASK asking a question: answering it
            # needs no disk at all, and refusing to while the image is borrowed
            # would be a puzzling way to fail.
            if cmd == MB_TO_HOST:
                ask.feed(payload)
                continue

            if cmd == PRINT_DATA:
                printer.feed(payload)
                continue

            if disk.paused:
                # Answer, but with an error - staying silent would just make the
                # cartridge time out and look like a dead link.
                resp = {BLK_INFO_REQ: BLK_INFO_RESP,
                        BLK_READ_REQ: BLK_READ_RESP,
                        BLK_WRITE_REQ: BLK_WRITE_RESP}.get(cmd)
                if resp:
                    ser.write(build_frame(resp, bytes([ST_ERR])))
                continue

            if cmd == BLK_INFO_REQ:
                resp = bytes([ST_OK]) + blocks.to_bytes(4, "little") \
                       + SECTOR.to_bytes(2, "little")
                ser.write(build_frame(BLK_INFO_RESP, resp))
                emit(CH_DISK, "info", blocks=blocks, sector=SECTOR,
                     readonly=bool(args.readonly))

            elif cmd == BLK_READ_REQ and len(payload) >= 5:
                lba = int.from_bytes(payload[0:4], "little")
                count = payload[4] or 1
                if lba + count > blocks:
                    ser.write(build_frame(BLK_READ_RESP, bytes([ST_ERR])))
                    emit(CH_IO, "read_error", lba=lba, count=count)
                    continue
                disk.f.seek(lba * SECTOR)
                buf = disk.f.read(SECTOR * count)
                buf = buf.ljust(SECTOR * count, b"\x00")   # short read at EOF
                ser.write(build_frame(BLK_READ_RESP, bytes([ST_OK]) + buf))
                stats["r"] += count
                emit(CH_IO, "read", lba=lba, count=count)

            elif cmd == BLK_WRITE_REQ and len(payload) >= 5:
                lba = int.from_bytes(payload[0:4], "little")
                count = payload[4] or 1
                body = payload[5:5 + SECTOR * count]
                if args.readonly:
                    ser.write(build_frame(BLK_WRITE_RESP, bytes([ST_ERR])))
                    emit(CH_IO, "write_refused", lba=lba)
                elif lba + count > blocks or len(body) < SECTOR * count:
                    ser.write(build_frame(BLK_WRITE_RESP, bytes([ST_ERR])))
                    emit(CH_IO, "write_error", lba=lba, count=count, length=len(body))
                else:
                    disk.f.seek(lba * SECTOR)
                    disk.f.write(body)
                    disk.f.flush()
                    ser.write(build_frame(BLK_WRITE_RESP, bytes([ST_OK])))
                    stats["w"] += count
                    emit(CH_IO, "write", lba=lba, count=count)


def main():
    ap = argparse.ArgumentParser(description="Serve a disk image to the MSX")
    ap.add_argument("image", nargs="?", help="disk image (see make_disk.sh)")
    ap.add_argument("--version", action="version", version=f"PicoDock {DISPLAY}")
    ap.add_argument("-p", "--port", help="serial port (auto-detect by VID/PID if omitted)")
    ap.add_argument("-s", "--serial",
                    help="which cartridge, by USB serial number (a unique prefix "
                         "is enough). Needed only when more than one PicoDock is "
                         "plugged in; --list shows them")
    ap.add_argument("--list", action="store_true",
                    help="list the PicoDocks that are plugged in, and exit")
    ap.add_argument("--readonly", action="store_true", help="reject writes from the MSX")
    ap.add_argument("-v", "--verbose", action="store_true", help="log every sector")
    ap.add_argument("--tui", action="store_true",
                    help="split-screen view: disk / printer "
                         "(Ctrl-A ? for keys)")
    ap.add_argument("--print", dest="print_mode", default="auto",
                    choices=["off", "auto", "text", "pdf", "raster"],
                    help="what to do with printer output (default: auto, into --output). "
                         "auto reads the finished job, picks text/raster/kanji/hangul "
                         "for it, and always keeps the raw .prn too - so a wrong guess "
                         "costs nothing. text=bytes decoded with --charset; "
                         "pdf=that text typeset (no graphics); "
                         "raster=ESC/P text+bit-image -> PNG with --glyphs; off ignores")
    ap.add_argument("--charset", default="cp437",
                    help="text-mode decode charset for --print text/pdf: cp437 (default, "
                         "MSX International), shift_jis/cp932 (JP), utf-8 (modern tools). "
                         "Any Python codec name is accepted and an unknown one falls back "
                         "to cp437. CJK sent as dots needs raster, not this")
    ap.add_argument("--glyphs", default="msx",
                    help="glyph set for --print raster: msx (MSX International ROM, "
                         "default), msx-din, msx-jp, fx80 (period-correct Epson), "
                         "cp437 (fx80 + CP437 upper region). MSX before FX-80")
    ap.add_argument("--print-timeout", type=float, default=3.0,
                    help="idle seconds that end a print job (default: 3.0)")
    ap.add_argument("--output", default=DEFAULT_OUTPUT, metavar="DIR",
                    help=f"where print jobs are written (default: {DEFAULT_OUTPUT}, "
                         "which is ../output beside this script - not beside the "
                         "shell, so it is the same folder however you launch it). "
                         "dist/disk/serve.sh passes ../output, giving dist/output/")
    ap.add_argument("--ask", default="google", choices=list(pd_ask.AskService.MODES),
                    help="who answers CALL PDASK(\"...\") from the MSX: google "
                         "(default - a web search) or manual (you type it here). "
                         "Switchable while running: /m and /g in a plain "
                         "terminal, Left/Right in the TUI's Ask pane. Answers "
                         f"are always cut at {pd_ask.LIMIT} characters")
    ap.add_argument("--ask-width", type=int, default=40, metavar="N",
                    help="fold answers at N columns on word boundaries "
                         "(default: 40, 0 = leave long lines alone)")
    ap.add_argument("--ask-charset", default="ascii", choices=list(pd_ask.CHARSETS),
                    help="how non-ASCII answers reach the MSX: ascii (default, "
                         "accents stripped and the rest '?'), cp949 (Korean MSX), "
                         "raw (UTF-8 bytes untouched)")
    ap.add_argument("--ask-engine", default="auto", choices=list(pd_ask.ENGINES),
                    help="which search --ask google runs: auto (default: "
                         "google.com, then DuckDuckGo), google, ddg. No keys "
                         "or accounts - these are the ordinary search pages")
    ap.add_argument("--ask-lang", default="en", metavar="LANG",
                    help="language for searches (default: en)")
    ap.add_argument("--ask-results", type=int, default=5, metavar="N",
                    help="how many search hits to send back (default: 5, before "
                         "--ask-limit cuts them)")
    ap.add_argument("--spool", action="store_true",
                    help="append every printed byte to <output>/spool/ and record "
                         "job boundaries there instead of rendering on the spot. "
                         "For an MSX that prints occasionally over a long session: "
                         "nothing is written until you ask, with "
                         "printer/msx_printer_spool.py or the Printer pane. "
                         "Combines with any --print mode, including off")
    args = ap.parse_args()

    if args.list:
        # No image needed to enumerate hardware, which is why `image` is
        # optional - it is required for every other path, checked just below.
        found = find_devices(VID, PID)
        if not found:
            print("no PicoDock found (VID %04X PID %04X)." % (VID, PID))
            others = describe_candidates()
            if others:
                print("\nOther USB serial ports seen:")
                for dev, what in others:
                    print("  %-28s %s" % (dev, what))
            return 1
        print("%d PicoDock%s:" % (len(found), "" if len(found) == 1 else "s"))
        for dev, sn, short in short_serials(found):
            line = "  %-28s serial %s" % (dev, sn or "(none reported)")
            if short and short != sn:
                line += "   (--serial %s is enough)" % short
            print(line)
        if ambiguous(found):
            print("\n[!] Every board reports the same serial, so --serial cannot"
                  "\n    tell them apart. That is firmware older than v0.38.0:"
                  "\n    reflash them, or select by --port for now.")
        elif len(found) > 1:
            print("\nPick one with --serial <prefix>; each needs its own image"
                  "\nand its own server process.")
        return 0

    if not args.image:
        ap.error("an image is required (or use --list)")

    # Attach a view before anything can be emitted. They are interchangeable
    # subscribers: the server never learns which one is watching, and a browser
    # over WebSocket will attach the same way.
    ui = None
    if args.tui:
        import pd_tui
        if pd_tui.available():
            ui = pd_tui.Tui(args.image, verbose=args.verbose,
                            out_dir=args.output)
        else:
            HUB.subscribe(TextView(verbose=args.verbose))
            # Two different reasons, and they need different answers: a pipe is
            # the user's own doing, a missing curses is something they can fix.
            # Saying "needs a terminal" to someone sitting at one is a dead end.
            if pd_tui.curses is None:
                why = ("no curses module, so no split view - everything else "
                       "works. On Windows:  py -m pip install --user "
                       "windows-curses")
            else:
                why = "--tui needs a terminal on stdin and stdout"
            emit(CH_LINK, "note", text=why + "; using plain output")
    if ui is None and not args.tui:
        HUB.subscribe(TextView(verbose=args.verbose))

    # Only now, with a view attached: emitted any earlier and nobody is
    # listening, so the very line meant to appear on every run appears on none.
    # (The TUI reads it from the hub's scrollback when it first draws.)
    emit(CH_LINK, "server", version=VERSION)

    if not os.path.isfile(args.image):
        sys.exit(f"[-] no such image: {args.image}\n"
                 f"    create one with: ./src/host/make_disk.sh")

    if is_mounted(args.image):
        # Not fatal: the server watches for this and pauses, so it can simply
        # wait for the eject instead of making you restart it.
        emit(CH_DISK, "mounted_at_start", path=args.image,
             at=mount_points(args.image))

    size = os.path.getsize(args.image)
    blocks = size // SECTOR
    emit(CH_DISK, "image", path=args.image, size=size, blocks=blocks,
         sector=SECTOR, readonly=bool(args.readonly))

    # Start curses late: anything above this point can still exit with a plain
    # message, and a failure printed onto an initialised curses screen is a
    # failure nobody gets to read.
    if ui is not None:
        try:
            ui.start(HUB)
        except Exception as e:
            # A terminal curses cannot drive is not a reason to refuse to serve
            # a disk. Fall back rather than die with a half-initialised screen.
            ui.restore()
            ui = None
            HUB.subscribe(TextView(verbose=args.verbose))
            emit(CH_LINK, "note", text="could not start the split view (%s) - "
                                       "using plain output" % e)

    disk = Disk(args.image, args.readonly)
    ui_pump = Ui(ui)
    printer = Printer(args.print_mode, args.print_timeout, charset=args.charset,
                      glyphs=args.glyphs, spool=args.spool, out_dir=args.output)
    if ui is not None:
        # The Printer pane retunes mode/charset/glyphs by writing to this very
        # object. Safe without a lock: the TUI runs on this thread (serve()
        # drives it through ui.read()), so a setting can never change midway
        # through a save.
        ui.attach_printer(printer)
    if printer.enabled:
        emit(CH_PRINT, "enabled", mode=args.print_mode, out=rel(args.output))

    ask = pd_ask.AskService(mode=args.ask, width=args.ask_width,
                            charset=args.ask_charset,
                            engine=args.ask_engine, lang=args.ask_lang,
                            results=args.ask_results)
    emit(CH_ASK, "enabled", mode=ask.mode, limit=ask.limit,
         charset=ask.charset, engine=ask.engine)
    if ui is not None:
        ui.attach_ask(ask)               # the Ask pane types into this object
    elif sys.stdin.isatty():
        Typist(ask).start()              # ...and in a plain terminal, this does
    elif ask.mode == "manual":
        # --ask manual with nothing to type on. The suggestion has to be a
        # thing that exists: there is no "off" mode, and saying so sent people
        # to an argparse error.
        emit(CH_ASK, "note",
             text="--ask manual, but stdin is not a terminal, so nobody can "
                  "type an answer here. Use --ask google, or run this from a "
                  "terminal")

    # Clear any coordination sidecars left by a previous run that was killed
    # (Ctrl-C cleans up after itself; SIGKILL does not). A stale .hold would
    # otherwise make this server start out paused for a disk_put that is long gone.
    for stale in (hold_path(args.image), held_path(args.image)):
        try:
            os.remove(stale)
        except OSError:
            pass

    # Advertise that a server holds this image, so disk_put.sh knows to ask for a
    # pause (via a .hold file) instead of colliding with it.
    with open(srv_path(args.image), "w") as f:
        f.write(str(os.getpid()))

    try:
        while True:
            ser = wait_for_port(args, disk, ui)
            try:
                serve(ser, disk, blocks, args, ui_pump, printer, ask)
            except OSError as e:
                emit(CH_LINK, "lost", error=e.__class__.__name__)
                printer.flush()      # don't lose a job in progress on a reconnect
            finally:
                try:
                    ser.close()
                except Exception:
                    pass
    except KeyboardInterrupt:
        emit(CH_LINK, "closed")
    finally:
        printer.flush()
        printer.close()          # index the open job rather than leave a tail
        ui_pump.restore()
        disk.close()
        for p in (srv_path(args.image), held_path(args.image)):
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main() or 0)
