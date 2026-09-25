# PicoDock on Windows — installation guide

Everything in this folder runs on Windows 10 and 11. You install one program,
Node.js, and one more if you want to hear the MSX's MIDI. Every command below
is a `.bat` file in this folder: double-click it, or run it from a command
prompt.

## What you need

- A Windows 10 or 11 PC with an internet connection for the first run
- The PicoDock cartridge
- **Two USB cables:** a normal data cable, for flashing the cartridge while it
  is out of the MSX, and a **VBUS-blocking** cable, for when it is in the MSX.
  Never connect a cartridge that is in a switched-on MSX with a normal cable —
  the computer's 5 V and the MSX's 5 V would meet.

## 1. Install Node.js (once)

Open a command prompt and run:

```
winget install OpenJS.NodeJS.LTS
```

or download the LTS installer from <https://nodejs.org>. Then **close the
command prompt and open a new one** — a window only sees programs that were
installed before it opened.

## 2. Set up (once)

```
setup.bat
```

It checks that Node.js is there and installs the packages the server uses
into `node\node_modules\` — `serialport` to reach the cartridge, and the
optional ones for PDASK and receipt printers. Nothing is installed
system-wide. If it stops, it says why.

No driver is needed for the cartridge. Windows recognises it on its own, as a
USB serial port and a USB MIDI device.

## 3. Flash the cartridge

Take the cartridge out of the MSX. **Hold the BOOTSEL button while plugging it
into the PC** with the normal cable. A drive called `RPI-RP2` appears. Then:

```
cartridge\flash.bat
```

It writes `picodock.uf2` if you built one, otherwise the plain
`picodock.org.uf2`, and says which. To put your own ROMs in the cartridge,
copy `.rom` files into `cartridge\roms\` and run `cartridge\make-uf2.bat`
first; to write a particular image, name it: `cartridge\flash.bat
picodock.org.uf2`.

It waits for the cartridge to restart, which is what tells you it worked.
Windows may report an error at the very end of the copy — the cartridge
restarts the moment it has the whole file, so the drive vanishes mid-copy.
That is normal.

## 4. Serve the disk

Put the cartridge back in the MSX, connect it with the **VBUS-blocking** cable,
and — **before** switching the MSX on — run:

```
disk\serve.bat
```

The first time, it builds the disk image `disk\picodock.img`. Leave the window
open while you use the MSX; Ctrl-C stops it. Then open
<http://127.0.0.1:8080/> in a browser — the disk, the printer, PDASK and the
sound are all there — switch the MSX on and choose **PicoDock Disk (Nextor)**
from the cartridge menu.

To put your own files on the disk, copy them into `disk\user-files\`, run
`disk\sync-disk.bat`, then type `PDSYNC` on the MSX.

## 5. Hearing the MSX's MIDI

### How it works

The cartridge is also a USB MIDI device called **PicoDock** (Windows may show
it as `PicoDock MIDI`). It sends MIDI **from the MSX to the PC**, from two
sources:

| Source | What it is | How to turn it on |
|---|---|---|
| **MIDI-PAC** | The cartridge listens to the MSX's PSG sound chip and writes MIDI notes from it. Works with any MSX software. The square wave becomes a General MIDI instrument. | The **MIDI-PAC** switch on the Sound page of <http://127.0.0.1:8080/>, which also chooses the instrument |
| **MSX-MIDI** | Software that drives the MSX-MIDI ports (MIDRY and the like) writes real MIDI, and the cartridge passes it through untouched. On an MSX without MSX-MIDI (a Sony HB-F1XD, say) run `PDMIDI` once first, or put it in `AUTOEXEC.BAT`; an OCM / 1chipMSX needs nothing. | Always on — with no such software running there is simply no traffic |

While MSX-MIDI is flowing, MIDI-PAC stays quiet, so the two never overlap.

MIDI is only notes, not sound. **Something on the PC has to play it**, and
Windows does not connect a MIDI input to a synthesiser by itself. You need a
synthesiser that listens to **PicoDock**. **FluidSynth (A) is the simplest**:
it opens PicoDock by itself, and Qsynth gives it a window. The others (B, C, D)
need a second program, MIDI-OX, to connect PicoDock to them.

### A. The simplest: FluidSynth

FluidSynth is a free SoundFont synthesiser — the same one the Sound page
suggests on macOS and Linux. On Windows it opens the PicoDock MIDI input
itself. It needs a **SoundFont** (`.sf2`, the instrument sounds) — download a
General MIDI one first: **GeneralUser GS**
(<https://schristiancollins.com/generaluser.php>) is free and a good choice.
Put the `.sf2` file in, for example, `C:\soundfonts\`.

Then use FluidSynth either with a window (Qsynth) or from a command prompt.

#### With a window: Qsynth

Qsynth is FluidSynth with a settings window; its Windows installer includes
FluidSynth itself.

1. Install `qsynth-0.9.91-1.1.win-x64-setup.exe` from
   <https://sourceforge.net/projects/qsynth/files/qsynth/0.9.91/>. That is the
   newest version with a Windows installer; the later ones are Linux-only.
2. Connect the cartridge first, then start Qsynth — it lists MIDI devices only
   when it starts.
3. Press **Setup...** and set:
   - **MIDI** tab: tick **Enable MIDI Input**. **MIDI Driver**: `winmidi`.
     **MIDI Device**: the entry ending in `PicoDock`, such as `1:PicoDock`.
     (Or leave it `default` and tick **Auto Connect MIDI Inputs**, which opens
     every MIDI input on the PC.)
   - **Audio** tab: **Audio Driver**: `wasapi` (`dsound` if there is no sound).
   - **Soundfonts** tab: **Open...** and choose your `.sf2` file.
4. Press **OK**. If Qsynth asks to restart the engine, say yes.
5. On the Sound page of <http://127.0.0.1:8080/>, switch **MIDI-PAC** on and
   pick an instrument. Play something on the MSX.

Qsynth remembers these settings. Next time, connect the cartridge and start
Qsynth — nothing else.

#### From a command prompt: FluidSynth itself

No installer: FluidSynth on its own is a 3 MB zip.

1. From <https://github.com/FluidSynth/fluidsynth/releases>, download
   `fluidsynth-v2.6.1-win10-x64-cpp11.zip` (or a newer version; `x86` instead
   of `x64` for 32-bit Windows). Extract it and rename the folder it makes to
   `C:\fluidsynth`, so that the program is `C:\fluidsynth\bin\fluidsynth.exe`.
2. Connect the cartridge, then run this in a command prompt, as one line (use
   your SoundFont's file name):

   ```
   C:\fluidsynth\bin\fluidsynth.exe -a wasapi -m winmidi -o midi.autoconnect=1 C:\soundfonts\GeneralUser-GS.sf2
   ```

   `-a wasapi` plays through Windows audio, `-m winmidi` reads MIDI input, and
   `-o midi.autoconnect=1` opens every MIDI input on the PC, PicoDock among
   them. Put the line in a `.bat` file to start it with a double-click.
3. FluidSynth shows a `>` prompt and plays for as long as the window is open.
   Type `quit` to stop it.
4. On the Sound page, switch **MIDI-PAC** on and pick an instrument.

**Only PicoDock, not every MIDI device.** `midi.autoconnect=1` also takes any
other MIDI input — a USB keyboard, say — away from other programs. To open
PicoDock alone, list the inputs:

```
C:\fluidsynth\bin\fluidsynth.exe -o help | findstr winmidi
```

The line shows them numbered, as `'0:...'`, `'1:PicoDock'` and so on. Then
replace `-o midi.autoconnect=1` with `-o midi.winmidi.device=1`, using
PicoDock's number.

If FluidSynth runs but nothing is heard, try `-a dsound` instead of
`-a wasapi`.

### B. No download of sounds: Windows' own synthesiser + MIDI-OX

Windows has a General MIDI synthesiser built in, **Microsoft GS Wavetable
Synth**, so this needs no SoundFont. MIDI-OX, a free MIDI utility, connects
PicoDock to it.

1. Install MIDI-OX from <http://www.midiox.com/> (free).
2. Connect the cartridge first, then start MIDI-OX. Like most MIDI programs it
   looks for devices only when it starts.
3. **Options → MIDI Devices…**
4. Under **MIDI Inputs**, select **PicoDock**. Under **MIDI Outputs**, select
   **Microsoft GS Wavetable Synth**. Press **OK**.
5. MIDI-OX sends every selected input to every selected output, so that is the
   whole connection. Leave MIDI-OX running — minimised is fine.
6. On the Sound page of <http://127.0.0.1:8080/>, switch **MIDI-PAC** on and
   pick an instrument. Play something on the MSX.

MIDI-OX's input monitor window shows the notes as they arrive, which tells you
whether a silence is the cartridge or the synthesiser.

The built-in synthesiser has a noticeable delay and a plain sound.

### C. VirtualMIDISynth + a SoundFont, through MIDI-OX

VirtualMIDISynth is a free software synthesiser that plays SoundFont (`.sf2`)
files and appears in Windows as a MIDI output, with less delay than the
built-in one.

1. Install VirtualMIDISynth from
   <https://coolsoft.altervista.org/en/virtualmidisynth>.
2. Add a General MIDI SoundFont (see A) in the VirtualMIDISynth configurator.
3. Do setup **B**, but in step 4 choose **VirtualMIDISynth #1** as the MIDI
   output instead of Microsoft GS Wavetable Synth.

The same MIDI-PAC instrument number sounds different in every SoundFont. If it
does not sound right, try another instrument on the Sound page before trying
another SoundFont.

### D. Roland MT-32 / CM-32L sound: Munt

Some MSX-MIDI software was written for the Roland MT-32 rather than General
MIDI. **Munt** (<https://github.com/munt/munt>) emulates it and installs a MIDI
output called **MT-32 Synth Emulator**; route PicoDock to it with MIDI-OX as in
**B**. Munt needs the MT-32 control and PCM ROMs, which are not distributed —
you have to dump them from your own hardware.

### One program at a time

On most Windows setups, **a MIDI input can be open in only one program at a
time.** The **Watch the MIDI** monitor on the Sound page reads PicoDock
directly in the browser, so while it is on, Qsynth, FluidSynth or MIDI-OX may
fail to open PicoDock, and while one of them has it, the monitor may see nothing. Use
one or the other, and restart whichever one lost. (Newer Windows 11 builds with Windows
MIDI Services can share a MIDI port between programs.)

### When there is no sound

| What you see | Why, and what to do |
|---|---|
| PicoDock is not in MIDI-OX's input list | The cartridge was not connected when MIDI-OX started. Connect it and restart MIDI-OX. Do the same after re-flashing or re-plugging it. |
| MIDI-OX says the device is in use | Something else has PicoDock open — usually the Watch the MIDI monitor in the browser, or Qsynth / FluidSynth. Close the other one. |
| Qsynth or FluidSynth runs but plays nothing | Was the cartridge connected before it started? Start it again after connecting or re-plugging the cartridge. In Qsynth, check **Setup... → MIDI → MIDI Device** shows PicoDock and **Soundfonts** has a `.sf2`; from the command prompt, check `fluidsynth -o help \| findstr winmidi` lists PicoDock. Try the `dsound` audio driver. |
| Notes arrive in MIDI-OX's monitor but nothing is heard | The output is wrong or muted: check the MIDI output in Options → MIDI Devices, and the Windows volume mixer. |
| Nothing arrives at all | Is MIDI-PAC switched on on the Sound page? Is the MSX program actually playing PSG music? For MSX-MIDI: does the program have its MSX-MIDI output selected? |
| It plays, but the instrument is odd | That is the SoundFont's version of that General MIDI number. Pick another instrument on the Sound page. |

The PSG sound itself — the real square wave, rebuilt in the browser — needs
none of this. Switch **PSG raw** on on the Sound page and it plays through the
browser.

## What differs from macOS

- **Print…** on the web page opens a PDF in macOS Preview, so it does nothing
  on Windows. Open the PDF from `output\` and print it from there.
- `--direct cups` (sending to a system printer queue) is macOS and Linux only.
- **Speech** (PDASK answering aloud, `PDVOICE`) uses Windows' own voices —
  nothing to install. English comes with Windows. For Korean or Japanese, add
  that language's speech voice under **Settings → Time & language → Speech**;
  only voices Windows also offers to older programs ("Desktop" voices) can be
  used, not the newest "natural" ones. To see what it found, run
  `node node\bin\pd_voice.js --list` from this folder. eSpeak NG
  (<https://github.com/espeak-ng/espeak-ng>) works too if you install it; it is
  found in its default folder even though its installer does not add it to the
  PATH.
- **Receipt printers over USB** usually need the WinUSB driver installed for the
  printer (for example with Zadig) before the program can reach them.

## If something goes wrong

- **`'node' is not recognized`** — open a new command prompt after installing
  Node.js. If that does not help, run the Node.js installer again; it adds
  itself to the PATH.
- **`npm` cannot download anything** — on a work network that is usually a
  proxy: `npm config set proxy http://proxy:port` and
  `npm config set https-proxy http://proxy:port`, then run `setup.bat` again.
- **`serve.bat` waits for the cartridge for ever** — check the cable. The
  VBUS-blocking cable is right when the cartridge is in the MSX; with the
  cartridge out of the MSX it carries no power, so nothing appears.
- **Flashing "failed", but the cartridge works** — expected; see step 3.

Licences: [NOTICE.md](NOTICE.md).
