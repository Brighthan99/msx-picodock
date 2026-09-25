#!/bin/sh
# ---------------------------------------------------------------------------
# test_line_endings.sh - .bat files are CR LF, .sh files are LF.
#
# Each is wrong in the other's ending, and neither says so when it is:
#   * cmd.exe finds `goto` labels by reading 512-byte blocks with CR LF
#     assumed. In an LF-only .bat a label near a block boundary is missed, or
#     execution resumes in the wrong place - depending on the bytes.
#   * A CR in a .sh is part of the last word on each line: `then\r` is not
#     `then`, and the script fails with a syntax error.
# The files are written on a Mac, where every editor defaults to LF, so the
# .bat side is the one that drifts. .gitattributes keeps git from converting;
# this catches an editor that did.
# ---------------------------------------------------------------------------
cd "$(dirname "$0")/.."
CR=$(printf '\r')
bad=0

for f in $(git ls-files '*.bat'); do
  lines=$(tr -cd '\n' < "$f" | wc -c | tr -d ' ')
  crlf=$(grep -c "${CR}\$" "$f")
  if [ "$lines" -eq 0 ] || [ "$lines" -ne "$crlf" ]; then
    echo "  FAIL $f: $((lines - crlf)) of $lines lines end in a bare LF"
    bad=$((bad + 1))
  fi
done

for f in $(git ls-files '*.sh'); do
  if grep -q "$CR" "$f"; then
    echo "  FAIL $f: has CR - a .sh must be LF only"
    bad=$((bad + 1))
  fi
done

if [ "$bad" -eq 0 ]; then
  echo "  OK   $(git ls-files '*.bat' | wc -l | tr -d ' ') .bat files CR LF, $(git ls-files '*.sh' | wc -l | tr -d ' ') .sh files LF"
  echo "  all passed"
fi
exit "$bad"
