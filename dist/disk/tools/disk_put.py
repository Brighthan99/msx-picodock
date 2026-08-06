#!/usr/bin/env python3
"""disk_put.py - copy files into an MSX disk image, without mounting it.

    ./dist/disk/tools/disk_put.py <image> <file-or-dir> [more...]

    ./dist/disk/tools/disk_put.py picodock.img GAME.ROM
    ./dist/disk/tools/disk_put.py picodock.img ~/msx/SOFARUN      # -> A:\\SOFARUN\\
    ./dist/disk/tools/disk_put.py picodock.img ~/msx/SOFARUN/*    # -> A:\\ (root)

This replaces the mount-and-copy the shell version did. `hdiutil attach` on
macOS and `sudo mount -o loop` on Linux were two implementations, a password
prompt on the machine this most often runs on, and nothing at all on Windows.
Writing FAT16 directly is one implementation that runs wherever Python does.

Not mounting also removes the hazard instead of managing it. A mounted image is
a second writer, which is why the old script had to ask the disk server to let
go, wait for it to confirm, and hand the image back afterwards. Nothing here
mounts, so the server can keep serving - it sees the writes the same way it sees
the MSX's own.

macOS junk cannot appear either: `._NAME` sidecars are something the *Finder*
writes onto a mounted FAT volume, and there is no mounted FAT volume any more.
disk_normalize.py is still worth running on an image that was mounted at some
point in its life, and make_disk.sh still does.

Names are shortened to 8.3 with FAT's own `~1` rule when they do not fit, and
every one of those is reported: which file gets `~1` and which gets `~2` depends
on the order they were written, so it is not something to put in an AUTOEXEC.BAT
without looking.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fat16 import Fat, to_83                                 # noqa: E402
from disk_hold import Hold                                   # noqa: E402


def _put_file(fat, dir_cluster, path, taken, renamed):
    with open(path, "rb") as fh:
        data = fh.read()
    name = os.path.basename(path)
    name11 = to_83(name, taken)
    taken.add(name11)
    shown = (name11[:8].rstrip() + "." + name11[8:].rstrip()).rstrip(".")
    if shown.upper() != name.upper():
        renamed.append((name, shown))
    fat.add_file(dir_cluster, name11, data, os.path.getmtime(path))
    return shown, len(data)


def _put_tree(fat, dir_cluster, path, taken, renamed, out, depth=0):
    """Copy a directory and everything under it."""
    name = os.path.basename(path.rstrip(os.sep))
    name11 = to_83(name, taken)
    taken.add(name11)
    sub = fat.mkdir(dir_cluster, name11, os.path.getmtime(path))
    sub_taken = fat.names(sub)
    n = 0
    for child in sorted(os.listdir(path)):
        if child.startswith("."):
            continue                       # .DS_Store and friends stay behind
        full = os.path.join(path, child)
        if os.path.isdir(full):
            n += _put_tree(fat, sub, full, sub_taken, renamed, out, depth + 1)
        else:
            shown, size = _put_file(fat, sub, full, sub_taken, renamed)
            n += 1
    out.append(("%s/" % name11[:8].rstrip(), n))
    return n


def put(image, paths, contents=()):
    # Stand the server aside first. Writes here are visible to the MSX the moment
    # they land - the server reads the file per block and caches nothing - so a
    # directory read that lands mid-update sees a filesystem nobody wrote.
    try:
        hold = Hold(image).__enter__()
    except IOError as e:
        print("[-] %s" % e)
        return 1
    try:
        return _open_and_put(image, paths, contents)
    finally:
        hold.release()


def _open_and_put(image, paths, contents=()):
    fat = Fat(open(image, "r+b"))
    try:
        return _put(fat, paths, contents)
    except IOError as e:
        # Running out of room part-way leaves the entries already written in
        # place and the failed file absent - the image stays mountable, which is
        # what matters. Say which one did not fit rather than a traceback.
        print("[-] %s" % e)
        print("    Nothing was corrupted; the files before this one are on the"
              " disk.")
        return 1
    finally:
        try:
            fat.f.flush()
            os.fsync(fat.f.fileno())
        finally:
            fat.f.close()


def _put(fat, paths, contents=()):
    """`paths` go on as themselves; `contents` folders have their insides go on.

    The second is what `disk_put.sh img sofarun/*` meant on Unix, done without
    the shell: cmd.exe does not glob at all, and a folder of a few hundred ROMs
    is more arguments than some shells will pass. One flag replaces both
    problems.
    """
    for d in contents:
        if not os.path.isdir(d):
            print("[-] not a folder: %s" % d)
            return 1
        paths = list(paths) + [os.path.join(d, e) for e in sorted(os.listdir(d))
                               if not e.startswith(".")]
    taken = fat.names(0)
    renamed = []
    dirs = []
    for p in paths:
        if not os.path.exists(p):
            print("[-] no such file: %s" % p)
            return 1
        if os.path.isdir(p):
            _put_tree(fat, 0, p, taken, renamed, dirs)
        else:
            shown, size = _put_file(fat, 0, p, taken, renamed)
            print("[+] %-13s %7d" % (shown, size))
    for name, n in dirs:
        print("[+] %-13s %7d file(s)" % (name, n))

    if renamed:
        print()
        for was, now in renamed[:5]:
            print("[!] %s -> %s" % (was, now))
        if len(renamed) > 5:
            print("[!] ...and %d more" % (len(renamed) - 5))
        print("    FAT has no room for the long name. The number in ~1 depends on"
              " what")
        print("    else went on and when, so check before naming one in"
              " AUTOEXEC.BAT.")
    return 0


def main(argv):
    args = argv[1:]
    contents = []
    rest = []
    i = 0
    while i < len(args):
        if args[i] in ("-c", "--contents") and i + 1 < len(args):
            contents.append(args[i + 1]); i += 2
        else:
            rest.append(args[i]); i += 1
    if not rest or (len(rest) < 2 and not contents):
        print("usage: %s <image> [-c FOLDER] [file-or-dir...]"
              % os.path.basename(argv[0]))
        print("       -c FOLDER puts what is *inside* FOLDER on the disk root")
        return 2
    image, paths = rest[0], rest[1:]
    if not os.path.isfile(image):
        print("[-] no such image: %s" % image)
        return 1
    return put(image, paths, contents)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
