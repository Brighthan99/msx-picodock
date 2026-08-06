#!/bin/sh
# ---------------------------------------------------------------------------
# make_tool.sh - build the standalone UF2 maker, firmware and all, for people
#                who have no build environment.
#
#   ./src/make_tool.sh                 # host platform
#   ./src/make_tool.sh macos           # universal (x86_64 + arm64)
#   ./src/make_tool.sh linux-x64       # needs zig or a cross gcc; see below
#
# What this produces
# ------------------
# One executable with the firmware, the menu ROM and the Nextor kernel already
# inside it. Someone who wants a cartridge does not need the Pico SDK, the ARM
# toolchain, cmake or sdcc - they put .ROM files in a folder, run this, and get
# a UF2. That is how MSX PicoVerse ships its own tool, and it is the reason to
# prefer this over publishing a prebuilt UF2: **a UF2 is fixed, this is not.**
# The user's own ROMs go in, which no image we could build for them ever could.
#
# The embedding is the same trick make_uf2.sh uses - xxd turns each binary into
# a C array and the tool source is left untouched - except the result is kept
# instead of thrown away with the staging directory.
#
# Cross-building
# --------------
# There is no portable way to make a Linux binary from macOS with the base
# system. `brew install zig` gives you one that works well:
#
#     zig cc -target x86_64-linux-gnu   ...
#     zig cc -target aarch64-linux-gnu  ...
#
# This script uses zig when it is present and says so when it is not, rather
# than emitting something silently wrong. CI is the other answer, and the more
# maintainable one for platforms nobody here can test on.
# ---------------------------------------------------------------------------
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLSRC="$ROOT/src/multirom-tool"
NEXTOR_DIR="$ROOT/src/nextor"
MENUSRC="$ROOT/src/picodock-menu"
STAGE="$ROOT/build/tool-dist"
OUTDIR="$ROOT/dist/cartridge"

TARGET="${1:-host}"
FWBIN="$ROOT/build/pdser/picoverse_pdser.bin"

[ -f "$FWBIN" ] || { echo "[-] firmware not built: $FWBIN"; echo "    run ./src/build.sh pdser first"; exit 1; }

# The menu ROM, on the same terms as make_uf2.sh: build it when sdcc is here so
# the version string is current, fall back to PicoVerse's released binary if not.
if command -v sdcc >/dev/null 2>&1; then
  make -C "$MENUSRC" >/dev/null || { echo "[-] menu build failed"; exit 1; }
  MENUROM="$MENUSRC/dist/menu.rom"
  echo "[*] menu ROM: built"
else
  MENUROM="$MENUSRC/reference/menu.rom"
  echo "[!] sdcc not found - embedding PicoVerse's released menu ROM."
  echo "    The boot screen will say 'MultiROM', not 'PicoDock <version>'."
fi

rm -rf "$STAGE"; mkdir -p "$STAGE/src" "$OUTDIR"
cp "$TOOLSRC/src/"*.c "$TOOLSRC/src/"*.h "$STAGE/src/" 2>/dev/null || true
rm -f "$STAGE/src/multirom.h" "$STAGE/src/menu.h" "$STAGE/src/nextor_sunrise.h"

xxd -i -n ___pico_multirom_build_multirom_bin "$FWBIN"   > "$STAGE/src/multirom.h"
xxd -i -n ___msx_dist_menu_rom                "$MENUROM" > "$STAGE/src/menu.h"
# Same rule as make_uf2.sh: the PicoDock kernel (CALL PDASK as the driver's
# DRV_BASSTAT) when it has been built, the stock one when it has not. This tool
# is the path for people with no build environment, so whichever ends up here is
# what most cartridges will carry.
NEXTOR_ROM="$NEXTOR_DIR/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM"
[ -f "$NEXTOR_ROM" ] || NEXTOR_ROM="$NEXTOR_DIR/Nextor-2.1.4.SunriseIDE.MasterOnly.ROM"
echo "[*] Nextor ROM: $(basename "$NEXTOR_ROM")"
xxd -i -n ___nextor_kernel_Nextor_2_1_4_SunriseIDE_MasterOnly_ROM \
    "$NEXTOR_ROM" > "$STAGE/src/nextor_sunrise.h"

VER="v$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0-unknown)"
CFLAGS="-O2 -DAPP_VERSION=\"$VER\" -Wno-unused-result"

build() {                               # build <outname> <compiler+flags...>
  out="$OUTDIR/$1"; shift
  if "$@" $CFLAGS "$STAGE/src/multirom.c" -o "$out" 2>&1 | grep -vE "^$"; then :; fi
  [ -x "$out" ] || { echo "[-] failed: $out"; return 1; }
  echo "[+] $out"
  file -b "$out" | sed 's/^/    /'
}

case "$TARGET" in
  host)
    build "picodock-uf2" cc
    ;;
  macos)
    [ "$(uname -s)" = Darwin ] || { echo "[-] macos target needs macOS"; exit 1; }
    build "picodock-uf2-macos" cc -arch x86_64 -arch arm64
    ;;
  linux-x64|linux-arm64|linux-armhf|windows-x64)
    # A Raspberry Pi is two of these, not one: 64-bit Pi OS reports aarch64 and
    # wants linux-arm64, while 32-bit Pi OS - still what ships on a Zero, a 1, a
    # 2 - reports armv6l or armv7l and wants linux-armhf. Building only arm64
    # covers the newer boards and leaves the older ones with "no prebuilt tool"
    # for a reason nobody would guess.
    case "$TARGET" in
      linux-x64)   ZTGT=x86_64-linux-gnu    ; OUTNAME=picodock-uf2-linux-x64 ;;
      linux-arm64) ZTGT=aarch64-linux-gnu   ; OUTNAME=picodock-uf2-linux-arm64 ;;
      linux-armhf) ZTGT=arm-linux-gnueabihf ; OUTNAME=picodock-uf2-linux-armhf ;;
      windows-x64) ZTGT=x86_64-windows-gnu  ; OUTNAME=picodock-uf2-windows-x64.exe ;;
    esac
    command -v zig >/dev/null 2>&1 || {
      echo "[-] no cross compiler for $TARGET."
      echo "    brew install zig      (then re-run; zig cc targets $ZTGT)"
      echo "    or build it on that machine / in CI."
      exit 1; }
    # -Wl,-s: these are shipped binaries, not something anyone debugs. Unstripped
    # they carry DWARF for a file nobody has - the armhf build was 1.2 MB of
    # which most was debug info. The Windows link also drops a .pdb beside the
    # .exe for the same reason; it is removed below.
    build "$OUTNAME" zig cc -target "$ZTGT" -Wl,-s
    rm -f "$OUTDIR/${OUTNAME%.exe}.pdb"
    ;;
  all)
    # Everything this machine can produce. macOS needs macOS; the rest need zig.
    # Keeps going after one fails, so a missing zig reports once per target
    # instead of stopping the run - the point of "all" is to see the whole set.
    rc=0
    [ "$(uname -s)" = Darwin ] && { "$0" macos || rc=1; }
    for t in linux-x64 linux-arm64 linux-armhf windows-x64; do
      "$0" "$t" || rc=1
    done
    exit "$rc"
    ;;
  *)
    echo "usage: $0 {host|macos|linux-x64|linux-arm64|linux-armhf|windows-x64|all}"
    exit 1 ;;
esac

echo
echo "    Ships with the firmware inside. Normally you do not run it directly -"
echo "      ./dist/cartridge/make-uf2.sh          (make-uf2.bat on Windows)"
echo "    picks the build for the machine and passes the flag below. By hand:"
echo "      cd <folder of .ROM files> && $OUTDIR/picodock-uf2* -m -o picodock.uf2"
echo "    -m is the Nextor disk entry with its 192KB mapper. Without it the menu"
echo "    cannot boot the disk; without the mapper a 64KB MSX2 cannot boot Nextor."
