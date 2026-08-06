#!/bin/sh
# ---------------------------------------------------------------------------
# build.sh - the PicoDock Nextor ROM: stock Nextor 2.1.4 SunriseIDE, with
#            CALL PDASK("...") added as the driver's DRV_BASSTAT.
#
#   ./src/nextor-driver/build.sh [out.rom]
#       default: src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM
#
# What it produces differs from the stock ROM in bank 7 (the driver) and
# nowhere else - the kernel is byte-identical, and the script refuses to
# finish if that ever stops being true. An unmodified driver reproduces the
# stock ROM exactly, so any difference is our change and nothing else.
#
# Toolchain, once, into ~/.msx-nextor-build/tools/:
#
#   N80 (Nestor80)  Nextor 2.1 is built with this, not the old M80.
#                   https://github.com/Konamiman/Nestor80/releases -> tools/n80/
#   mknexrom        cc -O2 -o tools/mknexrom <(curl -sSL \
#                     https://raw.githubusercontent.com/Konamiman/Nextor/v2.1/buildtools/sources/mknexrom.c)
#
# make_uf2.sh picks the result up automatically when it is there, and falls
# back to the stock ROM when it is not - so a tree without this toolchain
# still builds a working cartridge, just without CALL PDASK.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TC="${MSX_NEXTOR_TOOLS:-$HOME/.msx-nextor-build/tools}"
N80="$TC/n80/N80"
MK="$TC/mknexrom"
STOCK="$ROOT/src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.ROM"
OUT="${1:-$ROOT/src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM}"
B="$HERE/build"
mkdir -p "$B"

[ -x "$N80" ] || { echo "[-] N80 not found at $N80 - see the header"; exit 1; }
[ -x "$MK" ]  || { echo "[-] mknexrom not found at $MK - see the header"; exit 1; }
[ -f "$STOCK" ] || { echo "[-] stock ROM not found: $STOCK"; exit 1; }

# 1) the stock driver source (Nextor v2.1) and its bank-switch helper
SRC="https://raw.githubusercontent.com/Konamiman/Nextor/v2.1/source/kernel/drivers/SunriseIDE"
for f in sunride.asm chgbnk.mac; do
  [ -f "$B/$f" ] || curl -sSL "$SRC/$f" -o "$B/$f"
done

# 2) our one change: DRV_BASSTAT, which is a `scf`/`ret` stub upstream
cp "$B/sunride.asm" "$B/sunride.patched.asm"
patch -p0 --quiet "$B/sunride.patched.asm" < "$HERE/picodock-drv_basstat.patch" \
  || { patch -p0 "$B/sunride.patched.asm" < "$HERE/picodock-drv_basstat.patch"; }

# 3) kernel base = the stock ROM minus the driver bank (bank count lives at 0xFE)
python3 - "$STOCK" "$B/nextor_base.dat" <<'PY'
import sys
d = open(sys.argv[1], 'rb').read()
open(sys.argv[2], 'wb').write(d[:d[0xFE] * 16384])
PY

# 4) assemble and combine (MASTER_ONLY, not BAD_POPS - matches the 2.1.4 release)
"$N80" "$B/sunride.patched.asm" "$B/driver.bin" --build-type abs \
       --output-file-extension bin --define-symbols MASTER_ONLY >/dev/null
"$N80" "$B/chgbnk.mac" "$B/chgbnk.bin" --build-type abs \
       --output-file-extension bin >/dev/null
# mknexrom takes DOS-style /x: options, so a Unix absolute path (leading /) is
# read as one. Run it from $B with relative names and move the result after.
( cd "$B" && "$MK" nextor_base.dat _out.rom /d:driver.bin /m:chgbnk.bin ) | grep -i success
mkdir -p "$(dirname "$OUT")"
mv "$B/_out.rom" "$OUT"

# 5) the kernel must be untouched, and our handler must actually be in there
python3 - "$OUT" "$STOCK" <<'PY'
import sys
a = open(sys.argv[1], 'rb').read()
b = open(sys.argv[2], 'rb').read()
banks = {i // 16384 for i in range(min(len(a), len(b))) if a[i] != b[i]}
assert banks <= {7}, "kernel changed! banks %s" % sorted(banks)
assert b"PDASK: no host" in a, "the CALL PDASK handler is missing"
assert bytes([0x3A, 0x08, 0x7F]) in a, "the mailbox read is missing"
print("[+] %s  (%d bytes; only bank 7 differs; kernel intact)" % (sys.argv[1], len(a)))
PY
