# src/host — short names for the disk tools

The host side is [`../../node/`](../../node/README.md). What is here are shell
shims with the names people type — each one runs the Node program of the same
name in `node/bin/`:

| Shim | Runs | |
|---|---|---|
| [`make_disk.sh`](make_disk.sh) | `node/bin/make_disk.js` | create an MSX virtual disk image |
| [`disk_put.sh`](disk_put.sh) | `node/bin/disk_put.js` | put files into an image |
| [`disk_rm.sh`](disk_rm.sh) | `node/bin/disk_rm.js` | delete files from an image |
| [`disk_mv.sh`](disk_mv.sh) | `node/bin/disk_mv.js` | rename or move files |
| [`disk_mkdir.sh`](disk_mkdir.sh) | `node/bin/disk_mkdir.js` | make a folder |
| [`disk_text.sh`](disk_text.sh) | `node/bin/disk_text.js` | read or write a text file inside an image |
| [`disk_normalize.sh`](disk_normalize.sh) | `node/bin/disk_normalize.js` | force names to upper-case 8.3 |

All of them work while the server is running: they ask it to step aside, do
their work and hand the image back. Run `PDSYNC` on the MSX afterwards.

`src/stage_dist.sh` copies these to `dist/disk/tools/` and writes a `.bat` twin
for each, for Windows.

**GPL-2.0-only**, like the programs they start — [LICENSE](LICENSE).
