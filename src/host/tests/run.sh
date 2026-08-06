#!/bin/sh
# ---------------------------------------------------------------------------
# run.sh - the host tests
#
#   ./src/host/tests/run.sh
#
# Safe to run with the cartridge plugged in: every test that starts a server
# gives it a pseudo-terminal through --port, so find_port() is never called and
# there is nothing to take away from a live session. See pdtest.py.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"

fail=0
for t in "$HERE"/test_*.py "$HERE"/../printer/tests/test_*.py; do
  "$PY" "$t" || fail=1
  echo
done

if [ "$fail" = 0 ]; then
  echo "[+] all host tests passed"
else
  echo "[-] some host tests failed"
fi
exit "$fail"
