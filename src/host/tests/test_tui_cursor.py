#!/usr/bin/env python3
"""Where the cursor is parked after a redraw.

This is not cosmetic. An input method draws its composition at the cursor, and
curses leaves the cursor wherever the last write ended - which was the status
bar on the bottom line. Composing there filled that line and scrolled the whole
screen, carrying the header away. So: never the last row, always the first body
row, in every pane and however long the body is.

The child creates a Tui directly instead of starting a server, so no port is
opened and no cartridge can be disturbed.
"""

import json
import os
import select
import subprocess
import sys
import time

import pdtest
from pdtest import Checks, open_pty

RESULT = os.path.join(os.environ.get("TMPDIR", "/tmp"), "pdtest-cursor.json")
CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cursor_child.py")

if os.path.exists(RESULT):
    os.remove(RESULT)

ROWS, COLS = 30, 100
master, slave = open_pty(ROWS, COLS)
proc = subprocess.Popen([sys.executable, CHILD], stdin=slave, stdout=slave,
                        stderr=slave, close_fds=True,
                        env=dict(os.environ, TERM="xterm-256color",
                                 PDTEST_RESULT=RESULT))
os.close(slave)
try:
    end = time.time() + 15
    while proc.poll() is None and time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                os.read(master, 65536)
            except OSError:
                break
finally:
    if proc.poll() is None:
        proc.kill()
    proc.wait(timeout=5)
    os.close(master)

c = Checks("split view: cursor parking")
if not os.path.exists(RESULT):
    c("child produced a result", False, "it died before writing one")
    sys.exit(c.done())

d = json.load(open(RESULT))
h, _ = d["size"]
last = h - 1                      # the status bar; composing here scrolls

for view in ("disk", "printer", "help",
             "disk_busy", "disk_scrolled"):
    y, x = d[view]
    c(f"{view}: not on the last row", y != last, d[view])
    c(f"{view}: parked on the first body row", [y, x] == [3, 0], d[view])

sys.exit(c.done())
