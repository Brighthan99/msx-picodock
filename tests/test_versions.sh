#!/bin/sh
# VERSION is compiled into things, and the whole point of it is that a bug
# report can name one. A binary or a document quoting a number the repository
# has moved past is worse than no number at all.
set -e
cd "$(dirname "$0")/.."

V=$(cat VERSION 2>/dev/null || echo "")
[ -n "$V" ] || { echo "  FAIL no VERSION file"; exit 1; }
echo "  --   VERSION is $V"

fail=0

for tool in dist/cartridge/picodock-uf2-*; do
  [ -f "$tool" ] || continue
  if grep -q "v$V" "$tool" 2>/dev/null; then
    printf '  OK   %s carries v%s\n' "$(basename "$tool")" "$V"
  else
    printf '  FAIL %s was built from another VERSION\n' "$(basename "$tool")"
    echo "       ./src/make_tool.sh macos   (or the target you need)"
    fail=1
  fi
done

# The shipped cartridge. The boot menu compiles the version in and the menu is
# assembled into this file, so bumping VERSION leaves it stale - and nothing
# above catches that, because the tool that builds it was itself rebuilt. This
# went unnoticed once: the tools said v0.70.0 while the image people actually
# flash still announced v0.69.0 on the MSX.
for img in dist/cartridge/picodock.org.uf2; do
  [ -f "$img" ] || continue
  if strings -a "$img" 2>/dev/null | grep -q "v$V"; then
    printf '  OK   %s carries v%s\n' "$(basename "$img")" "$V"
  else
    printf '  FAIL %s was built from another VERSION\n' "$(basename "$img")"
    echo "       ./src/build_diskprint.sh"
    fail=1
  fi
done

# Documents that quote the banner. Only the ones that print a version, not
# every mention of the word. The two patterns are the two banners: the UF2 tool
# on the computer, and the cartridge menu on the MSX.
check_doc() {
  [ -f "$1" ] || return 0
  quoted=$(grep -o "$2 v[0-9][0-9.]*" "$1" | head -1 | sed "s/^$2 v//")
  [ -n "$quoted" ] || return 0
  if [ "$quoted" = "$V" ]; then
    printf '  OK   %s quotes v%s\n' "$1" "$V"
  else
    printf '  FAIL %s quotes v%s, VERSION says %s\n' "$1" "$quoted" "$V"
    fail=1
  fi
}

check_doc dist/cartridge/README.md "Creator"
check_doc docs/building.md "PicoDock"

[ "$fail" = 0 ] && echo "  all passed"
exit "$fail"
