"""Runs inside a pty and reports where curses left the cursor.

Not a test on its own - test_tui_cursor.py drives it. It creates the Tui
directly rather than starting a server, so it never opens a port.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pd_hub import Hub, CH_IO
from pd_tui import Tui

out = {}
t = Tui("picodock.img")
hub = Hub()
try:
    t.start(hub)
    out["size"] = list(t.scr.getmaxyx())

    def draw():
        t._draw()
        return list(t.scr.getyx())

    t.view = 0; out["disk"] = draw()
    t.view = 1; out["printer"] = draw()
    t.help = True; out["help"] = draw(); t.help = False
    # A pane with more lines than fit is the case that matters: the cursor must
    # still be parked on the first body row, not left at the end of the last
    # line drawn. The Disk pane is the one that fills, so fill it.
    for lba in range(200):
        hub.emit(CH_IO, "read", lba=lba, count=8)
    t.view = 0
    out["disk_busy"] = draw()
    t.scroll = 5; out["disk_scrolled"] = draw(); t.scroll = 0
finally:
    t.restore()
open(os.environ["PDTEST_RESULT"], "w").write(json.dumps(out))
