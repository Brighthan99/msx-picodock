#!/bin/sh
# ---------------------------------------------------------------------------
# build.sh - assemble dist/disk/system/, everything a bootable disk carries
#
#   ./src/msx-tools/build.sh     -> dist/disk/system/NEXTOR.SYS     (boot)
#                                   dist/disk/system/COMMAND2.COM   (boot)
#                                   dist/disk/system/PDSYNC.COM     (cache flush)
#                                   dist/disk/system/PDFRCPRN.COM   (OCM: arm 0x90)
#                                   dist/disk/system/PDASK.COM      (ask the host)
#                                   dist/disk/system/PDINFO.COM     (tell the host)
#
# All six together are one disk. make_disk.sh --bootable copies the lot, and
# disk_put.sh takes them for a disk you already have:
#
#   ./src/host/disk_put.sh picodock.img dist/disk/system/*
#
# Only the last four are built here. The Nextor boot files are staged from
# src/nextor/ by src/stage_dist.sh, which this calls first - before the
# sdcc check, so that someone without a toolchain still ends up with a complete
# dist/disk/system/ rather than the subset an assembler happens to produce.
#
# The .COM tools are assembled with sdasz80 + sdldz80 (they ship with sdcc, which
# is already needed for the menu ROM). A .COM is just the raw bytes loaded at
# 0x0100, so the link places _CODE there and the ihx is flattened.
#
# PDSYNC is additionally produced by make_pdsync.py, which needs no assembler;
# both are built and compared, so a drift between the two is caught.
#
# Printing needs no tool here any more. The MSX prints through its own printer
# port (0x90/0x91) and the cartridge captures it, so LPRINT and COPY ... PRN work
# as they always did. On an OCM, run PDFRCPRN once first: nothing there drives
# 0x90, so it floats to "busy forever" and printing would hang until the
# cartridge is told to answer. PDFRCPRN refuses on anything that is not an OCM.
#
# PDASK is CALL PDASK without the ROM: it asks the host a question over the
# mailbox and prints the answer. The ROM handler speaks the same protocol, so
# this is also how to tell a broken ROM from a broken host - see pdask.s.
#
# PDINFO goes the other way: it tells the host what this MSX is, which the host
# has no way of finding out for itself. Run by hand, on the same mailbox.
#
# The private 0xF5/0xF6 path that needed PDPRINT.COM and PDHOOK.BAS is in
# archive/ - see archive/README.md.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/dist/disk/system}"
BUILD="$ROOT/build/msx-tools"

mkdir -p "$OUTDIR"

# The parts that need no toolchain: Nextor's boot files and the host tools.
# Done first so a missing sdcc still leaves dist/ usable.
"$ROOT/src/stage_dist.sh"
echo

command -v sdasz80 >/dev/null 2>&1 || { echo "[-] sdasz80 missing (brew install sdcc)"; exit 1; }
command -v sdldz80 >/dev/null 2>&1 || { echo "[-] sdldz80 missing (brew install sdcc)"; exit 1; }

mkdir -p "$BUILD"

# ihx -> raw .COM (origin 0x0100, no padding: MSX-DOS loads it as-is)
flatten() {
  python3 - "$1" "$2" <<'PY'
import sys
mem = {}
for line in open(sys.argv[1], encoding="ascii"):
    line = line.strip()
    if not line.startswith(":"):
        continue
    raw = bytes.fromhex(line[1:])
    if (sum(raw) & 0xFF) != 0:
        sys.exit(f"[-] checksum error in {sys.argv[1]}")
    count, addr, rectype = raw[0], (raw[1] << 8) | raw[2], raw[3]
    if rectype == 0x01:
        break
    if rectype != 0x00:
        sys.exit(f"[-] unexpected record type {rectype:02X}")
    for i, b in enumerate(raw[4:4 + count]):
        mem[addr + i] = b

lo, hi = min(mem), max(mem)
if lo != 0x0100:
    sys.exit(f"[-] code starts at 0x{lo:04X}, expected 0x0100")
out = bytes(mem.get(a, 0) for a in range(lo, hi + 1))
open(sys.argv[2], "wb").write(out)
print(f"[+] {sys.argv[2]}  {len(out)} bytes  (0x{lo:04X}-0x{hi:04X})")
PY
}

build_com() {                           # build_com <name> <OUTNAME.COM>
  sdasz80 -l -o "$BUILD/$1.rel" "$HERE/$1.s"
  sdldz80 -n -i -b _CODE=0x100 "$BUILD/$1.ihx" "$BUILD/$1.rel"
  flatten "$BUILD/$1.ihx" "$OUTDIR/$2"
}

build_com pdsync   PDSYNC.COM
build_com pdfrcprn PDFRCPRN.COM
build_com pdask    PDASK.COM
build_com pdinfo   PDINFO.COM

# Cross-check PDSYNC against the assembler-free builder
REF="$BUILD/pdsync-ref.com"
python3 "$HERE/make_pdsync.py" "$REF" >/dev/null
if cmp -s "$OUTDIR/PDSYNC.COM" "$REF"; then
  echo "[*] PDSYNC.COM matches make_pdsync.py"
else
  echo "[!] MISMATCH between pdsync.s and make_pdsync.py"
  echo "    one was edited without the other - compare and fix before shipping"
  exit 1
fi
