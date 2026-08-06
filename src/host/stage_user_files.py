#!/usr/bin/env python3
"""stage_user_files.py - prepare dist/disk/user-files/ for an MSX disk.

    python3 stage_user_files.py <user-files> <system> <staging-dir>

Copies the first into the third, with the second treated as already-taken
names. What comes out is ready to hand to disk_put.sh; nothing here touches a
disk image.

It exists as its own file because two scripts need it and they must agree:
make-disk.sh builds a fresh image, sync-disk.sh pushes changes into one that
already exists. A copy of these rules in each would drift, and the drift would
show up as a disk that works when built one way and not the other.

Four things happen on the way, each of them a problem that only appears once
the disk is in an MSX:

**Names are upper-cased.** FAT stores short names in upper case, but macOS
marks "this was lower case" in the directory entry. The MSX does not see that
mark, so the same file reads differently on the two sides.

**system/ wins a collision, loudly.** A COMMAND2.COM in user-files/ is skipped
and said so. The half that has to boot is not replaced quietly.

**copyfile, not copy2.** copy2 brings extended attributes along -
com.apple.provenance is on everything that came from a download - and a FAT
volume has nowhere to put them, so macOS writes ._NAME sidecars instead. Those
are invisible on the Mac and plainly visible in DIR on the MSX. The bytes are
all that belongs on a 1983 disk.

**Names that do not fit 8.3 are reported, not renamed.** FAT invents one
(SOFAR~14) and the number depends on what else is on the volume, so it differs
between builds and is useless in an AUTOEXEC.BAT. Shortening it is a decision,
not a detail.

READMEs and dotfiles are left behind - a README explains the folder to whoever
is at the Mac, and on the MSX it is a name in DIR that nothing can open. That
is also what keeps .DS_Store off the disk.

Prints one line per skipped or over-long name, and finally "staged N" so a
caller can report a count without walking the tree again.
"""

import os
import shutil
import sys


def fits_8_3(name):
    base, _, ext = name.partition(".")
    return ("." not in ext and " " not in name
            and 1 <= len(base) <= 8 and len(ext) <= 3)


def stage(src, system, dst):
    taken = {n.upper() for n in os.listdir(system)} if os.path.isdir(system) else set()
    long_names = []
    staged = 0

    for root, dirs, files in os.walk(src):
        rel = "" if root == src else os.path.relpath(root, src) + os.sep
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        out = os.path.join(dst, *[p.upper() for p in rel.split(os.sep) if p])
        os.makedirs(out, exist_ok=True)

        for d in list(dirs):
            if not rel and d.upper() in taken:
                print("[!] user-files/%s/ skipped - system/ has that name" % d)
                dirs.remove(d)
            elif not fits_8_3(d):
                long_names.append(rel + d + "/")

        for f in sorted(files):
            if f.startswith(".") or f.lower() == "readme.md":
                continue
            if not rel and f.upper() in taken:
                print("[!] user-files/%s skipped - system/ has that name" % f)
                continue
            if not fits_8_3(f):
                long_names.append(rel + f)
            shutil.copyfile(os.path.join(root, f), os.path.join(out, f.upper()))
            staged += 1

    # A folder of ROMs named the way the internet names them is dozens of these,
    # so they are counted rather than listed one per line.
    if long_names:
        for n in long_names[:5]:
            print("[!] %s does not fit 8.3 - the MSX will see a name FAT invents" % n)
        if len(long_names) > 5:
            print("[!] ...and %d more" % (len(long_names) - 5))
        print("    They are still copied. Shorten the ones you mean to type -"
              " anything named in AUTOEXEC.BAT above all.")

    return staged


def main(argv):
    if len(argv) != 4:
        print(__doc__.strip().split("\n\n")[1])
        return 2
    src, system, dst = argv[1:4]
    if not os.path.isdir(src):
        print("[-] no such folder: %s" % src)
        return 1
    print("staged %d" % stage(src, system, dst))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
