#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see LICENSE / NOTICE.md in printer/)
"""msx_printer_kanji_render.py - MSX kanji-printer stream (ESC K + JIS) -> page PNG.

MSX-Write (ASCII, 1986) and its contemporaries do NOT print kanji as ESC/P
bit-images: they emit the MSX kanji-printer protocol, where each full-width
character goes out as `ESC 'K' j1 j2` (a 2-byte JIS X 0208 code) and the
*printer's own* kanji ROM supplies the glyph. A captured stream therefore
contains no pixels at all - to rasterize it we need a kanji font ROM dump.

Stream commands handled (observed from an MSX-Write capture via openMSX's
printer logger; line-feed semantics follow openMSX's ImagePrinterMSX):
    ESC 'K' j1 j2   print one full-width char, JIS code j1j2 (0x21-0x7E each)
    ESC 'T' n n     line feed nn/144" (two ASCII digits)
    ESC 'A' / 'B'   line feed 1/6" / 1/9"
    DC1 (0x11)      printer select / sync  - ignored
    CAN (0x18)      cancel line            - ignored
    CR LF FF        carriage return / line feed / form feed
    ESC <other>     single-byte escapes (0x01/0x04/0x08 head micro-feeds,
                    ruled-line sections...) - skipped and counted in .unknown

Kanji font ROM format (KNJFNT16-compatible, 128kB JIS1 or 256kB JIS1+JIS2).
Reverse-engineered from EC-702 / FS-A1WX dumps and verified glyph-by-glyph
against openMSX's kanji device output (see docs: msx-word 04-printer 4.5):

    glyph = ROM[index*32 .. +32]
    byte layout - four 8x8 quadrants, each byte one 8-pixel row, MSB = left:
        bytes 0-7   top-left      bytes 8-15  top-right
        bytes 16-23 bottom-left   bytes 24-31 bottom-right
    JIS (j1 j2) -> index:
        symbols/kana/fullwidth alnum (j1 0x21-0x28): (j1-0x20)*96 + (j2-0x20)
        kanji level 1 (j1 0x30-0x4F):        0x400 + (j1-0x30)*96 + (j2-0x20)
        kanji level 2 (j1 0x50-0x7E): same formula in the second 128kB half
    (index 0-95 holds the halfwidth 8x16 font; not needed for MSX-Write
    output, which sends everything as JIS.)

Two ways to draw the glyphs, in one place (the modern-font path used to live in
msx_printer_jis_modern_render.py, merged here in v0.33.0 - same parser, the
backends only differ in where the pixels come from):

    kanji ROM   period-accurate 16x16 printer bitmaps. Stdlib only.
    modern font a TTF/OTF typeset of the same text - Noto Sans JP, DotGothic16,
                Pretendard... (open OFL fonts ship in resources/fonts/). Needs
                Pillow; renders identically on macOS/Windows/Pi and `--pdf`
                embeds the font, so any modern printer reproduces it.

**Font resolution — the MSX font wins.** With no `--font`, we look for the
machine's own kanji ROM (`--kanji-rom`, then $MSX_KANJI_ROM, then the usual
directories) and use that, because it is what the hardware actually printed.
Only when no ROM can be found do we fall back to a bundled font, so the tool
still produces something readable on a machine that has no ROM dump. An
explicit `--font` overrides everything.

CLI:
    python3 msx_printer_kanji_render.py job.prn [out_prefix]
        (no options: kanji ROM if one is found, else a bundled font)
        --kanji-rom PATH   font ROM to use (KNJFNT16-compatible, 128/256kB)
        --font PATH.ttf    typeset with this TTF/OTF instead of a ROM
        --size N           modern-font glyph size in px (default 48)
        --pdf              modern-font: also write out_prefix.pdf
        --list-fonts       show the bundled fonts and any ROM found, then exit

Library:
    pages    = render(data, rom)                    # -> list[msx_printer_escp_render.Page]
    paths, r = render_to_png(data, rom, "out")      # -> PNG paths, renderer  (ROM)
    paths    = render_to_files(data, font, "out")   # -> paths               (modern font)
    paths, how = render_auto(data, "out")           # -> paths, backend description
    detect_dialect(data)                            # -> 'escp' | 'msx-kanji'
"""

import os
import re
import sys

from msx_printer_escp_render import Page

ESC = 0x1B

# Canvas geometry: same 180 dpi canvas as msx_printer_escp_render. Kanji-printer dots are
# rendered 2x2 px (16-dot glyph -> 32 px), advance one glyph + a small gap.
VDPI = 180.0
DOT = 2                                   # canvas px per glyph dot
CELL = 16 * DOT                           # glyph box, px
ADVANCE = CELL + 4                        # horizontal advance per char, px


# --- kanji font ROM access --------------------------------------------------
def jis_index(j1, j2):
    """JIS X 0208 code bytes -> glyph index in a KNJFNT16-style ROM."""
    if j1 >= 0x50:                        # JIS level 2 -> second 128kB half
        return 0x1000 + 0x400 + (j1 - 0x50) * 96 + (j2 - 0x20)
    if j1 >= 0x30:                        # kanji level 1
        return 0x400 + (j1 - 0x30) * 96 + (j2 - 0x20)
    return (j1 - 0x20) * 96 + (j2 - 0x20)  # symbols / kana / fullwidth alnum


def glyph_rows(rom, j1, j2):
    """16 ints (one per row, bit15 = leftmost pixel) for the JIS char, or None
    if the ROM is too small for its index (e.g. JIS2 char, 128kB ROM)."""
    off = jis_index(j1, j2) * 32
    g = rom[off:off + 32]
    if len(g) < 32:
        return None
    top = [(g[r] << 8) | g[8 + r] for r in range(8)]
    bot = [(g[16 + r] << 8) | g[24 + r] for r in range(8)]
    return top + bot


def pack_glyph(rows):
    """Inverse of glyph_rows: 16 row-ints -> the ROM's 32-byte quadrant order.
    Used by tests and tools that build font ROM images."""
    out = bytearray(32)
    for r in range(8):
        out[r], out[8 + r] = rows[r] >> 8, rows[r] & 0xFF
        out[16 + r], out[24 + r] = rows[8 + r] >> 8, rows[8 + r] & 0xFF
    return bytes(out)


def load_rom(path):
    rom = open(path, "rb").read()
    if len(rom) not in (0x20000, 0x40000):
        raise SystemExit(f"[-] {path}: kanji font ROM must be 128kB or 256kB "
                         f"(got {len(rom)} bytes)")
    return rom


# --- font resolution: the MSX font first, a bundled font as the fallback -----
_HERE = os.path.dirname(os.path.abspath(__file__))
from msx_printer_paths import repo_root

#: For finding optional assets only - resources/fonts, resources/msx-roms.
#: Nothing is written here.
_REPO = repo_root(_HERE)
FONT_DIR = os.path.join(_REPO, "resources", "fonts")

#: Where to look for the machine's kanji ROM, in order. $MSX_KANJI_ROM wins.
#: resources/ is gitignored user-asset territory - that is exactly where a ROM
#: dump belongs, so it is searched but nothing is ever shipped from there.
ROM_DIRS = (os.curdir, _REPO,
            os.path.join(_REPO, "resources"),
            os.path.join(_REPO, "resources", "font-roms"),
            os.path.join(_REPO, "resources", "msx-roms"),
            os.path.join(_REPO, "resources", "roms"), _HERE)
#: Exact names first, then any *kanjifont*/*knjfnt* file of the right size, so a
#: dump named after its machine (ec-702_kanjifont.rom) is found too.
ROM_NAMES = ("KNJFNT16.ROM", "knjfnt16.rom", "KNJFNT16.rom",
             "KNJDRV16.ROM", "kanji.rom", "KANJI.ROM")
ROM_GLOBS = ("*kanjifont*.rom", "*kanjifont*.ROM", "*knjfnt*", "*KNJFNT*")

#: Bundled fallbacks, best first. DotGothic16 leads for Japanese because it is
#: a 16-dot design - the closest thing to the ROM bitmaps it stands in for.
BUNDLED_JP = ("DotGothic16.ttf", "NotoSansJP.ttf", "BIZUDGothic.ttf",
              "IBMPlexSansJP.ttf")
BUNDLED_KR = ("NeoDunggeunmo.ttf", "Galmuri11.ttf", "NotoSansKR.ttf",
              "Pretendard.otf")


def find_rom():
    """Locate a kanji font ROM without being told where it is, or None.
    $MSX_KANJI_ROM first, then ROM_NAMES then ROM_GLOBS under ROM_DIRS. The size
    is validated (128/256kB), so a stray file - or one of the game ROMs that sit
    in the same directory - is skipped rather than used and misread as a font."""
    import glob as _glob
    env = os.environ.get("MSX_KANJI_ROM")
    cands = [env] if env else []
    cands += [os.path.join(d, n) for d in ROM_DIRS for n in ROM_NAMES]
    for d in ROM_DIRS:
        for g in ROM_GLOBS:
            cands += sorted(_glob.glob(os.path.join(d, g)))
    for p in cands:
        try:
            if os.path.getsize(p) in (0x20000, 0x40000):
                return p
        except OSError:
            continue
    return None


def find_bundled_font(script="jp"):
    """A bundled resources/fonts/ file for `script` ('jp'/'kr'), or None."""
    for name in (BUNDLED_KR if script == "kr" else BUNDLED_JP):
        p = os.path.join(FONT_DIR, name)
        if os.path.exists(p):
            return p
    return None


def resolve_font(font=None, rom=None, script="jp"):
    """Pick a rendering backend. Returns (kind, value, description) where kind
    is 'font' or 'rom' - see the module docstring for the precedence."""
    if font:
        return "font", font, f"font {os.path.basename(font)} (given)"
    if rom:
        return "rom", rom, f"kanji ROM {os.path.basename(rom)} (given)"
    found = find_rom()
    if found:
        return "rom", found, f"kanji ROM {os.path.basename(found)} (auto-detected)"
    bundled = find_bundled_font(script)
    if bundled:
        return ("font", bundled,
                f"font {os.path.basename(bundled)} (bundled; no kanji ROM found)")
    return "none", None, "no kanji ROM and no bundled font available"


# --- dialect detection ------------------------------------------------------
def detect_dialect(data):
    """'escp', 'msx-kanji' or 'msx-hangul'. ESC/P-only opcodes win; an ESC K
    whose 2 operand bytes are both JIS-range and are followed by another
    control byte (in ESC/P they would be a column *count*, followed by pixel
    data) or a DC1 sync run marks the MSX kanji-printer protocol; a stream
    with no escapes but jamo bytes (0x86-0xA6, Daewoo hangul driver) is the
    hangul jamo protocol."""
    data = bytes(data)
    if re.search(rb"\x1b[\x2a\x33\x40\x4a\x30\x31\x32]", data):
        return "escp"
    if re.search(rb"\x1bK[\x21-\x7e][\x21-\x7e](?:[\x00-\x1f]|$)", data):
        return "msx-kanji"
    if b"\x11" * 8 in data:
        return "msx-kanji"
    # Jamo stream: *every* high byte must be a jamo. Counting jamo-range bytes
    # instead used to call Japanese text hangul - shift_jis lead/trail bytes sit
    # right across 0x86-0xA6 (日本語のテスト文書です has 6), while a real Daewoo
    # capture has nothing outside it. Fixed in v0.34.0.
    hi = [b for b in data if b >= 0x80]
    if (b"\x1b" not in data and len(hi) >= 4
            and all(0x86 <= b <= 0xA6 for b in hi)):
        return "msx-hangul"
    return "escp"


# --- the interpreter --------------------------------------------------------
class KanjiRenderer:
    """rom=None parses without drawing - the records still collect every char
    (page, x, y, j1, j2), which is what extract_text() builds lines from."""

    def __init__(self, rom, width=2000):
        self.rom = rom
        self.width = width
        self.pages = [Page(width)]
        self.x = 0
        self.y = 0
        self.line_px = int(round(VDPI / 6))             # default 1/6"
        self.chars = 0                                  # ESC K chars drawn
        self.missing = 0                                # chars beyond ROM size
        self.unknown = {}                               # code -> count
        self.records = []                               # (page, x, y, j1, j2)

    @property
    def page(self):
        return self.pages[-1]

    def _draw(self, j1, j2):
        self.records.append((len(self.pages) - 1, self.x, self.y, j1, j2))
        if self.rom is None:
            self.chars += 1
            return
        rows = glyph_rows(self.rom, j1, j2)
        if rows is None:
            self.missing += 1
            return
        for ry in range(16):
            row = rows[ry]
            if not row:
                continue
            for rx in range(16):
                if row & (0x8000 >> rx):
                    px, py = self.x + rx * DOT, self.y + ry * DOT
                    for dy in range(DOT):
                        for dx in range(DOT):
                            self.page.plot(px + dx, py + dy)
        self.chars += 1

    def _escape(self, data, i, n):
        if i >= n:
            return n
        cmd = data[i]
        i += 1
        if cmd == 0x4B and i + 1 < n and \
           0x21 <= data[i] <= 0x7E and 0x21 <= data[i + 1] <= 0x7E:
            self._draw(data[i], data[i + 1])            # ESC K j1 j2
            self.x += ADVANCE
            return i + 2
        if cmd == 0x54 and i + 1 < n:                   # ESC T n n : nn/144"
            try:
                nn = int(bytes(data[i:i + 2]))
            except ValueError:
                nn = 24
            self.line_px = max(1, int(round(nn * VDPI / 144)))
            return i + 2
        if cmd == 0x41:                                 # ESC A : 1/6"
            self.line_px = int(round(VDPI / 6))
            return i
        if cmd == 0x42:                                 # ESC B : 1/9"
            self.line_px = int(round(VDPI / 9))
            return i
        key = chr(cmd) if 0x20 <= cmd < 0x7F else cmd
        self.unknown[key] = self.unknown.get(key, 0) + 1
        return i                                        # single-byte esc: skip

    def feed(self, data):
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == ESC:
                i = self._escape(data, i + 1, n)
            elif b == 0x0D:                             # CR
                self.x = 0
                i += 1
            elif b == 0x0A:                             # LF
                self.y += self.line_px
                i += 1
            elif b == 0x0C:                             # FF
                self.pages.append(Page(self.width))
                self.x = 0
                self.y = 0
                i += 1
            else:                                       # DC1/CAN/other: ignore
                i += 1
        return self


def render(data, rom):
    """Parse an MSX kanji-printer stream, return its pages (list[Page])."""
    return KanjiRenderer(rom).feed(bytes(data)).pages


def extract_text(data):
    """Decode the stream's JIS codes to Unicode text, no font needed.
    Returns a list of pages, each a list of line strings. JIS X 0208 (j1,j2)
    is decoded through the stdlib euc_jp codec: bytes(j|0x80)."""
    r = KanjiRenderer(None).feed(bytes(data))
    pages = []
    for pi in range(len(r.pages)):
        lines = {}
        for rec_page, x, y, j1, j2 in r.records:
            if rec_page == pi:
                lines.setdefault(y, []).append((x, j1, j2))
        page = []
        for y in sorted(lines):
            raw = b"".join(bytes((j1 | 0x80, j2 | 0x80))
                           for _, j1, j2 in sorted(lines[y]))
            page.append(raw.decode("euc_jp", "replace"))
        if page:
            pages.append(page)
    return pages


def render_to_png(data, rom, out_prefix):
    r = KanjiRenderer(rom).feed(bytes(data))
    paths = []
    pages = [p for p in r.pages if not p.empty()] or r.pages[:1]
    for idx, page in enumerate(pages, 1):
        path = f"{out_prefix}_p{idx}.png" if len(pages) > 1 else f"{out_prefix}.png"
        page.to_png(path)
        paths.append(path)
    return paths, r


# --- modern-font backend (Pillow; merged from jis_modern_render in v0.33.0) ---
MARGIN = 0.5                              # page margin, in glyph sizes
LEADING = 1.4                             # line height, in glyph sizes


def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
        return Image, ImageDraw, ImageFont
    except ImportError:
        raise SystemExit("[-] the modern-font backend needs Pillow: pip install pillow"
                         "\n    (or pass --kanji-rom to use the stdlib ROM path)")


def render_to_files(data, font_path, out_prefix, size=48, pdf=False):
    """Typeset a JIS (msx-kanji) stream with a TTF/OTF. Returns written paths."""
    return render_text_to_files(extract_text(data), font_path, out_prefix,
                                size=size, pdf=pdf)


def render_text_to_files(pages, font_path, out_prefix, size=48, pdf=False):
    """Typeset pages (lists of line strings) with `font_path`. Shared by the
    msx-kanji and msx-hangul dialects. Returns the written paths."""
    Image, ImageDraw, ImageFont = _pil()
    font = ImageFont.truetype(font_path, size)
    if not pages:
        pages = [[""]]
    margin = int(size * MARGIN)
    leading = int(size * LEADING)
    paths = []
    for n, lines in enumerate(pages, 1):
        width = max(
            [int(ImageDraw.Draw(Image.new("L", (1, 1))).textlength(l, font=font))
             for l in lines] or [size]) + 2 * margin
        height = len(lines) * leading + 2 * margin
        img = Image.new("L", (max(width, size), height), 255)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(lines):
            draw.text((margin, margin + i * leading), line, font=font, fill=0)
        stem = f"{out_prefix}_p{n}" if len(pages) > 1 else out_prefix
        img.save(stem + ".png")
        paths.append(stem + ".png")
        if pdf:
            img.convert("RGB").save(stem + ".pdf", resolution=300)
            paths.append(stem + ".pdf")
    return paths


# --- one entry point that picks the backend ---------------------------------
def render_auto(data, out_prefix, font=None, rom=None, size=48, pdf=False,
                script="jp"):
    """Render a kanji-printer stream, choosing the backend per resolve_font():
    an explicit font, else the machine's kanji ROM, else a bundled font.
    Returns (paths, description). Raises SystemExit if neither is available."""
    kind, value, how = resolve_font(font, rom, script)
    if kind == "rom":
        paths, r = render_to_png(data, load_rom(value), out_prefix)
        if r.missing:
            how += f"  ({r.missing} chars beyond ROM size - JIS2 needs 256kB)"
        return paths, how
    if kind == "font":
        return render_to_files(data, value, out_prefix, size=size, pdf=pdf), how
    raise SystemExit(
        "[-] nothing to draw with: pass --kanji-rom KNJFNT16.ROM (128/256kB)"
        " or --font NotoSansJP.ttf")


def _list_fonts():
    rom = find_rom()
    print("kanji ROM (preferred - what the machine itself printed):")
    print(f"  {rom}" if rom else
          "  (none found; set $MSX_KANJI_ROM or pass --kanji-rom)")
    print(f"\nbundled fonts in {FONT_DIR}, best first:")
    for script, names in (("jp", BUNDLED_JP), ("kr", BUNDLED_KR)):
        for rank, n in enumerate(names):
            p = os.path.join(FONT_DIR, n)
            note = "" if os.path.exists(p) else "   (missing)"
            if rank == 0 and not note:
                note = "   <- fallback for this script"
            print(f"  [{script}] {n}{note}")
    print(f"\nwith no options, rendering would use: {resolve_font()[2]}")
    return 0


def main(argv):
    rom_path, font_path, size, pdf, args = None, None, 48, False, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--kanji-rom":
            rom_path = argv[i + 1]; i += 2
        elif a == "--font":
            font_path = argv[i + 1]; i += 2
        elif a == "--size":
            size = int(argv[i + 1]); i += 2
        elif a == "--pdf":
            pdf = True; i += 1
        elif a == "--list-fonts":
            return _list_fonts()
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            args.append(a); i += 1
    if not args:
        print(__doc__)
        return 1
    data = open(args[0], "rb").read()
    prefix = args[1] if len(args) > 1 else os.path.splitext(args[0])[0]
    nchars = sum(len(l) for pg in extract_text(data) for l in pg)
    paths, how = render_auto(data, prefix, font=font_path, rom=rom_path,
                             size=size, pdf=pdf)
    print(f"[+] {len(data)} bytes, {nchars} chars, {how}"
          f" -> {len(paths)} file(s): {paths}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
