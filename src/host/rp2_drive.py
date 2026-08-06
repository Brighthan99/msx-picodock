#!/usr/bin/env python3
"""rp2_drive.py - find the RP2040 bootloader's mass-storage drive, on any host.

    rp2_drive.py            print where it is, or say it is not there
    rp2_drive.py --wait 30  wait up to 30s for it to appear
    rp2_drive.py --gone 90  wait up to 90s for it to disappear

The drive is called RPI-RP2 everywhere; only the place it turns up differs.

    macOS      /Volumes/RPI-RP2
    Linux      /media/<user>/RPI-RP2, /run/media/<user>/RPI-RP2, /mnt/RPI-RP2
    Windows    a drive letter, identified by its volume label

The letter is the reason this exists rather than a constant in a shell script:
on Windows there is nothing to hardcode, and on Linux the mount point depends on
the desktop that mounted it. Looking is one implementation; three hardcoded
paths is three.

**Disappearing is the success signal.** The bootloader counts UF2 blocks and
reboots only once it has the whole image, so the drive going away is what says
the write completed. A copy that fails part-way leaves it mounted, which is why
`--gone` exists and why the copy's own exit status is not worth reading.
"""

import glob
import os
import string
import sys
import time

LABEL = "RPI-RP2"


def _candidates():
    if sys.platform == "darwin":
        return ["/Volumes/" + LABEL]
    if os.name == "nt":
        # No mount point to guess at - walk the letters and read the label.
        out = []
        for letter in string.ascii_uppercase:
            root = "%s:\\" % letter
            if not os.path.isdir(root):
                continue
            try:
                import ctypes
                buf = ctypes.create_unicode_buffer(1024)
                ctypes.windll.kernel32.GetVolumeInformationW(
                    ctypes.c_wchar_p(root), buf, ctypes.sizeof(buf),
                    None, None, None, None, 0)
                if buf.value.upper() == LABEL:
                    out.append(root)
            except Exception:
                # No ctypes, or a drive that will not answer. INFO.UF2 is what
                # the bootloader always puts there, so it identifies the drive
                # without asking Windows anything.
                if os.path.isfile(os.path.join(root, "INFO_UF2.TXT")):
                    out.append(root)
        return out
    # Linux and the rest: whatever the desktop, or nothing, mounted it under.
    return (glob.glob("/media/*/" + LABEL) + glob.glob("/run/media/*/" + LABEL)
            + ["/media/" + LABEL, "/mnt/" + LABEL])


def find():
    """The mounted drive, or None."""
    for path in _candidates():
        if os.path.isdir(path):
            return path
    return None


def wait_for(seconds, present=True, tick=None):
    """Wait for the drive to appear (present) or go away. True if it happened."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if (find() is not None) == present:
            return True
        if tick:
            tick()
        time.sleep(0.5)
    return (find() is not None) == present


def main(argv):
    args = argv[1:]
    if args and args[0] in ("--wait", "--gone"):
        want = args[0] == "--wait"
        secs = float(args[1]) if len(args) > 1 else 30.0
        ok = wait_for(secs, present=want)
        if ok and want:
            print(find())
        return 0 if ok else 1
    where = find()
    if where:
        print(where)
        return 0
    print("[-] %s is not mounted - the cartridge is not in BOOTSEL." % LABEL,
          file=sys.stderr)
    print("    Hold BOOTSEL while plugging it in, with a normal data cable "
          "(a VBUS-blocking one carries no power, so BOOTSEL cannot work).",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
