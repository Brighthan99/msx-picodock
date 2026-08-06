#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only  (see LICENSE / NOTICE.md in printer/)
"""msx_printer_recharset.py - re-read a captured .prn under a different charset.

A capture is just the bytes the MSX sent, so the charset is *our* choice at
render time, not something baked into the file. Picked the wrong one at capture
time, or unsure which machine the print came from? Re-run this - no reprinting.

Two independent knobs, easy to mix up:

  --charset       the printer's **glyph set** - which character ROM draws the
                  dots. Affects the PNG. msx (default) | msx-din | msx-jp |
                  fx80 | cp437.  MSX takes priority over FX-80, so an MSX ROM
                  is the default; see msx_printer_escp_render.
  --text-charset  the **text codec** - how bytes decode to Unicode for --text.
                  cp437 (default) | shift_jis | cp932 | utf-8.
                  Any Python codec name works; unknown ones fall back.

`--all` renders every glyph set at once, which is the quick way to decide which
one a mystery capture actually wants.

Usage:
    msx_printer_recharset.py job.prn                       # -> job.png  (msx)
    msx_printer_recharset.py job.prn --charset msx-jp      # -> job.png  (Japanese ROM)
    msx_printer_recharset.py job.prn --all                 # -> job_msx.png, job_fx80.png ...
    msx_printer_recharset.py job.prn out                   # -> out.png
    msx_printer_recharset.py job.prn --text                # decoded text to stdout
    msx_printer_recharset.py job.prn --text --text-charset shift_jis -o job.txt
    msx_printer_recharset.py --list
"""

import os
import sys

import msx_printer_escp_render as er

#: Worth naming for MSX output: what the machine has been shown to emit.
#: Chinese and Korean are absent - see msx_printer_detect._CJK_CODECS for the
#: evidence. Any Python codec name still works if you pass one, so a Korean
#: capture can be tried by hand the day one turns up.
TEXT_CHARSETS = ("cp437", "shift_jis", "cp932", "utf-8", "latin-1")

_DESCRIPTIONS = {
    "msx":     "MSX International character ROM (Philips NMS8250) - the default",
    "msx-din": "MSX International, DIN variant (slashless zero)",
    "msx-jp":  "MSX Japanese ROM (Sony HB-F1XV), katakana at 0xA1-0xDF",
    "fx80":    "Epson FX-80 ROM, period-correct (high bit = italics)",
    "cp437":   "FX-80 glyphs with the CP437 upper region mapped onto them",
}


def decode_text(data, charset="cp437"):
    """Decode printer bytes to Unicode, falling back to cp437 on a bad codec."""
    try:
        return bytes(data).decode(charset, errors="replace")
    except LookupError:
        return bytes(data).decode("cp437", errors="replace")


def render(data, out_prefix, charset=er.DEFAULT_CHARSET):
    """Render `data` under one glyph charset. Returns (paths, renderer)."""
    return er.render_to_png(data, out_prefix, charset)


def render_all(data, out_prefix):
    """Render `data` under every glyph charset. Returns {charset: paths}."""
    return {cs: er.render_to_png(data, f"{out_prefix}_{cs}", cs)[0]
            for cs in er.CHARSETS}


def _list():
    print("glyph sets (--charset):")
    for cs in er.CHARSETS:
        mark = "  <- default" if cs == er.DEFAULT_CHARSET else ""
        print(f"  {cs:9} {_DESCRIPTIONS.get(cs, '')}{mark}")
    print("\ntext codecs (--text-charset):")
    print("  " + " ".join(TEXT_CHARSETS) + "   (any Python codec also works)")
    return 0


def main(argv):
    charset, text_charset = er.DEFAULT_CHARSET, "cp437"
    want_text, want_all, out, args = False, False, None, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--charset":
            charset = argv[i + 1]; i += 2
        elif a == "--text-charset":
            text_charset = argv[i + 1]; i += 2
        elif a in ("-o", "--output"):
            out = argv[i + 1]; i += 2
        elif a == "--text":
            want_text = True; i += 1
        elif a == "--all":
            want_all = True; i += 1
        elif a == "--list":
            return _list()
        elif a in ("-h", "--help"):
            print(__doc__); return 0
        else:
            args.append(a); i += 1

    if not args:
        print(__doc__)
        return 0
    if charset not in er.CHARSETS:
        print(f"[-] unknown --charset {charset!r} ({'|'.join(er.CHARSETS)})"
              "  - see --list")
        return 1

    path = args[0]
    prefix = args[1] if len(args) > 1 else os.path.splitext(path)[0]
    try:
        data = open(path, "rb").read()
    except OSError as exc:
        print(f"[-] {exc}")
        return 1
    print(f"[*] {path}: {len(data)} bytes")

    if want_text:
        text = decode_text(data, text_charset)
        target = out or (prefix + ".txt" if len(args) > 1 else None)
        if target:
            with open(target, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
            print(f"[+] text ({text_charset}) -> {target}")
        else:
            sys.stdout.write(text)
            if not text.endswith("\n"):
                sys.stdout.write("\n")
        return 0

    if want_all:
        for cs, paths in render_all(data, prefix).items():
            print(f"[+] {cs:9} -> {', '.join(paths)}")
        return 0

    paths, r = render(data, out or prefix, charset)
    note = f"charset {r.charset}"
    if r.charset == "cp437":
        note += " (FX-80 glyphs, CP437 upper region mapped)"
    print(f"[+] {len(paths)} page(s), {note}, {r.text_bytes} text bytes"
          f" -> {', '.join(paths)}")
    if r.unknown:
        print(f"    unhandled ESC codes: {r.unknown}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
