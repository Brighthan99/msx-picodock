#!/bin/sh
# ---------------------------------------------------------------------------
# serve.sh - hand the disk to the cartridge and keep it there.
#
#   ./dist/disk/serve.sh                      # picodock.img beside this script
#   ./dist/disk/serve.sh ~/games.img          # a different disk
#   ./dist/disk/serve.sh --print pdf          # options pass straight through
#   ./dist/disk/serve.sh ~/games.img -v
#
# Leave it running while you use the MSX. The cartridge comes and goes - resets,
# reflashing, the cable - and the server sits through all of it, so there is no
# need to restart it. Ctrl-C when you are done.
#
# It starts before the cartridge is plugged in, and says it is waiting. That is
# the normal way round: start this, then switch the MSX on.
#
# Print jobs land in ../output - that is dist/output/, one level up from here.
# It is passed as a relative path on purpose: this script runs from its own
# directory, so the same three characters mean the same folder on every machine
# that ever unpacks this. Pass --output somewhere/else to change it.
#
# The third of the three. ../cartridge/make-uf2.sh makes what you flash,
# make-disk.sh makes what you serve, this serves it. Each wraps something in
# tools/ with the answers most people want, so the common case takes no
# arguments. tools/pd_diskserver.py is the same program without the opinions -
# it takes an image, and --tui only if you ask.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

# A leading non-option argument is the image; everything else goes to the server
# untouched, so --print, --readonly, --serial and the rest work as documented.
IMAGE="picodock.img"
case "${1:-}" in
  ""|-*) ;;
  *)     # Resolve against the directory the user typed it in, since we are
         # about to leave it. An absolute path is left alone.
         case "$1" in
           /*) IMAGE="$1" ;;
           *)  IMAGE="$FROM/$1" ;;
         esac
         shift ;;
esac

# Everything below is relative to this script's own directory, which is what
# makes "../output" mean the same thing wherever this tree has been unpacked.
cd "$HERE"

[ -e tools/pd_diskserver.py ] || {
  echo "[-] tools/pd_diskserver.py is missing."
  echo "    tools/ is staged from src/host/ by ./src/stage_dist.sh - run that."
  exit 1; }

# A fresh clone has no picodock.img, so build one rather than stopping. No image
# is shipped: it would be a hundred-odd megabytes of mostly nothing in the
# repository, and making one needs only Python, which you already have to have
# to be here. Building also picks up whatever is in user-files/ already, which
# copying a shipped image could never do.
if [ ! -f "$IMAGE" ] && [ "$IMAGE" = picodock.img ] && [ -f make-disk.sh ]; then
  echo "[*] no picodock.img yet - building one"
  ./make-disk.sh || exit 1
fi

[ -f "$IMAGE" ] || {
  echo "[-] no disk image at $IMAGE"
  echo "    make one:  ./dist/disk/make-disk.sh"
  exit 1; }

exec ./tools/pd_diskserver.py "$IMAGE" --tui --output ../output "$@"
