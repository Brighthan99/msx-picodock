#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""Regenerate the msx_printer_kanji_render test target (golden PNG).

The source fixture `msxwrite_nihongo.prn` is a real capture: MSX-Write (ASCII
1986, official openMSX extension on a Sony HB-F1XD) printing the line
"日本語ｍｓｘｗｒｉｔｅ", logged byte-for-byte by openMSX's printer logger.
It contains no pixels - only `ESC K + JIS` codes - so rendering needs a kanji
font ROM.

Real kanji ROMs are copyrighted and stay out of the repo. `synth_rom()` builds
a deterministic 128kB stand-in instead: every glyph is a 16x16 border box that
shows its own JIS code as four hex digits - so the golden PNG is readable by
eye ("467C 4B5C 386C ..." = 日 本 語 ...). Glyphs are written through
pack_glyph() so the test also round-trips the quadrant byte layout. The golden
`msxwrite_nihongo_golden.png` is the fixture rendered with that synthetic ROM.

    python3 make_msx_kanji_fixtures.py     # rewrites the golden PNG

(For an eyeball check against the real font, render manually:
    python3 ../printer/msx_printer_escp_render.py --kanji-rom <KNJFNT16.ROM> msxwrite_nihongo.prn)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # host/printer/
import msx_printer_kanji_render as mk

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "msxwrite_nihongo.prn")
GOLDEN = os.path.join(HERE, "msxwrite_nihongo_golden")     # .png appended


# 3x5 hex digit font, one int per row (3 bits, MSB left).
_DIGITS = {
    "0": (7, 5, 5, 5, 7), "1": (2, 6, 2, 2, 7), "2": (7, 1, 7, 4, 7),
    "3": (7, 1, 7, 1, 7), "4": (5, 5, 7, 1, 1), "5": (7, 4, 7, 1, 7),
    "6": (7, 4, 7, 5, 7), "7": (7, 1, 2, 2, 2), "8": (7, 5, 7, 5, 7),
    "9": (7, 5, 7, 1, 7), "A": (2, 5, 7, 5, 5), "B": (6, 5, 6, 5, 6),
    "C": (7, 4, 4, 4, 7), "D": (6, 5, 5, 5, 6), "E": (7, 4, 7, 4, 7),
    "F": (7, 4, 7, 4, 4),
}


def index_to_jis(idx):
    """Inverse of msx_printer_kanji_render.jis_index (within the first 128kB half)."""
    if idx >= 0x400:
        return 0x30 + (idx - 0x400) // 96, 0x20 + (idx - 0x400) % 96
    return 0x20 + idx // 96, 0x20 + idx % 96


def synth_glyph_rows(idx):
    """Deterministic, human-readable 16x16 glyph for index `idx`: a full
    border box showing the char's own JIS code as four 3x5 hex digits."""
    rows = [0xFFFF] + [0x8001] * 14 + [0xFFFF]
    j1, j2 = index_to_jis(idx)
    for k, ch in enumerate(f"{j1:02X}{j2:02X}"):
        ox = 3 + (k % 2) * 7                            # digit origin in cell
        oy = 2 + (k // 2) * 7
        for dy, bits3 in enumerate(_DIGITS[ch]):
            rows[oy + dy] |= (bits3 & 7) << (13 - ox)
    return rows


def synth_rom():
    """A full 128kB (JIS1) synthetic kanji font ROM."""
    rom = bytearray(0x20000)
    for idx in range(len(rom) // 32):
        rom[idx * 32:(idx + 1) * 32] = mk.pack_glyph(synth_glyph_rows(idx))
    return bytes(rom)


def main():
    data = open(SOURCE, "rb").read()
    paths, r = mk.render_to_png(data, synth_rom(), GOLDEN)
    print(f"[+] {SOURCE.split('/')[-1]}: {r.chars} chars -> {paths}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
