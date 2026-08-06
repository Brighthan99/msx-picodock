#!/bin/sh
# ---------------------------------------------------------------------------
# run.sh - the checks that nothing has drifted out of step.
#
#   ./tests/run.sh
#
# These are not unit tests. They answer one question in several forms: are the
# copies of things still copies? This repository derives one folder from
# another in four places, and every one of them is a manual step someone can
# forget:
#
#   src/host/         -> dist/disk/tools/   ./src/stage_dist.sh
#   src/nextor/       -> dist/disk/system/  ./src/stage_dist.sh
#   src/msx-tools/    -> dist/disk/system/  ./src/msx-tools/build.sh
#   dist/disk/system/ -> picodock.img       ./dist/disk/make-disk.sh
#
# ...and VERSION is compiled into a binary and quoted in a document, which is
# two more copies that can fall behind.
#
# Forgetting one is silent and it has already happened: a crash fixed in
# src/host/pd_diskserver.py kept happening through dist/disk/serve.sh, because
# the staged copy was still the old file. Nothing said so. Now something does.
#
# Each check is a test_*.sh beside this file, and each is runnable on its own.
# Exit status is 0 if everything passed, 1 otherwise, so this works from a hook
# or from CI.
#
# The host tests (src/host/tests/run.sh) run at the end. Somebody typing
# "./tests/run.sh" means "check this repository", and an entry point that
# quietly skips half of it is worse than no entry point.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

fail=0
for t in "$HERE"/test_*.sh; do
  [ -f "$t" ] || continue
  name=$(basename "$t" .sh | sed 's/^test_//; s/_/ /g')
  echo "=== $name ==="
  if sh "$t"; then :; else fail=1; fi
  echo
done

if [ -x src/host/tests/run.sh ]; then
  echo "=== host tests ==="
  if ./src/host/tests/run.sh; then :; else fail=1; fi
  echo
fi

if [ "$fail" = 0 ]; then
  echo "[+] everything is in step"
else
  echo "[-] something is out of step - see above"
fi
exit "$fail"
