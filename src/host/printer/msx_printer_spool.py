#!/usr/bin/env python3
"""msx_printer_spool.py - keep every printed byte; decide what to do with it later.

The daemon's normal behaviour is to end a job on an idle timeout and write a
file there and then. That is right when printing is one document at a time, and
wrong when the MSX dribbles pages out over an afternoon: you get a directory of
fragments, named by the accidents of when the Z80 paused.

A spool separates the two decisions that mode conflates - *when a job ended*
and *when a file gets written*. Bytes are appended to one capture, job
boundaries are recorded as an index entry rather than a file split, and nothing
is rendered until someone asks. So "job 3 as text" and "jobs 1-7 as one PDF"
are both still available afterwards, and neither has to be chosen up front.

    ../output/spool/msx_print_20260801_143210.prn     every byte, in order
    ../output/spool/msx_print_20260801_143210.idx     one JSON line per job

    {"seq":1,"off":0,"len":1284,"t0":1754...,"t1":1754...,"end":"idle"}

This is the same principle `--print auto` already follows when it writes the
raw .prn alongside whatever it guessed: keep the capture, because a rendering
decision can be redone and a lost byte cannot.

Durability
----------
The index line is written and fsync'd when a job closes, not per byte - per
byte would make the Z80 wait on the host's disk. A crash therefore loses no
*closed* job, and the bytes of the job in flight are still in the .prn with no
index entry to describe them. The reader treats that tail as a final job marked
"unclosed" rather than ignoring it, so an interrupted capture still renders.

(c) 2026 - part of the PicoDock project
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from msx_printer_paths import rel, script_output

#: Script-relative, so the spool is the same folder whichever way the server is
#: launched. --output moves it; see msx_printer_paths.
DEFAULT_OUTPUT = script_output(__file__)
DEFAULT_DIR = os.path.join(DEFAULT_OUTPUT, "spool")


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------
class SpoolWriter:
    """Append-only capture plus a job index.

    One instance per server run. `write` takes bytes as they arrive; `mark`
    closes the current job. Both are cheap: `write` is a buffered append, and
    only `mark` reaches the platter.
    """

    def __init__(self, base_name="msx_print", directory=DEFAULT_DIR, timestamp=None):
        if timestamp is None:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
        os.makedirs(directory, exist_ok=True)
        stem = os.path.join(directory, f"{base_name}_{timestamp}")
        self.prn_path = stem + ".prn"
        self.idx_path = stem + ".idx"
        self._prn = open(self.prn_path, "ab")
        self._idx = open(self.idx_path, "a", encoding="utf-8")
        self._off = self._prn.tell()     # where the current job starts
        self._len = 0                    # bytes in the current job so far
        self._t0 = None
        self._t1 = None
        self.seq = 0                     # jobs closed so far

    @property
    def open_job(self):
        return self._len > 0

    def write(self, data):
        if not data:
            return
        now = time.time()
        if self._len == 0:
            self._t0 = now
        self._prn.write(data)
        self._len += len(data)
        self._t1 = now

    def mark(self, reason="idle"):
        """Close the current job. Returns its index record, or None if empty."""
        if self._len == 0:
            return None
        self._prn.flush()
        os.fsync(self._prn.fileno())
        self.seq += 1
        rec = {"seq": self.seq, "off": self._off, "len": self._len,
               "t0": round(self._t0, 3), "t1": round(self._t1, 3),
               "end": reason}
        self._idx.write(json.dumps(rec) + "\n")
        self._idx.flush()
        os.fsync(self._idx.fileno())
        self._off += self._len
        self._len = 0
        self._t0 = self._t1 = None
        return rec

    def close(self, reason="shutdown"):
        try:
            self.mark(reason)
        finally:
            for f in (self._prn, self._idx):
                try:
                    f.close()
                except OSError:
                    pass


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------
class Spool:
    """A capture on disk, read back as a list of jobs."""

    def __init__(self, path):
        # Accept either half of the pair, or the stem.
        stem = path[:-4] if path.endswith((".prn", ".idx")) else path
        self.stem = stem
        self.prn_path = stem + ".prn"
        self.idx_path = stem + ".idx"
        if not os.path.exists(self.prn_path):
            raise FileNotFoundError(self.prn_path)

    @property
    def name(self):
        return os.path.basename(self.stem)

    def jobs(self):
        """Index records, plus the unclosed tail if the writer was interrupted."""
        out = []
        if os.path.exists(self.idx_path):
            with open(self.idx_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        # A half-written final line: the process died mid-fsync.
                        # Everything before it is still good, and the bytes it
                        # described are recovered as the tail below.
                        break
        end = max((j["off"] + j["len"] for j in out), default=0)
        size = os.path.getsize(self.prn_path)
        if size > end:
            mt = os.path.getmtime(self.prn_path)
            out.append({"seq": len(out) + 1, "off": end, "len": size - end,
                        "t0": mt, "t1": mt, "end": "unclosed"})
        return out

    def read(self, job):
        """Bytes of one job, given its record or its seq number."""
        if isinstance(job, int):
            for j in self.jobs():
                if j["seq"] == job:
                    job = j
                    break
            else:
                raise KeyError(f"no job {job} in {self.name}")
        with open(self.prn_path, "rb") as f:
            f.seek(job["off"])
            return f.read(job["len"])


def find_spools(directory=DEFAULT_DIR):
    """Every capture in `directory`, newest last."""
    if not os.path.isdir(directory):
        return []
    stems = sorted(os.path.join(directory, f[:-4])
                   for f in os.listdir(directory) if f.endswith(".prn"))
    return [Spool(s) for s in stems]


def latest(directory=DEFAULT_DIR):
    spools = find_spools(directory)
    return spools[-1] if spools else None


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------
def pages_to_pdf(png_paths, out):
    """Wrap rendered pages into one PDF.

    Needs Pillow, since the pages are images. Not to be confused with the
    daemon's own `pdf` mode, which typesets decoded *text* with reportlab.
    """
    from PIL import Image
    pages = [Image.open(p).convert("RGB") for p in png_paths]
    pages[0].save(out, resolution=300.0, save_all=True, append_images=pages[1:])
    return out


# Modes whose output is a page image rather than a byte stream or typeset text.
# Concatenating the *bytes* of two jobs is wrong for these - see merge().
_RASTER_MODES = ("raster",)


def render(spool, seqs, mode="auto", base_name=None, charset="cp437",
           glyphs="msx", out_dir=None):
    """Render each of `seqs` to its own file. Returns the job records handled."""
    import msx_printer_render
    base = base_name or spool.name
    done = []
    for j in spool.jobs():
        if seqs and j["seq"] not in seqs:
            continue
        stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(j["t0"]))
        msx_printer_render.save_print_job(
            spool.read(j), mode, f"{base}_j{j['seq']:03d}", charset, glyphs, stamp)
        done.append(j)
    return done


def merge(spool, seqs, mode="raw", base_name=None, charset="cp437",
          glyphs="msx", out_dir=None):
    """Render `seqs` as ONE document.

    Byte concatenation is only safe where the stream carries no state that can
    outlive a job. For raw, text, pdf and cups it does not: those read bytes or
    decoded characters, and a job boundary is byte-aligned.

    ESC/P is not like that. Line spacing, pitch, condensed/emphasised and the
    page position all persist until something resets them, so gluing two jobs
    together silently renders the second one under the first one's settings -
    unless it happens to begin with ESC @. So raster jobs are rendered
    separately, each from a clean interpreter, and it is the *pages* that are
    combined.
    """
    base = base_name or spool.name
    jobs = [j for j in spool.jobs() if not seqs or j["seq"] in seqs]
    if not jobs:
        return None
    stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(jobs[0]["t0"]))

    if mode not in _RASTER_MODES:
        import msx_printer_render
        data = b"".join(spool.read(j) for j in jobs)
        msx_printer_render.save_print_job(data, mode, f"{base}_merged",
                                          charset, glyphs, stamp)
        return os.path.join(out_dir or DEFAULT_OUTPUT, f"{base}_merged_{stamp}")

    import msx_printer_recharset as rc
    os.makedirs(out_dir, exist_ok=True)
    pages = []
    for j in jobs:
        stem = os.path.join(out_dir, f"{base}_merged_{stamp}_j{j['seq']:03d}")
        paths, _ = rc.render(spool.read(j), stem, glyphs)
        pages.extend(paths)
    if not pages:
        return None
    out = os.path.join(out_dir, f"{base}_merged_{stamp}.pdf")
    try:
        pages_to_pdf(pages, out)
    except ImportError:
        return pages[0]                  # Pillow absent: the pages are still there
    for p in pages:                      # the PDF supersedes the per-page PNGs
        try:
            os.remove(p)
        except OSError:
            pass
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _parse_seqs(spec):
    """"3", "1-7", "1,3,5-6" -> a set. Empty/None means every job."""
    if not spec or spec == "all":
        return set()
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def _fmt_size(n):
    for unit, step in (("B", 1), ("KB", 1024), ("MB", 1024 * 1024)):
        if n < step * 1024:
            return f"{n} {unit}" if unit == "B" else f"{n / step:.1f} {unit}"
    return f"{n / (1024 * 1024):.1f} MB"


def _cmd_list(spool):
    jobs = spool.jobs()
    print(f"{spool.name}  ({len(jobs)} job(s), {_fmt_size(os.path.getsize(spool.prn_path))})")
    if not jobs:
        print("  (empty)")
        return
    try:
        import msx_printer_detect
    except ImportError:
        msx_printer_detect = None
    print("  seq  when      size       guess")
    for j in jobs:
        guess = ""
        if msx_printer_detect:
            try:
                picked, cs, _ = msx_printer_detect.detect(spool.read(j))
                guess = picked + (f" --charset {cs}" if cs else "")
            except Exception:
                guess = "?"
        flag = "  [unclosed]" if j["end"] == "unclosed" else ""
        print("  %3d  %s  %-9s  %s%s"
              % (j["seq"], time.strftime("%H:%M:%S", time.localtime(j["t0"])),
                 _fmt_size(j["len"]), guess, flag))


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        description="Inspect and render printer spools (see docs/printing.md).")
    ap.add_argument("command", choices=["list", "render", "merge"])
    ap.add_argument("spool", nargs="?",
                    help="spool path or stem (default: the newest in ../output/spool/)")
    ap.add_argument("-j", "--jobs", default="all",
                    help='which jobs: "3", "1-7", "1,3,5-6", or "all" (default)')
    ap.add_argument("-m", "--mode", default=None,
                    help="render mode: auto/text/raw/pdf/raster/cups "
                         "(default: auto for render, raw for merge)")
    ap.add_argument("--charset", default="cp437", help="text decode charset")
    ap.add_argument("--glyphs", default="msx", help="raster glyph set")
    ap.add_argument("-d", "--dir", default=DEFAULT_DIR, help="spool directory")
    args = ap.parse_args(argv)

    spool = Spool(args.spool) if args.spool else latest(args.dir)
    if spool is None:
        print(f"[-] no spool found in {args.dir}")
        return 1

    if args.command == "list":
        _cmd_list(spool)
        return 0

    seqs = _parse_seqs(args.jobs)
    if args.command == "render":
        done = render(spool, seqs, args.mode or "auto", charset=args.charset,
                      glyphs=args.glyphs)
        print(f"[+] rendered {len(done)} job(s) to {rel(out_dir or DEFAULT_OUTPUT)}")
    else:
        out = merge(spool, seqs, args.mode or "raw", charset=args.charset,
                    glyphs=args.glyphs)
        print(f"[+] merged -> {out}" if out else "[-] nothing to merge")
    return 0


if __name__ == "__main__":
    sys.exit(main())
