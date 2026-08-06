#!/usr/bin/env python3
"""The printer spool: capture now, decide later.

What matters here is not that bytes round-trip - it is that the *boundary*
information survives everything that can go wrong. A job index that is only
correct when the process exits cleanly is not worth having, because the case it
exists for is precisely the long unattended session.
"""

import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "printer"))

from pdtest import Checks                                    # noqa: E402
import msx_printer_spool as sp                               # noqa: E402

c = Checks("printer spool")

# A whole scratch tree, wiped each run: the Printer check below writes into
# ./output relative to the cwd, so this has to be a directory we own outright.
TMP = os.path.join(os.environ.get("TMPDIR", "/tmp"), "pdtest-spool")
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

# --- writing: three jobs, one still open ----------------------------------
w = sp.SpoolWriter("t", directory=TMP, timestamp="20260801_000000")
w.write(b"first job\r\n")
r1 = w.mark("idle")
w.write(b"second")
w.write(b" job\r\n")
r2 = w.mark("idle")

c("seq counts up", (r1["seq"], r2["seq"]) == (1, 2), (r1, r2))
c("offsets are contiguous", r2["off"] == r1["off"] + r1["len"], (r1, r2))
c("length is the bytes fed", r2["len"] == len(b"second job\r\n"), r2)
# Nothing is open here, so this must not invent a zero-length job - an idle
# poll ticks long after the last page and would otherwise fill the index.
c("mark on an empty job is a no-op", w.mark("idle") is None)

w.write(b"third, never closed")

# Do NOT close: this is the crash case, and it is the one that matters.
w._prn.flush(); w._idx.flush()

# --- reading back ----------------------------------------------------------
s = sp.Spool(os.path.join(TMP, "t_20260801_000000"))
jobs = s.jobs()
c("closed jobs plus the unclosed tail", len(jobs) == 3, [j["seq"] for j in jobs])
c("the tail is marked unclosed", jobs[2]["end"] == "unclosed", jobs[2])
c("closed jobs are not", [j["end"] for j in jobs[:2]] == ["idle", "idle"])
c("job 1 reads back", s.read(1) == b"first job\r\n", s.read(1))
c("job 2 reads back", s.read(2) == b"second job\r\n", s.read(2))
c("the interrupted job is recovered, not dropped",
  s.read(3) == b"third, never closed", s.read(3))
c("nothing is lost overall",
  b"".join(s.read(j) for j in jobs) == open(s.prn_path, "rb").read())

# Accepting either half of the pair, or the stem, is what makes the CLI
# forgiving about tab-completion.
for suffix in (".prn", ".idx", ""):
    c(f"opens by {suffix or 'stem'}",
      sp.Spool(os.path.join(TMP, "t_20260801_000000" + suffix)).name
      == "t_20260801_000000")

# --- a truncated final index line -----------------------------------------
# fsync is per job, so a kill mid-write can leave half a line. Everything
# before it must still parse, and the bytes it described must come back as the
# unclosed tail rather than vanishing.
with open(s.idx_path, "a", encoding="utf-8") as f:
    f.write('{"seq":3,"off":22,"len":19,"t0":1')     # cut off
jobs2 = sp.Spool(s.stem).jobs()
c("a half-written index line does not lose the earlier ones",
  [j["seq"] for j in jobs2[:2]] == [1, 2], jobs2)
c("and its bytes still come back as the tail",
  jobs2[-1]["end"] == "unclosed" and sp.Spool(s.stem).read(jobs2[-1])
  == b"third, never closed", jobs2[-1])

# --- close() indexes the open job -----------------------------------------
w2 = sp.SpoolWriter("u", directory=TMP, timestamp="20260801_000001")
w2.write(b"data")
w2.close("shutdown")
j = sp.Spool(os.path.join(TMP, "u_20260801_000001")).jobs()
c("close() closes the open job", len(j) == 1 and j[0]["end"] == "shutdown", j)

# --- discovery -------------------------------------------------------------
found = sp.find_spools(TMP)
c("find_spools sees both, newest last",
  [x.name for x in found] == ["t_20260801_000000", "u_20260801_000001"],
  [x.name for x in found])
c("latest() is the newest", sp.latest(TMP).name == "u_20260801_000001")

# --- seq specs -------------------------------------------------------------
c('"3"', sp._parse_seqs("3") == {3})
c('"1-7"', sp._parse_seqs("1-7") == set(range(1, 8)))
c('"1,3,5-6"', sp._parse_seqs("1,3,5-6") == {1, 3, 5, 6})
c('"all" means no filter', sp._parse_seqs("all") == set())
c("empty means no filter", sp._parse_seqs("") == set())

# --- the Printer wrapper ---------------------------------------------------
# The point of the spool is that `--print off --spool` still captures. If
# `enabled` were driven by the mode alone, feed() would drop every byte and the
# capture would be empty exactly when it was the only thing asked for.
import pd_diskserver as ds                                # noqa: E402

# Where it lands is the other half of the point. A bare "output/" meant "next to
# wherever the shell was", so the same server started from the repository root
# and from dist/disk/ wrote to two different folders - and the TUI's file list
# only ever looked in one of them. So chdir somewhere unrelated first: the spool
# must still appear under the repository, not under the cwd.
os.chdir(TMP)
sp_dir = os.path.join(TMP, "spool-under-cwd")
p = ds.Printer("off", timeout=0.01, base_name="v", spool=True,
               spool_dir=sp_dir)
c("spooling makes the printer enabled even with mode=off", p.enabled)
p.feed(b"hello")
time.sleep(0.02)
p.flush_if_idle()
p.feed(b"again")
p.close()
got = sp.find_spools(sp_dir)
c("the server wrote a spool", len(got) == 1, os.listdir(sp_dir) if os.path.isdir(sp_dir) else "no dir")

# The default is worked out from the script, and the cwd cannot move it.
import msx_printer_paths as mp                            # noqa: E402

_mod = os.path.dirname(os.path.abspath(sp.__file__))
c("the default output dir is ../output beside the module",
  sp.DEFAULT_OUTPUT == os.path.normpath(os.path.join(_mod, os.pardir, "output")),
  sp.DEFAULT_OUTPUT)
c("the spool sits inside it",
  sp.DEFAULT_DIR == os.path.join(sp.DEFAULT_OUTPUT, "spool"), sp.DEFAULT_DIR)

# This test has already chdir'd. A default stored as a relative path would now
# point at TMP/../output - which is why it is resolved and only shown relative.
c("a chdir cannot move it",
  sp.DEFAULT_OUTPUT == mp.script_output(sp.__file__)
  and os.path.isabs(sp.DEFAULT_OUTPUT), sp.DEFAULT_OUTPUT)

# Nothing user-visible should carry an absolute path: we have no idea what the
# absolute paths are on the machine this ends up on, and printing ours is noise.
c("rel() shortens a path under the cwd",
  mp.rel(os.path.join(os.getcwd(), "a", "b")) == os.path.join("a", "b"))
c("rel() leaves an unrelated path alone rather than making it worse",
  os.path.isabs(mp.rel("/nowhere/at/all")))
c("naming the folder does not create it",
  not os.path.exists(mp.script_output(sp.__file__, "nothing-writes-here")))
if got:
    gj = got[0].jobs()
    c("both jobs indexed (idle + shutdown)",
      [j["end"] for j in gj] == ["idle", "shutdown"], gj)
    c("no file was rendered - that is the caller's decision later",
      not [f for f in os.listdir(sp_dir)
           if f.endswith((".txt", ".pdf", ".png"))],
      os.listdir(sp_dir))

sys.exit(c.done())
