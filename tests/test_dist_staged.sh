#!/bin/sh
# dist/disk/tools/ and the two boot files in dist/disk/system/ are copies of
# src/. This asks stage_dist.sh itself whether they are current, rather than
# re-implementing its copy rules here - a second copy of the rules is the part
# that goes stale first, and then the test agrees with nothing.
set -e
cd "$(dirname "$0")/.."
exec ./src/stage_dist.sh --check
