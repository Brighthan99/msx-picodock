#!/bin/sh
# ---------------------------------------------------------------------------
# disk_mkdir.sh - make a folder on an MSX disk image.
#
#   ./dist/disk/tools/disk_mkdir.sh <image> <path>
#   ./dist/disk/tools/disk_mkdir.sh picodock.img GAMES/KONAMI
#
# A shim, for the same reason disk_put.sh is one. The work is node/bin/disk_mkdir.js.
# ---------------------------------------------------------------------------
# The work is node/bin/disk_mkdir.js since 2026-09-25 (it was disk_mkdir.py, which stays in
# src/host/ as the reference the tests compare against). src/host/../../node and
# dist/disk/tools/../../node are both the Node code - the same two steps up.
command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/../../node/bin/disk_mkdir.js" "$@"
