# node — everything that runs on the computer

The disk server, the disk tools, the printer tools, flashing and `PDASK`, in
Node.js 18 or newer. `dist/node/` is a copy of this folder made by
`src/stage_dist.sh`, and `dist/disk/serve.sh` is what most people run.

| Program | |
|---|---|
| `bin/pdserve.js` | serves a disk image to the cartridge, and the web screen at <http://127.0.0.1:8080/> — the disk, the printer, `PDASK`, the sound. Its options are listed at the top of the file |
| `bin/make_disk.js`, `bin/build_disk.js`, `bin/stage_user_files.js` | make a disk image, and put `dist/disk/user-files/` on it |
| `bin/disk_put.js` · `disk_rm.js` · `disk_mv.js` · `disk_mkdir.js` · `disk_text.js` · `disk_normalize.js` | change an image, also while the server is running |
| `bin/msx_printer_render.js` | draw a captured `.prn` again (dialect, glyphs, text) |
| `bin/msx_printer_spool.js` | look at the print spool, render jobs, merge them into one PDF |
| `bin/msx_printer_escpos.js` | send a job to a receipt printer (ESC/POS) or a real ESC/P printer |
| `bin/flash_uf2.js`, `bin/rp2_drive.js` | write a `.uf2` to a cartridge in BOOTSEL |
| `bin/pd_bootsel.js` | put a running cartridge into BOOTSEL over USB (1200 bps), without the button |
| `bin/pd_voice.js` | speech for `PDVOICE` |
| `bin/pd_ask.js`, `bin/ask_msx.js` | try `PDASK` without an MSX |
| `bin/linkcheck.js` | measure the USB link on its own |

Every file explains itself at the top — what it does, and why it does it that
way.

## Packages

`serialport` is the one the server needs to reach the cartridge; `serve.sh`
(or `setup.bat` on Windows) installs it on first run. The others are optional:
`usb` for receipt printers, and the Claude and Gemini SDKs for `PDASK`. An API
key for those is entered on the web screen and kept only in the server's
memory — never in a file, a log or the browser.

## Tests

```sh
cd node && npm ci && npm test
```

`npm test` ends with `crosschecks.js`, which compares these programs byte for
byte against the Python implementation they were ported from. That reference
is not part of this repository, so here it reports the cross-checks as
skipped.

## Licence

**GPL-2.0-only** — [LICENSE](LICENSE). The printer code carries logic from
openMSX and DOSBox-X, and the server loads it in-process, so the whole program
is GPL. [NOTICE.md](NOTICE.md) says what came from where, and
[LICENSES/](LICENSES/) holds the notices those ask to keep.
