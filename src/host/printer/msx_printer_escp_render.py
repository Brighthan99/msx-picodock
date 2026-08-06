#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
#
# Interpreter logic cross-ported from two GPL reference emulators so the
# behaviour (parameter consumption, units, page handling) stays comparable:
#   - DOSBox-X src/hardware/parport/printer.cpp   (GPL-2.0-or-later)
#   - openMSX  src/Printer.cc  ImagePrinterEpson  (GPL-2.0-or-later)
# Glyph sets come from msx_printer_fonts (extracted from openMSX, GPL-2.0+).
# The combined printer/ package is therefore GPL-2.0-only; see LICENSE
# and NOTICE.md in this directory.
"""msx_printer_escp_render.py - ESC/P printer stream -> raster page PNG.

A 9-pin-era (Epson FX-80 compatible) ESC/P interpreter that reconstructs each
printed page as a 1-bit PNG: bit-image graphics (ESC * / K / L / Y / Z / ^),
text, print styles, tabs, margins and page breaks. 24-pin ESC * modes
(32..40, 71..73) used by MSX Japanese word processors work on the same canvas.

Text is drawn with a real character ROM - see --charset. **MSX takes priority
over FX-80**: the default `msx` charset is the MSX's own International font, so
the upper region (accented letters, currency, box drawing, greek) prints as the
machine actually printed it. Pick `fx80` for period-correct Epson behaviour
instead, where the high bit means italics and accents live at 0x00-0x1F.

Some MSX software instead sends `ESC K + JIS code` per character and relies on
the printer's kanji ROM - that is a different dialect with a *conflicting*
ESC K opcode, handled by msx_printer_kanji_render.py (which needs a kanji font
ROM dump). The CLI picks the dialect automatically; see --dialect below.

Dependency-free: Python stdlib only (zlib for PNG; no Pillow/numpy). Unknown
ESC sequences are skipped and counted (see .unknown).

CLI:
    python3 msx_printer_escp_render.py job.prn [out_prefix]   # -> job_p1.png, job_p2.png ...
    python3 msx_printer_escp_render.py --charset fx80 job.prn
        --charset msx|msx-din|msx-jp|fx80|cp437   glyph set (default: msx)
            msx      MSX International character ROM               <- default
            msx-din  ditto, DIN variant (slashless zero)
            msx-jp   MSX Japanese ROM (katakana at 0xA1-0xDF)
            fx80     Epson FX-80 ROM, period-correct (high bit = italics)
            cp437    fx80 glyphs + CP437 upper region remapped onto them
    python3 msx_printer_escp_render.py --dialect auto --kanji-rom KNJFNT16.ROM job.prn
        --dialect escp|msx-kanji|auto   dialect selection (default: auto)
        --kanji-rom PATH                font ROM for the msx-kanji dialect
        --font PATH.ttf [--font-size N] render msx-kanji with a modern TTF/OTF
                                        instead (via msx_printer_kanji_render, needs Pillow)
    python3 msx_printer_escp_render.py --selftest [out_prefix]  # render a synthetic pattern

To re-render a capture under a different charset without re-printing, see
msx_printer_recharset.py.

Library:
    pages = render(data_bytes[, charset])          # -> list[Page]
    paths = render_to_png(data, "out"[, charset])  # -> list of PNG paths written
"""

import os
import sys
import zlib
import struct

# --- ESC/P bit-image modes -------------------------------------------------
# dens -> (bytes/column, vertical dot pitch dpi, horizontal dpi, adjacent)
# 8-dot heads print at 72 dpi vertically, 24-dot at 180, 48-dot at 360.
# `adjacent` False = high-speed mode that cannot fire the same pin twice in a
# row; the reference emulators draw those with 1px dots (no horizontal fill).
_MODES = {
    0:  (1, 72, 60, True),   1: (1, 72, 120, True),  2: (1, 72, 120, False),
    3:  (1, 72, 240, False), 4: (1, 72, 80, True),   5: (1, 72, 72, True),
    6:  (1, 72, 90, True),
    32: (3, 180, 60, True),  33: (3, 180, 120, True), 38: (3, 180, 90, True),
    39: (3, 180, 180, True), 40: (3, 180, 360, False),
    71: (6, 360, 180, True), 72: (6, 360, 360, False), 73: (6, 360, 360, True),
}
VDPI = 180.0                      # canvas resolution (both axes), dots/inch


def _mode_info(m):
    if m in _MODES:
        return _MODES[m]
    # sensible default for an unlisted mode: 24-dot heads use m>=32.
    return (3, 180, 180, True) if m >= 32 else (1, 72, 120, True)


# --- minimal 1-bit PNG writer (stdlib only) --------------------------------
def _png_chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def write_png_1bit(path, width, height, rows):
    """rows: `height` bytearrays of ((width+7)//8) bytes, bit=1 => printed dot.
    PNG grayscale/1 uses 0=black, so dots are inverted on the way out."""
    ihdr = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    raw = bytearray()
    for r in rows:
        raw.append(0)                                   # filter: none
        raw.extend(bytes((~b) & 0xFF for b in r))       # dot(1) -> black(0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(_png_chunk(b"IHDR", ihdr))
        f.write(_png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(_png_chunk(b"IEND", b""))


# --- a growable 1-bit page -------------------------------------------------
class Page:
    def __init__(self, width):
        self.width = width
        self.stride = (width + 7) // 8
        self.rows = []
        self.minx = self.miny = 1 << 30
        self.maxx = self.maxy = -1

    def _ensure(self, y):
        while len(self.rows) <= y:
            self.rows.append(bytearray(self.stride))

    def plot(self, x, y):
        if x < 0 or y < 0 or x >= self.width or y > 1 << 20:
            return
        self._ensure(y)
        self.rows[y][x >> 3] |= (0x80 >> (x & 7))
        if x < self.minx: self.minx = x
        if x > self.maxx: self.maxx = x
        if y < self.miny: self.miny = y
        if y > self.maxy: self.maxy = y

    def empty(self):
        return self.maxx < 0

    def to_png(self, path, margin=8):
        if self.empty():
            write_png_1bit(path, 8, 8, [bytearray(1) for _ in range(8)])
            return
        y0 = max(0, self.miny - margin)
        y1 = min(len(self.rows) - 1, self.maxy + margin)
        out_stride = ((self.maxx + margin) >> 3) + 1
        out_w = out_stride * 8
        out = [bytes(self.rows[y][:out_stride]).ljust(out_stride, b"\x00")
               for y in range(y0, y1 + 1)]
        write_png_1bit(path, out_w, y1 - y0 + 1, [bytearray(r) for r in out])


# --- glyph sets ------------------------------------------------------------
import msx_printer_fonts

CHARSETS = msx_printer_fonts.NAMES + ("cp437",)
DEFAULT_CHARSET = msx_printer_fonts.DEFAULT          # 'msx' - MSX before FX-80


# CP437 (= the MSX International upper region) -> FX-80 internal code.
#
# Only needed for --charset cp437, i.e. the FX-80 glyph set: a real FX-80 keeps
# its accented letters at 0x00-0x1F (normally reached through ESC R) and uses
# the high bit for italics, so an MSX that prints é (0x82) would otherwise get
# the high bit stripped and print 0x02 instead. The MSX charsets need no mapping
# at all - their tables already hold these glyphs at these very codes.
#
# Derived from the ESC R substitution tables below, which pair each FX-80
# internal code with the character it stands for.
_CP437_TO_FX80 = {
    0x80: 15,   # ç
    0x81: 28,   # ü
    0x82: 30,   # é
    0x84: 26,   # ä
    0x85: 0,    # à
    0x87: 15,   # ç  (no cedilla-C glyph; fall back to lowercase)
    0x8A: 1,    # è
    0x8B: 4,    # ï  -> ì  (nearest available)
    0x8C: 4,    # î  -> ì
    0x8D: 4,    # ì
    0x8E: 23,   # Ä
    0x8F: 13,   # Å
    0x91: 19,   # æ
    0x93: 3,    # ô  -> ò  (nearest available)
    0x94: 27,   # ö
    0x95: 3,    # ò
    0x97: 2,    # ù
    0x99: 24,   # Ö
    0x9A: 25,   # Ü
    0x9B: 20,   # ¢ -> Ø   (FX-80 has no cent sign)
    0x9C: 6,    # £
    0x9D: 31,   # ¥
    0x9E: 12,   # ₧
    0xA0: 0,    # á -> à
    0xA1: 4,    # í -> ì
    0xA2: 3,    # ó -> ò
    0xA3: 2,    # ú -> ù
    0xA4: 10,   # ñ
    0xA5: 9,    # Ñ
    0xA8: 8,    # ¿
    0xAD: 7,    # ¡
    0xE1: 17,   # ß
}


# International character code translation (FX-80), same tables as openMSX:
#              US   FR   DE   GB   DK   SE   IT   SP   JP
_INTL = {
    35:  ( 35,  35,  35,   6,  35,  35,  35,  12,  35),
    36:  ( 36,  36,  36,  36,  36,  11,  36,  36,  36),
    64:  ( 64,   0,  16,  64,  64,  29,  64,  64,  64),
    91:  ( 91,   5,  23,  91,  18,  23,   5,   7,  91),
    92:  ( 92,  15,  24,  92,  20,  24,  92,   9,  31),
    93:  ( 93,  16,  25,  93,  13,  13,  30,   8,  93),
    94:  ( 94,  94,  94,  94,  94,  25,  94,  94,  94),
    96:  ( 96,  96,  96,  96,  96,  30,   2,  96,  96),
    123: (123,  30,  26, 123,  19,  26,   0,  22, 123),
    124: (124,   2,  27, 124,  21,  27,   3,  10, 124),
    125: (125,   1,  28, 125,  14,  14,   1, 125, 125),
    126: (126,  22,  17, 126, 126,  28,   4, 126, 126),
}


# --- the ESC/P interpreter -------------------------------------------------
ESC = 0x1B
FS = 0x1C


class Renderer:
    def __init__(self, width=2000, charset=DEFAULT_CHARSET):
        self.width = width
        self.pages = [Page(width)]
        self.unknown = {}                               # (kind, code) -> count
        self.text_bytes = 0                             # printable bytes seen
        # 'cp437' is the FX-80 glyph set plus the upper-region mapping above.
        self.charset = charset
        self.cp437 = charset == "cp437"
        self.font = msx_printer_fonts.load("fx80" if self.cp437 else charset)
        self._reset()

    # ESC @ / power-on state. Does not clear already-rendered pages.
    def _reset(self):
        self.xf = 0.0                                   # x cursor (px, float)
        self.yf = 0.0                                   # y cursor (px, float)
        self.line_mode = "default"                      # 'default'|'3'|'A'|'fixed'
        self.line_val = None
        self.denom = 216                                # ESC 3/J: 216 (8/9-pin) or 180 (24-pin)
        self.page_px = int(round(11.0 * VDPI))          # form length
        self.top_px = 0.0
        self.bottom_px = float(self.page_px)
        self.left_px = 0.0
        self.right_px = float(self.width)
        self.cpi = 10.0                                 # pica; ESC M/P/g/!
        self.condensed = False                          # SI / DC2
        self.double_width = False                       # ESC W / ESC !
        self.dw_oneline = False                         # SO / DC4 (one line)
        self.bold = False                               # ESC E/F (emphasized)
        self.double_strike = False                      # ESC G/H
        self.underline = False                          # ESC -
        self.italic = False                             # ESC 4/5
        self.superscript = False                        # ESC S 0
        self.subscript = False                          # ESC S 1 / ESC T
        self.proportional = False                       # ESC p
        self.intersp_px = 0.0                           # ESC SP
        self.country = 0                                # ESC R (0=USA .. 8=Japan)
        self.upper_ctrl = False                         # ESC 6/7: 0x80-0x9F as glyphs
        self.alt_ctrl = False                           # ESC I: 0x00-0x1F as glyphs
        self.msb = None                                 # ESC = / > / # on text bytes
        self.htabs = None                               # None = every 8 columns
        self.vtabs = None                               # None = power-on (VT acts as LF)
        self.dens = {0x4B: 0, 0x4C: 1, 0x59: 2, 0x5A: 3}  # ESC K/L/Y/Z (ESC ?)
        self.ram_chars = {}                             # ESC & / ESC :
        self.use_ram = False                            # ESC %

    @property
    def page(self):
        return self.pages[-1]

    def _newpage(self):
        self.pages.append(Page(self.width))
        self.xf = self.left_px
        self.yf = self.top_px

    def _line_px(self):
        """Current line-feed distance in canvas px. ESC 3/J use `denom` (216 for
        8/9-pin, 180 for 24-pin) so bit-image bands stack contiguously either way."""
        if self.line_mode == "3":
            return self.line_val * VDPI / self.denom
        if self.line_mode == "A":
            return self.line_val * VDPI / 72.0
        if self.line_mode == "fixed":
            return self.line_val
        return VDPI / 6.0                               # default 1/6"

    def _linefeed(self):
        self.xf = self.left_px
        self.dw_oneline = False
        self.yf += self._line_px()
        if self.yf > self.bottom_px - 0.5:
            self._newpage()

    # -- text ---------------------------------------------------------------
    def _cpi_eff(self):
        """Characters per inch after pitch/condensed (double width halves it)."""
        cpi = self.cpi
        if self.condensed:
            cpi = 20.0 if cpi >= 12 else 17.16          # elite+SI = 20 cpi
        if self.double_width or self.dw_oneline:
            cpi /= 2.0
        return cpi

    def _glyph(self, ch):
        """(columns, start, end) for `ch`, honoring the RAM set (ESC & / %).

        `columns` are 9-bit vertical slices, bit 8 the top pin; [start:end] is
        the proportional span. See msx_printer_fonts for the storage format."""
        if self.use_ram and ch in self.ram_chars:
            attr, cols = self.ram_chars[ch]
            if attr == "rom":
                return cols, 0, len(cols)
            # 8-bit download data: attribute bit7 = use the top 8 of 9 pins.
            cols = [c << 1 if attr & 0x80 else c for c in cols]
            return cols, 0, len(cols)
        return self.font.glyph(ch)

    def _advance_px(self, ch):
        """Horizontal advance for one character, in canvas px."""
        if self.proportional:
            _, start, end = self._glyph(ch)
            # Proportional advance is the glyph's own span, in the font's column
            # pitch (a cell is `font.columns` columns wide at the current cpi).
            adv = (end - start + 1) * (VDPI / self.cpi) / self.font.columns
            if self.double_width or self.dw_oneline:
                adv *= 2.0
        else:
            adv = VDPI / self._cpi_eff()
        return adv + self.intersp_px

    def _text(self, ch):
        """Render one printable byte (already italic/international-mapped)."""
        self.text_bytes += 1
        adv = self._advance_px(ch)
        if self.xf + adv > self.right_px:               # FX-80 auto CR/LF
            self._linefeed()
        cols, start, end = self._glyph(ch)
        if cols:
            if self.proportional:
                cols = cols[start:end]
            # The glyph's columns span the character cell (cell = 1/cpi inch).
            cell = adv - self.intersp_px
            step = cell / max(1, len(cols))
            pitch = VDPI / 72.0                         # 9-pin vertical pitch
            yoff = 0.0
            if self.superscript or self.subscript:
                pitch /= 2.0
                if self.subscript:
                    yoff = 4.5 * (VDPI / 72.0)
            # MSX charsets have no italic glyph page, so slant them by hand -
            # a real MSX printer does the same for ESC 4.
            shear = (pitch * 0.5) if (self.italic and self.font.msx_charset) else 0.0
            dw = max(1, int(step) + 1)
            dh = max(1, int(pitch) + 1)
            passes = [(0.0, 0.0)]
            if self.bold:
                passes.append((step / 2.0, 0.0))        # emphasized: half-dot right
            if self.double_strike:
                passes.append((0.0, VDPI / 216.0))      # second pass slightly down
            for ox, oy in passes:
                for k, col in enumerate(cols):
                    if not col:
                        continue
                    x0 = self.xf + ox + k * step
                    for i in range(9):
                        if col & (1 << (8 - i)):
                            xi = int(round(x0 + (8 - i) * shear))
                            yi = int(round(self.yf + oy + yoff + i * pitch))
                            for dy in range(dh):
                                for dx in range(dw):
                                    self.page.plot(xi + dx, yi + dy)
        if self.underline:
            yi = int(round(self.yf + 8 * (VDPI / 72.0)))
            for x in range(int(round(self.xf)), int(round(self.xf + adv))):
                for dy in range(2):
                    self.page.plot(x, yi + dy)
        self.xf += adv

    # -- graphics -----------------------------------------------------------
    def _bitimage(self, m, data, ninepin=False):
        if ninepin:
            bpc, dot_vdpi, h_dpi, adjacent = 2, 72, (120 if m else 60), True
        else:
            bpc, dot_vdpi, h_dpi, adjacent = _mode_info(m)
        self.denom = 216 if dot_vdpi == 72 else 180     # 8/9-pin n/216", 24-pin n/180"
        xadv = VDPI / h_dpi                             # canvas px per column
        vscale = VDPI / dot_vdpi                        # canvas px per printer dot
        xw = max(1, int(round(xadv))) if adjacent else 1
        yh = max(1, int(round(vscale)))
        ncols = len(data) // bpc
        for c in range(ncols):
            xi = int(round(self.xf))
            base = c * bpc
            for bi in range(bpc):
                col = data[base + bi]
                if not col:
                    continue
                if ninepin and bi == 1:                 # 2nd byte: MSB = 9th pin
                    if col & 0x80:
                        yi = int(round(self.yf + 8 * vscale))
                        for dy in range(yh):
                            for dx in range(xw):
                                self.page.plot(xi + dx, yi + dy)
                    continue
                for bit in range(8):
                    if col & (0x80 >> bit):
                        yi = int(round(self.yf + (bi * 8 + bit) * vscale))
                        for dy in range(yh):
                            for dx in range(xw):
                                self.page.plot(xi + dx, yi + dy)
            self.xf += xadv

    # -- ESC/FS command dispatch --------------------------------------------
    def _u16(self, data, i):
        return data[i] + (data[i + 1] << 8)

    def _tablist(self, data, i, n, unit, limit):
        """Collect an ESC D / ESC B tab list: ascending stops terminated by NUL
        (an out-of-order value also ends the list, as on a real printer)."""
        tabs = []
        while i < n and data[i] != 0:
            v = data[i] * unit
            if tabs and v <= tabs[-1]:
                break
            if len(tabs) < limit:
                tabs.append(v)
            i += 1
        if i < n and data[i] == 0:
            i += 1
        return i, tabs

    def _escape(self, data, i, n):
        if i >= n:
            return n
        cmd = data[i]
        i += 1

        # ---- bit-image ----
        if cmd == 0x2A:                                 # ESC * m nL nH data
            if i + 2 >= n:
                return n
            m = data[i]
            length = self._u16(data, i + 1) * _mode_info(m)[0]
            i += 3
            self._bitimage(m, data[i:i + length])
            return i + length
        if cmd in (0x4B, 0x4C, 0x59, 0x5A):             # ESC K/L/Y/Z nL nH data
            if i + 1 >= n:
                return n
            m = self.dens[cmd]
            length = self._u16(data, i) * _mode_info(m)[0]
            i += 2
            self._bitimage(m, data[i:i + length])
            return i + length
        if cmd == 0x5E:                                 # ESC ^ d nL nH data (9-pin)
            # NOTE: ESC/P2 redefines ESC ^ as "print next control code"; the
            # FX-80 9-pin graphics meaning is what MSX-era software uses.
            if i + 2 >= n:
                return n
            m = data[i]
            length = self._u16(data, i + 1) * 2
            i += 3
            self._bitimage(m, data[i:i + length], ninepin=True)
            return i + length
        if cmd == 0x3F:                                 # ESC ? c m : reassign K/L/Y/Z
            if i + 1 >= n:
                return n
            if data[i] in self.dens:
                self.dens[data[i]] = data[i + 1]
            return i + 2

        # ---- line spacing ----
        if cmd == 0x30:                                 # ESC 0 : 1/8"
            self.line_mode, self.line_val = "fixed", VDPI / 8.0; return i
        if cmd == 0x31:                                 # ESC 1 : 7/72"
            self.line_mode, self.line_val = "fixed", VDPI * 7.0 / 72.0; return i
        if cmd == 0x32:                                 # ESC 2 : 1/6"
            self.line_mode, self.line_val = "fixed", VDPI / 6.0; return i
        if cmd == 0x33:                                 # ESC 3 n : n/216" (n/180" on 24-pin)
            if i >= n: return n
            self.line_mode, self.line_val = "3", data[i]; return i + 1
        if cmd == 0x41:                                 # ESC A n : n/72"
            if i >= n: return n
            self.line_mode, self.line_val = "A", data[i]; return i + 1
        if cmd == 0x2B:                                 # ESC + n : n/360" (= FS 3)
            if i >= n: return n
            self.line_mode, self.line_val = "fixed", data[i] * VDPI / 360.0
            return i + 1

        # ---- paper motion / page ----
        if cmd == 0x4A:                                 # ESC J n : one-shot feed n/denom"
            if i >= n: return n
            self.yf += data[i] * VDPI / self.denom
            if self.yf > self.bottom_px - 0.5:
                self._newpage()
            return i + 1
        if cmd == 0x6A:                                 # ESC j n : reverse feed n/216"
            if i >= n: return n
            self.yf = max(self.top_px, self.yf - data[i] * VDPI / 216.0)
            return i + 1
        if cmd == 0x0A:                                 # ESC LF : reverse line feed
            self.yf = max(self.top_px, self.yf - self._line_px()); return i
        if cmd == 0x0C:                                 # ESC FF : to top of current page
            self.yf = self.top_px; return i
        if cmd == 0x19:                                 # ESC EM n : paper load/eject
            if i >= n: return n
            if data[i] == 0x52:                         # 'R' = eject
                self._newpage()
            return i + 1
        if cmd == 0x43:                                 # ESC C n / ESC C 0 m : form length
            if i >= n: return n
            if data[i] == 0:
                if i + 1 >= n: return n
                self.page_px = int(round(data[i + 1] * VDPI))
                i += 2
            else:
                self.page_px = int(round(data[i] * self._line_px()))
                i += 1
            self.top_px = 0.0
            self.bottom_px = float(self.page_px)
            return i
        if cmd == 0x4E:                                 # ESC N n : skip-over-perforation
            if i >= n: return n
            self.bottom_px = max(self._line_px(),
                                 self.page_px - data[i] * self._line_px())
            return i + 1
        if cmd == 0x4F:                                 # ESC O : cancel skip-over-perf
            self.bottom_px = float(self.page_px); return i

        # ---- horizontal position ----
        if cmd == 0x24:                                 # ESC $ nL nH : absolute, n/60"
            if i + 1 >= n: return n
            x = self.left_px + self._u16(data, i) * VDPI / 60.0
            if x <= self.right_px:
                self.xf = x
            return i + 2
        if cmd == 0x5C:                                 # ESC \ nL nH : relative, n/120"
            if i + 1 >= n: return n
            rel = self._u16(data, i)
            if rel >= 0x8000:
                rel -= 0x10000
            self.xf = min(max(0.0, self.xf + rel * VDPI / 120.0), self.right_px)
            return i + 2
        if cmd == 0x6C:                                 # ESC l n : left margin (columns)
            if i >= n: return n
            self.left_px = max(0, data[i] - 1) * VDPI / self.cpi
            self.xf = max(self.xf, self.left_px)
            return i + 1
        if cmd == 0x51:                                 # ESC Q n : right margin (columns)
            if i >= n: return n
            self.right_px = min(float(self.width), data[i] * VDPI / self.cpi)
            return i + 1

        # ---- tabs ----
        if cmd == 0x44:                                 # ESC D n... NUL : horizontal tabs
            i, self.htabs = self._tablist(data, i, n, VDPI / self.cpi, 32)
            return i
        if cmd == 0x42:                                 # ESC B n... NUL : vertical tabs
            i, self.vtabs = self._tablist(data, i, n, self._line_px(), 16)
            return i
        if cmd == 0x62:                                 # ESC b c n... NUL : VFU channel
            # The channel is ignored (we have one paper path), so this collects
            # vertical tabs exactly like ESC B - as DOSBox-X does.
            i, self.vtabs = self._tablist(data, i + 1, n, self._line_px(), 16)
            return i

        # ---- print styles ----
        if cmd == 0x21:                                 # ESC ! n : master select
            if i >= n: return n
            m = data[i]
            self.cpi = 12.0 if m & 0x01 else 10.0
            self.proportional = bool(m & 0x02)
            self.condensed = bool(m & 0x04)
            self.bold = bool(m & 0x08)
            self.double_strike = bool(m & 0x10)
            self.double_width = bool(m & 0x20)
            self.italic = bool(m & 0x40)
            self.underline = bool(m & 0x80)
            return i + 1
        if cmd == 0x4D:                                 # ESC M : elite (12 cpi)
            self.cpi = 12.0; return i
        if cmd == 0x50:                                 # ESC P : pica (10 cpi)
            self.cpi = 10.0; return i
        if cmd == 0x67:                                 # ESC g : 15 cpi
            self.cpi = 15.0; return i
        if cmd == 0x20:                                 # ESC SP n : intercharacter space
            if i >= n: return n
            self.intersp_px = data[i] * VDPI / 120.0; return i + 1
        if cmd == 0x0E:                                 # ESC SO : double width (one line)
            self.dw_oneline = True; return i
        if cmd == 0x0F:                                 # ESC SI : condensed
            self.condensed = True; return i
        if cmd == 0x57:                                 # ESC W n : double width
            if i >= n: return n
            self.double_width = data[i] in (1, 49); return i + 1
        if cmd == 0x2D:                                 # ESC - n : underline
            if i >= n: return n
            self.underline = data[i] in (1, 49); return i + 1
        if cmd == 0x45:                                 # ESC E : emphasized on
            self.bold = True; return i
        if cmd == 0x46:                                 # ESC F : emphasized off
            self.bold = False; return i
        if cmd == 0x47:                                 # ESC G : double strike on
            self.double_strike = True; return i
        if cmd == 0x48:                                 # ESC H : double strike off
            self.double_strike = False; return i
        if cmd == 0x34:                                 # ESC 4 : italic on
            self.italic = True; return i
        if cmd == 0x35:                                 # ESC 5 : italic off
            self.italic = False; return i
        if cmd == 0x53:                                 # ESC S n : super/subscript
            if i >= n: return n
            self.superscript = data[i] in (0, 48)
            self.subscript = data[i] in (1, 49)
            return i + 1
        if cmd == 0x54:                                 # ESC T : cancel super/subscript
            self.superscript = self.subscript = False; return i
        if cmd == 0x70:                                 # ESC p n : proportional
            if i >= n: return n
            self.proportional = data[i] in (1, 49); return i + 1
        if cmd == 0x52:                                 # ESC R n : international set
            if i >= n: return n
            self.country = data[i] if data[i] <= 8 else 0
            return i + 1

        # ---- character sets / control-code printing ----
        if cmd == 0x36:                                 # ESC 6 : print 0x80-0x9F glyphs
            self.upper_ctrl = True; return i
        if cmd == 0x37:                                 # ESC 7 : 0x80-0x9F are controls
            self.upper_ctrl = False; return i
        if cmd == 0x49:                                 # ESC I n : print 0x00-0x1F glyphs
            if i >= n: return n
            self.alt_ctrl = bool(data[i] & 1); return i + 1
        if cmd == 0x25:                                 # ESC % n : ROM/RAM charset
            if i >= n: return n
            self.use_ram = bool(data[i] & 1); return i + 1
        if cmd == 0x3A:                                 # ESC : 0 0 0 : copy ROM to RAM
            for c in range(256):
                cols, _, _ = self.font.glyph(c)
                self.ram_chars[c] = ("rom", cols)
            return min(i + 3, n)
        if cmd == 0x26:                                 # ESC & 0 c1 c2 (attr+11 cols)/char
            if i + 2 >= n:
                return n
            c1, c2 = data[i + 1], data[i + 2]
            i += 3
            for c in range(c1, c2 + 1):
                if i + 12 > n:
                    return n
                self.ram_chars[c] = (data[i], list(data[i + 1:i + 12]))
                i += 12
            return i

        # ---- MSB control ----
        if cmd == 0x23:                                 # ESC # : cancel MSB control
            self.msb = None; return i
        if cmd == 0x3D:                                 # ESC = : MSB 0
            self.msb = 0; return i
        if cmd == 0x3E:                                 # ESC > : MSB 1
            self.msb = 1; return i

        if cmd == 0x40:                                 # ESC @ : reset
            self._reset(); return i

        # ---- ESC ( x nL nH ... : the ESC/P2 extended block ----
        # Every ESC ( command carries its own byte count, so unknown ones can be
        # skipped exactly instead of spraying their parameters into the text as
        # glyphs. None of these are FX-80 commands - a 24-pin Japanese word
        # processor may still emit them, so skip cleanly and count them.
        if cmd == 0x28:
            if i + 2 >= n:
                return n
            sub = data[i]
            length = self._u16(data, i + 1)
            key = ("ESC (", chr(sub) if 0x20 <= sub < 0x7F else sub)
            self.unknown[key] = self.unknown.get(key, 0) + 1
            return min(i + 3 + length, n)

        # ---- recognized no-ops (consume parameters, don't count unknown) ----
        if cmd in (0x3C, 0x38, 0x39, 0x02, 0x7F):       # ESC < 8 9, undoc, DEL
            return i
        if cmd in (0x55, 0x69, 0x73, 0x2F, 0x6B, 0x78,  # ESC U i s / k x t w a h r
                   0x74, 0x77, 0x61, 0x68, 0x72):
            return min(i + 1, n)
        if cmd in (0x63, 0x65):                         # ESC c (HMI), ESC e : 2 params
            return min(i + 2, n)
        if cmd == 0x58:                                 # ESC X : 3 params
            return min(i + 3, n)

        key = ("ESC", chr(cmd) if 0x20 <= cmd < 0x7F else cmd)
        self.unknown[key] = self.unknown.get(key, 0) + 1
        return i                                        # best effort: skip cmd byte

    def _fs(self, data, i, n):
        """FS (0x1C) commands - Japanese 24-pin extensions (per DOSBox-X)."""
        if i >= n:
            return n
        cmd = data[i]
        i += 1
        if cmd == 0x5A:                                 # FS Z nL nH : 360x180 24-bit
            if i + 1 >= n:
                return n
            length = self._u16(data, i) * 3
            i += 2
            self._bitimage(40, data[i:i + length])
            return i + length
        if cmd == 0x32:                                 # FS 2 : 1/6" spacing
            self.line_mode, self.line_val = "fixed", VDPI / 6.0; return i
        if cmd == 0x34:                                 # FS 4 : italic on
            self.italic = True; return i
        if cmd == 0x35:                                 # FS 5 : italic off
            self.italic = False; return i
        if cmd in (0x46, 0x52):                         # FS F/R : feed direction
            return i
        if cmd == 0x41:                                 # FS A n : n/60" spacing
            if i >= n: return n
            self.line_mode, self.line_val = "fixed", data[i] * VDPI / 60.0
            return i + 1
        if cmd == 0x33:                                 # FS 3 n : n/360" spacing
            if i >= n: return n
            self.line_mode, self.line_val = "fixed", data[i] * VDPI / 360.0
            return i + 1
        if cmd in (0x43, 0x45, 0x49, 0x53, 0x56):       # FS C/E/I/S/V n : ignore
            return min(i + 1, n)
        key = ("FS", chr(cmd) if 0x20 <= cmd < 0x7F else cmd)
        self.unknown[key] = self.unknown.get(key, 0) + 1
        return i

    def _htab(self):
        if self.htabs is None:                          # power-on: every 8 columns
            cell = 8 * VDPI / self.cpi
            x = (int((self.xf - self.left_px) / cell) + 1) * cell + self.left_px
        else:
            x = next((t + self.left_px for t in self.htabs
                      if t + self.left_px > self.xf), -1.0)
        if 0 <= x < self.right_px:
            self.xf = x

    def _vtab(self):
        self.dw_oneline = False
        if self.vtabs is None:                          # power-on: acts like LF
            self._linefeed()
        elif not self.vtabs:                            # all cancelled: acts like CR
            self.xf = self.left_px
        else:
            y = next((t for t in self.vtabs if t > self.yf), -1.0)
            if y < 0 or y > self.bottom_px:
                self._newpage()
            else:
                self.yf = y

    def _control(self, b):
        if b == 0x0D:                                   # CR
            self.xf = self.left_px
        elif b == 0x0A:                                 # LF
            self._linefeed()
        elif b == 0x0C:                                 # FF
            self.dw_oneline = False
            self._newpage()
        elif b == 0x09:                                 # HT
            self._htab()
        elif b == 0x0B:                                 # VT
            self._vtab()
        elif b == 0x08:                                 # BS
            self.xf = max(self.left_px, self.xf - VDPI / self._cpi_eff())
        elif b == 0x0E:                                 # SO: double width, one line
            self.dw_oneline = True
        elif b == 0x0F:                                 # SI: condensed
            self.condensed = True
        elif b == 0x12:                                 # DC2: condensed off
            self.condensed = False
        elif b == 0x14:                                 # DC4: one-line double width off
            self.dw_oneline = False
        elif b in (0x00, 0x07, 0x11, 0x13, 0x18, 0x7F):  # NUL BEL DC1 DC3 CAN DEL
            pass
        elif self.alt_ctrl:                             # ESC I 1: control-code glyphs
            self._text(b)

    def feed(self, data):
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == ESC:
                i = self._escape(data, i + 1, n)
                continue
            if b == FS:
                i = self._fs(data, i + 1, n)
                continue
            i += 1
            if self.msb == 0:                           # ESC = / ESC >
                b &= 0x7F
            elif self.msb == 1:
                b |= 0x80
            if self.font.msx_charset:
                # MSX before FX-80: the glyph table covers 0x00-0xFF, so the high
                # bit is data. Don't strip it for italics (_text slants instead),
                # don't fold 0x80-0x9F onto control codes, and skip ESC R - the
                # MSX ROM already carries the accented letters at their own codes.
                if b >= 0x20:
                    self._text(b)
                else:
                    self._control(b)
                continue
            # --charset cp437: remap the MSX/CP437 upper region onto the FX-80's
            # own accented codes before the high bit is read as italics below.
            if self.cp437 and b in _CP437_TO_FX80:
                self._text(_CP437_TO_FX80[b])
                continue
            # FX-80 semantics: high bit selects italics, 0x80-0x9F are control
            # code aliases unless ESC 6, and ESC R substitutes 12 positions.
            if b >= 0x20:
                b = (b | 0x80) if self.italic else (b & 0x7F)
            if not self.upper_ctrl and 0x80 <= b < 0xA0:
                b &= 0x1F                               # high control codes
            if b & 0x7F in _INTL:                       # ESC R mapping
                b = (b & 0x80) | _INTL[b & 0x7F][self.country]
            if b >= 0x20:
                self._text(b)
            else:
                self._control(b)
        return self


def render(data, charset=DEFAULT_CHARSET):
    """Parse an ESC/P stream and return its pages (list[Page])."""
    return Renderer(charset=charset).feed(bytes(data)).pages


def render_to_png(data, out_prefix, charset=DEFAULT_CHARSET):
    """Render `data` and write one PNG per non-empty page. Returns the paths."""
    r = Renderer(charset=charset).feed(bytes(data))
    paths = []
    pages = [p for p in r.pages if not p.empty()] or r.pages[:1]
    for idx, page in enumerate(pages, 1):
        path = f"{out_prefix}_p{idx}.png" if len(pages) > 1 else f"{out_prefix}.png"
        page.to_png(path)
        paths.append(path)
    return paths, r


# --- synthetic ESC/P for the self-test -------------------------------------
def bitmap_to_escp(grid, mode=39):
    """Encode a 2D 0/1 bitmap (list of equal-length rows) into an ESC/P 24-dot
    bit-image stream. Bands of 24 rows, exact 24/180" line feeds between them."""
    h = len(grid)
    w = len(grid[0]) if h else 0
    out = bytearray()
    out += bytes([ESC, 0x33, 24])                       # line spacing = 24/180"
    for top in range(0, h, 24):
        out += b"\r"                                    # CR: x back to 0
        cols = bytearray()
        for x in range(w):
            for byteidx in range(3):
                v = 0
                for bit in range(8):
                    ry = top + byteidx * 8 + bit
                    if ry < h and grid[ry][x]:
                        v |= (0x80 >> bit)
                cols.append(v)
        nL, nH = w & 0xFF, (w >> 8) & 0xFF
        out += bytes([ESC, 0x2A, mode, nL, nH]) + cols
        out += b"\n"                                    # LF: down one 24-dot band
    return bytes(out)


def _selftest_grid():
    """A 64x48 box with an X and a filled corner - easy to eyeball and verify."""
    W, H = 64, 48
    g = [[0] * W for _ in range(H)]
    for x in range(W):
        g[0][x] = g[H - 1][x] = 1                       # top/bottom border
    for y in range(H):
        g[y][0] = g[y][W - 1] = 1                       # left/right border
    for i in range(min(W, H)):                          # diagonals (the X)
        g[i * (H - 1) // (min(W, H) - 1)][i * (W - 1) // (min(W, H) - 1)] = 1
        g[i * (H - 1) // (min(W, H) - 1)][W - 1 - i * (W - 1) // (min(W, H) - 1)] = 1
    for y in range(8):                                  # a solid 8x8 block, top-left inside
        for x in range(8):
            g[2 + y][2 + x] = 1
    return g


def _selftest(out_prefix="escp_selftest"):
    grid = _selftest_grid()
    stream = bitmap_to_escp(grid)
    paths, r = render_to_png(stream, out_prefix)
    page = r.pages[0]
    # verify a handful of pixels round-trip (square 180-dpi mode -> 1px/dot).
    checks = [
        ("top-left corner set", _get(page, 0, 0) == 1),
        ("inner block set", _get(page, 4, 4) == 1),
        ("interior gap empty", _get(page, 20, 40) == 0),
        ("bottom-right corner set", _get(page, 63, 47) == 1),
        ("outside is blank", _get(page, 70, 5) == 0),
    ]
    ok = all(v for _, v in checks)
    for name, v in checks:
        print(f"  [{'OK' if v else '!!'}] {name}")
    print(f"  stream: {len(stream)} bytes -> {paths}  ({page.maxx + 1}x{page.maxy + 1} px)")
    if r.unknown:
        print(f"  unknown ESC codes: {r.unknown}")
    return 0 if ok else 1


def _get(page, x, y):
    if y >= len(page.rows) or x >= page.width:
        return 0
    return 1 if (page.rows[y][x >> 3] & (0x80 >> (x & 7))) else 0


def main(argv):
    dialect, rom_path, font_path, font_size, args = "auto", None, None, 48, []
    charset = DEFAULT_CHARSET
    i = 0
    while i < len(argv):
        if argv[i] == "--charset":
            charset = argv[i + 1]
            i += 2
        elif argv[i] == "--dialect":
            dialect = argv[i + 1]
            i += 2
        elif argv[i] == "--kanji-rom":
            rom_path = argv[i + 1]
            i += 2
        elif argv[i] == "--font":
            font_path = argv[i + 1]
            i += 2
        elif argv[i] == "--font-size":
            font_size = int(argv[i + 1])
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args[0] == "--selftest":
        return _selftest(args[1] if len(args) > 1 else "escp_selftest")
    if dialect not in ("auto", "escp", "msx-kanji", "msx-hangul"):
        print(f"[-] unknown --dialect {dialect!r} (escp|msx-kanji|msx-hangul|auto)")
        return 1
    if charset not in CHARSETS:
        print(f"[-] unknown --charset {charset!r} ({'|'.join(CHARSETS)})")
        return 1
    path = args[0]
    prefix = args[1] if len(args) > 1 else os.path.splitext(path)[0]
    data = open(path, "rb").read()

    import msx_printer_kanji_render as mk
    if dialect == "auto":
        dialect = mk.detect_dialect(data)
        print(f"[+] dialect: {dialect} (auto-detected)")
    if dialect == "msx-hangul":
        # Jamo text, not dots - it needs a hangul font. There is no MSX hangul
        # ROM to prefer here, so a bundled font is the fallback (mk.resolve_font).
        import msx_printer_hangul_render as mh
        pages = mh.decode(data)
        kind, font, how = mk.resolve_font(font_path, script="kr")
        if kind != "font":
            print("[-] the msx-hangul dialect is a jamo text stream: pass a"
                  " hangul-capable font (--font Galmuri11.ttf / NeoDunggeunmo.ttf)")
            for lines in pages:
                for l in lines:
                    print("    " + l)
            return 1
        paths = mk.render_text_to_files(pages, font, prefix, size=font_size)
        print(f"[+] {len(data)} bytes, {how} -> {paths}")
        return 0
    if dialect == "msx-kanji":
        # The MSX font wins: an explicit --font, else the machine's kanji ROM,
        # else a bundled font. See msx_printer_kanji_render.resolve_font.
        nchars = sum(len(l) for pg in mk.extract_text(data) for l in pg)
        paths, how = mk.render_auto(data, prefix, font=font_path, rom=rom_path,
                                    size=font_size)
        print(f"[+] {len(data)} bytes, {nchars} chars, {how}"
              f" -> {len(paths)} file(s): {paths}")
        return 0

    paths, r = render_to_png(data, prefix, charset)
    print(f"[+] {len(data)} bytes -> {len(paths)} page(s): {paths}")
    if r.text_bytes:
        how = f"charset {r.charset}"
        print(f"    ({r.text_bytes} text bytes, {how})")
    if r.unknown:
        print(f"    unhandled ESC codes (extend the parser for this dialect): {r.unknown}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
