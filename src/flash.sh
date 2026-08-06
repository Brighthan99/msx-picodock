#!/bin/sh
# ---------------------------------------------------------------------------
# flash.sh - write a UF2 through the bootloader's mass-storage drive
#
#   ./src/flash.sh <uf2>
#
# Why not picotool
#   picotool 2.3.0 is not reliable on this machine: `picotool info` segfaults
#   when no device is attached, and `picotool load` has aborted mid-write
#   ("connection_error") on a 7.7MB image, leaving a **half-written flash** -
#   which looks exactly like a cartridge that hangs the MSX at boot.
#   The RPI-RP2 drive path goes through the RP2040's own ROM bootloader instead
#   and does not depend on any of that.
#
# How it knows the write finished
#   The bootloader counts blocks and reboots only once it has received the whole
#   image (each UF2 block carries its index and the total). So the drive
#   disappearing *is* the completion signal - and a copy that errors out early
#   leaves it mounted. That makes "did it take?" answerable without picotool.
#
#   cp itself always looks like it failed here: the device reboots while cp
#   still has the file open, so it reports -36 or "device not configured". Its
#   exit status is therefore ignored on purpose; the drive is what is checked.
#
# Use a **normal data cable**. The VBUS-cut cable carries no power, so BOOTSEL
# cannot work over it.
# ---------------------------------------------------------------------------
set -e

DRIVE=/Volumes/RPI-RP2
TIMEOUT=90

usage() {
  echo "usage: ${0##*/} <uf2>"
  echo "  e.g. ${0##*/} dist/cartridge/picodock.uf2"
  echo
  echo "Put the cartridge in BOOTSEL first: hold the button while plugging it in."
}

case "$1" in
  -h|--help) usage; exit 0 ;;
  "")        usage; exit 1 ;;
esac

UF2="$1"
[ -f "$UF2" ] || { echo "[-] no such file: $UF2"; exit 1; }

if [ ! -d "$DRIVE" ]; then
  echo "[-] $DRIVE is not mounted - the cartridge is not in BOOTSEL."
  echo "    Hold BOOTSEL while plugging it in, with a normal data cable."
  exit 1
fi

SIZE=$(wc -c < "$UF2" | tr -d ' ')
echo "[*] writing $UF2 ($((SIZE / 1024))KB) to $DRIVE"

# Expected to fail: the device reboots out from under it. The drive check below
# is the real verdict.
cp "$UF2" "$DRIVE/" 2>/dev/null || true

echo "[*] waiting for the cartridge to reboot (that is what confirms the write)"
n=0
while [ -d "$DRIVE" ]; do
  n=$((n + 1))
  if [ "$n" -ge "$TIMEOUT" ]; then
    echo "[-] $DRIVE is still mounted after ${TIMEOUT}s."
    echo "    The bootloader never got a complete image, so the flash is now"
    echo "    PARTIAL - the cartridge will hang the MSX until this succeeds."
    echo "    Try again; a different USB port or a direct connection (no hub)"
    echo "    is usually what fixes it."
    exit 1
  fi
  sleep 1
done

echo "[+] rebooted - the bootloader accepted the whole image."
echo "    Confirm the firmware came up with:"
echo "      ./src/flash_check.sh \"$UF2\""
