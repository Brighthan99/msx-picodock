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
  NODEOUT="$SCRATCH/node"
  LICOUT="$SCRATCH/licences"
else
  SYSDIR="dist/disk/system"
  TOOLS="dist/disk/tools"
  NODEOUT="dist/node"
  LICOUT="dist"
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

# --- host programs: Node.js -------------------------------------------------
# Since 2026-09-25 everything a user runs on the computer side is Node.js - the
# server, the disk tools, the printer tools, flashing. node/ is copied whole
# minus what only a developer needs (tests, the table generators, installed
# packages). The packages are fetched on the user's machine the first time
# serve.sh runs (dist/need-node.sh): serialport carries per-platform binaries,
# and a copy made on this Mac would be the wrong ones on a Pi.
#
# Wiped first, like tools/ below: a file deleted from node/ has to disappear
# here too. All but node_modules/: that is what serve.sh installed on this
# machine, and wiping it would make the next serve.sh fetch it all again.
mkdir -p "$NODEOUT"
find "$NODEOUT" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
copied=0
# LICENSES/ with them: node/ is GPL-2.0-only as a whole, and the notices for
# what it took from Pillow, CPython and Unicode have to go wherever it goes.
for d in bin src web LICENSES; do
  cp -R "node/$d" "$NODEOUT/$d"
  copied=$((copied + $(find "node/$d" -type f | wc -l)))
done
cp node/package.json node/package-lock.json node/LICENSE node/NOTICE.md "$NODEOUT/"
printf 'node_modules/\n' > "$NODEOUT/.gitignore"
cat > "$NODEOUT/README.md" <<'README'
# dist/node — generated, do not edit

A copy of `node/`, remade by `src/stage_dist.sh` on every build. **An edit here
is lost at the next one.** Fix `node/` and re-run the script.

This is every program the computer side runs: the disk server (`bin/pdserve.js`,
started by `../disk/serve.sh`), the disk tools, the printer tools and flashing.
It needs Node.js 18 or newer and nothing else. The one package the server needs
to reach the cartridge, `serialport`, is installed into `node_modules/` here
the first time `../disk/serve.sh` runs. The optional ones come with it: the
Claude and Gemini SDKs for PDASK, and `usb` for receipt printers.

## Licence

**GPL-2.0-only**, all of it - `LICENSE`. The printer code carries logic from
openMSX and DOSBox-X and the server loads it in-process, so the whole program
is GPL. `NOTICE.md` says what came from where (openMSX, DOSBox-X, Pillow,
CPython, Unicode, WHATWG) and `LICENSES/` holds the notices those ask to keep.
The cartridge firmware is a separate program under CC BY-NC-SA 4.0 - see
`../NOTICE.md`.
README

# --- licences for the binaries -------------------------------------------------
# dist/ is the whole product, so the licence and the notices travel with it:
# the project licence (CC BY-NC-SA 4.0, for the firmware and everything else
# outside node/) and the texts the UF2 binaries have to carry for the Pico SDK
# (BSD-3-Clause) and TinyUSB (MIT). dist/NOTICE.md is written by hand - it
# describes dist/'s own paths - and is not staged.
mkdir -p "$LICOUT/LICENSES"
cp LICENSE "$LICOUT/LICENSE"
rm -f "$LICOUT"/LICENSES/*
cp LICENSES/* "$LICOUT/LICENSES/"
copied=$((copied + 1 + $(ls LICENSES | wc -l)))

# --- host tools: the shell names people type ---------------------------------
# Wiped first: a file deleted from src/host/ has to disappear here too, or the
# staged copy slowly accumulates things the source no longer has.
rm -rf "$TOOLS"
mkdir -p "$TOOLS"

# Only the .sh wrappers. They forward to ../../node/bin/, which is dist/node/
# from here. The Python beside them in src/host/ stays behind: it is the
# reference the cross-check tests compare the Node tools against, and nobody
# using a PicoDock needs it.
for f in "$SRCTOOLS"/*.sh; do
  [ -f "$f" ] || continue
  cp "$f" "$TOOLS/"
  copied=$((copied + 1))
done
chmod +x "$TOOLS"/*.sh 2>/dev/null || true

# And the same names for cmd.exe, which cannot run a .sh.
for t in disk_put disk_rm disk_mv disk_mkdir disk_text disk_normalize make_disk; do
  # printf, not echo: /bin/sh's echo reads the backslashes in ..\node\bin as
  # escapes and writes a newline and a backspace into the path. CR LF, like
  # every .bat here - see .gitattributes.
  printf '%s\r\n' '@echo off' \
    "rem $t.bat - the Windows half of $t.sh. Generated by src/stage_dist.sh." \
    'where node >nul 2>&1 || (echo [-] Node.js is needed ^(18 or newer^): https://nodejs.org & exit /b 1)' \
    "node \"%~dp0..\\..\\node\\bin\\$t.js\" %*" > "$TOOLS/$t.bat"
  copied=$((copied + 1))
done

# Rewrite the paths the copies print about themselves. Without this, running
# dist/disk/tools/make_disk.sh prints "./src/host/..." and sends the reader back
# to the folder we just told them to ignore.
find "$TOOLS" -type f -name '*.sh' -exec sed -i '' 's|\./src/host/|./dist/disk/tools/|g' {} +

cat > "$TOOLS/README.md" <<'README'
# dist/disk/tools — generated, do not edit

Remade by `src/stage_dist.sh` on every build. **An edit here is lost at the
next one.** Fix `src/host/` and re-run the script.

## What you run

Usually not these. `../serve.sh` and `../make-disk.sh` wrap them with the
answers most people want, and `serve.sh` builds the disk itself the first time
it runs, so there is nothing to prepare.

    ./dist/disk/tools/make_disk.sh 128m picodock.img MSXDISK --bootable
    ./dist/disk/tools/disk_put.sh picodock.img ~/msx/*.rom
    ./dist/disk/tools/disk_rm.sh  picodock.img OLD.ROM
    ./dist/disk/tools/disk_mv.sh  picodock.img OLD.ROM NEW.ROM

On Windows the same names end in `.bat`. They are shims: the programs are in
`../../node/bin/` (that is `dist/node/bin/`) and need Node.js 18 or newer.

Run `PDSYNC` on the MSX after adding or removing files, or Nextor keeps showing
the directory it cached.

## Where the real documentation is

Start at [`../../README.md`](../../README.md) - that is `dist/README.md`, which
explains the whole product in one page. The guides are in `docs/` at the
repository root.

## Licence

GPL-2.0-only, like `src/host/` they are copied from and the `node/` programs
they start - the text is in `../../node/LICENSE`.
README

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
  for f in LICENSE LICENSES; do
    if ! diff -r -q "$LICOUT/$f" "dist/$f" >/tmp/stage_check.$$ 2>&1; then
      sed "s|$LICOUT|<freshly staged>|; s|^|[~] |" /tmp/stage_check.$$
      stale=$((stale + $(wc -l < /tmp/stage_check.$$)))
    fi
  done
  # node_modules/ is the user's machine's, not ours - installed there on first run.
  if ! diff -r -q -x node_modules "$NODEOUT" dist/node >/tmp/stage_check.$$ 2>&1; then
    sed "s|$NODEOUT|<freshly staged>|; s|^|[~] |" /tmp/stage_check.$$
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

echo "[+] $NODEOUT and $TOOLS  ($copied files, from node/ and src/host/)"
echo
echo "    dist/ is now complete. Nothing below needs a toolchain:"
echo "      ./dist/disk/make-disk.sh          # if there is no picodock.img yet"
echo "      ./dist/disk/serve.sh"
