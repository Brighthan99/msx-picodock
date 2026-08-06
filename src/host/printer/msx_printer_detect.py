#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see LICENSE / NOTICE.md in printer/)
"""msx_printer_detect.py - look at a captured print job and say how to render it.

`--print auto` uses this: the daemon holds the whole job (it saves on an idle
timeout, not while streaming), so the decision is made with every byte in hand.

    mode, charset, why = detect(data)

`mode` is one of the daemon's output modes plus the two post-hoc dialects:

    off               empty job
    text              ASCII/control bytes only, or CJK sent as character codes
                      (then `charset` names the codec - see the caveat below)
    raster            ESC/P: bit-image graphics, or text with styling opcodes
                      that only the renderer reproduces faithfully
    msx-kanji         ESC K + JIS X 0208 - needs a kanji ROM or a font
    msx-hangul        Daewoo jamo stream - needs a hangul font

**Auto-detection is a convenience, not an oracle.** `--print auto` always writes
the raw .prn as well, so a wrong guess costs nothing: re-render the capture with
msx_printer_recharset.py.

The codec candidates are chosen for what this hardware actually emits, not for
CJK coverage in general - see _CJK_CODECS. Chinese used to be in the list and
was the one measured failure (gb2312 read as euc_kr, 0/5); it is gone because
MSX was never sold in mainland China, which makes the failure moot rather than
merely tolerated.

Hangul arrives two different ways and only one of them is a codec at all:
Daewoo's printer driver sends a *jamo stream* (one byte per jamo, 0x86-0xA6,
composed by the printer) and that is the msx-hangul dialect, not text. Two-byte
Korean has no candidate codec here yet - see _CJK_CODECS - so it lands as raw,
which is the honest answer until a capture says which encoding to add.
"""

import re

import msx_printer_kanji_render as _mk

#: Bit-image opcodes: ESC * / K / L / Y / Z / ^ and FS Z. Any of these means the
#: stream carries dots, so only the renderer can reproduce the page.
_GFX = re.compile(rb"\x1b[\x2a\x4b\x4c\x59\x5a\x5e]|\x1cZ")

#: Styling/layout opcodes - no dots, but pitch, bold, underline, tabs and
#: margins are lost by a plain byte->text decode, so prefer the renderer.
_STYLE = re.compile(rb"\x1b[\x21\x2d\x34\x35\x45\x46\x47\x48\x4d\x50"
                    rb"\x53\x54\x57\x67\x70\x44\x42\x51\x6c\x24\x5c]")

#: Codecs tried when a stream has high bytes but no ESC/P structure.
#:
#: utf-8 first: it is the one encoding here that validates. Arbitrary 8-bit
#: data almost never forms well-formed multi-byte UTF-8, so a clean decode is
#: strong evidence rather than a guess. No MSX-era software emits it - modern
#: cross-development tools do, and they are what prints it.
#:
#: Nothing Korean, for now. Korea had MSX in quantity (Daewoo CPC/DPC, Zemmix),
#: but no Korean *codec* has been shown to come out of one. What has: the Daewoo
#: printer driver's jamo stream, which is the msx-hangul dialect, not text. The
#: era's other method was a 7-bit johab wrapped in SI/SO - and Python's `johab`
#: codec is the later 8-bit KS C 5601-1992 (cp1361), a different thing that was
#: added here on the strength of a shared name. euc_kr is the PC/DOS standard
#: from 1987 with no MSX evidence either. Both are out until a capture settles
#: it; see the note in PRINTING.md for what to look for.
#:
#: Chinese is out for a stronger reason: MSX was never sold in mainland China -
#: msx.org has no record of any activity there and the machine has no Chinese
#: character ROM - so gb2312/big5 could only ever add a wrong answer.
_CJK_CODECS = ("utf-8", "shift_jis")

#: A decode only counts if the CJK it produced is most of what came out. Any
#: 8-bit codec will "succeed" on bytes meant for another one - euc_kr text
#: decodes as shift_jis into half-width katakana noise with the odd ideograph
#: in it - and without this a single accidental hit would beat an honest
#: no-answer. Below the threshold we return None, and the caller keeps the
#: capture as raw rather than writing a confidently wrong .txt.
_CJK_MIN_DENSITY = 0.30


def sniff_charset(data):
    """Guess the text codec of a CJK byte stream. Returns (name, scores).

    Scoring: kana and Hangul syllables are weighted over plain ideographs
    because only one codec can produce each - a kana run all but proves
    shift_jis. utf-8 gets a further bump for validating; see _CJK_CODECS."""
    scores = {}
    for cs in _CJK_CODECS:
        try:
            t = bytes(data).decode(cs)
        except Exception:
            scores[cs] = -1
            continue
        kana = sum("぀" <= c <= "ヿ" for c in t)
        hang = sum("가" <= c <= "힣" for c in t)
        han = sum("一" <= c <= "鿿" for c in t)
        cjk = kana + hang + han
        body = sum(not c.isspace() for c in t) or 1
        if cjk / body < _CJK_MIN_DENSITY:
            scores[cs] = 0            # decoded, but into noise - not an answer
            continue
        score = kana * 3 + hang * 3 + han
        # A clean utf-8 decode is a checksum, not a coincidence: the multi-byte
        # form is self-validating, so weight it above the codecs that accept
        # any byte pair. Only when it actually produced CJK, though - ASCII is
        # valid utf-8 too and is handled before we ever get here.
        if cs == "utf-8":
            score *= 2
        scores[cs] = score
    best = max(scores, key=scores.get)
    return (best if scores[best] > 0 else None), scores


def detect(data):
    """(mode, charset, why) for a complete print job. `charset` is None unless
    mode is 'text' and the bytes look like CJK character codes."""
    data = bytes(data)
    if not data:
        return "off", None, "empty job"

    dialect = _mk.detect_dialect(data)
    if dialect == "msx-kanji":
        return "msx-kanji", None, "ESC K + JIS codes (kanji ROM or font needed)"
    if dialect == "msx-hangul":
        return "msx-hangul", None, "Daewoo jamo stream (hangul font needed)"

    if _GFX.search(data):
        return "raster", None, "ESC/P bit-image opcodes"
    if _STYLE.search(data):
        return "raster", None, "ESC/P styling opcodes (a text decode drops them)"

    hi = sum(b >= 0x80 for b in data)
    if hi:
        cs, scores = sniff_charset(data)
        if cs:
            ranked = ", ".join(f"{k}={v}" for k, v in
                               sorted(scores.items(), key=lambda kv: -kv[1]))
            return "text", cs, f"CJK character codes ({ranked})"
        return "raw", None, f"{hi} high bytes, no structure recognised"

    return "text", "cp437", "ASCII and control codes only"


def describe(data):
    """One line summarising what detect() decided, for logs."""
    mode, charset, why = detect(data)
    return f"{mode}{' --charset ' + charset if charset else ''}  ({why})"


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(0)
    for path in sys.argv[1:]:
        with open(path, "rb") as fh:
            print(f"{path}: {describe(fh.read())}")
