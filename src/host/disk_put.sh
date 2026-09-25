#!/bin/sh
# ---------------------------------------------------------------------------
# disk_put.sh - copy files into an MSX disk image.
#
#   ./src/host/disk_put.sh <image> <file-or-dir> [more...]
#
# A shim. The work is node/bin/disk_put.js, which writes FAT16 directly instead of
# mounting the image - see its header for why. This stays because make-disk.sh,
# sync-disk.sh, the docs and anything anyone has in a shell history all name it,
# and because a script that suddenly is not there is a worse answer than one
# that forwards.
#
# Windows has no .sh to forward from; disk_put.bat beside the staged copy
# (dist/disk/tools/) does the same for cmd.exe.
# ---------------------------------------------------------------------------
# The work is node/bin/disk_put.js since 2026-09-25 (it was disk_put.py, which stays in
# src/host/ as the reference the tests compare against). src/host/../../node and
# dist/disk/tools/../../node are both the Node code - the same two steps up.
command -v node >/dev/null 2>&1 || {
  echo "[-] Node.js is needed (18 or newer): https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/../../node/bin/disk_put.js" "$@"
