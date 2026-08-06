#!/bin/sh
# ---------------------------------------------------------------------------
# disk_rm.sh - remove files or folders from an MSX disk image.
#
#   ./dist/disk/tools/disk_rm.sh <image> <name> [more...]
#   ./dist/disk/tools/disk_rm.sh <image>                  # no names: list the disk
#
# A shim, for the same reason disk_put.sh is one. The work is disk_rm.py.
# ---------------------------------------------------------------------------
exec python3 "$(dirname "$0")/disk_rm.py" "$@"
