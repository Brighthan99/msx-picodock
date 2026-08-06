# nextor-driver — `CALL PDASK("...")` as the Nextor driver's `DRV_BASSTAT`

```basic
10 CALL PDASK("give me a haiku about cassette tapes")
```

The MSX asks; the host answers (a person types it, or a search does); the MSX
prints it. The host half is [`../host/pd_ask.py`](../host/pd_ask.py); this
folder is the MSX half.

## Why here, and not in a ROM of our own

`CALL` is a standard MSX mechanism: at boot the BIOS records which slots hold a
ROM with a STATEMENT entry, and `CALL NAME(...)` puts the name in `PROCNM`
(`0xFD89`) and offers it to each of them in turn. `Cy=1` means "not mine, ask
the next one"; `Cy=0` means "handled", with `HL` moved past what was consumed.

A disk interface adds its own `CALL` commands at a documented place in that
chain, and Nextor inherited it from MSX-DOS 1's `OEMSTA`: the kernel tries its
own names first — `SYSTEM`, `FORMAT`, `CHDRV`, `MKDIR`, `RAMDISK`, `MAPDRV`,
`LOCKDRV`, `NEXTOR`, `DRIVERS` and the rest — and hands the ones it does not
know to each driver's `DRV_BASSTAT`. In the stock SunriseIDE driver that entry
is a `scf`/`ret` stub. `PD` is ours to take: no name in the kernel table
collides with it.

Doing it this way means **the cartridge firmware does not change at all**. The
alternative — our own 16KB ROM with an "AB" header in a second sub-slot — would
need sub-slot ROM serving added to the firmware for no gain.

That the kernel really does this is visible in the ROM itself, not only in the
documentation. The driver's jump table sits at `0x4130` in the driver bank, so
`DRV_BASSTAT` is entered at `0x4139`, and kernel bank 0 holds

    DD 21 39 41    ld ix,4139h
    CD 42 40       call CALBNK        ; 4042h: call it in the driver bank

immediately before the table of the kernel's own `CALL` names at `0x59E8`.

## What it costs

`CALL PDASK` only works while Nextor is running — that is, in Disk BASIC, which is
where a PicoDock MSX lives anyway. The menu and plain cartridge games have no
disk ROM in the chain and no `CALL PDASK`.

## Reading the argument

A literal is read straight out of the BASIC text — BASIC only tokenises
keywords, so the characters between the quotes are sitting there exactly as
typed. Nothing is borrowed, nothing to put back, no bank to restore. **Verified
on hardware, 2026-08-02.**

```basic
CALL PDASK("give me a haiku")     ✓  no interpreter involved
A$="world" : CALL PDASK(A$)       ✓  one borrowed call, see below
CALL PDASK("in one line: "+T$)    ✓
CALL PDASK(3)                     ✗  says so, then Syntax error
```

Both paths verified on hardware, 2026-08-02 (Nextor 2.1.4, v0.75.0).

Anything that is not a literal has to be evaluated, and `FRMEVL` (`0x4C64`) is
inside the window this bank occupies. The standard answer is `CALBAS` — here the
kernel's (`0x403F`), not the BIOS one, because this is one of eight banks sharing
page 1. Two things hardware taught that the documentation did not:

**Interrupts must be off across the call.** The MSX timer interrupt runs the
Nextor kernel's own hook, which switches banks — in the middle of a sequence
that is doing the same thing. With interrupts left on, the first borrowed call
survived and the second never came back. `di` / `call CALBAS` / `ei`.

**One borrowed call is enough.** `FRESTR` was called next to obtain the string
descriptor, the way the Kanji BASIC ROM does it. It is unnecessary: `FRMEVL`
already leaves a pointer to the descriptor at `DAC+2` (`0xF7F8`). Hardware
printed `dac=00007AF60000` for `A$="world"` — `F67A`, which is `TEMPST`, the
pool BASIC keeps temporary descriptors in. So the descriptor is read directly,
and the tidying `FRESTR` would have done is one instruction: put `TEMPPT`
(`0xF678`) back to `TEMPST`.

**The interpreter's text pointer is not usable afterwards.** Where it lands was
guessed at twice and was wrong twice; hardware finally reported it sitting on
`14h` — not the bracket, not one short of it, not the end of the statement. So
the handler no longer asks. It finds the matching `)` itself, *before* borrowing
anything, counting brackets and stepping over quoted runs, and returns that
position to BASIC. What `FRMEVL` leaves in `HL` is discarded.

That also makes `CALL PDASK(MID$(A$,1,3))` and `CALL PDASK("a)b")` land in the right
place, which a single scan for the first `)` would not have.

## The change

[`picodock-drv_basstat.patch`](picodock-drv_basstat.patch) — one hunk, replacing
the `DRV_BASSTAT` stub with ~530 bytes of handler. The driver bank has ~11.4KB
free after it.

The protocol it speaks is in [`../pd_protocol.md`](../pd_protocol.md), and
[`../msx-tools/pdask.s`](../msx-tools/pdask.s) (`PDASK.COM`) speaks the same one
from MSX-DOS without any ROM — which is how to tell a broken handler from a
broken host.

## Building

Toolchain, once, into `~/.msx-nextor-build/tools/` (override with
`MSX_NEXTOR_TOOLS`):

* **N80** (Nestor80) — Nextor 2.1 is built with this, not the old M80.
  Download the SelfContained build from
  <https://github.com/Konamiman/Nestor80/releases> and unzip to `tools/n80/`.
* **mknexrom** —
  `cc -O2 -o tools/mknexrom <(curl -sSL https://raw.githubusercontent.com/Konamiman/Nextor/v2.1/buildtools/sources/mknexrom.c)`

Then:

    ./src/nextor-driver/build.sh
    # -> src/nextor/Nextor-2.1.4.SunriseIDE.MasterOnly.PicoDock.ROM

The script fetches the stock driver source, applies the patch, extracts the
kernel base from the stock ROM, assembles with N80 and combines with mknexrom.
It then asserts that **only bank 7 (the driver) differs** from the stock ROM —
the kernel is byte-identical — and that the handler is actually in there. An
unmodified driver reproduces the stock ROM exactly, so any difference is our
change and nothing else.

`make_uf2.sh` and `make_tool.sh` pick the result up when it exists and fall back
to the stock ROM when it does not, so a tree without this toolchain still builds
a working cartridge — one where `CALL PDASK` says `Syntax error`.

## Not in here: the remote keyboard

The other patch to this driver — `DRV_TIMI` injecting host bytes into `KEYBUF` —
is not published, and is deliberately not combined with this one. Both consume
mailbox RX bytes, and a background reader stealing bytes from a foreground one
is a bug that has already been had once. One consumer at a time.
