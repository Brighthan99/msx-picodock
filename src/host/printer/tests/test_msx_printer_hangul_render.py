#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""msx_printer_hangul_render - the Daewoo hangul jamo-stream printer dialect.

Source fixture `dpc200_hangul.prn` is a genuine capture: DPC-200 (Qnix
"IQ-1000 hangul" v2.0 driver) running 10 LPRINT"한글 워드프로세서" /
20 LPRINT"=============", logged by openMSX's printer logger. Hangul goes
out as one byte per dubeolsik jamo (0x86-0xA6), ASCII as-is.
"""
import os
import sys

# pdtest (shared harness) stays in the sibling tests/ dir - reach it from here.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests"))
import pdtest                                    # noqa: F401  (path setup)
from pdtest import Checks

import msx_printer_kanji_render as mk
import msx_printer_hangul_render as mh

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "dpc200_hangul.prn")

c = Checks("msx_printer_hangul_render")

# --- the real capture decodes to what was typed on the DPC-200 --------------
src = open(SOURCE, "rb").read()
c("capture decodes to 한글 워드프로세서 x2 + ruler",
  mh.decode(src) == [["한글 워드프로세서", "한글 워드프로세서", "============="]],
  mh.decode(src))

# --- jamo byte map pinned (reverse-engineered spec) -------------------------
c("ㄱ is 0x86, ㅎ is 0x98", mh.CONS[0] == "ㄱ" and mh.CONS[0x98 - 0x86] == "ㅎ")
c("ㅏ is 0x99, ㅣ is 0xA6", mh.VOWS[0] == "ㅏ" and mh.VOWS[0xA6 - 0x99] == "ㅣ")
c("한 = 98 99 88", mh.encode("한") == bytes([0x98, 0x99, 0x88]))
c("드 = 89 a5", mh.encode("드") == bytes([0x89, 0xA5]))

# --- composer: the hard cases -----------------------------------------------
rt = "MSX 한글 Test 123 mixed!"
c("English/hangul mix round-trips", mh.decode(mh.encode(rt)) == [[rt]])
c("carry-over 하나 (ㅎㅏㄴㅏ)",
  mh.decode(bytes([0x98, 0x99, 0x88, 0x99])) == [["하나"]])
c("compound vowel 워 (ㅇㅜㅓ)",
  mh.decode(bytes([0x91, 0xA3, 0x9D])) == [["워"]])
c("double patchim 값 (ㄱㅏㅂㅅ)",
  mh.decode(mh.encode("값")) == [["값"]])
c("double patchim carry-over 없어 -> 업서? no: 없어",
  mh.decode(mh.encode("없어")) == [["없어"]])
c("복모음+쌍받침 됐다", mh.decode(mh.encode("됐다")) == [["됐다"]])
c("lone jamo pass through", mh.decode(mh.encode("ㅋㅋ 의")) == [["ㅋㅋ 의"]])

# --- dialect detection routes all three correctly ---------------------------
c("capture detected as msx-hangul", mk.detect_dialect(src) == "msx-hangul")
c("kanji capture still msx-kanji",
  mk.detect_dialect(open(os.path.join(HERE, "msxwrite_nihongo.prn"), "rb").read())
  == "msx-kanji")
c("escp fixture still escp",
  mk.detect_dialect(open(os.path.join(HERE, "escp_boxx.prn"), "rb").read())
  == "escp")

# --- modern-font rendering (optional: needs Pillow + hangul fonts) ----------
FONTS_DIR = os.path.join(HERE, "..", "..", "..", "..", "resources", "fonts")
try:
    from PIL import Image                            # noqa: F401
    have_pil = True
except ImportError:
    have_pil = False
hangul_fonts = [f for f in ("Galmuri11.ttf", "NeoDunggeunmo.ttf",
                            "NotoSansKR.ttf", "Pretendard.otf")
                if os.path.exists(os.path.join(FONTS_DIR, f))]
if not (have_pil and hangul_fonts):
    print("  --   modern-font checks skipped "
          f"({'no Pillow' if not have_pil else 'no hangul fonts'})")
else:
    from msx_printer_kanji_render import render_text_to_files
    pages = mh.decode(src)
    for f in hangul_fonts:
        out = f"/tmp/msx_hangul_{os.path.splitext(f)[0]}"
        paths = render_text_to_files(pages, os.path.join(FONTS_DIR, f), out)
        c(f"render with {f}", paths and all(os.path.getsize(p) > 500 for p in paths))

sys.exit(c.done())
