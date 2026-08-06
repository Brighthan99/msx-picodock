# src — the work tree

Everything needed to build PicoDock is here. The user-facing guide is the top-level
[`../README.md`](../README.md); this file is the map of the code.

| Folder | Contents |
|---|---|
| `picoverse-picodock/` | ★ **the integrated firmware** — core0 slot bus + mappers (multirom), core1 USB CDC device, mailbox, printer capture |
| `multirom-tool/` | the UF2 assembly tool |
| `picodock-menu/` | the MSX-side boot menu (Z80, sdcc + Fusion-C). `reference/` is PicoVerse's released binary, the fallback when sdcc is absent |
| `msx-tools/` | MSX-DOS tools (Z80 assembly) — `PDSYNC` (cache flush) and `PDFRCPRN` (OCM: arm the 0x90 responder). Printing itself needs no tool |
| `host/` | the host side (Mac / Raspberry Pi) — disk server, TUI, printing. See [host/README.md](host/README.md) |
| `tools/` | build helpers — ihx→ROM conversion, sdcc link checking |

Reference documents that live here because code comments point at them:

- [`pd_protocol.md`](pd_protocol.md) — the wire format between cartridge and host
- [`bus_contention_and_port_conflicts.md`](bus_contention_and_port_conflicts.md) —
  why driving port 0x90 is safe on an OCM and dangerous elsewhere

> **`../resources/`** is gitignored and does not exist until you make it. It is
> an optional place for *your* assets — `resources/fonts/` for a CJK TrueType
> font and `resources/font-roms/` for a kanji ROM dump, both of which the printer
> looks for and does without. Everything the documented workflow needs already
> has a home that ships: `dist/cartridge/roms/` and `dist/disk/user-files/`.

## Build

Each script's header says what it needs and why. `env.sh` holds the paths.

```sh
# firmware (Pico SDK + ARM toolchain - paths in env.sh)
./src/build.sh pdser          # the integrated firmware
./src/build.sh printer        # the standalone virtual printer

# the MSX menu (sdcc + Fusion-C)
cd src/picodock-menu && make

# the whole disk + printer build in one command (firmware -> menu -> UF2)
./src/build_diskprint.sh                                 # -> dist/cartridge/picodock.uf2

# or by hand - NEXTOR=sunrise is required for the virtual disk!
NEXTOR=sunrise ./src/make_uf2.sh resources/msx-roms      # -> dist/cartridge/picodock_full.uf2
```

To get back to a plain, working cartridge there is nothing to build:
`dist/cartridge/picodock.org.uf2` ships in this repository and
`./dist/cartridge/flash.sh picodock.org.uf2` writes it.

Output lands in `build/` at the repository root (gitignored).

## External dependencies (outside this repository)

Set through `src/env.sh` and `picodock-menu/Makefile`.

| What | Default path | Note |
|---|---|---|
| Pico SDK 2.1.1 | `~/work/pico-sdk` | with the tinyusb submodule |
| ARM GNU Toolchain 14.2.rel1 | `~/work/toolchains/arm-gnu-…` | ⚠️ the Homebrew build has no newlib and cannot be used |
| Fusion-C 1.3 | `~/work/fusion-c` | for `picodock-menu` only |
| sdcc, cmake, ninja | Homebrew / apt | |
