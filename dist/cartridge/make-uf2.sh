#!/bin/sh
# ---------------------------------------------------------------------------
# make-uf2.sh - turn a folder of ROMs into a flashable cartridge image.
#
#   ./dist/cartridge/make-uf2.sh                    # uses dist/cartridge/roms/
#   ./dist/cartridge/make-uf2.sh ~/msx/konami       # or any other folder
#   ./dist/cartridge/make-uf2.sh ~/msx/konami out.uf2
#
# This is the no-build-environment path. It runs the picodock-uf2-* binary that
# sits beside it, which has the firmware, the menu ROM and the Nextor kernel
# compiled in, so nothing here needs the Pico SDK, an ARM toolchain, cmake or
# sdcc.
#
# The ROM folder may be empty. You get a cartridge whose menu holds just the
# Nextor disk entry, which is a perfectly good one - software on the *virtual
# disk* can be changed without reflashing.
#
# Two images live here and the names say which is which:
#
#   picodock.org.uf2   what this project ships - the Nextor disk entry and
#                      nothing else. In the repository, and left alone.
#   picodock.uf2       what this script writes, with your ROMs in it. Yours,
#                      and not in the repository.
#
# So running this as often as you like never costs you the original: flash
# picodock.org.uf2 to get back to a plain cartridge.
#
# If you want to change the firmware itself rather than the ROM list, this is
# the wrong script: build from source with ../../src/build_diskprint.sh.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="$PWD"

ROMDIR="${1:-roms}"
OUT="${2:-picodock.uf2}"
# Resolve anything the user typed against the directory they typed it in, then
# work from this script's own directory. Every path printed below is then short
# and means the same thing on any machine that unpacks this - we have no idea
# what the absolute ones would be.
case "$ROMDIR" in /*) ;; *) [ -n "${1:-}" ] && ROMDIR="$FROM/$ROMDIR" ;; esac
case "$OUT"    in /*) ;; *) [ -n "${2:-}" ] && OUT="$FROM/$OUT" ;; esac
cd "$HERE"

# Pick the binary for this machine.
#
# A Raspberry Pi is two answers, not one. 64-bit Pi OS says aarch64; 32-bit Pi
# OS - what a Zero, a 1 or a 2 still runs - says armv6l or armv7l, and both want
# the armhf build. Mapping only aarch64 leaves those boards reporting "no
# prebuilt tool" for a reason nobody would think to check.
case "$(uname -s)" in
  Darwin)
    TOOL="$HERE/picodock-uf2-macos" ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) ARCH=x64 ;;
      aarch64|arm64) ARCH=arm64 ;;
      armv6l|armv7l|armv8l|armhf) ARCH=armhf ;;
      *) ARCH="$(uname -m)" ;;
    esac
    TOOL="$HERE/picodock-uf2-linux-$ARCH" ;;
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash / MSYS2 on Windows. The .exe is the same one make-uf2.bat runs.
    TOOL="$HERE/picodock-uf2-windows-x64.exe" ;;
  *)
    TOOL="" ;;
esac

if [ -z "$TOOL" ] || [ ! -x "$TOOL" ]; then
  echo "[-] no prebuilt tool for $(uname -s) $(uname -m)."
  echo "    Available:"
  ls picodock-uf2-* 2>/dev/null | sed 's|^|      |' || echo "      (none)"
  echo "    Build one:   ../../src/make_tool.sh host"
  echo "    Cross-build:  ../../src/make_tool.sh all   (needs zig)"
  echo "    Or build the image from source:   ../../src/build_diskprint.sh"
  exit 1
fi

# The default folder is not in the repository - it holds ROMs, and those are
# rarely ours to publish - so a fresh clone does not have one. Make it rather
# than refusing: an empty roms/ is a perfectly good build (the plain cartridge),
# and "no such folder" would be a dead end for the exact command the README
# tells people to run first. A folder named on the command line is different:
# if that one is missing it is a typo, and inventing it would hide the typo.
if [ -z "${1:-}" ] && [ ! -d "$ROMDIR" ]; then
  mkdir -p "$ROMDIR"
  echo "[*] made $ROMDIR - put .rom files there to have them in the menu"
fi
[ -d "$ROMDIR" ] || { echo "[-] no such folder: $ROMDIR"; exit 1; }

# The tool scans its working directory, so the run below goes to the ROM folder
# and hands it a full path - a relative one would drop the image among the ROMs.
# The name kept for the messages is the short one; the long one never appears.
OUTNAME="$OUT"
case "$OUT" in
  /*) ;;
  *)  OUT="$(pwd)/$OUT" ;;
esac

n=$(find "$ROMDIR" -maxdepth 1 -iname '*.rom' 2>/dev/null | wc -l | tr -d ' ')
echo "[*] ROMs:  $ROMDIR  ($n found)"
[ "$n" = 0 ] && echo "    none - the image will hold just the Nextor disk entry, which is fine."
echo "[*] tool:  $(basename "$TOOL")"
echo

# -s and -m are the two Nextor disk entries; without them the menu lists ROMs and
# has no way to boot the virtual disk, which is the mistake this script exists to
# prevent. Two, because whether the machine has a memory mapper decides which one
# works - see ../README.md. Picking at the menu costs nothing; finding out that a
# cartridge does not boot on your MSX2 costs an evening.
( cd "$ROMDIR" && "$TOOL" -m -o "$OUT" )

echo
echo "[+] $OUTNAME"
echo "    Take the cartridge out of the MSX, hold BOOTSEL, plug it in with a"
echo "    NORMAL data cable (a VBUS-blocking one carries no power), and drop"
echo "    this file on the RPI-RP2 drive that appears."
