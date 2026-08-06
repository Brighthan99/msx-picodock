#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-2.0-only  (see LICENSE / NOTICE.md in printer/)
"""
MSX printer output -> files. The rendering half of the print pipeline.

(c) 2026 MSX PicoVerse Project

Given the bytes an MSX printed, this turns them into something you can look at:
text, a raw .prn, a PDF, a 1-bit PNG rendered from ESC/P, or a job handed to a
CUPS printer. It does not talk to any hardware - callers hand it a finished job:

  * pd_diskserver.py           Printer.flush() -> save_print_job()
  * msx_printer_spool.py       render / merge from a capture

Features:
  * MSX character-set decoding (International font ~= CP437) for TXT/PDF/console.
  * PDF output wraps long lines and strips ESC/P control codes.
  * Console echo is sanitized so raw control bytes can't corrupt the terminal.
  * `auto` inspects a finished job and picks a mode, always keeping the .prn.

It used to be a daemon as well, with its own receive loop over USB serial (and
once over TCP). That only worked with the standalone printer firmware, which put
nothing but print bytes on the pipe; the integrated firmware frames everything so
it can share the pipe with disk sectors. The loop is in
archive/src/host/printer/standalone_daemon.py, which still calls into here.
"""

import os
from datetime import datetime

from msx_printer_paths import rel, script_output

#: Where jobs land when the caller does not say. Script-relative, so it is the
#: same folder however this is launched - see msx_printer_paths.
DEFAULT_OUTPUT = script_output(__file__)

# Optional import for PDF generation
try:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    HAS_REPORTLAB = True
except ImportError:
    HAS_REPORTLAB = False

# Seconds to wait between serial (re)connection attempts.


# -----------------------------------------------------------------------------
# MSX character-set handling
# -----------------------------------------------------------------------------
# MSX text is emitted in the machine's character ROM encoding, NOT Latin-1/CP1252.
# For the International (Western) MSX character set the printable upper region
# (0x80-0xAF: accented letters, currency symbols, punctuation) matches IBM CP437
# exactly, so decoding with CP437 is a far better match than cp1252. Bytes
# 0x00-0x1F stay as control codes (printer/ESC-P control), which callers keep
# (raw), strip (pdf), or sanitize (console) as appropriate.
#
# Japanese/Korean MSX machines use different ROM fonts; if you target those,
# add the differing positions to MSX_CHAR_OVERRIDES (msx_byte -> unicode char).
MSX_CHAR_OVERRIDES = {
    # 0x?? : "\u????",
}


def decode_msx(data, charset="cp437") -> str:
    """Decode raw MSX printer bytes to Unicode using `charset` - the MSX ROM
    encoding the bytes are in: 'cp437' for International/Western (default), or a
    multi-byte codec for text-mode CJK: 'shift_jis'/'cp932' (Japanese),
    'utf-8' (modern tools). Any Python codec name is accepted; an unknown one
    falls back to
    cp437. NOTE: most MSX word processors send CJK as ESC/P bit-image graphics,
    not text codes - use --print raster/escp for those; --charset only helps
    software that prints CJK as actual character codes.

    MSX_CHAR_OVERRIDES patches individual single-byte positions (cp437 only)."""
    try:
        if MSX_CHAR_OVERRIDES and charset == "cp437":
            return "".join(
                MSX_CHAR_OVERRIDES.get(b, bytes([b]).decode("cp437", errors="replace"))
                for b in bytes(data)
            )
        return bytes(data).decode(charset, errors="replace")
    except LookupError:
        return bytes(data).decode("cp437", errors="replace")


def sanitize_for_console(text: str) -> str:
    """Keep tab/newline; replace other control chars & DEL so ESC/P sequences
    can't move the cursor, change colours, or otherwise corrupt the terminal."""
    return "".join(
        ch if (ch in "\t\r\n" or (32 <= ord(ch) != 127)) else "·"
        for ch in text
    )


# -----------------------------------------------------------------------------
# Console logging helpers
#
# When this module is used as a library (pd_diskserver imports save_print_job)
# the embedding server may own the screen - a split-screen view would be shredded
# by a stray print() from in here. set_report_sink() lets it take delivery of
# these messages instead. Standalone, nothing is installed and they print as
# they always have.
# -----------------------------------------------------------------------------
_report_sink = None


def set_report_sink(fn):
    """Route the messages below to `fn(level, msg)` - level is info/ok/error.
    Pass None to go back to printing."""
    global _report_sink
    _report_sink = fn


def print_status(msg):
    if _report_sink:
        _report_sink("info", msg)
        return
    print(f"[*] {msg}", flush=True)


def print_success(msg):
    if _report_sink:
        _report_sink("ok", msg)
        return
    print(f"[+] {msg}", flush=True)


def print_error(msg):
    if _report_sink:
        _report_sink("error", msg)
        return
    print(f"[-] {msg}", flush=True)


# -----------------------------------------------------------------------------
# Saving a completed print job
# -----------------------------------------------------------------------------
def _pdf_clean_line(line: str) -> str:
    """Expand tabs and drop remaining control chars so ESC/P codes don't render
    as tofu boxes in the PDF."""
    line = line.replace("\t", "    ")
    return "".join(ch for ch in line if 32 <= ord(ch) != 127)


def _wrap(line: str, width: int):
    """Hard-wrap a line to at most `width` characters (monospace)."""
    if not line:
        return [""]
    return [line[i:i + width] for i in range(0, len(line), width)]


def _save_dialect(data, dialect, base_name, timestamp, raw_name, out_dir):
    """msx-kanji / msx-hangul: render with whatever font the machine offers.
    The kanji path prefers the MSX's own ROM; hangul has no ROM, so it needs a
    bundled font. Either way the raw capture at `raw_name` stays on disk."""
    prefix = os.path.join(out_dir, f"{base_name}_{timestamp}")
    try:
        import msx_printer_kanji_render as mk
        if dialect == "msx-kanji":
            paths, how = mk.render_auto(data, prefix)
        else:
            # Hangul has no printer ROM to prefer - the Daewoo machines drove a
            # jamo protocol, not a glyph ROM - so go straight to a bundled font.
            # (resolve_font would hand back a *kanji* ROM here, which is useless.)
            import msx_printer_hangul_render as mh
            font = mk.find_bundled_font("kr")
            if not font:
                print_error("no hangul font in resources/fonts; kept RAW only: "
                            + raw_name)
                return
            how = f"font {os.path.basename(font)} (bundled)"
            paths = mk.render_text_to_files(mh.decode(data), font, prefix)
        print_success(f"Rendered {dialect} with {how}: {', '.join(paths)}")
        print_status(f"raw kept alongside: {raw_name}")
    except Exception as exc:
        print_error(f"{dialect} render failed ({exc}); kept RAW: {raw_name}")


def save_print_job(data, mode, base_name, charset="cp437", glyphs=None,
                   timestamp=None, out_dir=None):
    if not data:
        return

    if timestamp is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = out_dir or DEFAULT_OUTPUT
    os.makedirs(out, exist_ok=True)

    if mode == "auto":
        # Decide from the finished job - the daemon saves on an idle timeout, so
        # every byte is already in hand. The raw .prn is written *first and
        # always*: a wrong guess then costs nothing, because the capture is still
        # there to re-render (msx_printer_recharset.py).
        raw_name = os.path.join(out, f"{base_name}_{timestamp}.prn")
        with open(raw_name, "wb") as f:
            f.write(bytes(data))
        try:
            import msx_printer_detect
            picked, cs, why = msx_printer_detect.detect(data)
        except Exception as exc:
            print_error(f"auto-detect failed ({exc}); kept RAW only: {raw_name}")
            return
        print_status(f"auto -> {picked}"
                     + (f" --charset {cs}" if cs else "")
                     + f"  ({why})")
        if picked in ("off", "raw"):
            print_success(f"Saved RAW print job to: {rel(raw_name)}")
            return
        if picked in ("msx-kanji", "msx-hangul"):
            # Dialects need a font/ROM decision - render through the post-hoc
            # tool's resolver rather than guessing here.
            _save_dialect(data, picked, base_name, timestamp, raw_name, out)
            return
        save_print_job(data, picked, base_name, cs or charset, glyphs,
                       timestamp, out)
        print_status(f"raw kept alongside: {raw_name}")
        return

    # 'raw' is no longer offered on the command line - `auto` writes the .prn
    # before it interprets anything, so asking for raw alone gained nothing but
    # a shorter file list. The mode itself stays, and is load-bearing: `auto`
    # falls back to it when the detector finds no structure, `raster` falls back
    # to it when a render throws, and msx_printer_spool merges with it.
    if mode == "raw":
        filename = os.path.join(out, f"{base_name}_{timestamp}.prn")
        with open(filename, "wb") as f:
            f.write(bytes(data))
        print_success(f"Saved RAW print job to: {rel(filename)}")

    elif mode == "text":
        filename = os.path.join(out, f"{base_name}_{timestamp}.txt")
        text_content = decode_msx(data, charset)
        # newline="" keeps the original line endings verbatim (no CRLF doubling).
        with open(filename, "w", encoding="utf-8", newline="") as f:
            f.write(text_content)
        print_success(f"Saved TEXT print job to: {rel(filename)}")

    elif mode == "pdf":
        if not HAS_REPORTLAB:
            print_error("ReportLab is not installed. Falling back to TEXT output.")
            save_print_job(data, "text", base_name, charset, out_dir=out)
            return

        filename = os.path.join(out, f"{base_name}_{timestamp}.pdf")
        try:
            page_w, page_h = letter
            left, top, bottom, leading = 50, 750, 50, 12
            font_name, font_size = "Courier", 10
            char_w = font_size * 0.6                       # Courier advance width
            max_chars = max(1, int((page_w - left - 40) / char_w))

            c = canvas.Canvas(filename, pagesize=letter)
            c.setFont(font_name, font_size)

            text = decode_msx(data, charset).replace("\r\n", "\n").replace("\r", "\n")
            y = top
            for raw_line in text.split("\n"):
                for seg in _wrap(_pdf_clean_line(raw_line), max_chars):
                    c.drawString(left, y, seg)
                    y -= leading
                    if y < bottom:
                        c.showPage()
                        c.setFont(font_name, font_size)
                        y = top
            c.save()
            print_success(f"Saved PDF print job to: {rel(filename)}")
        except Exception as e:
            print_error(f"Failed to generate PDF: {e}")

    elif mode == "raster":
        # ESC/P -> raster PNG: bit-image graphics (8/9/24-pin) plus text drawn
        # from a real character ROM. See msx_printer_escp_render.py.
        try:
            import msx_printer_escp_render as _er
            paths, r = _er.render_to_png(data, os.path.join(out, f"{base_name}_{timestamp}"),
                                         glyphs or _er.DEFAULT_CHARSET)
            extra = ""
            if r.text_bytes:
                extra += f"  ({r.text_bytes} text bytes, charset {r.charset})"
            if r.unknown:
                extra += f"  unhandled ESC: {r.unknown} (extend msx_printer_escp_render for this dialect)"
            print_success(f"Rendered ESC/P to {len(paths)} PNG page(s): {', '.join(paths)}{extra}")
        except Exception as e:
            print_error(f"ESC/P raster render failed ({e}); saving RAW instead.")
            save_print_job(data, "raw", base_name, charset, glyphs, out_dir=out)

    # 'cups' (straight to lpr) was here and is coming back as a flag rather than
    # a mode: it is the one destination that is not a file, so it does not
    # belong in a list where every other entry writes to --output. As a mode it
    # also forced a choice - paper or a file, never both.
