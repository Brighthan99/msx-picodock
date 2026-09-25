# PicoDock

## What it is built on

[**MSX PicoVerse 2040**](https://github.com/cristianoag/msx-picoverse-public), by
Cristiano Goncalves, is an open MSX cartridge built around a Raspberry Pi Pico. A
tool on your computer packs what you want into a UF2 file, you drag that onto the
board, and the cartridge becomes it:

- **a ROM cartridge** — one game, or many behind a boot menu, mapper detected for you
- **a disk** — Nextor over emulated Sunrise IDE, reading a USB pendrive
- **a memory mapper** — 192 KB, which is what Nextor wants for DOS2
- **an adapter** — plug a USB keyboard, gamepad or MIDI cable in and the MSX sees
  a native one

The pattern throughout is that the cartridge's USB-C port is a **host** port:
things plug *into* it, and everything the MSX needs is aboard.

## What PicoDock adds

PicoDock turns that port around. The cartridge runs as a USB **device**, so the
far end of the cable is a computer rather than a pendrive — and the MSX gets what
the computer has:

| | |
|---|---|
| **a hard disk** | 128 MB of Nextor that is really a file on the computer. Change it there and the MSX sees it |
| **a printer** | `LPRINT` comes out on the computer as PDF, text or raster |
| **`PDASK`** | the MSX asks a question and the computer answers — a web search, by default |
| **sound** | the PSG played on the computer, and MIDI: the cartridge is also a USB MIDI device |
| **`PDVOICE`** | the MSX says something out loud through its own sound chip |

The ROM menu and the mapper are still there; the disk is simply the first entry
on the menu. A Node.js program on the computer serves all of it, with a screen
in your browser at <http://127.0.0.1:8080/>.

---

> ### ⚠️ Experimental. Use at your own risk.
>
> This is hobby firmware that drives an MSX slot bus and, optionally, a printer
> port. **No responsibility is taken for damage to your MSX, your cartridge or
> anything attached to them.** Read the two warnings below before plugging
> anything in — they are the ones that can cost you hardware.

---

## Two things that can damage hardware

### 1. The USB cable must have VBUS cut

The cartridge's VBUS pin is tied to the MSX slot's 5 V rail. Plug a **normal**
USB cable into a running MSX and your computer drives that rail too — two power
supplies fighting across your machine's 5 V.

**Whenever the cartridge is in the MSX, use a VBUS-blocking cable** — the one
thing standing between a mistake and a repair.

They are sold as "data-only" or "power-blocking", but they are hard to actually
find, and most of what is sold under those names is the opposite: *charge-only*
cables, which cut the data lines and keep the power. That is exactly backwards
here and the cartridge will not talk at all.

So the practical answer is to make one. Take a cheap cable that does carry data,
open the sheath, and **cut the VBUS wire — the red one — leaving a gap.** Do not
join it to anything; shorting it to ground is a different and worse mistake.

**The data pair must stay intact.** Everything here runs over USB CDC, so a cable
with the data lines cut is no use — it is the power you are removing, and only
the power.

| wire | | |
|---|---|---|
| VBUS (red) | **cut** | this is the whole point |
| D+ / D− (white, green) | leave alone | the disk, the printer and `PDASK` all ride on these |
| GND (black) | leave alone | the signals need a common reference |

| | cable | cartridge |
|---|---|---|
| flashing | normal | out of the MSX |
| everything else | **VBUS-blocking** | in the MSX |

### 2. Printing needs a dummy plug — and `PDFRCPRN` is experimental

To print, the MSX drives its own printer port and the cartridge listens in. That
listening is passive and safe anywhere.

The MSX also *polls* that port for a BUSY signal before every byte, and with
nothing plugged in it never gets an answer, so printing hangs. **Use a
Centronics dummy plug** with BUSY tied to ready. That is the safe way.

Nobody sells one, so make it: get a **14-pin Centronics male plug** (57-series,
CHAMP or micro-ribbon, solder-cup type) and **join pin 11 to pin 14** — BUSY to
ground. Nothing else is connected. The MSX then reads "ready" every time it
asks, and printing starts instead of hanging.

`PDFRCPRN` makes the cartridge answer BUSY instead. It exists for the **OCM /
1chipMSX**, which has no real printer port at all, and it refuses to run on
anything else. **It is experimental and drives a bus line — no responsibility is
taken for it.** On a real MSX2 you do not need it: use the dummy plug.

---

## Setting up

The one thing to install is **Node.js 18 or newer** (<https://nodejs.org>, or
`brew install node` on macOS). No Python, no Pico SDK, no ARM toolchain, no sdcc
— the cartridge image in `dist/` is already built.

The first `serve.sh` fetches the one package the server needs to reach the
cartridge (`serialport`) into `dist/node/node_modules/`. On **Windows**, run this
once instead and it does the same, stopping with an explanation if anything is
missing:

```bat
dist\setup.bat
```

[dist/WINDOWS.md](dist/WINDOWS.md) walks through the whole installation on
Windows, including how to hear the MSX's MIDI there.

On **Linux**, `dist/disk/99-picodock.rules` gives you access to the serial port
and keeps ModemManager off it:

```sh
sudo cp dist/disk/99-picodock.rules /etc/udev/rules.d/
```

Every command below is given both ways. Under Git Bash or WSL the `.sh` versions
work on Windows too, and the `.bat` is unnecessary.

### Flash the cartridge

Cartridge **out** of the MSX, hold **BOOTSEL** while plugging it into the
computer with a **normal** cable:

```sh
./dist/cartridge/flash.sh          # macOS
dist\cartridge\flash.bat           # Windows
```

The drive disappearing is what confirms the write. Your file manager will report
an error if you drag the file across by hand — that is the cartridge rebooting,
not a failure.

### Serve the disk

Cartridge **in** the MSX, **VBUS-blocking** cable, and start the server *before*
switching the MSX on:

```sh
./dist/disk/serve.sh               # macOS
dist\disk\serve.bat                # Windows
```

Switch on the MSX and pick **PicoDock Disk (Nextor)** from the menu. You get an
`A>` prompt.

Leave the server running for as long as you are using the MSX — it sits through
resets and reflashing without needing a restart. **Ctrl-C ends it.**

While it runs, <http://127.0.0.1:8080/> shows the disk, the printer, `PDASK` and
the sound. It listens on this computer only. `--no-web` turns it off.

---

## The cartridge menu

The first entry is always **PicoDock Disk (Nextor)** — the virtual disk. Entries
after it are ROMs you chose.

**Put `.rom` files in `dist/cartridge/roms/`**, then:

```sh
./dist/cartridge/make-uf2.sh       # macOS   -> dist/cartridge/picodock.uf2
./dist/cartridge/flash.sh          #         flashes it

dist\cartridge\make-uf2.bat        # Windows -> dist\cartridge\picodock.uf2
dist\cartridge\flash.bat           #         flashes it
```

The mapper for each ROM is detected automatically. `picodock.org.uf2` is the
plain cartridge as it ships and is never overwritten, so passing it to the
flasher always takes you back:

```sh
./dist/cartridge/flash.sh picodock.org.uf2   # macOS
dist\cartridge\flash.bat picodock.org.uf2    # Windows
```

Most people put very little in flash. Software on the *disk* can be changed
without reflashing, which is the easier way round.

---

## The disk

### Recommended: put SOFARUN on it

**SOFARUN** runs `.rom`, `.dsk` and `.cas` files straight off the disk, so you
can carry hundreds of them without reflashing anything. Search for it by name —
it is well known in the MSX community and easy to find. Drop it in:

```
dist/disk/user-files/SOFARUN/
```

...and your software wherever you like beside it, for instance:

```
dist/disk/user-files/GAMES/
```

Then build the disk. Anything in `user-files/` goes on with its folder structure
intact, so `user-files/GAMES/X.ROM` arrives as `A:\GAMES\X.ROM`.

### Building the disk

```sh
./dist/disk/make-disk.sh           # macOS   -> dist/disk/picodock.img
dist\disk\make-disk.bat            # Windows -> dist\disk\picodock.img
```

128 MB and bootable.

It refuses to overwrite an image that already exists, so it cannot cost you a
disk you have been filling. **`serve.sh` builds one for you the first time**, so
you may never run this at all — use it for a second disk, or a different size.

### Changing it later, while it is running

Add or change something in `user-files/`, then:

```sh
./dist/disk/sync-disk.sh           # macOS
dist\disk\sync-disk.bat            # Windows
```

This works **while the server is running** — it borrows the image from the
server and hands it back. It copies and overwrites; it never deletes, so a file
you removed from `user-files/` stays on the disk.

### `PDSYNC` — the one thing to remember

After changing the disk from the computer, run this on the MSX:

```
A> PDSYNC
```

Nextor caches the directory listing. Until `PDSYNC` runs, `DIR` shows what was
there before and your new files look missing. They are not.

---

## Printing

Print the way you always would:

```basic
LPRINT "HELLO"
```

or from DOS, `COPY README.TXT PRN`. It arrives on the computer:

```sh
./dist/disk/serve.sh --print pdf   # macOS   - or text, raw, raster
ls dist/output/

dist\disk\serve.bat --print pdf    # Windows
dir dist\output\
```

Every job is saved as a raw `.prn` first, always, plus whatever the mode asked
for. So a wrong guess costs nothing — the capture is still there to render
again.

Japanese and Korean printing work, using the machine's own kanji ROM when it has
one. Remember the dummy plug, and `PDFRCPRN` on an OCM only.

---

## Asking the computer — `PDASK`

The MSX sends a question over the cable and prints what comes back. A web search
answers by default.

**From BASIC:**

```basic
10 CALL PDASK("give me a haiku about cassette tapes")
20 A$="what is an msx" : CALL PDASK(A$)
```

**From MSX-DOS:**

```
A> PDASK give me a haiku about cassette tapes
```

To answer the questions yourself instead of searching:

```sh
./dist/disk/serve.sh --ask manual  # macOS
dist\disk\serve.bat --ask manual   # Windows
```

Claude and Gemini can answer too: pick one on the web screen and give it your
API key there. The key is kept in memory for that run and never written to disk.

Answers are cut to 500 characters — an MSX screen is 40 columns and nobody wants
five pages of it.

---

## `PDINFO`

```
A> PDINFO
```

Sends what the MSX knows about itself — machine, slots, memory, the cartridge it
found — to the computer, where it appears on the web screen.

Run it first when something is not behaving. It is also the quickest way to
answer *is the cartridge even being seen*: if `PDINFO` says
`No PicoDock found`, nothing else is worth trying until that is fixed.

---

## Sound and MIDI

The web screen plays the MSX's PSG on the computer as it happens. The cartridge
is also a USB MIDI device called **PicoDock**, sending two kinds of MIDI:

| | |
|---|---|
| **MIDI-PAC** | the cartridge listens to the PSG and writes notes from it. Any MSX software; switched on, and given an instrument, on the web screen |
| **MSX-MIDI** | software that drives the MSX-MIDI ports (`MIDRY /I5` and the like) writes real MIDI, and the cartridge passes it through untouched |

MIDI is only notes. Something on the computer has to play it — GarageBand or
any synthesiser on macOS; on Windows, see [dist/WINDOWS.md](dist/WINDOWS.md).

### `PDMIDI` — an MSX without MSX-MIDI

MSX-MIDI software checks the interface's status port (0xE9) before it sends
anything. A machine with no MSX-MIDI of its own — a Sony HB-F1XD, say — has
nothing there, and the software stops with *I/F not found*. Run this once per
boot, or put it in `AUTOEXEC.BAT`:

```
A> PDMIDI
```

It tells the cartridge to answer "ready to send", and only after checking that
nothing else answers that port. On an OCM, or any machine with MSX-MIDI of its
own, it sees the port answering already and does nothing. An MSX-MIDI cartridge
that its software has not yet moved up to 0xE8 still answers at 0xE1, and
`PDMIDI` leaves that alone too.

## `PDVOICE`

```
A> PDVOICE hello there
```

The computer turns the text into speech and the MSX plays it through its own
PSG. It uses the computer's speech engine: `say` on macOS, the built-in voices
on Windows, `espeak-ng` or `piper` elsewhere.

---

## Wanting more detail

Every script and program in `dist/` explains itself at the top of the file — why
it works the way it does, and what happens when it does not. That is the real
documentation, and it cannot drift from the code because it lives in it.

```sh
head -40 dist/disk/serve.sh                 # macOS
head -60 dist/node/bin/pdserve.js

type dist\disk\serve.bat                    # Windows
```

[node/README.md](node/README.md) says what each program on the computer side is.

---

## Licence

Two programs, two licences:

| | |
|---|---|
| **the cartridge** — firmware, menu, MSX-DOS tools | **CC BY-NC-SA 4.0** — non-commercial, share alike. Derived from **[MSX PicoVerse](https://github.com/cristianoag/msx-picoverse-public)** by Cristiano Goncalves, under the same licence ([LICENSE](LICENSE)) |
| **the computer side** — `node/`, and the shims in `src/host/` that run it | **GPL-2.0-only** ([node/LICENSE](node/LICENSE)). Its printer code carries openMSX and DOSBox-X logic, which makes the whole program GPL |

Nextor, the Pico SDK, TinyUSB, Fusion-C and the fonts have their own terms. See
[NOTICE.md](NOTICE.md) and [node/NOTICE.md](node/NOTICE.md) — some of it is GPL
and some of it is not ours to sell.
