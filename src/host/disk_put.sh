#!/bin/sh
# ---------------------------------------------------------------------------
# disk_put.sh - copy files into an MSX disk image.
#
#   ./src/host/disk_put.sh <image> <file-or-dir> [more...]
#
# A shim. The work is disk_put.py, which writes FAT16 directly instead of
# mounting the image - see its header for why. This stays because make-disk.sh,
# sync-disk.sh, the docs and anything anyone has in a shell history all name it,
# and because a script that suddenly is not there is a worse answer than one
# that forwards.
#
# Windows has no .sh to forward from, so it calls disk_put.py itself.
# ---------------------------------------------------------------------------
exec python3 "$(dirname "$0")/disk_put.py" "$@"
