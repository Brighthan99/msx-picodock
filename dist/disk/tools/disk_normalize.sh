#!/bin/sh
# ---------------------------------------------------------------------------
# disk_normalize.sh - make an image read the same on the Mac and on the MSX.
#
#   ./dist/disk/tools/disk_normalize.sh <image>
#
# A shim, for the same reason disk_put.sh is one. The work is node/bin/disk_normalize.js.
# ---------------------------------------------------------------------------
# The work is node/bin/disk_normalize.js since 2026-09-25 (it was disk_normalize.py, which stays in
# src/host/ as the reference the tests compare against). src/host/../../node and
# dist/disk/tools/../../node are both the Node code - the same two steps up.
command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/../../node/bin/disk_normalize.js" "$@"
