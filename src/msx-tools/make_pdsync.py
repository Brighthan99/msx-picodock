#!/usr/bin/env python3
"""make_pdsync.py - build PDSYNC.COM without needing an assembler.

    ./src/msx-tools/make_pdsync.py dist/disk/system/PDSYNC.COM

The readable source of record is pdsync.s; build.sh assembles that and compares
the result against this, so the two cannot drift apart. This exists so the tool
can still be rebuilt where sdcc is not installed.

The problem
-----------
Files added to the image from the host do not show up on the MSX until it is
reset. That is not a bug in the transfer: Nextor has the directory, the FAT and
the drive's disk parameters cached, and nothing tells it the media changed
underneath. A real disk does not have this problem because the same OS wrote the
files and invalidated its own cache.

The fix
-------
Nextor's _LOCK function (77h) says:

    "Locking and unlocking operations cause all the buffers for the drive to be
     flushed and invalidated. Also, cached disk parameters for the media are
     deleted so the next access to the media will re-read them."

So locking then immediately unlocking a drive is a cache flush. PDSYNC.COM does
exactly that for the current drive, after which DIR shows the new files.

    A>PDSYNC        <- instead of resetting the MSX

Why a hand-assembled binary
---------------------------
It is about thirty bytes. Going through sdcc would drag in a crt0 and a linker
setup for something that fits on one screen, and the bytes here can be checked
against the opcode comments directly.
"""

import sys

BDOS = 0x0005
F_CURDRV = 0x19          # get current drive -> A (0=A:)
F_LOCK = 0x77            # Nextor: lock/unlock, flushes and invalidates buffers
F_STROUT = 0x09          # print $-terminated string
F_TERM = 0x00            # terminate

MSG = b"Disk buffers flushed - new files are visible now.\r\n$"


def build():
    code = bytearray()

    def emit(*b):
        code.extend(b)

    # --- which drive are we on? --------------------------------------------
    emit(0x0E, F_CURDRV)             # ld c,#19h
    emit(0xCD, BDOS & 0xFF, BDOS >> 8)   # call 0005h   -> A = current drive (0-based)
    emit(0x5F)                       # ld e,a          E = physical drive for _LOCK

    # --- lock: C=77h, E=drive, A=01 (set), B=FFh (lock) --------------------
    emit(0xD5)                       # push de         keep the drive number
    emit(0x0E, F_LOCK)               # ld c,#77h
    emit(0x06, 0xFF)                 # ld b,#0FFh      lock
    emit(0x3E, 0x01)                 # ld a,#01h       set lock status
    emit(0xCD, BDOS & 0xFF, BDOS >> 8)   # call 0005h
    emit(0xD1)                       # pop de

    # --- unlock: same call with B=00 ---------------------------------------
    # The flush happens on both transitions; unlocking again leaves the drive as
    # we found it, so normal media-change checking keeps working afterwards.
    emit(0x0E, F_LOCK)               # ld c,#77h
    emit(0x06, 0x00)                 # ld b,#00h       unlock
    emit(0x3E, 0x01)                 # ld a,#01h       set lock status
    emit(0xCD, BDOS & 0xFF, BDOS >> 8)   # call 0005h

    # --- say so and exit ----------------------------------------------------
    # The message sits right after the code. What follows this point is:
    #   ld de,msg (3) + ld c,#09 (2) + call (3) + ld c,#00 (2) + jp (3) = 13 bytes
    msg_addr = 0x0100 + len(code) + 13
    emit(0x11, msg_addr & 0xFF, msg_addr >> 8)  # ld de,msg
    emit(0x0E, F_STROUT)             # ld c,#09h
    emit(0xCD, BDOS & 0xFF, BDOS >> 8)   # call 0005h
    emit(0x0E, F_TERM)               # ld c,#00h
    emit(0xC3, BDOS & 0xFF, BDOS >> 8)   # jp 0005h     terminate

    assert 0x0100 + len(code) == msg_addr, (hex(0x0100 + len(code)), hex(msg_addr))
    code.extend(MSG)
    return bytes(code)


def main(argv):
    out = argv[1] if len(argv) > 1 else "PDSYNC.COM"
    data = build()
    with open(out, "wb") as f:
        f.write(data)
    print(f"[+] {out}  {len(data)} bytes")
    print("    put it on the disk, then run PDSYNC on the MSX after adding files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
