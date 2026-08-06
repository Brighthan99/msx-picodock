#!/bin/sh
# No disk image is committed - serve.sh builds one on first run - so this makes
# a throwaway and checks that what comes out of dist/disk/system/ actually lands
# on it. That is the thing worth testing: a rebuilt .COM that never reaches the
# disk builder is a file people are handed stale.
# The image is read directly rather than mounted: mounting needs privileges on
# Linux and leaves the host writing to a file the MSX may be serving.
set -e
cd "$(dirname "$0")/.."

IMG="${TMPDIR:-/tmp}/pdtest-disk-image.img"
rm -f "$IMG"
# 8m, not 128m: nothing here cares about free space, and the small one is built
# and thrown away in a fraction of the time.
python3 dist/disk/tools/build_disk.py bare dist/disk 8m "$IMG" PICODOCK >/dev/null || {
  echo "  FAIL could not build a disk image from dist/disk/system/"
  exit 1; }
export IMG
trap 'rm -f "$IMG"' EXIT

exec python3 - <<'PY'
import os, struct, sys

# The one just built, not picodock.img: that is whatever the person running this
# has put on it, and holding that to system/ would fail for them.
IMG, SRC = os.environ["IMG"], "dist/disk/system"

def root_entries(path):
    """Name -> size, from the FAT16 root directory.

    Located through the MBR and the BPB rather than by scanning for something
    that looks like a directory. The scan version of this worked until the disk
    had enough files to be interesting, then reported one of them missing when
    it was not - a test that cries wolf is worse than no test.
    """
    with open(path, "rb") as f:
        head = f.read(0x100000)

    start = struct.unpack("<I", head[446 + 8:446 + 12])[0]   # first partition LBA
    bpb = head[start * 512:start * 512 + 512]
    bytes_per_sec = struct.unpack("<H", bpb[11:13])[0]
    reserved = struct.unpack("<H", bpb[14:16])[0]
    n_fats = bpb[16]
    root_entries_max = struct.unpack("<H", bpb[17:19])[0]
    fat_secs = struct.unpack("<H", bpb[22:24])[0]
    if bytes_per_sec != 512 or not root_entries_max:
        raise SystemExit("  FAIL %s does not look like the FAT16 we write" % path)

    root = (start + reserved + n_fats * fat_secs) * 512
    out = {}
    for i in range(root_entries_max):
        e = head[root + i * 32:root + i * 32 + 32]
        if e[:1] == b"\x00":                 # end of directory
            break
        if e[:1] == b"\xe5" or e[11] & 0x0F == 0x0F:   # deleted, or a VFAT part
            continue
        name = e[0:8].decode("ascii", "replace").strip()
        ext = e[8:11].decode("ascii", "replace").strip()
        out[f"{name}.{ext}" if ext else name] = struct.unpack("<I", e[28:32])[0]
    return out


on_disk = root_entries(IMG)
wanted = {f: os.path.getsize(os.path.join(SRC, f))
          for f in sorted(os.listdir(SRC)) if not f.startswith(".")}

# Everything else on the image is somebody else's business: what the user put in
# user-files/, and what the MSX itself wrote there - SofaRun makes a SAVES
# directory the first time it runs. This check exists to catch a system file
# that went stale, not to police a disk that is in use.

fail = 0
for name, size in wanted.items():
    got = on_disk.get(name.upper())
    if got is None:
        print(f"  FAIL {name} is in {SRC}/ but not on the image")
        fail = 1
    elif got != size:
        print(f"  FAIL {name}: image has {got} bytes, {SRC}/ has {size}")
        print("       the disk builder is not picking that file up -")
        print("       check dist/disk/tools/build_disk.py and stage_user_files.py")
        fail = 1
    else:
        print(f"  OK   {name}  {size}")

extra = sorted(set(on_disk) - {n.upper() for n in wanted})
if extra:
    print("  --   also on the image (yours, or the MSX's): "
          + ", ".join(extra[:8]) + (" ..." if len(extra) > 8 else ""))

if not fail:
    print("  all passed")
sys.exit(fail)
PY
