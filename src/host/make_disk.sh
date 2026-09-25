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
# The image is written by node/bin/make_disk.js, which lays out the MBR and BPB exactly as
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
# The image is written sparsely, so a fresh 128MB one occupies about 300KB until
# something is put on it (APFS, ext4, NTFS; a FAT-formatted host disk has no
# sparse files and does take the lot). 128MB holds hundreds of MSX ROMs.
#
# **The cluster is picked large on purpose** - 16KB wherever it fits. That is
# the opposite of the usual advice, and the reason is the link. Every FAT sector
# costs one USB round trip (the cartridge asks for one sector at a time), and
# `DIR` walks the whole FAT to print its "bytes free" footer. At 2KB clusters a
# 128MB volume has a 128KB FAT: 256 round trips for that one line. At 16KB it is
# 32. The cost is slack - on average half a cluster per file, so 8KB each - which
# on a 128MB disk full of 16-48KB ROMs is a trade worth making.
#
# Next steps
# ----------
#   ./src/host/disk_put.sh <image> <files...>     add files
#   ./dist/disk/serve.sh <image>                serve it to the MSX
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

command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
node "$HERE/../../node/bin/make_disk.js" "$IMAGE" "$SIZE" "$VOLNAME"

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
  # of a served disk, without PDFRCPRN printing hangs on an OCM, and without
  # PDMIDI MSX-MIDI software finds no interface on an MSX that has none. Making the
  # user fetch and copy them separately is asking them to assemble a working
  # product out of parts.
  #
  # They are build output, so dist/ is where they are; resources/assets/ wins if
  # you keep your own. If neither has them the disk is still made - the tools can
  # be added later with disk_put.sh - but say what is absent and how to get it.
  TOOLS=""
  NOTOOLS=""
  for f in PDSYNC.COM PDFRCPRN.COM PDMIDI.COM; do
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
  echo "    serve     : ./dist/disk/serve.sh $IMAGE"
  echo "    (for a disk the MSX can boot from, pass --bootable)"
fi
