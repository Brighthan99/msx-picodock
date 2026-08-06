#!/bin/sh
# ---------------------------------------------------------------------------
# stage_dist.sh - fill dist/ with everything that needs no toolchain
#
#   ./src/stage_dist.sh
#
# The goal is that someone using a PicoDock never has to look outside dist/.
# They flash dist/cartridge/, they make a disk out of dist/disk/, and that is
# the whole product. src/ is where it comes from, not where they work.
#
# Two things get staged:
#
#   dist/disk/system/   NEXTOR.SYS, COMMAND2.COM   <- src/nextor/
#   dist/disk/tools/    the host-side programs     <- src/host/
#
# Neither is compiled, which is why this is separate from build.sh and why
# msx-tools/build.sh calls it before its own sdcc check: someone with no
# toolchain at all should still end up with a complete dist/.
#
# **dist/disk/tools/ is generated. Do not edit it.**
#
# It is a copy of src/host/, and this script overwrites it every run, so an edit
# made there is lost at the next stage. That is the deliberate trade: a copy can
# be shipped and run from one place, a symlink cannot survive a zip download,
# and re-deriving it every time is what stops the two from drifting apart. Fix
# things in src/host/ and re-run this.
#
# Self-referential paths in the copies are rewritten (./src/host/foo.sh ->
# ./dist/disk/tools/foo.sh) so that a usage line printed by the staged copy names
# the staged copy. Tests are not staged - they are for developing this, not for
# using it.
# ---------------------------------------------------------------------------
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."                           # the repository root; paths below are
                                        # relative to it, so nothing printed
                                        # here names somebody's home directory

# --check stages into a scratch directory and reports what would differ, so a
# test can ask "is dist/ current?" without the answer being a second copy of the
# rules below. A duplicated rule is the thing that goes stale first.
CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "")      ;;
  *)       echo "usage: $0 [--check]"; exit 1 ;;
esac

NEXTOR="src/nextor"
SRCTOOLS="src/host"
if [ "$CHECK" = 1 ]; then
  SCRATCH="$(mktemp -d)"
  trap 'rm -rf "$SCRATCH"' EXIT
  SYSDIR="$SCRATCH/system"
  TOOLS="$SCRATCH/tools"
else
  SYSDIR="dist/disk/system"
  TOOLS="dist/disk/tools"
fi

# --- boot files ------------------------------------------------------------
# Nextor's own, stock distribution bytes. src/nextor/README.md has the
# provenance. Copied rather than referenced so dist/disk/ is self-contained.
mkdir -p "$SYSDIR"
for f in NEXTOR.SYS COMMAND2.COM; do
  if [ -f "$NEXTOR/$f" ]; then
    cp "$NEXTOR/$f" "$SYSDIR/$f"
    [ "$CHECK" = 1 ] || echo "[+] $SYSDIR/$f  $(wc -c < "$SYSDIR/$f" | tr -d ' ') bytes"
  else
    echo "[!] src/nextor/$f is missing - a disk made without it will not boot"
  fi
done

# --- host tools ------------------------------------------------------------
# Wiped first: a file deleted from src/host/ has to disappear here too, or the
# staged copy slowly accumulates things the source no longer has.
rm -rf "$TOOLS"
mkdir -p "$TOOLS"

copied=0
for f in "$SRCTOOLS"/*.py "$SRCTOOLS"/*.sh; do
  [ -f "$f" ] || continue
  cp "$f" "$TOOLS/"
  copied=$((copied + 1))
done

# printer/ comes too - pd_diskserver imports it, and printing is half the point
# of the cartridge. LICENSE and NOTICE.md come with it and are not optional:
# this code is GPL-2.0-only, ported from openMSX and DOSBox-X, so a copy that
# ships without its notice is a copy that should not ship. Its tests stay
# behind - fixtures and golden images are several MB and mean nothing to
# someone using the thing.
mkdir -p "$TOOLS/printer"
for f in "$SRCTOOLS"/printer/*.py "$SRCTOOLS"/printer/LICENSE "$SRCTOOLS"/printer/NOTICE.md; do
  [ -f "$f" ] || continue
  cp "$f" "$TOOLS/printer/"
  copied=$((copied + 1))
done

chmod +x "$TOOLS"/*.sh "$TOOLS"/*.py 2>/dev/null || true

# Rewrite the paths the copies print about themselves. Without this, running
# dist/disk/tools/make_disk.sh prints "next: ./src/host/pd_diskserver.py" and
# sends the reader back to the folder we just told them to ignore.
find "$TOOLS" -type f \( -name '*.py' -o -name '*.sh' -o -name '*.md' \) \
  -exec sed -i '' 's|\./src/host/|./dist/disk/tools/|g' {} +

# Only two .md files end up staged - the README written below, and printer's
# NOTICE.md, which links to upstream projects by URL. Neither carries a relative
# path that could break at this depth, which is why the developer documents
# (src/host/README.md, printer/PRINTING.md) are deliberately not copied: their
# links resolve from src/host/ and point at tests/ that do not ship.

# The folder's own README is written, not copied. src/host/README.md is a
# developer document about how these work internally, and its relative links
# resolve from src/host/, not from three levels down.
cat > "$TOOLS/README.md" <<'EOF'
# dist/disk/tools — generated, do not edit

Copies of `src/host/`, remade by `src/stage_dist.sh` on every build. **An edit
here is lost at the next one.** Fix `src/host/` and re-run the script.

They are copied rather than referenced so that `dist/` is the whole product:
someone using a PicoDock should never have to open `src/`.

## What you run

Usually not these. `../serve.sh` and `../make-disk.sh` wrap them with the
answers most people want, and `serve.sh` builds the disk itself the first time
it runs, so there is nothing to prepare.

    ./dist/disk/tools/pd_diskserver.py picodock.img --tui
    ./dist/disk/tools/make_disk.sh 128m picodock.img MSXDISK --bootable
    ./dist/disk/tools/disk_put.sh picodock.img ~/msx/*.rom
    ./dist/disk/tools/disk_rm.sh  picodock.img OLD.ROM

Run `PDSYNC` on the MSX after adding or removing files, or Nextor keeps showing
the directory it cached.

Needs Python 3. `--tui` and PNG/PDF output want `pyserial` and `Pillow`; the
server says so if they are missing rather than failing later.

## Licence

`printer/` is **GPL-2.0-only** - it ports ESC/P handling from openMSX and
DOSBox-X. See `printer/LICENSE` and `printer/NOTICE.md`, which travel with it.
The rest is under the repository's own terms.

## Where the real documentation is

Start at [`../../README.md`](../../README.md) - that is `dist/README.md`, which
explains the whole product in one page. The guides are in `docs/` at the
repository root, and `src/host/README.md` covers how these programs work inside.
EOF

if [ "$CHECK" = 1 ]; then
  # Compare only what this script owns. dist/disk/system/ also holds the two
  # .COM tools, which msx-tools/build.sh produces - they are not ours to judge.
  stale=0
  for f in NEXTOR.SYS COMMAND2.COM; do
    [ -f "$SYSDIR/$f" ] || continue
    if ! cmp -s "$SYSDIR/$f" "dist/disk/system/$f"; then
      echo "[~] stale: dist/disk/system/$f"
      stale=$((stale + 1))
    fi
  done
  # diff -r catches all three ways it can be wrong at once: changed, missing
  # here, and left behind after the source file was deleted.
    # __pycache__ is excluded: running the tests makes one in here - they
    # import the staged tools, which is what staging them is for - and it would
    # then report dist/ as behind src/ for the rest of the day. It is already
    # gitignored; a check that fails on what nobody can commit is just noise.
  if ! diff -r -q -x __pycache__ "$TOOLS" dist/disk/tools >/tmp/stage_check.$$ 2>&1; then
    sed "s|$TOOLS|<freshly staged>|; s|^|[~] |" /tmp/stage_check.$$
    stale=$((stale + $(wc -l < /tmp/stage_check.$$)))
  fi
  rm -f /tmp/stage_check.$$
  if [ "$stale" = 0 ]; then
    echo "[+] dist/ is current with src/"
    exit 0
  fi
  echo
  echo "[-] dist/ is $stale file(s) behind src/ - run ./src/stage_dist.sh"
  exit 1
fi

echo "[+] $TOOLS  ($copied files, from src/host/)"
echo
echo "    dist/ is now complete. Nothing below needs a toolchain:"
echo "      ./dist/disk/make-disk.sh          # if there is no picodock.img yet"
echo "      ./dist/disk/serve.sh"
