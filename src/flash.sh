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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT=90

# Where the bootloader's drive turns up differs by host - /Volumes on macOS,
# /media/<user> or /run/media/<user> on Linux, a drive letter on Windows. That
# is what node/bin/rp2_drive.js is for, so ask it rather than hardcoding one
# path here and being wrong on the other two.
# 못 찾은 것은 오류가 아니라 답이다 - rp2_drive.js 는 그때 1 로 끝나는데,
# set -e 아래에서는 그것이 DRIVE=$(drive) 를 통째로 중단시킨다. 빈 문자열을
# 돌려주고 성공으로 끝낸다.
drive() { node "$ROOT/node/bin/rp2_drive.js" 2>/dev/null || true; }

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

DRIVE=$(drive)

if [ -z "$DRIVE" ]; then
  # The cartridge is running, which means an MSX may be running *on* it.
  #
  # Flashing yanks the cartridge out from under the machine: the RP2040 reboots
  # into the bootloader, its pins go high-impedance, and a Z80 executing from
  # that slot runs garbage and hangs. No harm to either board - nothing is
  # driving the bus against anything - but **a sector write in flight never
  # reaches the host**, which can leave the FAT half-updated. That part is
  # silent, and it is the reason for this warning.
  #
  # Recovery is a power cycle of the MSX. The image is checked with
  # src/host/disk_normalize.py, which refuses to walk a broken FAT.
  #
  # PDFLASH=yes skips the question, for scripts and for a cartridge that is
  # plugged into nothing but this computer.
  if [ -z "${PDFLASH:-}" ]; then
    echo "[!] The cartridge is running. If an MSX is switched on with it in a"
    echo "    slot, flashing will hang that MSX - and any disk write it has in"
    echo "    flight is lost, which can leave the image's FAT half-written."
    echo "    Switch the MSX off first, or make sure it is idle."
    # A pipe or a script gets the warning but not the question - stopping there
    # would just teach everyone to set PDFLASH and stop reading. The warning is
    # in the log either way, which is what matters when someone asks later why
    # the MSX hung.
    if [ -t 0 ]; then
      printf "    Flash anyway? [y/N] "
      read -r reply
      case "$reply" in
        y|Y|yes|YES) ;;
        *) echo "[*] stopped. Nothing was written."; exit 1 ;;
      esac
    fi
  fi

  # Not in BOOTSEL. Try to get there without the button: the firmware reboots
  # into the bootloader when the CDC port is opened at 1200 bps (pd_usb.c,
  # tud_cdc_line_coding_cb). It fails loudly if something else holds the port,
  # which is what made this look broken for three flashes.
  echo "[*] not in BOOTSEL - knocking (1200 bps)"
  node "$ROOT/node/bin/pd_bootsel.js" --wait 10 || true
  DRIVE=$(drive)
fi

if [ -z "$DRIVE" ]; then
  echo "[-] RPI-RP2 is not mounted - the cartridge is not in BOOTSEL."
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
while [ -n "$(drive)" ]; do
  n=$((n + 1))
  if [ "$n" -ge "$TIMEOUT" ]; then
    echo "[-] RPI-RP2 is still mounted after ${TIMEOUT}s."
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
