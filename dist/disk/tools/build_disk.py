#!/usr/bin/env python3
"""build_disk.py - make or update the virtual disk from the folders beside it.

    build_disk.py make <dist/disk> [size] [image] [volume]
    build_disk.py bare <dist/disk> [size] [image] [volume]
    build_disk.py sync <dist/disk> [image]

`make` builds a disk from nothing and refuses to touch one that exists, because
rebuilding would throw away whatever the MSX has written. `sync` is the other
half: change something in user-files/ and the disk catches up in place.

`bare` is `make` without user-files/ - system/ and nothing else. That is the
disk this project ships: what someone else put in user-files/ is theirs, not
part of the product, and a 128 MB image full of one person's ROM collection is
not something to hand to anyone.

Both take the *folder* rather than a list of files, and what goes on is the two
folders in it:

    system/       Nextor's kernel loader, the command interpreter and the
                  MSX-side tools. This is what makes the image bootable.
    user-files/   whatever you want on the disk, structure intact, with this
                  folder as the root: user-files/GAMES/X.ROM lands as
                  A:\\GAMES\\X.ROM.

system/ wins a name collision, and says so rather than quietly replacing the
half that has to boot.

This is a Python file and not two shell scripts because there are four callers -
make-disk.sh, make-disk.bat, sync-disk.sh, sync-disk.bat - and the rules have to
be the same in all of them. A .bat cannot call a .sh, so the choice was one
implementation here or two that drift; the drift would show up as a disk that
works when built on one machine and not another.
"""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import disk_put                                              # noqa: E402
import make_disk                                             # noqa: E402
from stage_user_files import stage                           # noqa: E402


def _folders(root):
    return os.path.join(root, "system"), os.path.join(root, "user-files")


def _check(root):
    system, _ = _folders(root)
    if not os.path.isdir(system):
        print("[-] no system/ folder in %s" % root)
        return None
    real = [e for e in sorted(os.listdir(system))
            if not e.startswith(".") and e.lower() != "readme.md"]
    if not real:
        print("[-] system/ is empty - the image would boot to nothing.")
        print("    ./src/msx-tools/build.sh fills it (or ./src/stage_dist.sh")
        print("    for the two Nextor files, if you have no sdcc).")
        return None
    return real


def _stage_user(root):
    """user-files/ prepared for the disk, or None when there is nothing to put."""
    _, user = _folders(root)
    if not os.path.isdir(user):
        return None
    tmp = tempfile.mkdtemp(prefix="picodock-stage-")
    system, _ = _folders(root)
    n = stage(user, system, tmp)
    if not n:
        shutil.rmtree(tmp, ignore_errors=True)
        return None
    return tmp


def make(root, size="128m", image=None, volume="MSXDISK", with_user=True):
    system, _ = _folders(root)
    real = _check(root)
    if real is None:
        return 1
    image = image or os.path.join(root, "picodock.img")
    if os.path.exists(image):
        print("[!] %s exists already." % _rel(image))
        print("    Making it again would discard whatever is on it. Move it")
        print("    aside, or use sync-disk to update it in place.")
        return 1

    rc = make_disk.main(["make_disk.py", image, size, volume])
    if rc:
        return rc
    print()

    tmp = _stage_user(root) if with_user else None
    try:
        contents = [system] + ([tmp] if tmp else [])
        print("[*] system/ (%d files)%s"
              % (len(real), ", user-files/" if tmp
                 else "" if with_user else ", user-files/ skipped"))
        return disk_put.put(image, [], contents)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def sync(root, image=None):
    if _check(root) is None:
        return 1
    image = image or os.path.join(root, "picodock.img")
    if not os.path.isfile(image):
        print("[-] no disk image at %s" % _rel(image))
        print("    make one first:  make-disk")
        return 1
    tmp = _stage_user(root)
    if not tmp:
        print("[*] nothing to copy - user-files/ holds no files the disk can take.")
        return 0
    try:
        return disk_put.put(image, [], [tmp])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _rel(path):
    try:
        r = os.path.relpath(path)
        return r if len(r) < len(path) else path
    except ValueError:
        return path


def main(argv):
    if len(argv) < 3 or argv[1] not in ("make", "bare", "sync"):
        print(__doc__.strip().split("\n\n")[1])
        return 2
    what, root = argv[1], argv[2]
    if what in ("make", "bare"):
        return make(root, *(argv[3:6] or []), with_user=(what == "make"))
    return sync(root, *(argv[3:4] or []))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
