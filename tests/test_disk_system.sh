#!/bin/sh
# The MSX-side tools in dist/disk/system/ come out of an assembler, so they
# cannot be compared against a source file. What can be checked is that they are
# there at all, and that PDSYNC still matches the assembler-free builder - the
# cross-check msx-tools/build.sh does, repeated here so a stale committed .COM
# is caught even when nobody has run the build.
set -e
cd "$(dirname "$0")/.."

fail=0
for f in NEXTOR.SYS COMMAND2.COM PDSYNC.COM PDFRCPRN.COM; do
  if [ -f "dist/disk/system/$f" ]; then
    printf '  OK   %s\n' "$f"
  else
    printf '  FAIL %s is missing - a disk made from this will not boot\n' "$f"
    fail=1
  fi
done

if [ -f dist/disk/system/PDSYNC.COM ]; then
  ref="$(mktemp)"
  trap 'rm -f "$ref"' EXIT
  if python3 src/msx-tools/make_pdsync.py "$ref" >/dev/null 2>&1; then
    if cmp -s dist/disk/system/PDSYNC.COM "$ref"; then
      echo "  OK   PDSYNC.COM matches make_pdsync.py"
    else
      echo "  FAIL PDSYNC.COM differs from make_pdsync.py"
      echo "       pdsync.s and make_pdsync.py were edited apart, or the"
      echo "       committed .COM predates one of them. ./src/msx-tools/build.sh"
      fail=1
    fi
  else
    echo "  --   make_pdsync.py did not run; cross-check skipped"
  fi
fi

[ "$fail" = 0 ] && echo "  all passed"
exit "$fail"
