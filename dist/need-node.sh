# ---------------------------------------------------------------------------
# need-node.sh - find Node.js, and install the server's packages the first time.
#
#   DIST="$HERE/.."               # where dist/ is, from the calling script
#   . "$DIST/need-node.sh"        # sets NODE and NODEDIR, or exits saying why
#   NEED_PACKAGES=1 . "$DIST/need-node.sh"   # the server: also npm install once
#
# Sourced, not run: the scripts that use it need NODE and NODEDIR afterwards.
#
# Everything in dist/ runs on Node.js since 2026-09-25 - there is no Python to
# install any more. Most of it needs nothing beyond Node itself: making a disk,
# putting files on it and flashing the cartridge use only what Node ships with.
# Serving the disk needs one package, serialport, because talking to a USB
# serial port is not something Node does on its own. That (and the optional
# ones - Claude, Gemini, USB receipt printers) is fetched the first time
# serve.sh runs, into dist/node/node_modules/, and never again.
# ---------------------------------------------------------------------------
NODEDIR="$DIST/node"

if ! command -v node >/dev/null 2>&1; then
  echo "[-] Node.js was not found."
  echo "    Install version 18 or newer:"
  echo "      macOS         brew install node       (or the installer at nodejs.org)"
  echo "      Raspberry Pi  sudo apt install nodejs npm"
  echo "      anywhere      https://nodejs.org"
  exit 1
fi
NODE=node

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "[-] Node.js $(node -v) is too old - 18 or newer is needed."
  exit 1
fi

if [ ! -f "$NODEDIR/bin/pdserve.js" ]; then
  echo "[-] $NODEDIR is missing."
  echo "    dist/node/ is staged from node/ by ./src/stage_dist.sh - run that."
  exit 1
fi

if [ "${NEED_PACKAGES:-0}" = 1 ] && [ ! -d "$NODEDIR/node_modules/serialport" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "[-] npm was not found. It comes with Node.js; on Raspberry Pi OS it is"
    echo "    a separate package:  sudo apt install npm"
    exit 1
  fi
  echo "[*] first run: installing the server's packages into dist/node/ (once)"
  # ci, not install: exactly the versions in package-lock.json, and it never
  # writes that file - install would, and leave a tracked file changed on every
  # machine that ran this.
  ( cd "$NODEDIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ) || {
    echo "[-] npm ci failed - read what it said above. Running it again by hand:"
    echo "      cd dist/node && npm ci --omit=dev"
    exit 1; }
  echo
fi
