#!/bin/sh
# ---------------------------------------------------------------------------
# disk_text.sh - read or edit a text file inside an MSX disk image.
#
#   ./src/host/disk_text.sh read  <image> <path> [--charset NAME]
#   ./src/host/disk_text.sh write <image> <path> [--charset NAME]  < new.txt
#
# A shim, for the same reason disk_put.sh is one. The work is node/bin/disk_text.js.
# ---------------------------------------------------------------------------
# The work is node/bin/disk_text.js since 2026-09-25 (it was disk_text.py, which stays in
# src/host/ as the reference the tests compare against). src/host/../../node and
# dist/disk/tools/../../node are both the Node code - the same two steps up.
command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/../../node/bin/disk_text.js" "$@"
