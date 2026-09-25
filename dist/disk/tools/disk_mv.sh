#!/bin/sh
# ---------------------------------------------------------------------------
# disk_mv.sh - rename a file or folder on an MSX disk image.
#
#   ./dist/disk/tools/disk_mv.sh <image> <path> <new-name>
#   ./dist/disk/tools/disk_mv.sh picodock.img GAMES/OLD.ROM NEW.ROM
#
# A shim, for the same reason disk_put.sh is one. The work is node/bin/disk_mv.js.
# ---------------------------------------------------------------------------
# The work is node/bin/disk_mv.js since 2026-09-25 (it was disk_mv.py, which stays in
# src/host/ as the reference the tests compare against). src/host/../../node and
# dist/disk/tools/../../node are both the Node code - the same two steps up.
command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/../../node/bin/disk_mv.js" "$@"
