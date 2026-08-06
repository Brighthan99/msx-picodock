#!/bin/sh
# ---------------------------------------------------------------------------
# flash.sh - write a cartridge image to the PicoDock.
#
#   ./dist/cartridge/flash.sh                 # picodock.uf2 if you built one,
#                                             # otherwise picodock.org.uf2
#   ./dist/cartridge/flash.sh picodock.org.uf2   # back to a plain cartridge
#   ./dist/cartridge/flash.sh ~/somewhere/other.uf2
#
# Put the cartridge in BOOTSEL first: take it out of the MSX, hold the button,
# and plug it into the computer with a NORMAL data cable. A VBUS-blocking one
# carries no power, so BOOTSEL cannot work through it.
#
# You can also just drag the .uf2 onto the RPI-RP2 drive - that is all this
# does. What it adds is knowing whether it worked: the bootloader reboots only
# once it has the whole image, so the drive disappearing is the completion
# signal, and the copy erroring out is normal. Finder reports failure on a
# perfectly good write for exactly that reason.
#
# The work is ../disk/tools/flash_uf2.py, which finds the drive wherever this
# mounts it. flash.bat is the same thing for cmd.exe.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

# A relative name is resolved against the directory it was typed in, then
# against this one. The second half matters: the images live beside this script,
# so "./flash.sh picodock.org.uf2" - which is what the message below tells
# people to type - names a file that is not in their working directory.
UF2="${1:-}"
case "$UF2" in
  ""|/*) ;;
  *) if   [ -f "$FROM/$UF2" ]; then UF2="$FROM/$UF2"
     elif [ -f "$HERE/$UF2" ]; then UF2="$HERE/$UF2"
     else UF2="$FROM/$UF2"          # let the "no such file" name what they typed
     fi ;;
esac
cd "$HERE"

if [ -z "$UF2" ]; then
  # Yours if you have built one, the shipped image otherwise. Someone who ran
  # make-uf2.sh wants to flash what they just made; someone who has not wants
  # the one that came with this.
  # Whichever it picks, say which and say what the other one is. This is the
  # line someone reads with the cartridge in their hand, and "picodock" appears
  # in both names - naming the file without saying what it holds would not
  # actually tell them what is about to be written.
  if [ -f picodock.uf2 ]; then
    UF2=picodock.uf2
    echo "[*] flashing picodock.uf2 - the one you built, with your roms/ in it"
    echo "    (picodock.org.uf2 is the plain one this ships;"
    echo "     ./flash.sh picodock.org.uf2 goes back to it)"
  elif [ -f picodock.org.uf2 ]; then
    UF2=picodock.org.uf2
    echo "[*] flashing picodock.org.uf2 - the plain cartridge this ships"
    echo "    (put .rom files in roms/ and ./make-uf2.sh builds picodock.uf2"
    echo "     with them in it)"
  else
    echo "[-] no image here to flash."
    echo "    picodock.org.uf2 ships with this; ./make-uf2.sh builds picodock.uf2"
    exit 1
  fi
fi

# The host programs are staged once, under ../disk/tools/. They are not
# disk-specific - that folder is where src/host/ lands - and one staged copy is
# better than two that drift.
TOOLS=../disk/tools
[ -e "$TOOLS/flash_uf2.py" ] || {
  echo "[-] $TOOLS/flash_uf2.py is missing."
  echo "    tools/ is staged from src/host/ by ./src/stage_dist.sh - run that."
  exit 1; }

python3 "$TOOLS/flash_uf2.py" "$UF2" || exit 1

echo "    Confirm the firmware came up:  ./dist/cartridge/flash-check.sh"
