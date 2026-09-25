#!/bin/sh
# ---------------------------------------------------------------------------
# sync-disk.sh - push what is in user-files/ onto a disk that already exists.
#
#   ./dist/disk/sync-disk.sh                    # into picodock.img beside this
#   ./dist/disk/sync-disk.sh ~/games.img        # into another one
#   ./dist/disk/sync-disk.sh -y                 # do not ask
#
# make-disk.sh builds a disk from nothing and refuses to touch one that is
# already there, because rebuilding would throw away whatever the MSX has
# written to it. This is the other half: change something in user-files/, run
# this, and the disk catches up without being rebuilt.
#
# It is a copy, not a mirror, and the difference matters enough to say out loud
# before doing anything - see the prompt below.
#
# Safe to run while serve.sh is up. disk_put.sh asks the server to let go of the
# image, waits for confirmation, and releases it afterwards, so the two never
# write at once.
#
# The work is ../node/bin/build_disk.js, the same file make-disk.sh calls. sync-disk.bat
# needs the same rules and cannot call a .sh, so there is one implementation and
# four thin wrappers rather than two that drift - and a disk built one way and
# updated the other cannot end up different.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

ASSUME_YES=0
IMAGE=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes)  ASSUME_YES=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "[-] unknown option: $arg  (try --help)"; exit 1 ;;
    *)         case "$arg" in
                 /*) IMAGE="$arg" ;;
                 *)  IMAGE="$FROM/$arg" ;;
               esac ;;
  esac
done
[ -n "$IMAGE" ] || IMAGE="picodock.img"

cd "$HERE"

DIST="$HERE/.."
. "$DIST/need-node.sh"

[ -f "$IMAGE" ] || {
  echo "[-] no disk image at $IMAGE"
  echo "    make one first:  ./dist/disk/make-disk.sh"
  exit 1; }

# Not in the repository - what goes in it is yours - so a fresh clone has none.
# Make it and stop, which answers the question the error used to leave open:
# there is nothing to copy *yet*, and here is where to put it.
[ -d user-files ] || {
  mkdir -p user-files
  echo "[*] made user-files/ - put what you want on the disk there, then run"
  echo "    this again. Folders are kept: user-files/GAMES/X.ROM -> A:\\GAMES\\X.ROM"
  exit 0; }

# --- say what this does not do, before doing it ----------------------------
# Both limits are the kind that are invisible until they bite: a file you
# deleted is still on the disk and still in DIR, and an edit to something
# system/ also provides quietly does nothing. Better to read it every time than
# to find out from an MSX.
cat <<TXT
This copies user-files/ onto $IMAGE. Two things it does not do:

  * Files removed from user-files/ are NOT removed from the disk. This adds
    and overwrites; it never deletes. Anything the MSX wrote is safe for the
    same reason - and so is anything you meant to get rid of.

  * system/ wins. A file in user-files/ whose name system/ already uses is
    skipped, not copied over the top. That is the half that has to boot.

TXT

if [ "$ASSUME_YES" = 0 ]; then
  if [ -t 0 ]; then
    printf 'Go ahead? [Y/n] '
    read -r reply || reply=""
    case "$reply" in
      ""|y|Y|yes|YES|Yes) ;;
      *) echo "[-] stopped, nothing was written."; exit 1 ;;
    esac
    echo
  else
    # No terminal to ask at: a pipe or a cron job. Refuse rather than assume -
    # -y is one flag, and a script that writes to a disk image because nobody
    # was there to object is not a script anyone wants.
    echo "[-] not a terminal, and no -y given. Nothing was written."
    exit 1
  fi
fi

node "$NODEDIR/bin/build_disk.js" sync . "$IMAGE" || exit 1

cat <<'TXT'

    Now run PDSYNC on the MSX.

    Nextor caches the directory, so until PDSYNC runs, DIR shows the listing
    from before this - the new files are on the disk and simply not visible
    yet. It is on the disk already:  A> PDSYNC
TXT
