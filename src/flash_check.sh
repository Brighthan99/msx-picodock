#!/bin/sh
# ---------------------------------------------------------------------------
# flash_check.sh - did the UF2 actually land?
#
#   ./src/flash_check.sh <uf2>
#
# The UF2 is named explicitly and has no default: this repo builds more than one
# (pdser, stock multirom, different ROM sets), and a check that quietly compares
# against the wrong one is worse than no check.
#
# Why this exists
#   Copying a UF2 onto RPI-RP2 in Finder almost always ends with an error
#   ("can't be read or written", code -36, or "disk was not ejected properly").
#   That is expected, not a failure: the RP2040 reboots the instant the last
#   block arrives, so the drive vanishes while Finder still has it open. The
#   copy succeeded; the unmount did not. Which means the error tells you nothing
#   either way - hence an actual check.
#
# It picks its check from what is plugged in:
#
#   cartridge running    -> does it enumerate as "PicoDock"? Stock multirom
#     (normal cable,        firmware runs the port as a USB *host* and never
#      out of the MSX)      enumerates at all, so seeing the CDC device is proof
#                           the pdser build is the one running.
#
#   cartridge in BOOTSEL -> picotool reads the flash back and compares it byte
#     (hold the button      for byte, which also covers the ROM payload.
#      while plugging in)
# ---------------------------------------------------------------------------
set -e

usage() {
  echo "usage: ${0##*/} <uf2>"
  echo "  uf2   image to compare the flash against, e.g. dist/cartridge/picodock.uf2"
  echo
  echo "Only used in BOOTSEL mode. With the firmware already running there is"
  echo "nothing to compare against - the check is just whether the cartridge"
  echo "enumerates as PicoDock."
}

case "$1" in
  -h|--help) usage; exit 0 ;;
  "")        usage; exit 1 ;;
esac

UF2="$1"

# Checked before the mode detection below, so a typo is reported whatever the
# cartridge happens to be doing.
if [ ! -f "$UF2" ]; then
  echo "[-] no such file: $UF2"
  exit 1
fi

# --- BOOTSEL? ------------------------------------------------------------
# Probed by looking for the drive rather than by asking picotool: picotool 2.3.0
# segfaults instead of reporting "no device" when nothing is attached, so it
# cannot be used as a presence test.
BOOTSEL=$(python3 "$(dirname "$0")/host/rp2_drive.py" 2>/dev/null || true)
if [ -n "$BOOTSEL" ]; then
  echo "[*] BOOTSEL mode ($BOOTSEL mounted)"

  if ! command -v picotool >/dev/null 2>&1; then
    echo "[-] picotool missing (brew install picotool)"
    echo "    Without it: flash with ./src/flash.sh and re-run this after the"
    echo "    cartridge reboots - the CDC check below is nearly as good."
    exit 1
  fi

  echo "[*] verifying $UF2 - reads back ~7MB, give it a minute"
  if picotool verify "$UF2"; then
    echo "[+] flash matches the file."
  else
    echo "[-] MISMATCH (or picotool could not attach). Reflash with:"
    echo "      ./src/flash.sh \"$UF2\""
    echo "    (not \`picotool load\` - it has aborted mid-write on this machine,"
    echo "     which is how a flash ends up half-written in the first place)"
    echo
    echo "    Before assuming the flash is damaged, look at the differing bytes."
    echo "    If they are address-shaped (0x1000xxxx / 0x2000xxxx) and every one"
    echo "    of them differs by the *same* amount, nothing is corrupt: the flash"
    echo "    holds an older build and the linker moved everything by that much."
    echo "    Reflashing is still the answer, but the previous flash was fine."
    exit 1
  fi
  exit 0
fi

# --- running firmware? ---------------------------------------------------
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1 || true)
NAME=$(system_profiler SPUSBDataType 2>/dev/null | grep -c "PicoDock" || true)

if [ "$NAME" -gt 0 ] 2>/dev/null; then
  echo "[+] PicoDock is enumerated - the pdser firmware is running."
  [ -n "$PORT" ] && echo "    port: $PORT"
  echo "    The flash is good enough to boot. For a byte-exact check against"
  echo "    $UF2,"
  echo "    put the cartridge in BOOTSEL and re-run."
  exit 0
fi

if [ -n "$PORT" ]; then
  echo "[!] a serial port is present ($PORT) but it does not identify as"
  echo "    \"PicoDock\". Something else is on that port, or an older"
  echo "    firmware is running."
  exit 1
fi

echo "[-] nothing found. Connect the cartridge with a **normal data cable**:"
echo "      just plugged in       -> should appear as PicoDock"
echo "      BOOTSEL held while plugging in -> should mount RPI-RP2"
echo "    The VBUS-cut cable carries no power, so neither can happen over it."
exit 1
