# Licences and third-party notices

PicoDock is a derivative work. This file records which licence covers which
part of the repository, what came from where, and which notices the binaries
in `dist/` have to carry.

## Two licences, one per program

| Path | Licence | Why |
|---|---|---|
| **the host programs**: `node/`, and the shims in `src/host/` that run it | **GPL-2.0-only** ([node/LICENSE](node/LICENSE), [src/host/LICENSE](src/host/LICENSE)) | they contain printer code ported from openMSX and DOSBox-X |
| **everything else**: the cartridge firmware, the menu, the UF2 tool, the MSX-side tools, the Nextor driver patch, the build scripts, the docs | **CC BY-NC-SA 4.0** ([LICENSE](LICENSE)) | derived from MSX PicoVerse |

The nearest `LICENSE` file up the tree is the one that applies.

**Why the host is GPL.** The printer pipeline carries ESC/P interpretation
logic and glyph tables from openMSX (GPL-2.0-only) and DOSBox-X (GPL-2.0-or-later).
The disk server loads it in-process (`import './printrender.js'`), and the web
screen loads the interpreter into the same page as the rest of the interface. A program with GPL code in it is GPL as a whole, and CC BY-NC-SA
cannot be that: its NonCommercial term is an "additional restriction" the GPL
forbids.

Until v1.23.0 only the printer package was marked GPL and the rest of the host
was nominally CC BY-NC-SA, which did not hold up for exactly that reason. From
**v1.23.1** the host programs are GPL-2.0-only as a whole. Their own code was
written for this project and does not derive from MSX PicoVerse, so its author
could choose; the choice that makes the combination lawful is GPL-2.0-only.

**Why the firmware is not.** The firmware derives from MSX PicoVerse, published
under CC BY-NC-SA 4.0, and ShareAlike requires derivatives to keep that licence.
**Commercial use of the firmware is not permitted.** The host programs, being
GPL, may be used commercially; the firmware they talk to may not.

**The wall is now between the two programs.** The cartridge and the computer
are separate programs communicating over USB, and neither contains the other's
code. Do not copy code across that line in either direction. The protocol they
share — frame layout and command numbers, `src/pd_protocol.md`,
`src/picoverse-picodock/pd_protocol_ids.h`, `node/src/protocol.js` — is an
interface, not an implementation, and both sides implement it.

**Version 2 only.** openMSX is GPL-2.0-only — the reasoning is in
[node/NOTICE.md](node/NOTICE.md) — so GPL-3-only, LGPL-3 and Apache-2.0 material
must never be copied into `node/` or `src/host/`.

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
mailbox (`pd_mailbox.c`), the printer capture path (`pd_stdprint.c`), the
PSG/MIDI path (`pd_midipac.c`, `pd_msxmidi.c`) and the voice ring
(`pd_voice_win.c`).

`src/multirom-tool/src/sha1.h` is based on Steve Reid's public-domain SHA-1.

### Nextor — Konamiman (Nestor Soriano) and contributors

    src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.ROM
    src/nextor/NEXTOR.SYS
    src/nextor/COMMAND2.COM

All three unmodified, from the same Nextor **2.1.4** distribution. The kernel ROM
is what the cartridge boots into; the two system files are what
`make_disk.sh --bootable` writes onto the image. They ship together because
they have to match — see [src/nextor/README.md](src/nextor/README.md).

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

**The PicoDock kernel build.** `src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM`
is that same 2.1.4 release with one addition: the SunriseIDE **driver**'s
`DRV_BASSTAT` entry — a `scf`/`ret` stub upstream — implements `CALL PDASK("...")`.
The kernel banks are byte-for-byte identical to the stock ROM and the build
script refuses to finish if that ever stops being true; only the driver bank
differs. It is assembled with Nextor's own driver toolchain (Nestor80 +
`mknexrom`) from the upstream driver source, which is fetched at build time and
never redistributed here. What this project wrote is the patch alone —
[src/nextor-driver/picodock-drv_basstat.patch](src/nextor-driver/picodock-drv_basstat.patch).
It is a driver for this cartridge, not a fork of Nextor.

`COMMAND2.COM` is not Nextor's own work: it is MSX-DOS 2's command interpreter
(version 2.44), included exactly as Konamiman distributes it in Nextor's
`extras/tools.zip`. It is redistributed on the basis that the Nextor project
distributes it as part of its own release; if you need a stricter provenance,
delete it and put your own copy in `resources/assets/`, which takes precedence.

Upstream: https://github.com/Konamiman/Nextor

### Fusion-C — Eric Boez, Fernando García Sanz and contributors

**CC BY-SA 4.0** · https://github.com/ericb59/FUSION-C-1.3

`src/picodock-menu/lib/fusion_min_printf.lib` is a Fusion-C 1.3 library archive,
and `src/picodock-menu/` links against Fusion-C headers and `crt0`.
`src/picodock-menu/reference/menu.rom` is PicoVerse's released menu binary,
byte for byte, and therefore also contains Fusion-C code.

Fusion-C is CC BY-**SA** (commercial use allowed), whereas the firmware is CC
BY-**NC**-SA; the NC term is an additional restriction relative to BY-SA. The
menu ROM is redistributed here in the same form and combination that MSX
PicoVerse already publishes upstream; if you need a combination without that
tension, build the menu yourself against Fusion-C and treat the result as BY-SA.

### Raspberry Pi Pico SDK and TinyUSB — inside every `.uf2`

**BSD-3-Clause** · https://github.com/raspberrypi/pico-sdk
**MIT** · https://github.com/hathach/tinyusb

Not vendored as source; the firmware builds against an SDK you install
(`src/env.sh`). But the UF2 images in `dist/cartridge/` are **binaries that
contain them**, and both licences ask for their notice to travel with a binary.
The texts are in [LICENSES/pico-sdk.BSD-3-Clause.txt](LICENSES/pico-sdk.BSD-3-Clause.txt)
and [LICENSES/tinyusb.MIT.txt](LICENSES/tinyusb.MIT.txt), and `src/stage_dist.sh`
copies them to `dist/LICENSES/`.

The firmware also links the C library (newlib) and `libgcc` from the Arm GNU
Toolchain 14.2. `libgcc` is covered by the GCC Runtime Library Exception.
newlib is a collection of permissive licences, listed in its `COPYING.NEWLIB`
(https://sourceware.org/git/?p=newlib-cygwin.git;a=blob;f=COPYING.NEWLIB);
it is not reproduced here.

### openMSX and DOSBox-X — the printer

**GPL-2.0-only** · https://github.com/openMSX/openMSX
**GPL-2.0-or-later** · https://github.com/joncampbell123/dosbox-x

`node/src/escp.js` interprets ESC/P following DOSBox-X
`src/hardware/parport/printer.cpp`, cross-checked against openMSX
`src/Printer.cc` (`ImagePrinterEpson`). `node/src/escp-fonts.js` is generated
from glyph tables in openMSX `src/MSXCharacterSets.cc` and `src/Printer.cc`, as
are the national character substitution tables.

### The host programs' other sources

`node/` translates a few routines from Pillow (MIT-CMU) and CPython (PSF-2.0),
and carries data from the Unicode Character Database (Unicode License v3) and
the WHATWG HTML standard (CC BY 4.0). All four are GPL-compatible. What came
from where, and the full notices, are in [node/NOTICE.md](node/NOTICE.md) and
[node/LICENSES/](node/LICENSES/), which travel with `dist/node/`.

The ESC/POS and 1:1 bit-image logic match msx-picoprinter's `pp_escp.c` and
`escpos.c`, which are the same author's own work there; the author licenses
that logic here under GPL-2.0-only.

The npm packages the host installs on first run — `serialport`, `usb` (MIT),
`@anthropic-ai/sdk` (MIT), `@google/genai` (Apache-2.0) — are not in this
repository or in `dist/`. `node/NOTICE.md` says why the Apache-2.0 one is
still acceptable, and what someone bundling `node_modules/` would have to do.

### Build tools, not shipped

**SDCC** (GPL; its runtime library carries a linking exception) builds the
MSX-side tools and the menu ROM, with Node.js running the small helpers in
`src/tools/`. **zig** or a cross gcc builds the `dist/cartridge/picodock-uf2-*`
tool binaries. None of them is vendored.

---

## Not published here

This repository is the public subset of a larger private development tree. The
development journal, hardware notes, the remote-keyboard and memory-monitor
features, the Python implementation the host programs were ported from (kept
there as the reference their tests compare against), and the author's own ROM,
font and system-file collection are not part of it. Code comments occasionally
refer to `tasks.md`, which is that private journal — an honest pointer to where
a decision was recorded, even though the record itself is not public.

`resources/` is not in the repository at all — make it yourself if you want
one. It is where **you** put ROMs, kanji ROM dumps and fonts, and those are
either copyrighted or personal. Kanji ROM dumps are never redistributed.
