#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""msx_printer_escp_render, checked against a real ESC/P stream captured through openMSX.

`escp_boxx.prn` is a bordered box with an X, drawn as an ESC K 8-dot bit-image
and captured *byte-for-byte* by openMSX's printer logger - so it's a genuine
ESC/P stream, not our own synthetic one. openMSX's independent FX-80 emulation
renders the same box+X from it. This checks our renderer reproduces that shape,
contiguously (the 8/9-pin ESC 3 = n/216" spacing, which a cross-check against
openMSX is exactly what first exposed).

Regenerate / re-cross-check with escp_prn_to_cart.py + openMSX (see its header).
"""
import os
import sys

# pdtest (shared harness) stays in the sibling tests/ dir - reach it from here.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests"))
import pdtest                                    # noqa: F401  (path setup)
from pdtest import Checks

import msx_printer_escp_render as e

c = Checks("msx_printer_escp_render")

# The built-in synthetic round-trip - a rigorous parser check on its own.
c("selftest passes", e._selftest("/tmp/escp_selftest_t") == 0)

# Render the openMSX-captured fixture and check the box+X.
fixture = os.path.join(os.path.dirname(__file__), "escp_boxx.prn")
pages = e.render(open(fixture, "rb").read())
# The trailing FF opens a fresh (empty) page after the content, so filter.
content = [pg for pg in pages if not pg.empty()]
c("one page of content", len(content) == 1, len(pages))

p = content[0]
# ESC K = 8-dot, 60 dpi horizontal: 48 columns -> 48*3 = 144 px wide.
c("content ~144 px wide (48 cols x 3)", 138 <= p.maxx + 1 <= 150, p.maxx + 1)
# 3 bands of 8 dots, stacked contiguously (n/216 spacing): 3 * 20 = 60 px tall.
# The /180 bug would make this ~68 with gaps between bands.
c("bands contiguous, ~60 px tall (not ~68)", 54 <= p.maxy + 1 <= 64, p.maxy + 1)
# It is a box outline - all four corners of the content sit on the border.
c("box top-left set", e._get(p, 1, 1) == 1)
c("box top-right set", e._get(p, p.maxx - 1, 1) == 1)
c("box bottom-left set", e._get(p, 1, p.maxy - 1) == 1)
c("box bottom-right set", e._get(p, p.maxx - 1, p.maxy - 1) == 1)

# ---------------------------------------------------------------------------
# The interpreter extensions cross-ported from DOSBox-X / openMSX (v0.28.0).
# Geometry facts used below: canvas 180 dpi, pica char cell = 18 px (1/10"),
# 9-pin vertical pitch = 2.5 px.
# ---------------------------------------------------------------------------

# Text rendering via the MSX International character ROM (the default charset).
r = e.Renderer().feed(b"Hello")
c("text renders dots", not r.pages[0].empty())
c("text advance = 5 chars x 18px", 80 <= r.pages[0].maxx <= 92, r.pages[0].maxx)
c("text bytes counted", r.text_bytes == 5, r.text_bytes)

# ESC ! master select bit5 = double width: same text twice as wide.
w = e.Renderer().feed(bytes([27, 0x21, 0x20]) + b"Hello").pages[0].maxx
c("master-select double width doubles advance", 165 <= w <= 184, w)

# ESC ^ = 9-pin graphics, 2 bytes/column, 2nd byte MSB = 9th pin.
p9 = e.Renderer().feed(bytes([27, 94, 0, 4, 0]) + b"\xff\x80" * 4).pages[0]
c("ESC ^ 9-pin: 4 cols x 3px wide", 10 <= p9.maxx <= 13, p9.maxx)
c("ESC ^ 9-pin: 9 pins ~22px tall", 19 <= p9.maxy <= 24, p9.maxy)

# ESC ? reassigns the density ESC K uses (here: mode 3 = 240 dpi).
pk = e.Renderer().feed(bytes([27, 63, 75, 3, 27, 75, 8, 0]) + b"\xff" * 8).pages[0]
c("ESC ? reassign: 8 cols at 240dpi stay narrow", pk.maxx <= 7, pk.maxx)

# ESC C 0 n = form length in inches; LF past the bottom opens a new page.
rp = e.Renderer().feed(bytes([27, 67, 0, 1]) + b"X\n" * 8)
c("page length: LFs page-break", len(rp.pages) >= 2, len(rp.pages))

# ESC $ = absolute horizontal position in n/60 inch.
ra = e.Renderer().feed(bytes([27, 36, 60, 0]) + b"A").pages[0]
c("ESC $ 60/60in -> x=180px", 178 <= ra.minx <= 185, ra.minx)

# HT: power-on tabs every 8 columns; ESC D sets custom stops.
c("HT default tab at col 8", 140 <= e.Renderer().feed(b"\tA").pages[0].minx <= 150)
rd = e.Renderer().feed(bytes([27, 68, 4, 0]) + b"\tA").pages[0]
c("ESC D custom tab at col 4", 70 <= rd.minx <= 78, rd.minx)

# ESC + n = n/360" line spacing (the last gap vs DOSBox-X): 90/360" = 45px.
rplus = e.Renderer().feed(bytes([27, 0x2B, 90]) + b"X\n" * 3 + b"X")
c("ESC + 90/360in -> 45px per line", 135 <= rplus.pages[0].maxy <= 165, rplus.pages[0].maxy)
c("ESC + is not unknown", not rplus.unknown, rplus.unknown)

# ESC b c n... = vertical tabs in a VFU channel. The channel byte is ignored,
# the stops are collected like ESC B - and neither may reach the paper as text.
rb = e.Renderer().feed(bytes([27, 0x62, 0, 5, 0]) + b"\x0bA")
c("ESC b sets vertical tabs", rb.vtabs and abs(rb.vtabs[0] - 150.0) < 1, rb.vtabs)
c("ESC b VT jumps to the stop", 148 <= rb.pages[0].miny <= 156, rb.pages[0].miny)
c("ESC b params not printed", rb.text_bytes == 1, rb.text_bytes)

# ESC ( x nL nH = the ESC/P2 extended block. Unknown ones carry their own byte
# count, so they are skipped exactly rather than printed as garbage glyphs.
rpar = e.Renderer().feed(bytes([27, 0x28, 0x56, 2, 0, 0xAA, 0xBB]) + b"A")
c("ESC ( payload skipped, not printed", rpar.text_bytes == 1, rpar.text_bytes)
c("ESC ( counted as unknown", ("ESC (", "V") in rpar.unknown, rpar.unknown)

# Unknown ESC codes are still counted, not crashed on.
c("unknown ESC counted", ("ESC", "z") in e.Renderer().feed(bytes([27, 0x7A])).unknown)

# ---------------------------------------------------------------------------
# Charsets (v0.31.0). Glyphs now come from openMSX's character ROM tables, and
# MSX takes priority over FX-80: the default charset is the MSX International
# ROM, whose upper region carries the accented letters at the CP437 codes.
# ---------------------------------------------------------------------------
import msx_printer_fonts as F                          # noqa: E402

c("default charset is an MSX ROM", e.DEFAULT_CHARSET == "msx", e.DEFAULT_CHARSET)
c("all charsets loadable", all(F.load(n) for n in F.NAMES), F.NAMES)
c("'cp437' selects FX-80 glyphs",
  e.Renderer(charset="cp437").font.name == "fx80")

# Every code 0x00-0xFF has a glyph in each charset (no index errors, no gaps).
for name in F.NAMES:
    f = F.load(name)
    spans = [f.glyph(x) for x in range(256)]
    c(f"{name}: 256 glyphs, sane proportional spans",
      all(0 <= s < en <= len(cols) for cols, s, en in spans))

# é (0x82) is the case that motivated all this. The MSX ROM has it at 0x82;
# a real FX-80 strips the high bit and prints 0x02 instead; --charset cp437
# remaps it onto the FX-80's own é so the accent survives.
def _dots(charset, byte):
    return not e.Renderer(charset=charset).feed(bytes([byte])).pages[0].empty()

c("msx: e-acute renders", _dots("msx", 0x82))
c("cp437: e-acute renders (mapped onto FX-80)", _dots("cp437", 0x82))
c("fx80: e-acute is stripped, as a real FX-80 does", not _dots("fx80", 0x82))
c("cp437 maps 0x82 -> FX-80 code 30", e._CP437_TO_FX80[0x82] == 30)

# n-tilde (0xA4) used to print as '$' (0xA4 & 0x7F = 0x24) under FX-80 rules.
nt_msx = e.Renderer(charset="msx").feed(bytes([0xA4])).pages[0]
nt_dollar = e.Renderer(charset="msx").feed(b"$").pages[0]
c("msx: n-tilde is not the '$' glyph",
  [bytes(r) for r in nt_msx.rows] != [bytes(r) for r in nt_dollar.rows])

# The MSX charsets must not treat the high bit as an italic flag.
c("msx charset keeps the high bit as data", F.load("msx").msx_charset)
c("fx80 charset uses FX-80 italic semantics", not F.load("fx80").msx_charset)

# msx-jp carries katakana where International has box drawing - so the same
# byte must render differently between the two ROMs.
def _rows(charset, byte):
    return [bytes(r) for r in e.Renderer(charset=charset).feed(bytes([byte])).pages[0].rows]

c("msx-jp differs from msx in the katakana region", _rows("msx-jp", 0xB1) != _rows("msx", 0xB1))
# ... while plain ASCII stays identical across the two.
c("msx-jp matches msx for ASCII 'A'", _rows("msx-jp", 0x41) == _rows("msx", 0x41))

# msx-din is International with a slashless zero: only '0' may differ.
c("msx-din differs from msx only at '0'",
  _rows("msx-din", 0x30) != _rows("msx", 0x30)
  and _rows("msx-din", 0x41) == _rows("msx", 0x41))

# A bad charset name is rejected, not silently ignored.
try:
    e.Renderer(charset="nope")
    c("unknown charset raises", False)
except ValueError:
    c("unknown charset raises", True)

sys.exit(c.done())
