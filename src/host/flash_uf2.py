#!/usr/bin/env python3
"""flash_uf2.py - write a UF2 through the RP2040 bootloader's drive.

    flash_uf2.py <uf2>

Why not picotool
    picotool 2.3.0 is not reliable here: `picotool info` segfaults with no
    device attached, and `picotool load` has aborted mid-write on a 7.7 MB
    image, leaving a **half-written flash** - which looks exactly like a
    cartridge that hangs the MSX at boot. Copying to the drive goes through the
    RP2040's own ROM bootloader and depends on none of that.

How it knows the write finished
    The bootloader counts blocks and reboots only once it has the whole image -
    each UF2 block carries its index and the total. So the drive disappearing
    *is* the completion signal, and a copy that stops early leaves it mounted.

    The copy itself always looks like it failed: the device reboots out from
    under it, so the write returns an error on a healthy flash. Reading that
    status would report failure exactly when it worked, which is why the drive
    check below is the verdict and the copy's own result is discarded.

This is Python rather than the shell script it replaces because that one had
/Volumes/RPI-RP2 in it, and there is no such path on Linux or Windows. See
rp2_drive.py for where it actually turns up.
"""

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import rp2_drive                                             # noqa: E402

TIMEOUT = 90


def flash(uf2):
    if not os.path.isfile(uf2):
        print("[-] no such file: %s" % uf2)
        return 1

    drive = rp2_drive.find()
    if not drive:
        print("[-] %s is not mounted - the cartridge is not in BOOTSEL."
              % rp2_drive.LABEL)
        print("    Hold BOOTSEL while plugging it in, with a normal data cable")
        print("    (a VBUS-blocking one carries no power, so BOOTSEL cannot work).")
        return 1

    size = os.path.getsize(uf2)
    print("[*] writing %s (%dKB) to %s" % (uf2, size // 1024, drive))

    try:
        shutil.copy(uf2, os.path.join(drive, os.path.basename(uf2)))
    except OSError:
        pass          # expected: the device reboots mid-write. See the header.

    print("[*] waiting for the cartridge to reboot"
          " (that is what confirms the write)")
    if not rp2_drive.wait_for(TIMEOUT, present=False):
        print("[-] %s is still mounted after %ds." % (drive, TIMEOUT))
        print("    The bootloader never got a complete image, so the flash is")
        print("    now PARTIAL - the cartridge will hang the MSX until this")
        print("    succeeds. Try again; a different USB port or a direct")
        print("    connection (no hub) is usually what fixes it.")
        return 1

    print("[+] rebooted - the bootloader accepted the whole image.")
    return 0


def main(argv):
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        print("usage: %s <uf2>" % os.path.basename(argv[0]))
        print("  e.g. %s dist/cartridge/picodock.org.uf2"
              % os.path.basename(argv[0]))
        print()
        print("Put the cartridge in BOOTSEL first: hold the button while")
        print("plugging it in.")
        return 0 if len(argv) == 2 else 1
    return flash(argv[1])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
