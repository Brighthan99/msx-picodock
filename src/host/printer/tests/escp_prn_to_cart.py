#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""escp_prn_to_cart.py - wrap an ESC/P (.prn) stream in a 16KB MSX cartridge ROM.

On boot the cartridge's INIT routine writes every byte of the embedded stream to
the printer port (OUT 0x91 data / OUT 0x90 strobe), then halts. Run it in openMSX
with a printer device plugged and you get that stream through a real emulated
printer port - no hardware, no copyrighted BIOS (C-BIOS is enough). This is how
msx_printer_escp_render.py (host/printer/) is cross-checked against openMSX's independent FX-80 emulation.

    python3 escp_prn_to_cart.py in.prn out.rom

Cross-check recipe (needs `brew install openmsx`):

    # 1. capture the stream byte-for-byte back out (sanity: == in.prn)
    openmsx -machine C-BIOS_MSX2+ -cart out.rom -command \\
      'set printerlogfilename cap.prn ; plug printerport logger ; after realtime 6 {exit}'

    # 2. render it with openMSX's FX-80 emulation -> ~/.openMSX/prints/page0001.png
    openmsx -machine C-BIOS_MSX2+ -cart out.rom -command \\
      'plug printerport epson-printer ; after realtime 6 {exit}'

    # 3. render the same stream with ours, and compare the two PNGs
    python3 ../msx_printer_escp_render.py in.prn mine
"""
import sys

BASE = 0x4000


def prn_to_cart(stream):
    stream = bytes(stream)
    if len(stream) > 0x4000 - 0x2A:
        raise ValueError(f"stream too big for a 16KB cart ({len(stream)} bytes)")
    rom = bytearray(b"\xff" * 0x4000)
    rom[0:2] = b"AB"                                  # ROM signature
    rom[2], rom[3] = 0x10, 0x40                       # INIT vector -> 0x4010
    stream_addr = 0x402A
    code = bytes([
        0x21, stream_addr & 0xFF, stream_addr >> 8,  # ld hl, stream
        0x01, len(stream) & 0xFF, len(stream) >> 8,  # ld bc, len
        0x7E,                                        # loop: ld a,(hl)
        0xD3, 0x91,                                  # out (0x91),a   ; data
        0xAF,                                        # xor a
        0xD3, 0x90,                                  # out (0x90),a   ; strobe low
        0x3E, 0x01,                                  # ld a,1
        0xD3, 0x90,                                  # out (0x90),a   ; strobe high
        0x23, 0x0B,                                  # inc hl : dec bc
        0x78, 0xB1,                                  # ld a,b : or c
        0x20, 0xF0,                                  # jr nz, loop
        0xF3, 0x76, 0x18, 0xFD,                      # di : halt : jr halt
    ])
    assert 0x4010 + len(code) == stream_addr
    rom[0x4010 - BASE:0x4010 - BASE + len(code)] = code
    rom[stream_addr - BASE:stream_addr - BASE + len(stream)] = stream
    assert len(rom) == 0x4000
    return bytes(rom)


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    stream = open(argv[0], "rb").read()
    open(argv[1], "wb").write(prn_to_cart(stream))
    print(f"[+] {len(stream)} bytes -> {argv[1]} (16384-byte cartridge)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
