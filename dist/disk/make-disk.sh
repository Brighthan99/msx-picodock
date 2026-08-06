#!/bin/sh
# ---------------------------------------------------------------------------
# make-disk.sh - build the virtual disk, filled and ready to serve.
#
#   ./dist/disk/make-disk.sh                    # -> picodock.img, 128 MB
#   ./dist/disk/make-disk.sh 512m               # a different size
#   ./dist/disk/make-disk.sh 128m ~/games.img
#   ./dist/disk/make-disk.sh 128m ~/games.img GAMES
#
# The disk beside this script is already built with these defaults, so you only
# need this for a different size, a second disk, or a fresh one after filling
# the first. It refuses to overwrite an image that exists - use sync-disk.sh to
# update one in place. Needs Python 3 and nothing else.
#
# What goes on is the two folders beside this script:
#
#   system/       Nextor's kernel loader, the command interpreter and the
#                 MSX-side tools. This is what makes the image bootable; an
#                 empty FAT16 volume would mount but leave the MSX nowhere to go.
#   user-files/   whatever you want on the disk, structure intact and this
#                 folder as the root, so user-files/GAMES/X.ROM lands as
#                 A:\GAMES\X.ROM with names upper-cased on the way.
#
# system/ wins: a file in user-files/ whose name system/ already uses is left
# out, and said so, rather than quietly replacing the half that has to boot.
#
# The rules live in tools/build_disk.py, not here. make-disk.bat needs the same
# ones and cannot call a .sh, so there is one implementation and four thin
# wrappers rather than two that drift.
#
# This is the counterpart of ../cartridge/make-uf2.sh: one flashes, one serves.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

SIZE="${1:-128m}"
OUT="${2:-}"
VOL="${3:-MSXDISK}"
case "$OUT" in "" ) ;; /*) ;; *) OUT="$FROM/$OUT" ;; esac
cd "$HERE"

[ -e tools/build_disk.py ] || {
  echo "[-] tools/build_disk.py is missing."
  echo "    tools/ is staged from src/host/ by ./src/stage_dist.sh - run that."
  exit 1; }

python3 tools/build_disk.py make . "$SIZE" "${OUT:-picodock.img}" "$VOL"
rc=$?
[ "$rc" = 0 ] || exit "$rc"

echo
echo "    serve it:  ./dist/disk/serve.sh"
echo "    add files: drop them in user-files/ and run ./dist/disk/sync-disk.sh"
echo "    then run PDSYNC on the MSX, or Nextor keeps showing the old listing."
