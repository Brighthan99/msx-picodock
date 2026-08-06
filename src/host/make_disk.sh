#!/bin/sh
# ---------------------------------------------------------------------------
# make_disk.sh - create an MSX virtual disk image (D4e/D4f)
#
#   ./src/host/make_disk.sh [size] [image] [volume-name]
#   ./src/host/make_disk.sh 128m picodock.img MSXDISK --bootable
#
#   size       : 128m (default) | 256m | 512m | 1g | 2g   - or any value in MB
#   --bootable : also copy the Nextor system files from resources/assets, so the MSX
#                boots straight into MSX-DOS from this disk
#
# The image is written by make_disk.py, which lays out the MBR and BPB exactly as
# Nextor's own FDISK does. hdiutil and mkfs.vfat both produce a valid FAT16 that
# Nextor nonetheless refuses (wrong partition type, CHS marker, media byte...),
# so building it ourselves is what makes the image usable without running FDISK
# on the MSX first. It also removes the macOS/Linux tooling split.
#
# How big?
# --------
# FAT16 tops out at 65524 clusters, so the cluster size fixes the maximum volume:
#
#     cluster 2KB -> 128MB      cluster 8KB -> 512MB      cluster 32KB -> 2GB
#     cluster 4KB -> 256MB      cluster 16KB -> 1GB
#
# Smaller is usually better, though not for the reason it looks: the image is
# written sparsely, so a fresh 128MB one occupies about 300KB until something is
# put on it (APFS, ext4, NTFS; a FAT-formatted host disk has no sparse files and
# does take the lot). The real cost is the cluster size, which grows with the
# image and wastes on average half a cluster per file - noticeable with many
# small MSX ROMs. 128MB already holds hundreds of them.
#
# Next steps
# ----------
#   ./src/host/disk_put.sh <image> <files...>     add files
#   ./src/host/pd_diskserver.py <image>         serve it to the MSX
#
# Never leave the image mounted on this machine while serving it: both sides
# would write the same filesystem and corrupt it.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
# The repository root is found by walking up to the directory holding VERSION,
# not by counting "..". This script runs from two depths - src/host/ and the
# staged copy in dist/disk/tools/ - and a fixed count is wrong in one of them.
ROOT="$HERE"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/VERSION" ]; do ROOT="$(dirname "$ROOT")"; done
[ -f "$ROOT/VERSION" ] || ROOT="$(cd "$HERE/../.." && pwd)"

SIZE="128m"
IMAGE=""
VOLNAME="MSXDISK"
BOOTABLE=0

# Positional args in order, with --bootable accepted anywhere
POS=0
for arg in "$@"; do
  case "$arg" in
    --bootable) BOOTABLE=1 ;;
    -h|--help)  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      POS=$((POS + 1))
      case $POS in
        1) SIZE="$arg" ;;
        2) IMAGE="$arg" ;;
        3) VOLNAME="$arg" ;;
      esac ;;
  esac
done
[ -n "$IMAGE" ] || IMAGE="picodock.img"

python3 "$HERE/make_disk.py" "$IMAGE" "$SIZE" "$VOLNAME"

if [ "$BOOTABLE" = "1" ]; then
  # The two files Nextor needs to reach a DOS prompt. They ship with the
  # repository (src/nextor/), from the same 2.1.4 distribution as the
  # kernel ROM - the versions have to match, and leaving that to chance means a
  # cartridge that hangs mid-boot for a reason nothing reports.
  #
  # Three places are consulted in order: resources/assets/ (yours) beats
  # dist/disk/system/ (staged) beats src/nextor/ (shipped). The staged
  # copy is the normal answer and holds all four; src/nextor/ stays as a
  # fallback so a fresh clone makes a bootable disk before anything is built.
  #
  # MSXDOS2.SYS is not in the list: the kernel only looks for it when NEXTOR.SYS
  # is absent (or on an explicit CALL SYSTEM2), so shipping it would be shipping
  # a file nothing loads. Drop one in resources/assets/ and it is picked up like
  # any other override.
  BUNDLED="$ROOT/src/nextor"
  ASSETS="$ROOT/resources/assets"
  DISTDIR="$ROOT/dist/disk/system"
  SYSFILES=""
  MISSING=""
  for f in NEXTOR.SYS COMMAND2.COM; do
    if   [ -f "$ASSETS/$f"  ]; then SYSFILES="$SYSFILES $ASSETS/$f"
    elif [ -f "$DISTDIR/$f" ]; then SYSFILES="$SYSFILES $DISTDIR/$f"
    elif [ -f "$BUNDLED/$f" ]; then SYSFILES="$SYSFILES $BUNDLED/$f"
    else MISSING="$MISSING $f"
    fi
  done
  if [ -n "$MISSING" ]; then
    echo "[-] missing system files:$MISSING"
    echo "    expected in dist/disk/system/ (staged by ./src/stage_dist.sh),"
    echo "    src/nextor/ (shipped) or resources/assets/ (yours)"
    echo "    the image was created but is not bootable"
    exit 1
  fi
  # The MSX-side tools go on too. They are not optional extras: PDSYNC is how
  # files added from the host become visible to Nextor, which is the whole point
  # of a served disk, and without PDFRCPRN printing hangs on an OCM. Making the
  # user fetch and copy them separately is asking them to assemble a working
  # product out of parts.
  #
  # They are build output, so dist/ is where they are; resources/assets/ wins if
  # you keep your own. If neither has them the disk is still made - the tools can
  # be added later with disk_put.sh - but say what is absent and how to get it.
  TOOLS=""
  NOTOOLS=""
  for f in PDSYNC.COM PDFRCPRN.COM; do
    if   [ -f "$ASSETS/$f" ]; then TOOLS="$TOOLS $ASSETS/$f"
    elif [ -f "$DISTDIR/$f" ]; then TOOLS="$TOOLS $DISTDIR/$f"
    else NOTOOLS="$NOTOOLS $f"
    fi
  done

  echo
  # shellcheck disable=SC2086  # deliberate word splitting: one path per file
  "$HERE/disk_put.sh" "$IMAGE" $SYSFILES $TOOLS

  if [ -n "$NOTOOLS" ]; then
    echo
    echo "[!] not on the disk:$NOTOOLS"
    echo "    build them with ./src/msx-tools/build.sh (needs sdcc), then"
    echo "    ./src/host/disk_put.sh $IMAGE dist/disk/system/PD*.COM"
    echo "    PDSYNC is what makes host-side changes visible to Nextor."
  fi
else
  echo
  echo "    add files : ./src/host/disk_put.sh $IMAGE <files...>"
  echo "    serve     : ./src/host/pd_diskserver.py $IMAGE"
  echo "    (for a disk the MSX can boot from, pass --bootable)"
fi
