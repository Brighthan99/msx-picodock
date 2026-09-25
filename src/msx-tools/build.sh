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
#                                   dist/disk/system/PDVOICE.COM    (say it aloud)
#                                   dist/disk/system/PDMIDI.COM     (no MIDI: arm 0xE9)
#
# All eight together are one disk. make_disk.sh --bootable copies the lot, and
# disk_put.sh takes them for a disk you already have:
#
#   ./src/host/disk_put.sh picodock.img dist/disk/system/*
#
# Only the last six are built here. The Nextor boot files are staged from
# src/nextor/ by src/stage_dist.sh, which this calls first - before the
# sdcc check, so that someone without a toolchain still ends up with a complete
# dist/disk/system/ rather than the subset an assembler happens to produce.
#
# The .COM tools are assembled with sdasz80 + sdldz80 (they ship with sdcc, which
# is already needed for the menu ROM). A .COM is just the raw bytes loaded at
# 0x0100, so the link places _CODE there and the ihx is flattened
# (src/tools/ihx2rom.mjs --exact - Node, like everything else on the host side).
#
# Where make_pdsync.py is present, PDSYNC is also produced by it, which needs no
# assembler; both are built and compared, so a drift between the two is caught.
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
# PDVOICE says something out loud. The host synthesises, the cartridge holds the
# samples, and the MSX pours them into the PSG's volume registers - which is a
# DAC once the tone generators are out of the way. It needs psgvol_table.inc,
# generated from src/host/pd_voice.py by make_psgtable.py: the host sends an
# index and that file is what an index means. They are checked against each
# other by src/host/tests/test_psgtable.py, so regenerate rather than edit.
#
# PDMIDI is PDFRCPRN's counterpart for MSX-MIDI. Software like MIDRY /I5 reads
# the 8251 status at 0xE9 before it sends a byte; on a machine without MSX-MIDI
# (HB-F1XD) that floats to 0xFF and it reports "I/F not found". PDMIDI arms the
# cartridge to answer "ready", and only when it has read 0xFF there itself.
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
  node "$ROOT/src/tools/ihx2rom.mjs" "$1" "$2" --start 0x100 --exact
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
build_com pdvoice  PDVOICE.COM
build_com pdmidi   PDMIDI.COM

# Cross-check PDSYNC against the assembler-free builder, where there is one.
# make_pdsync.py is Python and stays in the development tree; the published
# tree needs no Python and builds without it.
if [ -f "$HERE/make_pdsync.py" ] && command -v python3 >/dev/null 2>&1; then
  REF="$BUILD/pdsync-ref.com"
  python3 "$HERE/make_pdsync.py" "$REF" >/dev/null
  if cmp -s "$OUTDIR/PDSYNC.COM" "$REF"; then
    echo "[*] PDSYNC.COM matches make_pdsync.py"
  else
    echo "[!] MISMATCH between pdsync.s and make_pdsync.py"
    echo "    one was edited without the other - compare and fix before shipping"
    exit 1
  fi
fi
