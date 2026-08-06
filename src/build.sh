#!/bin/sh
# ---------------------------------------------------------------------------
# build.sh - firmware build helper
#
#   ./src/build.sh pdser        -> src/picoverse-picodock (integrated) -> build/pdser/picoverse_pdser.uf2
#   ./src/build.sh clean
#
# Output lands under build/ at the repo root (which is gitignored).
#
# The stock multirom firmware used to be a target here, as an A/B baseline. Its
# source is byte-identical to msx-picoverse-public, and FWBIN_OVERRIDE packages a
# firmware built from an older commit of *this* tree, which answers the more
# useful question when a cartridge stops booting.
# ---------------------------------------------------------------------------
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/src/env.sh"

[ -d "$PICO_SDK_PATH" ]       || { echo "[-] PICO_SDK_PATH not found: $PICO_SDK_PATH"; exit 1; }
[ -d "$PICO_TOOLCHAIN_PATH" ] || { echo "[-] PICO_TOOLCHAIN_PATH not found: $PICO_TOOLCHAIN_PATH"; exit 1; }

TARGET="${1:-pdser}"

case "$TARGET" in
  pdser)     SRC="$ROOT/src/picoverse-picodock" ;;
  clean)    rm -rf "$ROOT/build"; echo "[*] removed build/"; exit 0 ;;
  *)        echo "usage: $0 {pdser|clean}"; exit 1 ;;
esac

BUILD="$ROOT/build/$TARGET"
echo "[*] $TARGET  ($SRC)"
# Extra args after the target are forwarded to cmake configure, e.g.
#   ./src/build.sh pdser -DPD_P90_STATUS=ON
cmake -S "$SRC" -B "$BUILD" -G Ninja -DPICO_BOARD=pico "${@:2}" >/dev/null
cmake --build "$BUILD" -j

echo "[+] $(ls "$BUILD"/*.uf2)"

