#!/usr/bin/env python3
"""ihx2rom.py - Intel HEX (.ihx) to a fixed-size MSX ROM image.

The original msx/Makefile uses `hex2bin -e ROM -s 0x4000 -l 0x8000`, but hex2bin
is not available on macOS (there is no brew formula either). sdcc's makebin
always emits from address 0, so getting an image that starts at 0x4000 would
need post-processing. Doing the conversion explicitly is clearer - it leaves no
ambiguity about the layout.

    ihx2rom.py <in.ihx> <out.rom> [--start 0x4000] [--size 0x8000] [--fill 0xFF]

Records outside the start/size window are an error rather than being silently
truncated: silent truncation is very hard to diagnose later.
"""

import sys


def parse_ihx(path):
    """Flatten the file into a {address: byte} dict. Segment/extended records are
    not used here, so only type 00 (data) and 01 (EOF) are accepted; anything
    else is rejected explicitly."""
    mem = {}
    with open(path, "r", encoding="ascii") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            if not line.startswith(":"):
                raise ValueError(f"{path}:{lineno}: does not start with ':'")
            raw = bytes.fromhex(line[1:])
            count, addr_hi, addr_lo, rectype = raw[0], raw[1], raw[2], raw[3]
            addr = (addr_hi << 8) | addr_lo
            data = raw[4:4 + count]
            if (sum(raw) & 0xFF) != 0:
                raise ValueError(f"{path}:{lineno}: checksum mismatch")
            if rectype == 0x01:
                break
            if rectype != 0x00:
                raise ValueError(f"{path}:{lineno}: unsupported record type {rectype:02X}")
            for i, b in enumerate(data):
                mem[addr + i] = b
    return mem


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1

    src, dst = argv[1], argv[2]
    start, size, fill = 0x4000, 0x8000, 0xFF

    i = 3
    while i < len(argv):
        opt = argv[i]
        val = int(argv[i + 1], 0)
        if opt == "--start":
            start = val
        elif opt == "--size":
            size = val
        elif opt == "--fill":
            fill = val
        else:
            print(f"unknown option: {opt}")
            return 1
        i += 2

    mem = parse_ihx(src)
    if not mem:
        print("[-] no data records found")
        return 1

    lo, hi = min(mem), max(mem)
    if lo < start or hi >= start + size:
        print(f"[-] code falls outside the image window: "
              f"0x{lo:04X}-0x{hi:04X} vs 0x{start:04X}-0x{start + size - 1:04X}")
        return 1

    rom = bytearray([fill]) * size
    for addr, b in mem.items():
        rom[addr - start] = b

    with open(dst, "wb") as f:
        f.write(rom)

    used = len(mem)
    print(f"[+] {dst}  {size} bytes  (start 0x{start:04X}, "
          f"code 0x{lo:04X}-0x{hi:04X}, used {used} bytes / {used * 100 // size}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
