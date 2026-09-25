# node/ — licence and third-party notices

Everything in this directory — the server, the disk tools, the printer tools,
flashing, PDASK and the web screen — is **GPL-2.0-only** ([LICENSE](LICENSE)).

## Why GPL, when the firmware is CC BY-NC-SA

The printer code here is ported from the project's earlier Python printer
package, which was GPL-2.0-only because it carries ESC/P interpretation logic
and glyph tables from openMSX and DOSBox-X. The server loads that code in its own process, and the web screen
loads `escp.js`, `kanji.js` and `hangul.js` into the same page as the rest of
the interface. That makes one combined program, and a combined program with GPL
code in it has to be GPL as a whole — the NonCommercial term of CC BY-NC-SA is
an "additional restriction" the GPL does not allow.

So since v1.23.1 the whole host program is GPL-2.0-only. Its own code was
written for this project and is not derived from MSX PicoVerse, so its author
could choose. **The cartridge firmware is unchanged**: it is derived from MSX
PicoVerse and stays CC BY-NC-SA 4.0. The two are separate programs that talk
over USB; neither contains the other's code. The protocol they share (frame
layout and command numbers, `src/protocol.js` here and `pd_protocol_ids.h` in
the firmware) is an interface, not an implementation.

**GPL-2.0-only, not 2-or-later**, because openMSX is. The openMSX files the
printer logic comes from (`src/Printer.cc`, `src/MSXCharacterSets.cc`) carry no
licence header; the project README says the rest is under "the GNU Public
License (GPL), of which you can find a copy in the file 'GPL.txt'", and that
file is the version 2 text with no "or any later version". Debian, Fedora and
openSUSE all read that as GPL-2.0-only. DOSBox-X states 2-or-later in its file
headers, so version 2 is the one licence both allow. The practical
consequence: GPL-3-only, LGPL-3 and Apache-2.0 material must not be copied into
this directory.

The glyph tables are bitmap fonts openMSX extracted from MSX BIOS ROMs and the
Epson FX-80 character ROM. Under US law bitmap typeface data is not
copyrightable as a typeface (37 CFR 202.1(e)); the GPL notice above covers the
file that carries them as a work.

The GPL permits commercial use; the cartridge firmware's licence still does not.

## Components

### openMSX and DOSBox-X — the printer

| Here | From | Licence |
|---|---|---|
| `src/escp.js` (ESC/P interpreter) | DOSBox-X `src/hardware/parport/printer.cpp`, cross-checked against openMSX `src/Printer.cc` (`ImagePrinterEpson`) | GPL-2.0-or-later / GPL-2.0-only |
| `src/escp-fonts.js` (glyph and national-substitution tables; generated) | openMSX `src/MSXCharacterSets.cc`, `src/Printer.cc` | GPL-2.0-only |
| `src/kanji.js`, `src/hangul.js`, `src/printer_detect.js`, `src/printer_text.js`, `src/printrender.js`, `src/escpos.js`, `bin/msx_printer_*.js` | ported from the project's earlier Python printer package (`msx_printer_*.py`, same author) | GPL-2.0-only |

- openMSX: https://github.com/openMSX/openMSX
- DOSBox-X: https://github.com/joncampbell123/dosbox-x

### msx-picoprinter — the same author

The 1:1 bit-image layout (`nativeBitmap` in `src/escp.js`) and the ESC/POS
stream (`src/escpos.js`) match `pp_escp.c` and `printer/escpos/escpos.c` in
msx-picoprinter at source level. Those files are the author's own work in that
repository (published there under CC BY-NC-SA 4.0, not derived from MSX
PicoVerse); the author licenses the logic taken from them here under
GPL-2.0-only.

### Pillow — resampling, dithering, rotation

`src/imageops.js` translates three routines from Pillow's C source
(`src/libImaging/Resample.c` LANCZOS, `Convert.c` Floyd–Steinberg to bilevel,
`Geometry.c` ROTATE_90) so that receipts come out byte-identical to what the
earlier Python tools sent.

**MIT-CMU** — full text in [LICENSES/Pillow.MIT-CMU.txt](LICENSES/Pillow.MIT-CMU.txt).
Copyright © 1997-2011 by Secret Labs AB, © 1995-2011 by Fredrik Lundh and
contributors, © 2010 by Jeffrey 'Alex' Clark and contributors.
https://github.com/python-pillow/Pillow

### CPython — text wrapping, HTML entities, CJK codecs

| Here | From |
|---|---|
| `src/askshape.js` `twWrap` | `Lib/textwrap.py` — `_split_chunks`, `_wrap_chunks`, `_handle_long_word`, translated to JavaScript |
| `src/search.js` `unescapeHtml` | `Lib/html/__init__.py` `unescape()`, translated |
| `src/textdata.js` `INVALID_CHARREFS`, `INVALID_CODEPOINTS` (generated) | `Lib/html/__init__.py` |
| `src/codecs-data.js` (generated) | the `shift_jis` and `cp949` mappings of CPython's CJK codecs, read out of CPython by a generator script |

**PSF License Agreement, version 2** — full text in
[LICENSES/Python-PSF-2.0.txt](LICENSES/Python-PSF-2.0.txt).
Copyright © 2001 Python Software Foundation; All Rights Reserved.

Summary of changes, as that licence asks: the Python was translated to
JavaScript; `textwrap` is reduced to the one configuration PDASK uses
(`break_long_words=True`, `break_on_hyphens=False`), keeping Python's
code-point lengths rather than JavaScript's UTF-16 ones; `unescape` is reduced
to the function itself; the codec tables are data extracted from the codecs,
not their code.
https://github.com/python/cpython

### Unicode Character Database — combining marks

`src/textdata.js` `COMBINING` is the list of code-point ranges with a
non-zero canonical combining class, extracted from Python's `unicodedata`
(Unicode 15.1.0) by a generator script. It is used to strip accents
before a PDASK answer is sent to a 7-bit MSX.

**Unicode License v3** — full text in [LICENSES/Unicode-3.0.txt](LICENSES/Unicode-3.0.txt).
Copyright © 1991-2026 Unicode, Inc.

### WHATWG HTML — named character references

`src/textdata.js` `HTML5` is the table of named character references
(`&amp;`, `&eacute;` …) as Python's `html.entities.html5` carries it, from the
HTML Living Standard. © WHATWG (Apple, Google, Mozilla, Microsoft), licensed
under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).
https://html.spec.whatwg.org/multipage/named-characters.html

### Written here, with nothing taken

`src/ttf.js` (TrueType reading and rasterising), `src/png.js`,
`src/pdfwrite.js`, `src/ws.js` (WebSocket server), `web/psg-worklet.js` (the
AY-3-8910 synthesiser) and the rest are this project's own. `src/pdfwrite.js`
names the PDF standard font Courier without embedding it.

## npm packages — installed on your machine, not shipped

`package.json` lists four **optional** dependencies. None of them is in this
repository or in `dist/`: `serve.sh` installs them into `node_modules/` on the
machine that runs it (`npm ci`), and the server works without the ones a user
does not need.

| Package | Licence | Used for |
|---|---|---|
| `serialport` | MIT | the USB link to the cartridge |
| `usb` | MIT | sending to a receipt printer |
| `@anthropic-ai/sdk` | MIT | `--ask claude` |
| `@google/genai` | Apache-2.0 | `--ask gemini` |

Their own dependencies are MIT, BSD-3-Clause, Apache-2.0 and Unlicense;
`npm ls --all` and each package's `package.json` in `node_modules/` have the
detail.

**`@google/genai` is Apache-2.0, which the FSF regards as incompatible with
GPL version 2.** It is not distributed with this program — it is fetched by
the user, from npm, onto their own machine, and loaded only when they choose
`--ask gemini` — and the GPL's conditions apply to distribution, not to
running. Anyone who wants to *distribute* a build that bundles `node_modules/`
should leave `@google/genai` out of that bundle.

## Fonts and ROMs are not here

The kanji ROM, MSX ROMs and TrueType fonts the printer can use live in
`resources/` in the source tree, which is not in the repository. A kanji ROM
dump is copyrighted and is never redistributed; fonts (DotGothic16,
NeoDunggeunmo, Galmuri11, Noto Sans JP) are OFL-licensed and are put there by
the user.
