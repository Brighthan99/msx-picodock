# src/host — the host side

The end that talks to the cartridge over USB CDC. Python plus pyserial, so macOS
and Raspberry Pi behave identically. The port is found by USB VID/PID, so the
`/dev/cu.usbmodem*` vs `/dev/ttyACM*` difference never comes up.

**Every serial link goes through [`pd_port.py`](pd_port.py)** — server,
TUI or printer daemon, it does not matter. That is what guarantees DTR is
asserted and an exclusive lock is taken. Missing either one fails quietly and
strangely, which is exactly the kind of bug you do not want twice.

| Tool | |
|---|---|
| [`make_disk.sh`](make_disk.sh) | create an MSX virtual disk image |
| [`disk_put.sh`](disk_put.sh) | put files into an image (mount → copy → tidy → eject) |
| [`disk_rm.sh`](disk_rm.sh) | delete files from an image, case-insensitively, with the server up |
| [`disk_normalize.py`](disk_normalize.py) | force names to upper-case 8.3 (run automatically by `disk_put.sh`) |
| [`pd_diskserver.py`](pd_diskserver.py) | serve an image to the MSX as a hard disk — the main program |
| [`pd_tui.py`](pd_tui.py) | the split-screen view: Disk, Printer, Ask, Status |
| [`pd_ask.py`](pd_ask.py) | answers `CALL PDASK("...")` from the MSX — a search does it, or you type it |
| [`printer/`](printer/) | the printing pipeline. **GPL-2.0-only** — see [printer/NOTICE.md](printer/NOTICE.md) |
| [`tests/run.sh`](tests/run.sh) | the whole host test suite |

## Usage

The guides, not this file, are the place to start:

Every file here explains itself at the top - what it does, and why it does it
that way. That is the documentation; it cannot drift from the code because it
lives in it. The user-facing guide is [../../README.md](../../README.md).

The usual command:

```sh
./src/host/pd_diskserver.py picodock.img --tui --print text
```

## Architecture

```
pd_port.py     one place that opens the serial link (DTR + exclusive lock)
      |
pd_diskserver.py   the serial loop: block requests, mailbox, printer frames
      |
pd_hub.py      an event bus. Everything emits structured events here...
      |
pd_tui.py      ...and the TUI subscribes, so the server does not know it exists
```

Two properties worth knowing before changing anything:

**The TUI is a hub subscriber and an input source.** It presents the same
`read()` contract as the plain console, so `serve()` calls it exactly where it
used to ask the terminal for keystrokes. Not one line of the serial loop changes
depending on whether the TUI is running.

**It is single-threaded on purpose.** curses is not thread-safe, and a
background redraw thread racing the serial loop is a corrupted screen once an
hour and an impossible bug to reproduce. `read()` is called constantly by the
serial loop, so that is where input and redraw happen, rate-limited.

**Events carry fields, not sentences.** `emit(CH_IO, "read", lba=1234, count=8)`,
not a formatted string — because the Disk pane, the counters and the plain-text
log each want to render it differently.

## Requirements

Python 3 is preinstalled on macOS and Raspberry Pi OS. You need pyserial:

```sh
/usr/bin/python3 -m pip install --user pyserial     # macOS
sudo apt install python3-serial                     # Raspberry Pi OS / Debian
pipx install pyserial                               # externally-managed environments
```

⚠️ On Raspberry Pi OS Bookworm and later, `pip3 install pyserial` is refused
(PEP 668). Use apt or a venv. Reaching `/dev/ttyACM0` also needs the `dialout`
group: `sudo usermod -aG dialout $USER`, then log out and back in.

Check which interpreter actually has it:

```sh
python3 -c "import sys, serial; print(sys.executable, serial.VERSION)"
```

Because `python3` resolves differently in different shells, `pd_port.py`
finds an interpreter that has pyserial and re-executes itself under it. If none
exists it prints platform-specific install instructions and stops. Force a
particular one with `PYTHON=/path/to/python3` in front of the command.

Optional: `reportlab` for `--print pdf` (falls back to text mode without it), and
`Pillow` for image rendering.

## Tests

```sh
./src/host/tests/run.sh
```

Safe to run with the cartridge plugged in: every test that starts a server hands
it a pseudo-terminal through `--port`, so `find_port()` is never called and a
live session is never disturbed. Checks needing assets you may not have (a kanji
ROM, a CJK font) skip rather than fail.
