#!/bin/sh
# ---------------------------------------------------------------------------
# build_diskprint.sh - the disk + printer build, end to end.
#
#   ./src/build_diskprint.sh                      # firmware -> menu -> UF2
#   ./src/build_diskprint.sh <rom-folder>         # ...with those *.ROM listed too
#   ./src/build_diskprint.sh <rom-folder> out.uf2
#   SKIP_BUILD=1 ./src/build_diskprint.sh         # package what is already built
#
# One command, because the disk build has two settings that have to agree and
# make_uf2.sh cannot default to them - it also has to serve the other builds.
#
#   FW=pdser        the integrated firmware: virtual disk + printer captor
#   NEXTOR=on       one menu entry, "PicoDock Disk (Nextor)", and it is the one
#                   that carries its own 192KB memory mapper (mapper 11). It
#                   boots on a machine with a mapper and on one without alike.
#
#   Nextor only loads NEXTOR.SYS in DOS2 mode, and DOS2 mode needs mapped RAM.
#   A 64K MSX2 such as the Sony HB-F1XD has none, so a disk entry without its
#   own mapper drops to BASIC there - which looks like the cartridge failed and
#   is not. There used to be two entries (NEXTOR=both), one with and one
#   without; the one without had no machine it was needed on, so it went. The
#   multirom tool's -s is kept as an alias for -m. See make_uf2.sh.
#
#   Without NEXTOR the menu lists ROMs only and there is nothing to boot the
#   disk with, which is the mistake this script exists to stop.
#
# There used to be a third, KEYBOARD=off, selecting the stock Nextor kernel over
# one carrying the remote keyboard as its DRV_TIMI. That whole path is in
# archive/ now, and there is no setting for the kernel any more: make_uf2.sh
# takes the PicoDock one (CALL PDASK as DRV_BASSTAT, src/nextor-driver/build.sh)
# when it has been built and the stock one when it has not.
#
# The ROM folder is optional. With none, you get a menu holding just the disk
# entry - which is the whole point of a disk + printer cartridge.
# ---------------------------------------------------------------------------
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ROMDIR="$1"
OUT="${2:-$ROOT/dist/cartridge/picodock.org.uf2}"

# No ROM folder: hand make_uf2.sh an empty one. The tool scans *.ROM in the
# directory it is run from, finds none, and with -s still emits an image - just
# the Nextor entry in the menu.
if [ -z "$ROMDIR" ]; then
  ROMDIR="$ROOT/build/diskprint-roms"
  mkdir -p "$ROMDIR"
  echo "[*] no ROM folder given - the menu will hold the disk entry only"
elif [ ! -d "$ROMDIR" ]; then
  echo "[-] not a directory: $ROMDIR"
  exit 1
fi

if [ "${SKIP_BUILD:-0}" = 1 ]; then
  echo "[*] SKIP_BUILD=1 - using the firmware already in build/pdser"
else
  echo "[*] firmware"
  "$ROOT/src/build.sh" pdser
fi

echo
echo "[*] image"
FW=pdser NEXTOR=on "$ROOT/src/make_uf2.sh" "$ROMDIR" "$OUT"

echo
echo "[+] disk + printer image ready"
echo "    flash : hold BOOTSEL, plug in, drop $OUT on RPI-RP2"
echo "    serve : ./dist/disk/serve.sh <image.img>"
