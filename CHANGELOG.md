# Changelog

Semantic versioning. The number lives in [`VERSION`](VERSION) and moves with
every change that ships — the server prints it on start-up and the web screen
carries it in its header, which is the point: a bug report that says "v0.70.0" is
answerable, one that says "the build I made some time in July" is not.

## 1.24.1

The first update since the initial commit, so it covers a lot. The version
numbers in between were used by the development tree and never published here.

**The computer side is Node.js, and there is no Python any more.**
- Everything that runs on the computer is `node/` — the disk server, the disk
  tools, the printer tools, flashing and `PDASK`. `dist/node/` is a staged copy,
  and `dist/disk/tools/*.sh` / `.bat` are short names that run it. Node.js 18 or
  newer is the only thing to install; the first `serve.sh` fetches `serialport`.
- The terminal split-screen is gone. `serve.sh` opens a screen in the browser at
  <http://127.0.0.1:8080/> (this computer only): the disk, the printer, `PDASK`,
  the sound. `--no-web` turns it off.
- Windows: `setup.bat` checks for Node.js and installs the one package;
  `dist/WINDOWS.md` is a step-by-step guide, MIDI included. `.bat` files are
  CR LF (`.gitattributes`, `tests/test_line_endings.sh`).
- Building needs no Python either: the menu ROM and `.COM` helpers are
  `src/tools/*.mjs`, byte-identical in output to the scripts they replace.

**Licence.** The host programs — `node/`, and the shims in `src/host/` — are
GPL-2.0-only as a whole, because the printer code in them carries openMSX and
DOSBox-X logic. The cartridge firmware stays CC BY-NC-SA 4.0. See `NOTICE.md`.

**Cartridge**
- The disk entry carries its own 192 KB memory mapper, so a 64 KB MSX2 (Sony
  HB-F1XD) boots the disk; one entry for every machine.
- The cartridge is a USB MIDI device: **MIDI-PAC** turns the PSG into notes,
  and **MSX-MIDI** software (`MIDRY /I5`) writing to port 0xE8 is passed through.
- On an MSX without MSX-MIDI, `PDMIDI` has the cartridge answer the 8251 status
  port 0xE9 with "ready to send", pulling `/BUSDIR` while it answers so the
  machine's slot buffer lets the byte through. It is off at boot and armed only
  after `PDMIDI` has read nothing at 0xE9 (and nothing at 0xE1, where an
  unmoved MSX-MIDI cartridge sits). Tested on a Sony HB-F1XD.
- `node/bin/pd_bootsel.js` puts a running cartridge into BOOTSEL over USB
  (1200 bps), without pressing the button.

**MSX-DOS tools**: `PDVOICE` (the MSX speaks through its PSG) and `PDMIDI` are
new, beside `PDSYNC`, `PDFRCPRN`, `PDASK` and `PDINFO`.

**Host**
- `PDASK` can also be answered by Claude or Gemini. The API key is entered on
  the web screen and kept only in the server's memory — never written to disk.
- The PSG plays in the browser as the MSX plays it.
- Printing: receipt printers (ESC/POS) and real ESC/P printers as outputs, the
  spool merged into one PDF, Japanese (with the machine's own kanji ROM when
  given one) and Korean text.

## 0.70.0

Initial commit.
