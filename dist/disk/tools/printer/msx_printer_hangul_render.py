#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see LICENSE / NOTICE.md in printer/)
"""msx_printer_hangul_render.py - Daewoo MSX hangul printer stream -> text / PNG.

Reverse-engineered from a DPC-200 (Qnix "IQ-1000 hangul" v2.0 driver) LPRINT
capture (2026-07, openMSX printer logger): the driver sends hangul NOT as
KS codes but as a *jamo stream* - one byte per dubeolsik jamo, composition
left to the (Daewoo hangul) printer. ASCII passes through unchanged, so
English/hangul mix freely. No escape codes; lines end with CR LF.

    0x86-0x98   consonants ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ (19)
    0x99-0xA6   vowels     ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ (14, keyboard set)
    0x20-0x7E   ASCII, printed as-is
    CR LF / FF  line / page breaks

    한 = 98 99 88 (ㅎㅏㄴ)   드 = 89 a5 (ㄷㅡ)   ...capture: "한글 워드프로세서"

This module composes the jamo back into Hangul syllables with a dubeolsik
automaton (compound vowels ㅘㅝㅢ..., double patchim ㄳㄼ..., and the
carry-over rule: 한+ㅏ -> 하나). Output is Unicode text; rendering to
PNG/PDF uses a modern font via msx_printer_kanji_render (e.g. resources/fonts
Galmuri11 / NeoDunggeunmo for the period-correct johab look).

CLI:
    python3 msx_printer_hangul_render.py job.prn --font Galmuri11.ttf [out_prefix]
        --size N / --pdf    like msx_printer_kanji_render
    python3 msx_printer_hangul_render.py job.prn          # decode to stdout only
"""

import os
import sys

CONS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"          # 0x86..0x98
VOWS = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ"                    # 0x99..0xA6

CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONG = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"

VOW_COMPOUND = {("ㅗ", "ㅏ"): "ㅘ", ("ㅗ", "ㅐ"): "ㅙ", ("ㅗ", "ㅣ"): "ㅚ",
                ("ㅜ", "ㅓ"): "ㅝ", ("ㅜ", "ㅔ"): "ㅞ", ("ㅜ", "ㅣ"): "ㅟ",
                ("ㅡ", "ㅣ"): "ㅢ"}
JONG_COMPOUND = {("ㄱ", "ㅅ"): "ㄳ", ("ㄴ", "ㅈ"): "ㄵ", ("ㄴ", "ㅎ"): "ㄶ",
                 ("ㄹ", "ㄱ"): "ㄺ", ("ㄹ", "ㅁ"): "ㄻ", ("ㄹ", "ㅂ"): "ㄼ",
                 ("ㄹ", "ㅅ"): "ㄽ", ("ㄹ", "ㅌ"): "ㄾ", ("ㄹ", "ㅍ"): "ㄿ",
                 ("ㄹ", "ㅎ"): "ㅀ", ("ㅂ", "ㅅ"): "ㅄ"}
JONG_SPLIT = {v: k for k, v in JONG_COMPOUND.items()}


class Composer:
    """Dubeolsik jamo -> Hangul syllables, with carry-over (도깨비불)."""

    def __init__(self):
        self.out = []
        self.cho = self.jung = self.jong = None

    def _flush(self):
        if self.cho is not None and self.jung is not None:
            s = 0xAC00 + (CHO.index(self.cho) * 21 + JUNG.index(self.jung)) * 28
            if self.jong is not None:
                s += JONG.index(self.jong) + 1
            self.out.append(chr(s))
        elif self.cho is not None:
            self.out.append(self.cho)
        elif self.jung is not None:
            self.out.append(self.jung)
        self.cho = self.jung = self.jong = None

    def consonant(self, c):
        if self.jung is not None and self.jong is None and c in JONG:
            self.jong = c
        elif self.jong is not None and (self.jong, c) in JONG_COMPOUND:
            self.jong = JONG_COMPOUND[(self.jong, c)]
        else:
            self._flush()
            self.cho = c

    def vowel(self, v):
        if self.jong is not None:                       # carry-over: 한+ㅏ->하나
            jong = self.jong
            self.jong = None
            if jong in JONG_SPLIT:
                self.jong, carry = JONG_SPLIT[jong]
            else:
                carry = jong
            self._flush()
            self.cho = carry if carry in CHO else None
            if self.cho is None:
                self.out.append(carry)
            self.jung = v
        elif self.jung is not None and (self.jung, v) in VOW_COMPOUND:
            self.jung = VOW_COMPOUND[(self.jung, v)]
        elif self.cho is not None and self.jung is None:
            self.jung = v
        else:
            self._flush()
            self.jung = v

    def other(self, ch):
        self._flush()
        self.out.append(ch)

    def result(self):
        self._flush()
        return "".join(self.out)


def decode(data):
    """Jamo/ASCII printer stream -> list of pages, each a list of lines."""
    pages, lines, comp = [], [], Composer()

    def endline(final=False):
        nonlocal comp
        text = comp.result()
        comp = Composer()
        if text or (lines and not final):
            lines.append(text)

    for b in bytes(data):
        if 0x86 <= b <= 0x98:
            comp.consonant(CONS[b - 0x86])
        elif 0x99 <= b <= 0xA6:
            comp.vowel(VOWS[b - 0x99])
        elif b == 0x0D:
            continue
        elif b == 0x0A:
            endline()
        elif b == 0x0C:
            endline()
            if lines:
                pages.append([l for l in lines])
                lines.clear()
        elif 0x20 <= b <= 0x7E:
            comp.other(chr(b))
        # other control / unknown high bytes: ignored
    endline(final=True)
    if lines:
        pages.append(lines)
    return pages


def encode(text):
    """Unicode -> jamo stream bytes (inverse of decode; used by tests)."""
    out = bytearray()
    for ch in text:
        o = ord(ch)
        if 0xAC00 <= o <= 0xD7A3:
            o -= 0xAC00
            cho, jung, jong = CHO[o // 588], JUNG[o % 588 // 28], o % 28
            out.append(0x86 + CONS.index(cho))
            jstr = {"ㅘ": "ㅗㅏ", "ㅙ": "ㅗㅐ", "ㅚ": "ㅗㅣ", "ㅝ": "ㅜㅓ",
                    "ㅞ": "ㅜㅔ", "ㅟ": "ㅜㅣ", "ㅢ": "ㅡㅣ"}.get(jung, jung)
            out += bytes(0x99 + VOWS.index(v) for v in jstr)
            if jong:
                j = JONG[jong - 1]
                for c in JONG_SPLIT.get(j, (j,)):
                    out.append(0x86 + CONS.index(c))
        elif ch in CONS:
            out.append(0x86 + CONS.index(ch))
        elif ch in VOWS:
            out.append(0x99 + VOWS.index(ch))
        elif ch == "\n":
            out += b"\r\n"
        else:
            out.append(ord(ch) & 0x7F)
    return bytes(out)


def main(argv):
    font_path, size, pdf, args = None, 48, False, []
    i = 0
    while i < len(argv):
        if argv[i] == "--font":
            font_path = argv[i + 1]
            i += 2
        elif argv[i] == "--size":
            size = int(argv[i + 1])
            i += 2
        elif argv[i] == "--pdf":
            pdf = True
            i += 1
        elif argv[i] in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            args.append(argv[i])
            i += 1
    if not args:
        print(__doc__)
        return 1
    data = open(args[0], "rb").read()
    pages = decode(data)
    if not font_path:                                   # decode-only mode
        for n, lines in enumerate(pages, 1):
            print(f"--- page {n}")
            for l in lines:
                print(l)
        return 0
    from msx_printer_kanji_render import render_text_to_files
    prefix = args[1] if len(args) > 1 else os.path.splitext(args[0])[0]
    paths = render_text_to_files(pages, font_path, prefix, size=size, pdf=pdf)
    print(f"[+] {len(data)} bytes, font {os.path.basename(font_path)} -> {paths}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
