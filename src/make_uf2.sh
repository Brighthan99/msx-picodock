#!/bin/sh
# ---------------------------------------------------------------------------
# make_uf2.sh - build a flashable UF2 image (A3.5)
#
#   ./src/make_uf2.sh <rom-folder> [out.uf2]
#   FW=multirom ./src/make_uf2.sh <rom-folder>   # stock firmware, for A/B comparison
#   NEXTOR=sunrise ./src/make_uf2.sh <rom-folder>  # add the Nextor entry (virtual disk)
#   MENU=orig   ./src/make_uf2.sh <rom-folder>   # PicoVerse's released menu ROM
#
# Why this is needed:
#   picoverse_pdser.uf2 from `build.sh pdser` is firmware only, so flashing it
#   directly leaves the menu empty. The real image is a concatenation:
#
#       [firmware bin][menu ROM 16KB][config area][ROM payloads]
#
#   The firmware locates the payload via the linker symbol __flash_binary_end
#   (multirom.c: `rom = (const uint8_t *)&__flash_binary_end`), so a firmware of a
#   different size than the original still lines up automatically.
#
# The stock tool does the assembling; only the embedded firmware is swapped for
# our build. The tool's source refers to the symbol name xxd derives from the file
# path (___pico_multirom_build_multirom_bin), so `xxd -i -n` forces the same name
# and **the embedding needs no change to the tool at all**.
#
# One line of it is changed, and only one: the banner says "PicoDock MultiROM"
# rather than "MultiROM", because the firmware inside is not the stock one and
# the banner is the only place that shows before flashing. It is marked
# [PicoDock] in multirom.c.
# ---------------------------------------------------------------------------
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLSRC="$ROOT/src/multirom-tool"
NEXTOR_DIR="$ROOT/src/nextor"
STAGE="$ROOT/build/pdser-tool"

# FW=pdser (default) | multirom
#   Build both firmware images from the same ROM set for an A/B comparison.
#   Stock multirom never starts core1, which makes it the baseline for timing.
#     FW=multirom ./src/make_uf2.sh resources/msx-roms build/orig.uf2
FW="${FW:-pdser}"
case "$FW" in
  pdser)     FWBIN="$ROOT/build/pdser/picoverse_pdser.bin" ; DEFOUT="$ROOT/dist/cartridge/picodock_full.uf2" ;;
  multirom) FWBIN="$ROOT/build/multirom/multirom.bin"   ; DEFOUT="$ROOT/dist/cartridge/multirom_orig.uf2" ;;
  *)        echo "[-] FW must be pdser or multirom"; exit 1 ;;
esac

# FWBIN=<path> packages a firmware built somewhere else - a git worktree at an
# older commit, say. That is how a known-good baseline gets packaged with the
# current ROM set, which is the only way to tell "the new code is broken" apart
# from "flashing is broken" when a cartridge stops booting.
FWBIN="${FWBIN_OVERRIDE:-$FWBIN}"

# NEXTOR=off (default) | sunrise | mapper | both
#   Adds a Nextor entry to the menu, which is what boots the virtual disk (D4).
#     sunrise : "PicoDock Disk (Nextor)"             (mapper 10)
#     mapper  : "PicoDock Disk+192K Mapper"          (mapper 11)
#     both    : both entries in one image
#
# `both` is the useful one on a cartridge that moves between machines. A machine
# with its own memory mapper (OCM, MSX2+ and most MSX2 with 128K+) boots the
# first entry and keeps the printer. A machine without one - Sony HB-F1XD and
# every other 64K MSX2 - needs the second: Nextor loads NEXTOR.SYS only in
# DOS2 mode, DOS2 mode needs mapped RAM, and without it the kernel falls back to
# looking for MSX-DOS 1 files that are not on the disk. The symptom is a drop
# straight to BASIC, which looks like the cartridge failed and is not.
#
# The cost of the second entry is 128KB of flash (its own copy of the kernel
# ROM) and, while it is running, the printer: the mapper's page registers live
# at I/O FC-FF and PIO1 is already spoken for.
#   Without this the menu only lists ROMs and there is nothing to boot Nextor with.
NEXTOR="${NEXTOR:-off}"
case "$NEXTOR" in
  off)                  NEXTOR_FLAG="" ;;
  on|sunrise|mapper|both) NEXTOR_FLAG="-m" ;;
  *)                    echo "[-] NEXTOR must be off or on"; exit 1 ;;
esac

# MENU=auto (default) | built | orig
#   auto  : build it if sdcc is here, else fall back to orig and say so
#   built : build it, and fail if that is not possible
#   orig  : reference/menu.rom - PicoVerse's released binary, byte for byte
#
# The default used to be orig, which meant the shipped cartridge announced
# itself as "MultiROM": reference/menu.rom is upstream's binary, and our
# rebranding lives in the source. It also meant the boot screen's version could
# never track the VERSION file, since that number is compiled in. So the default
# now builds - and falls back rather than making sdcc a hard requirement for
# anyone who only wants a UF2.
MENU="${MENU:-auto}"
MENUSRC="$ROOT/src/picodock-menu"
case "$MENU" in
  auto)
    if command -v sdcc >/dev/null 2>&1; then
      MENU=built
    else
      MENU=orig
      echo "[!] sdcc not found - using PicoVerse's released menu ROM."
      echo "    The boot screen will say 'MultiROM', not 'PicoDock <version>'."
      echo "    Install sdcc (brew install sdcc) for the PicoDock menu."
    fi
    ;;
  built|orig) ;;
  *) echo "[-] MENU must be auto, built or orig"; exit 1 ;;
esac

if [ "$MENU" = built ]; then
  # Always remake: VERSION is compiled in, so a stale dist/menu.rom would ship
  # a version the rest of the build has already moved past.
  make -C "$MENUSRC" >/dev/null || { echo "[-] menu build failed"; exit 1; }
  MENUROM="$MENUSRC/dist/menu.rom"
else
  MENUROM="$MENUSRC/reference/menu.rom"
fi

ROMDIR="$1"
OUT="${2:-$DEFOUT}"
mkdir -p "$(dirname "$OUT")"

# The tool runs after cd'ing into the ROM folder, so the output path must be
# absolute (a relative path would drop the image inside the ROM folder)
case "$OUT" in
  /*) ;;
  *)  OUT="$(pwd)/$OUT" ;;
esac

if [ -z "$ROMDIR" ] || [ ! -d "$ROMDIR" ]; then
  echo "usage: $0 <rom-folder> [out.uf2]"
  echo "  *.ROM files in that folder are embedded in the image."
  exit 1
fi

if [ ! -f "$FWBIN" ]; then
  echo "[-] firmware not found: $FWBIN"
  echo "    Run ./src/build.sh $FW first."
  exit 1
fi

echo "[*] menu ROM ($MENU): $MENUROM"
echo "[*] Nextor entry: $NEXTOR"
echo "[*] firmware ($FW): $FWBIN ($(wc -c < "$FWBIN" | tr -d ' ') bytes)"

# --- Stage the tool source (leave the original tree untouched) --------------
rm -rf "$STAGE"
mkdir -p "$STAGE/src"
cp "$TOOLSRC/src/"*.c "$TOOLSRC/src/"*.h "$STAGE/src/" 2>/dev/null || true
# Drop the copied generated headers; they are regenerated below
rm -f "$STAGE/src/multirom.h" "$STAGE/src/menu.h" "$STAGE/src/nextor_sunrise.h"

# --- Generate headers, forcing the original symbol names (tool source stays put)
xxd -i -n ___pico_multirom_build_multirom_bin "$FWBIN" > "$STAGE/src/multirom.h"
xxd -i -n ___msx_dist_menu_rom "$MENUROM" > "$STAGE/src/menu.h"
# Nextor 2.1.4 SunriseIDE. The PicoDock build of it - the same kernel with
# CALL PDASK("...") added as the driver's DRV_BASSTAT (src/nextor-driver/) - is
# used when it has been built; otherwise the stock ROM, which gives a cartridge
# that is complete in every way except that CALL PDASK says Syntax error. Building
# it needs a toolchain most people will not have, and a disk that will not boot
# would be a poor way to tell them so.
#
# The -n symbol name is the same either way, so nothing in multirom.c changes.
NEXTOR_ROM="$NEXTOR_DIR/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM"
if [ -f "$NEXTOR_ROM" ]; then
  echo "[*] Nextor ROM: PicoDock 2.1.4 SunriseIDE (Master Only) - CALL PDASK included"
else
  NEXTOR_ROM="$NEXTOR_DIR/Nextor-2.1.4.SunriseIDE.MasterOnly.ROM"
  echo "[*] Nextor ROM: stock 2.1.4 SunriseIDE (Master Only) - no CALL PDASK"
  echo "    (build it with ./src/nextor-driver/build.sh)"
fi
[ -f "$NEXTOR_ROM" ] || { echo "[-] missing $NEXTOR_ROM"; exit 1; }
xxd -i -n ___nextor_kernel_Nextor_2_1_4_SunriseIDE_MasterOnly_ROM \
    "$NEXTOR_ROM" > "$STAGE/src/nextor_sunrise.h"

# xxd -n also names the length variable <name>_len; the tool only uses sizeof(), so
# that is harmless.
echo "[*] headers generated"

# --- Build the tool ---------------------------------------------------------
gcc -g -DAPP_VERSION=\"pdser\" "$STAGE/src/multirom.c" -o "$STAGE/multirom" \
    -Wno-unused-result 2>&1 | grep -vE "^$" || true
[ -x "$STAGE/multirom" ] || { echo "[-] tool build failed"; exit 1; }
echo "[*] tool built"

# --- Build the image (the tool scans *.ROM in the current directory) --------
ROMDIR_ABS="$(cd "$ROMDIR" && pwd)"
echo "[*] ROM folder: $ROMDIR_ABS"
( cd "$ROMDIR_ABS" && "$STAGE/multirom" $NEXTOR_FLAG -o "$OUT" )

echo "[+] $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "    Drag it onto the RPI-RP2 drive that appears in BOOTSEL mode."
echo "    NOTE: flash with a normal data cable - the VBUS-cut cable carries no power."
