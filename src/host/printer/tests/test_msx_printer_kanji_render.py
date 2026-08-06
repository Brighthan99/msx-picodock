#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""msx_printer_kanji_render - the MSX kanji-printer (ESC K + JIS) dialect.

Source fixture `msxwrite_nihongo.prn` is a genuine capture (MSX-Write printing
"日本語ｍｓｘｗｒｉｔｅ" through openMSX's printer logger). The target
`msxwrite_nihongo_golden.png` is that stream rendered with the deterministic
synthetic font ROM from make_msx_kanji_fixtures.py - regenerate it with that
script whenever the renderer's geometry intentionally changes.

The JIS->index expectations encode the ROM spec reverse-engineered from
EC-702/FS-A1WX dumps (verified against openMSX's kanji device rendering).
"""
import os
import struct
import sys
import zlib

# pdtest (shared harness) stays in the sibling tests/ dir - reach it from here.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests"))
import pdtest                                    # noqa: F401  (path setup)
from pdtest import Checks

import msx_printer_escp_render as e
import msx_printer_kanji_render as mk
from make_msx_kanji_fixtures import synth_glyph_rows, synth_rom

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "msxwrite_nihongo.prn")
GOLDEN = os.path.join(HERE, "msxwrite_nihongo_golden.png")

c = Checks("msx_printer_kanji_render")

# --- JIS -> ROM index: the reverse-engineered spec, pinned ------------------
c("日 0x467C -> 3228", mk.jis_index(0x46, 0x7C) == 3228)
c("語 0x386C -> 1868", mk.jis_index(0x38, 0x6C) == 1868)
c("本 0x4B5C -> 3676", mk.jis_index(0x4B, 0x5C) == 3676)
c("。 0x2123 -> 99", mk.jis_index(0x21, 0x23) == 99)
c("あ 0x2422 -> 386", mk.jis_index(0x24, 0x22) == 386)
c("Ａ 0x2341 -> 321", mk.jis_index(0x23, 0x41) == 321)
c("JIS2 0x5021 -> second 128kB half",
  mk.jis_index(0x50, 0x21) * 32 == 0x20000 + 0x400 * 32 + 0x20)

# --- quadrant byte layout round-trips ---------------------------------------
rows = synth_glyph_rows(3228)
rom1 = bytearray(3229 * 32)
rom1[3228 * 32:] = mk.pack_glyph(rows)
c("pack_glyph/glyph_rows round-trip", mk.glyph_rows(rom1, 0x46, 0x7C) == rows)
c("glyph beyond ROM size -> None", mk.glyph_rows(b"\x00" * 64, 0x46, 0x7C) is None)

# --- dialect auto-detection -------------------------------------------------
src = open(SOURCE, "rb").read()
boxx = open(os.path.join(HERE, "escp_boxx.prn"), "rb").read()
c("capture detected as msx-kanji", mk.detect_dialect(src) == "msx-kanji")
c("escp_boxx detected as escp", mk.detect_dialect(boxx) == "escp")
c("synthetic ESC/P detected as escp",
  mk.detect_dialect(e.bitmap_to_escp(e._selftest_grid())) == "escp")

# --- render the capture with the synthetic ROM ------------------------------
r = mk.KanjiRenderer(synth_rom()).feed(src)
content = [p for p in r.pages if not p.empty()]
c("11 chars drawn (日本語ｍｓｘｗｒｉｔｅ)", r.chars == 11, r.chars)
c("one page of content", len(content) == 1, len(r.pages))
c("no chars beyond ROM", r.missing == 0, r.missing)
p = content[0]
c("line is 11 cells wide", p.maxx + 1 == 10 * mk.ADVANCE + mk.CELL, p.maxx + 1)
# The capture leads with ESC T + LF, so the line sits one 61/144" feed down.
c("line starts one ESC T 61 feed down", p.miny == round(61 * mk.VDPI / 144), p.miny)
c("line is one cell tall", p.maxy - p.miny + 1 == mk.CELL, p.maxy - p.miny + 1)
# Every synthetic glyph has a full border: char cell corners must be set.
corner_ok = all(e._get(p, k * mk.ADVANCE, p.miny) and
                e._get(p, k * mk.ADVANCE + mk.CELL - 1, p.maxy)
                for k in range(11))
c("all 11 glyph borders present", corner_ok)


# --- golden target comparison (pixel-exact, zlib-independent) ---------------
def read_png_1bit(path):
    """Decode the 1-bit grayscale PNGs written by msx_printer_escp_render.write_png_1bit."""
    blob = open(path, "rb").read()
    assert blob[:8] == b"\x89PNG\r\n\x1a\n"
    i, w, h, idat = 8, 0, 0, b""
    while i < len(blob):
        (ln,), typ = struct.unpack(">I", blob[i:i + 4]), blob[i + 4:i + 8]
        payload = blob[i + 8:i + 8 + ln]
        if typ == b"IHDR":
            w, h = struct.unpack(">II", payload[:8])
        elif typ == b"IDAT":
            idat += payload
        i += 12 + ln
    raw, stride = zlib.decompress(idat), (w + 7) // 8
    return w, h, [raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)] for y in range(h)]


out_prefix = "/tmp/msx_printer_kanji_render_t"
paths, _ = mk.render_to_png(src, synth_rom(), out_prefix)
c("golden target exists", os.path.exists(GOLDEN))
if os.path.exists(GOLDEN):
    got, want = read_png_1bit(paths[0]), read_png_1bit(GOLDEN)
    c("rendered page matches golden target", got == want,
      f"{got[0]}x{got[1]} vs {want[0]}x{want[1]}")

# --- JIS -> Unicode text extraction (stdlib euc_jp, no font needed) ---------
c("extract_text decodes the capture",
  mk.extract_text(src) == [["日本語ｍｓｘｗｒｉｔｅ"]], mk.extract_text(src))
c("records survive rom=None parsing",
  len(mk.KanjiRenderer(None).feed(src).records) == 11)

# --- font resolution: the MSX font wins (v0.33.0 merge) ---------------------
# resolve_font() picks the backend: explicit --font, else the machine's kanji
# ROM, else a bundled font. These pin the precedence without needing a real ROM.
c("explicit font wins", mk.resolve_font("X.ttf", "R.ROM")[:2] == ("font", "X.ttf"))
c("given ROM beats auto-detection", mk.resolve_font(None, "R.ROM")[:2] == ("rom", "R.ROM"))
_kind, _val, _how = mk.resolve_font()
# On a fresh clone resources/ is empty - it is gitignored, user-supplied
# territory - so there is neither a kanji ROM nor a font to fall back to and
# resolve_font() has nothing to return. That is the documented state, not a
# failure, so this only asserts the precedence when something is installed.
if _kind == "none":
    print("  --   font resolution check skipped "
          "(no kanji ROM and no font in resources/fonts - see docs/printing.md)")
else:
    c("no options -> a ROM if found, else a bundled font",
      _kind in ("rom", "font"), _how)
c("bundled jp fallback is the 16-dot DotGothic16", mk.BUNDLED_JP[0] == "DotGothic16.ttf")
c("bundled kr fallback is hangul-capable", mk.BUNDLED_KR[0] in
  ("NeoDunggeunmo.ttf", "Galmuri11.ttf"), mk.BUNDLED_KR[0])
c("find_rom rejects wrong-sized files", mk.find_rom() is None
  or __import__("os").path.getsize(mk.find_rom()) in (0x20000, 0x40000))
# The merged module must still expose what jis_modern_render did.
for fn in ("render_to_files", "render_text_to_files", "render_auto", "extract_text"):
    c(f"merged API has {fn}", callable(getattr(mk, fn, None)))

# --- modern-font rendering (optional: needs Pillow + resources/fonts) -------
FONTS_DIR = os.path.join(HERE, "..", "..", "..", "..", "resources", "fonts")
try:
    from PIL import Image                            # noqa: F401
    have_pil = True
except ImportError:
    have_pil = False
font_files = sorted(f for f in (os.listdir(FONTS_DIR) if os.path.isdir(FONTS_DIR) else [])
                    if f.lower().endswith((".ttf", ".otf")))
if not (have_pil and font_files):
    print(f"  --   modern-font checks skipped "
          f"({'no Pillow' if not have_pil else 'no fonts in resources/fonts'})")
else:
    import msx_printer_kanji_render as jm
    for f in font_files:
        out = f"/tmp/msx_kanji_modern_{os.path.splitext(f)[0]}"
        paths = jm.render_to_files(src, os.path.join(FONTS_DIR, f), out)
        ok = paths and all(os.path.getsize(p) > 500 for p in paths)
        c(f"modern render with {f}", ok, paths)

# --- real font ROM (optional: not in the repo history, so skip if absent) ---
# Found the way the renderer finds it, rather than by a path spelled out here.
# Those two drifted apart once: the module searched resources/msx-roms/ and not
# resources/font-roms/, so dumps had to be copied into the other one to be seen
# at all. A test that hardcodes the workaround cannot notice what it works
# around. Pinned to the EC-702 bitmap, so it is that dump we want and not merely
# any dump - find_rom() would hand back whichever sorts first.
REAL_ROM = os.environ.get("MSX_KANJI_ROM") or next(
    (os.path.join(d, "ec-702_kanjifont.rom") for d in mk.ROM_DIRS
     if os.path.exists(os.path.join(d, "ec-702_kanjifont.rom"))), "")
if not os.path.exists(REAL_ROM):
    print(f"  --   real-ROM checks skipped ({REAL_ROM} not found)")
else:
    import hashlib
    rom = open(REAL_ROM, "rb").read()
    c("real ROM is 128/256kB", len(rom) in (0x20000, 0x40000), len(rom))

    # 日 (JIS 0x467C) pinned against the EC-702 dump: three horizontal bars
    # (rows 1/7/14) over side strokes - the exact rows the MSX-Write screen
    # rendering showed. This nails formula + quadrant layout on real data.
    sha1 = hashlib.sha1(rom).hexdigest()
    if sha1 == "fc71561a64f73da0e0043d256f67fd18d7fc3a7f":     # EC-702 dump
        want_ni = ([0x0000, 0x3FF8] + [0x2008] * 5 + [0x3FF8]
                   + [0x2008] * 6 + [0x3FF8, 0x2008])
        c("real 日 glyph matches EC-702 bitmap",
          mk.glyph_rows(rom, 0x46, 0x7C) == want_ni)
    else:
        print(f"  --   unknown dump (sha1 {sha1[:12]}...), bitmap pin skipped")
        g = mk.glyph_rows(rom, 0x46, 0x7C)
        c("real 日 glyph has 3 repeated bars",
          g is not None and max(g.count(r) for r in g if r) >= 3)

    rr = mk.KanjiRenderer(rom).feed(src)
    c("real ROM: 11 chars, none missing", rr.chars == 11 and rr.missing == 0,
      (rr.chars, rr.missing))
    real_content = [pg for pg in rr.pages if not pg.empty()]
    c("real ROM: one page of content", len(real_content) == 1)
    rp = real_content[0]
    # Real glyphs need not touch their cell edges, so allow ink to end up to
    # one cell short of the synthetic (full-border) extents.
    c("real ROM: line spans 11 char cells",
      10 * mk.ADVANCE <= rp.maxx + 1 <= 10 * mk.ADVANCE + mk.CELL
      and mk.CELL // 2 <= rp.maxy - rp.miny + 1 <= mk.CELL,
      (rp.maxx + 1, rp.maxy - rp.miny + 1))
    real_paths, _ = mk.render_to_png(src, rom, "/tmp/msx_printer_kanji_render_real")
    print(f"  --   real-ROM render for eyeballing: {real_paths[0]}")

sys.exit(c.done())
