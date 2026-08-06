#!/usr/bin/env python3
"""disk_rm.py - remove files or folders from an MSX disk image, without mounting.

    ./src/host/disk_rm.py <image> <name> [more...]

    ./src/host/disk_rm.py picodock.img OLD.ROM
    ./src/host/disk_rm.py picodock.img PDKEY.COM PDMON.COM
    ./src/host/disk_rm.py picodock.img SOFARUN          # a folder and its contents

The counterpart of disk_put.py, and for the same reasons: one implementation
instead of hdiutil-here and sudo-mount-there, no password on a Raspberry Pi, and
it works on Windows. See fat16.py.

Names are matched as the MSX sees them - 8.3, case-insensitive. `SOFARUN` and
`sofarun` are the same entry; `Space Manbow - Konami.rom` is not a name on the
disk at all, and `SPACEM~1.ROM` probably is. Run it with no names to see what is
there.

Nothing is removed unless every name given was found. A typo in one of five
arguments should not leave the other four deleted and the reason buried above
the error.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fat16 import Fat, ATTR_DIR, ATTR_LFN, ATTR_VOLUME, FREE   # noqa: E402
from disk_hold import Hold                                     # noqa: E402


def _listing(fat, cluster):
    """{name11: (is_dir, size)} for one directory, in the order FAT holds them."""
    out = {}
    for _, _, ent in fat.entries(cluster):
        if ent[0] == FREE or ent[11] == ATTR_LFN or ent[11] & ATTR_VOLUME:
            continue
        if bytes(ent[0:8]).strip() in (b".", b".."):
            continue
        name = ent[0:11].decode("latin-1")
        out[name] = (bool(ent[11] & ATTR_DIR),
                     int.from_bytes(ent[28:32], "little"))
    return out


def _shown(name11):
    base, ext = name11[:8].rstrip(), name11[8:].rstrip()
    return f"{base}.{ext}" if ext else base


def _match(listing, want):
    """The stored 11-byte name for `want`, however the user typed it."""
    want = want.strip().upper()
    for name11 in listing:
        if _shown(name11).upper() == want or name11.rstrip().upper() == want:
            return name11
    return None


def show(image):
    fat = Fat(open(image, "r+b"))
    try:
        listing = _listing(fat, 0)
        if not listing:
            print("[*] the disk is empty")
            return 0
        for name11, (is_dir, size) in listing.items():
            print("  %-13s %s" % (_shown(name11),
                                  "<DIR>" if is_dir else "%7d" % size))
    finally:
        fat.f.close()
    return 0


def remove(image, names):
    try:
        hold = Hold(image).__enter__()
    except IOError as e:
        print("[-] %s" % e)
        return 1
    try:
        fat = Fat(open(image, "r+b"))
        try:
            listing = _listing(fat, 0)

            # Resolve every name before removing any of them.
            targets = []
            missing = []
            for want in names:
                got = _match(listing, want)
                (targets.append(got) if got else missing.append(want))
            if missing:
                for m in missing:
                    print("[-] not on the disk: %s" % m)
                print("    Nothing was removed. Names are 8.3 as the MSX sees"
                      " them - run with no names to list them.")
                return 1

            for name11 in targets:
                is_dir, size = listing[name11]
                fat.remove(0, name11)
                print("[-] %-13s %s" % (_shown(name11),
                                        "<DIR> and its contents" if is_dir
                                        else "%7d" % size))
            fat.f.flush()
            os.fsync(fat.f.fileno())
        finally:
            fat.f.close()
    finally:
        hold.release()

    print()
    print("    Now run PDSYNC on the MSX, or Nextor keeps showing what was"
          " there.")
    return 0


def main(argv):
    if len(argv) < 2:
        print("usage: %s <image> [name...]   (no names lists the disk)"
              % os.path.basename(argv[0]))
        return 2
    image = argv[1]
    if not os.path.isfile(image):
        print("[-] no such image: %s" % image)
        return 1
    return show(image) if len(argv) == 2 else remove(image, argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
