# Third-party notices

PicoDock is a derivative work. This file records what came from where, under
what licence, and which parts of this repository are governed by something other
than the project licence.

## Project licence

Everything in this repository is **CC BY-NC-SA 4.0** ([LICENSE](LICENSE)) —
Attribution, NonCommercial, ShareAlike — **except** `src/host/printer/`, which is
**GPL-2.0-only** (see below).

CC BY-NC-SA is not a choice so much as an inheritance: the firmware is derived
from MSX PicoVerse, which is published under that licence, and ShareAlike
requires derivatives to use it too. **Commercial use is not permitted.**

## The two licences, and the wall between them

| Path | Licence | Why |
|---|---|---|
| everything else | CC BY-NC-SA 4.0 | derived from MSX PicoVerse |
| `src/host/printer/` | GPL-2.0-only | ports ESC/P logic from openMSX and DOSBox-X |

**Do not copy code from `src/host/printer/` into the rest of the tree.** GPL-2.0
and CC BY-NC-SA are not compatible in a combined work — the NC restriction is an
additional restriction the GPL forbids. Calling the printer package as a
separate process or as a standalone tool, which is how the server uses it, is
fine; that is why it is a separate package with its own `LICENSE` and
[`NOTICE.md`](src/host/printer/NOTICE.md).

That file also documents why the version is GPL **2-only** rather than
2-or-later, which matters: it means LGPL-3 and GPL-3-only material must never be
brought into that directory.

---

## Components

### MSX PicoVerse — Cristiano Goncalves (The Retro Hacker)

**CC BY-NC-SA 4.0** · https://github.com/cristianoag/msx-picoverse-public

The foundation of the cartridge firmware. From it come the slot-bus PIO engine,
the mapper implementations, the Sunrise IDE emulation, the boot menu and the
UF2 assembly tool. Individual files carry his copyright header; those headers
are kept intact.

| Here | Upstream |
|---|---|
| `src/picoverse-picodock/multirom.c`, `msx_bus.pio`, `sunrise_ide.c` (+ headers) | `multirom.pio/pico/multirom` |
| `src/picoverse-picodock/pd_usb.c` (CDC descriptors, core1 pump) | `loadrom.pio/pico/printer` |
| `src/multirom-tool/` | `multirom.pio/tool` |
| `src/picodock-menu/` | `multirom.pio/msx` |

What this project added on top: a USB CDC **device** on core1, the host-backed
block device behind the IDE emulation (`pd_usb.c`, the `0x2x` frames), the
mailbox (`pd_mailbox.c`), and the printer capture path (`pd_stdprint.c`).

### Nextor — Konamiman (Nestor Soriano) and contributors

    src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.ROM
    src/nextor/NEXTOR.SYS
    src/nextor/COMMAND2.COM

All three unmodified, from the same Nextor **2.1.4** distribution. The kernel ROM
is what the cartridge boots into so the MSX has a disk operating system; the two
system files are what `make_disk.sh --bootable` writes onto the image so it
reaches a DOS prompt. They are shipped together because they have to match — see
[`src/nextor/README.md`](src/nextor/README.md).

Nextor is published with permission from the MSX Licensing Corporation. Its
licence grants use "without restriction" with two carve-outs that matter here:

> "**Commercial usage** of the Software is not allowed without explicit
> permission from the copyright holders. 'Commercial usage' means selling copies
> of the Software, either in source code form or in binary form."
>
> "**Derivative works** are not allowed without explicit permission from the
> copyright holders. 'Derivative works' means independent projects that are
> created as forks of the original source code for the Software."

This repository is non-commercial and forks no Nextor source, so both are met.

**The PicoDock kernel build.** Alongside the stock ROM this repository also
ships

    src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM

which is that same 2.1.4 release with one addition: the SunriseIDE **driver**'s
`DRV_BASSTAT` entry — a `scf`/`ret` stub upstream — implements `CALL PDASK("...")`.
The kernel banks are byte-for-byte identical to the stock ROM and the build
script refuses to finish if that ever stops being true; only the driver bank
differs.

This is the mechanism Nextor documents for hardware to add its own BASIC
commands, assembled with Nextor's own driver toolchain (Nestor80 + `mknexrom`)
from the upstream driver source, which is fetched at build time and never
redistributed here. What this project wrote is the patch alone —
[`src/nextor-driver/picodock-drv_basstat.patch`](src/nextor-driver/picodock-drv_basstat.patch) —
so what is ours and what is Konamiman's stays separable. It is a driver for this
cartridge, not a fork of Nextor.

One thing to be aware of: `COMMAND2.COM` is not Nextor's own work. It is
MSX-DOS 2's command interpreter (version 2.44), and it is included here exactly
as Konamiman distributes it inside Nextor's `extras/tools.zip`. The Nextor manual
treats it as an external dependency — "the same command interpreter of MSX-DOS 2
is used (any version of COMMAND2.COM from 2.20 will do)". It is redistributed on
the basis that the Nextor project distributes it as part of its own release; if
you need a stricter provenance than that, delete it and put your own copy in
`resources/assets/`, which takes precedence.

Upstream: https://github.com/Konamiman/Nextor

### Fusion-C — Eric Boez, Fernando García Sanz and contributors

**CC BY-SA 4.0**

`src/picodock-menu/lib/fusion_min_printf.lib` is a Fusion-C 1.3 library archive,
and `src/picodock-menu/` links against Fusion-C headers and `crt0`.
`src/picodock-menu/reference/menu.rom` is PicoVerse's released menu binary,
byte for byte, and therefore also contains Fusion-C code.

Note for anyone reusing the menu: Fusion-C is CC BY-**SA** (commercial use
allowed), whereas this project is CC BY-**NC**-SA. The NC term is an additional
restriction relative to BY-SA. The menu ROM is redistributed here in the same
form and combination that MSX PicoVerse already publishes upstream; if you need
a combination without that tension, build the menu yourself against Fusion-C and
treat the result as BY-SA.

Upstream: https://github.com/ericb59/FUSION-C-1.3

### openMSX

**GPL-2.0-only** · https://github.com/openMSX/openMSX

`src/host/printer/msx_printer_escp_render.py` reimplements ESC/P interpretation
cross-checked against `src/Printer.cc` (`ImagePrinterEpson`), and
`src/host/printer/msx_printer_fonts.py` is generated from glyph tables in
`src/MSXCharacterSets.cc` and `src/Printer.cc`. The national character
substitution tables come from `ImagePrinterEpson`.

### DOSBox-X

**GPL-2.0-or-later** · https://github.com/joncampbell123/dosbox-x

The ESC/P command interpretation in `src/host/printer/msx_printer_escp_render.py`
is ported from `src/hardware/parport/printer.cpp`.

### Raspberry Pi Pico SDK and TinyUSB

**BSD-3-Clause** / **MIT**

Not vendored here. The firmware builds against a Pico SDK you install yourself
(`src/env.sh`); `pico_sdk_import.cmake` is the SDK's own bootstrap file.

### SDCC

**GPL** (the compiler; its runtime library carries a linking exception)

Used to build the MSX-side tools and the menu ROM. Not vendored.

---

## Verification material, not code

`src/host/printer/tests/` contains printer captures used as test fixtures —
`.prn` byte streams and one golden PNG. They are outputs produced for this
project, used to pin behaviour; no third-party code was taken with them.

## Not published here

This repository is the public subset of a larger private development tree. The
development journal, hardware notes, the remote-keyboard and memory-monitor
features, and the author's own ROM, font and system-file collection are not part
of it. Code comments occasionally refer to `tasks.md`, which is that private
journal — an honest pointer to where a decision was recorded, even though the
record itself is not public.

`resources/` is not in the repository at all — make it yourself if you want
one. It is where **you** put ROMs, kanji ROM dumps and fonts, and those are
either copyrighted or personal.
