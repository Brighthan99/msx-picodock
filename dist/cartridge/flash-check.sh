#!/bin/sh
# ---------------------------------------------------------------------------
# flash-check.sh - did the flash take?
#
#   ./dist/cartridge/flash-check.sh                    # against picodock.org.uf2
#   ./dist/cartridge/flash-check.sh picodock.uf2       # or whichever you flashed
#
# Two ways to answer, and it uses whichever the cartridge is in:
#
#   in BOOTSEL      picotool verifies the flash against the file, byte for byte.
#                   Reads back the whole image, so give it a minute. Needs
#                   picotool installed (brew install picotool, apt install
#                   picotool); without it, use the other way.
#
#   running         the cartridge is asked to identify itself over USB CDC. Not
#                   a byte comparison, but it answers the question that matters
#                   after flashing - did the firmware come up.
#
# The work is ../../src/flash_check.sh. Unlike the rest of dist/ this one is not
# a staged copy: it needs picotool, which is a separate install on every
# platform, so there is no version of this that works from a bare clone anyway.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

UF2="${1:-}"
case "$UF2" in
  ""|/*) ;;
  *) if   [ -f "$FROM/$UF2" ]; then UF2="$FROM/$UF2"
     elif [ -f "$HERE/$UF2" ]; then UF2="$HERE/$UF2"
     else UF2="$FROM/$UF2"
     fi ;;
esac
if [ -z "$UF2" ]; then
  if   [ -f "$HERE/picodock.uf2" ];     then UF2="$HERE/picodock.uf2"
  elif [ -f "$HERE/picodock.org.uf2" ]; then UF2="$HERE/picodock.org.uf2"
  else echo "[-] no image here to check against."; exit 1
  fi
fi

CHECK="$HERE/../../src/flash_check.sh"
[ -x "$CHECK" ] || { echo "[-] $CHECK is missing."; exit 1; }
exec "$CHECK" "$UF2"
