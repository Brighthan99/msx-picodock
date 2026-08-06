# printer/ — licence notice

This directory (`src/host/printer/`) is distributed under **GPL-2.0-only**
(`LICENSE`). Why v2 and not v3 is argued below.

Its licence is **deliberately different from the rest of the repository**, which
is CC BY-NC-SA 4.0. The printer package carries logic and font data taken from
GPL reference implementations, so this subpackage alone is copyleft.

**Do not copy code out of this package into the rest of the tree** — in
particular not into the CC BY-NC-SA firmware. Invoking it as a separate process
or standalone tool, which is how the server uses it, is fine.

## Provenance

| Component | Origin | Original licence |
|---|---|---|
| `msx_printer_escp_render.py` ESC/P interpretation | [DOSBox-X](https://github.com/joncampbell123/dosbox-x) `src/hardware/parport/printer.cpp` (the file header states "or (at your option) any later version") | **GPL-2.0-or-later** |
| 〃 | Cross-checked against [openMSX](https://github.com/openMSX/openMSX) `src/Printer.cc` (`ImagePrinterEpson`) and reimplemented in Python | **GPL-2.0-only** |
| `msx_printer_fonts.py` glyph tables | Extracted from openMSX `src/MSXCharacterSets.cc` (MSX International, DIN, Japanese) and `src/Printer.cc` (`EpsonFontRom`). **A generated file — do not hand-edit** | **GPL-2.0-only** |
| National character substitution tables (`_INTL`) | openMSX `ImagePrinterEpson` | **GPL-2.0-only** |
| Every other `msx_printer_*.py` | Written for this project | Distributed as GPL-2.0-only |

## Why v2, not v3

**openMSX is GPL-2.0-only.** An earlier revision of this package recorded it as
"GPL-2.0-or-later" and therefore labelled the package GPL-3.0-or-later. That was
an unverified assumption and, since GPL-2-only code is **incompatible** with v3,
the label was a violation. It has been corrected. The evidence:

- The openMSX files we took from (`src/Printer.cc`, `src/MSXCharacterSets.cc`)
  **carry no licence header**. Neither do `main.cc`, `openmsx.hh`,
  `MSXMotherBoard.cc` or `Paper.cc`, which were checked as a sample.
- The project `README` says only: *"Some source files contain a license notice;
  all other source files are licensed under the GNU Public License (GPL), of
  which you can find a copy in the file 'GPL.txt'"*. That `doc/GPL.txt` is the
  **text of GPL version 2**, with no "or any later version" declaration.
- Third-party assessments differ, but the strict ones say v2-only:
  **Debian**'s `debian/copyright` (which passes ftpmaster legal review) says
  `License: GPL-2` + *"…as published by the Free Software Foundation, **version
  2**."*; **Fedora 41+** and **openSUSE** also say `GPL-2.0-only`. (nixpkgs,
  Solus and Homebrew record `GPL-2.0-or-later`, with no cited basis; we treat
  that as a misclassification.)
- The disagreement comes from GPL-2 §9: if no version is specified the recipient
  may choose any. But openMSX says "see GPL.txt" and points at a copy of v2,
  which the conservative reading — Debian's, Fedora's, openSUSE's — takes as
  specifying the version.

DOSBox-X states or-later in its file headers, so using it under v2 is fine.
**GPL-2.0-only is therefore the intersection that is safe under every reading**
(even if openMSX really were or-later, distributing under v2 remains lawful).
What is given up is v3's patent clause and compatibility with Apache-2.0 and
**CC BY-SA 4.0** — the latter because Creative Commons declared BY-SA 4.0
one-way compatible with GPL **v3** only. If a CC BY-SA font is ever wanted here,
openMSX would have to be asked to confirm or-later first.

> ⚠️ **This is not reversible.** LGPL-3 is absorbed only into GPL-3 and is
> **incompatible with GPL-2**. An earlier version of this package combined
> openMSX logic (GPL-2-only) with EPHEX font data (LGPL-3), which never actually
> held together; removing EPHEX fixed it, for reasons other than the ones
> intended at the time. **Never bring LGPL-3 or GPL-3-only material into this
> directory.**

Before that removal, [EPHEX-80](https://github.com/MurphyMc/EPHEX-80) (LGPL-3.0)
was vendored for its `ephex_charset.py`. Compared against the openMSX tables it
turned out to be the same FX-80 ROM extraction — **247 of 256 characters
byte-identical** — and openMSX additionally provides three MSX character ROMs,
which fits the "MSX first" principle better. So the project standardised on
openMSX and dropped the EPHEX vendoring entirely. The licence benefit was a
consequence, not the goal.

## About the font data

openMSX extracted the MSX fonts from BIOS ROMs (International: Philips NMS8250;
Japanese: Sony HB-F1XV) and the Epson set from an FX-80 character generator ROM.
Under US law **bitmap typeface data is not copyrightable as a typeface**
(37 CFR 202.1(e)); the Copyright Office treats a bitmap font as "nothing more
than an electronic depiction of a particular typeface" and refuses registration
— in contrast to outline formats such as TrueType, which are protected as
programs. That is the basis on which EPHEX, openMSX and blueMSX have circulated
this data without an Epson licence. The GPL notice above governs
`msx_printer_fonts.py` **as a file**, which is a separate question.

## The limits of this isolation

Changing or removing the fonts would **not** take this package out of copyleft.
It is GPL because the **interpretation logic** was ported from DOSBox-X and
openMSX; the fonts are secondary. Making it permissive would mean rewriting the
whole interpreter clean-room from Epson's official documentation — and giving up
the 72-command parity that was established against those two references.

## Verification material, no code taken

Used only to check behaviour: an openMSX printer-logger capture
(`tests/escp_boxx.prn`), and a cross-reading of the blueMSX sources.
