#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see ../LICENSE / ../NOTICE.md)
"""msx_printer_detect - what `--print auto` decides, and where it gives up.

The interesting cases are the ones that used to go wrong: shift_jis text was
read as a Daewoo jamo stream (its lead/trail bytes sit across 0x86-0xA6), and a
codec that merely *decoded* could beat an honest no-answer. Both are pinned
here.

The candidate list is only what MSX hardware has been shown to emit, which is
why Chinese and Korean are both absent - see _CJK_CODECS for the evidence, and
the density floor below for why removing them is safe rather than merely tidy.
`--print auto` always keeps the raw .prn, so a wrong guess is recoverable
either way.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "tests"))
import pdtest                                    # noqa: F401  (path setup)
from pdtest import Checks

import msx_printer_detect as det
import msx_printer_kanji_render as mk

c = Checks("msx_printer_detect")
HERE = os.path.dirname(os.path.abspath(__file__))


def _fixture(name):
    with open(os.path.join(HERE, name), "rb") as fh:
        return fh.read()


# --- the three captured dialects --------------------------------------------
c("bit-image capture -> raster", det.detect(_fixture("escp_boxx.prn"))[0] == "raster")
c("MSX-Write capture -> msx-kanji",
  det.detect(_fixture("msxwrite_nihongo.prn"))[0] == "msx-kanji")
c("Daewoo capture -> msx-hangul",
  det.detect(_fixture("dpc200_hangul.prn"))[0] == "msx-hangul")

# --- plain text --------------------------------------------------------------
mode, charset, _ = det.detect(b"HELLO MSX\r\nSECOND LINE\r\n")
c("ASCII -> text/cp437", (mode, charset) == ("text", "cp437"), (mode, charset))
c("empty job -> off", det.detect(b"")[0] == "off")

# --- ESC/P without graphics --------------------------------------------------
# Styling opcodes carry layout a byte->text decode would drop, so they go to the
# renderer even though there is not a single dot in the stream.
c("ESC/P styling -> raster",
  det.detect(bytes([27, 0x45]) + b"BOLD" + bytes([27, 0x46]))[0] == "raster")
c("ESC * graphics -> raster",
  det.detect(bytes([27, 0x2A, 39, 1, 0, 0xFF, 0xFF, 0xFF]))[0] == "raster")

# --- the shift_jis regression (was detected as msx-hangul before v0.34.0) ----
for s in ("日本語のテスト文書です", "プリンタ出力の試験", "あいうえお", "こんにちは世界"):
    mode, charset, _ = det.detect(s.encode("shift_jis") + b"\r\n")
    c(f"shift_jis {s[:6]!r} -> text/shift_jis",
      (mode, charset) == ("text", "shift_jis"), (mode, charset))
    c(f"shift_jis {s[:6]!r} is not a jamo stream",
      mk.detect_dialect(s.encode("shift_jis")) != "msx-hangul")

# A real jamo capture has *no* high byte outside 0x86-0xA6 - that is what
# separates it from Japanese text, and what the fixed rule keys on.
jamo = _fixture("dpc200_hangul.prn")
c("jamo capture: every high byte is a jamo",
  all(0x86 <= b <= 0xA6 for b in jamo if b >= 0x80))

# --- two-byte Korean has no codec candidate yet ------------------------------
# Korea had MSX in quantity, but no Korean *codec* has been shown to come out of
# one: the Daewoo driver sends jamo (the dialect above), and the era's other
# method was a 7-bit johab in SI/SO, which is not Python's `johab` (that is the
# later 8-bit cp1361). So both are out until a capture settles it, and Korean
# two-byte text lands as raw - the capture is kept, nothing is invented.
for _cs in ("euc_kr", "johab"):
    mode, charset, _ = det.detect("한글 문서 시험입니다\r\n".encode(_cs))
    c(f"{_cs} -> raw, not a wrong guess", (mode, charset) == ("raw", None),
      (mode, charset))

# That only holds because a decode has to produce mostly CJK to count. euc_kr
# bytes DO decode as shift_jis - into half-width katakana noise with one stray
# ideograph - and before the density floor that single hit was enough to win.
_noise = "한글 문서 시험입니다".encode("euc_kr").decode("shift_jis")
c("euc_kr-as-shift_jis really is decodable noise", len(_noise) > 0)
_best, _scores = det.sniff_charset("한글 문서 시험입니다".encode("euc_kr"))
c("...and the density floor rejects it", _best is None, _scores)

# --- utf-8: not period, but modern tooling prints it -------------------------
# Weighted above the rest because it validates: arbitrary bytes almost never
# form well-formed multi-byte UTF-8, so a clean decode is evidence.
for _s in ("한글 문서 시험", "日本語のテスト"):
    mode, charset, _ = det.detect(_s.encode("utf-8") + b"\r\n")
    c(f"utf-8 {_s[:4]!r} -> text/utf-8", (mode, charset) == ("text", "utf-8"),
      (mode, charset))

# --- Chinese is gone on purpose ----------------------------------------------
# MSX was never sold in mainland China (msx.org has no record of any activity
# there, and there is no Chinese character ROM for the machine), so gb2312 and
# big5 only ever contributed a wrong answer - and one that could not be told
# from euc_kr, since they share a byte structure. Dropping them retired that
# blind spot rather than tolerating it.
c("gb2312 is not a candidate", "gb2312" not in det._CJK_CODECS, det._CJK_CODECS)
c("big5 is not a candidate", "big5" not in det._CJK_CODECS, det._CJK_CODECS)

# The scorer must at least never crash on a codec that cannot decode the bytes.
_best, scores = det.sniff_charset(b"\xff\xfe\xff\xfe")
c("sniff_charset survives undecodable bytes", isinstance(scores, dict))

# describe() is what the log line uses - it must mention the mode.
c("describe mentions the mode", "raster" in det.describe(_fixture("escp_boxx.prn")))

sys.exit(c.done())
