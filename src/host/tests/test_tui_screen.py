#!/usr/bin/env python3
"""What the split view actually draws, and what the keys actually do.

curses needs a real terminal on both ends, so the only honest test is to give it
one: run the server on a pty, feed it keys, read the screen back. Every failure
listed here has happened at least once.
"""

import os
import sys

import pdtest
from pdtest import Checks, server

TMP = os.environ.get("TMPDIR", "/tmp")
IMAGE = pdtest.scratch_image(os.path.join(TMP, "pdtest-screen.img"))

# What the cursor keys look like on the wire once curses has switched the
# keypad into application mode - which it does, because keypad(True).
UP, DOWN, RIGHT, LEFT = b"\x1bOA", b"\x1bOB", b"\x1bOC", b"\x1bOD"

c = Checks("split view: screen and keys")

with server(IMAGE, "--tui") as s:
    s.pump(2.0)
    c("draws at all (title and tabs)",
      s.seen("PicoDock", "Disk", "Printer"), repr(s.screen[-300:]))
    c("shows the version", "PicoDock v" in s.screen)
    # --port points at a pty (see pdtest.fake_port), so the link comes up at
    # once - which is also what proves --port bypasses find_port entirely.
    c("shows the link state", s.seen("connected:"), repr(s.screen[:200]))
    c("status bar", s.seen("reads", "writes", "print jobs"))

    # The pane only ever drew while serve() was running, so with no cartridge
    # the screen stayed blank - exactly when someone is watching it to see
    # whether plugging in worked.
    c("draws before a cartridge appears", "PicoDock" in s.screen)

    s.clear(); s.send(b"2")
    c("2 -> Printer", s.seen("printer mode"), repr(s.screen[-400:]))

    s.clear(); s.send(b"?")
    c("? -> help", s.seen("Ctrl-A 1", "Ctrl-A k", "any key closes"), repr(s.screen[-500:]))
    s.clear(); s.send(b" ")
    c("any key closes help", not s.seen("any key closes"))

    s.clear(); s.send(b"1")
    c("1 -> Disk", s.seen("1 Disk"), repr(s.screen[-300:]))

    s.clear(); s.send(b"\x01")
    c("Ctrl-A shows it is waiting", s.seen("Ctrl-A ..."), repr(s.screen[-200:]))
    s.clear(); s.send(b"2")
    c("Ctrl-A 2 switches view too", s.seen("printer mode"), repr(s.screen[-400:]))

    s.clear(); s.send(b"3")
    c("3 -> Ask", s.seen("Answer Option", "By ["), repr(s.screen[-400:]))

    # The arrows alone, on a real terminal. TERM is xterm-256color and curses
    # puts the keypad into application mode, so the cursor keys arrive as ESC O
    # x, not ESC [ x - send the wrong one and every assertion below passes for
    # the wrong reason, because an unrecognised key changes nothing.
    # Down stops on the section title. The marker is the proof: it has to be on
    # "Options" and not yet on the row of fields under it, because the first
    # version of this lit the fields up here and stepping in became invisible.
    s.clear(); s.send(b"\x012"); s.send(DOWN); s.send(b"\x01l")
    c("Down stops on the section title, above the fields",
      s.seen("> Options") and not s.seen("> mode ["), repr(s.screen[-600:]))
    s.clear(); s.send(RIGHT); s.send(b"\x01l")
    c("Right on a title does not step in - Enter is the only way in",
      s.seen("> Options") and not s.seen("> mode ["), repr(s.screen[-600:]))
    s.clear(); s.send(b"\r"); s.send(b"\x01l")
    c("...and Enter moves the marker down onto the fields",
      s.seen("> mode [") and not s.seen("> Options"), repr(s.screen[-600:]))
    # No arrow leaves a level. On the fields, Left on the first one and Up
    # anywhere used to step back out to the title, so the two keys you press
    # when you want nothing to happen were the two that moved you.
    s.clear(); s.send(LEFT); s.send(UP); s.send(DOWN); s.send(b"\x01l")
    c("Left on the first field and Up/Down stay put",
      s.seen("> mode [") and not s.seen("> Options") and not s.seen("> Output"),
      repr(s.screen[-600:]))

    s.clear(); s.send(RIGHT); s.send(b"\r")
    c("Right picks the next field, Enter opens its values",
      s.seen("shift_jis", "Enter takes it"), repr(s.screen[-600:]))
    s.clear(); s.send(LEFT); s.send(b"\x01l")
    c("Left does not close the value list either",
      s.seen("shift_jis"), repr(s.screen[-600:]))
    s.clear(); s.send(b"\x1b"); s.send(b"\x01l")
    c("...Esc does, and leaves the setting as it was",
      s.seen("charset [cp437]") and not s.seen("Enter takes it"),
      repr(s.screen[-600:]))

    # Esc on a real terminal, which is the half a unit test cannot reach: the
    # lone 0x1b has to arrive as Esc and not be mistaken for the start of a
    # cursor-key sequence. Two presses from a field: out to the title, out to
    # the bar - and the hint on the bar is how we can see which is which.
    s.clear(); s.send(b"\x1b"); s.send(b"\x01l")
    c("Esc from a field steps out to the section title",
      s.seen("> Options") and not s.seen("> mode ["), repr(s.screen[-600:]))
    s.clear(); s.send(b"\x1b"); s.send(b"\x01l")
    c("...and again to the menu bar", s.seen("<- -> view   Enter in"),
      repr(s.screen[-600:]))
    # ...while the arrow keys, which are 0x1b sequences themselves, still work.
    s.clear(); s.send(DOWN); s.send(DOWN); s.send(UP); s.send(b"\r")
    s.send(b"\x01l")
    c("arrow keys still parse after Esc has been given a meaning",
      s.seen("> mode ["), repr(s.screen[-600:]))
    s.send(b"\x1b"); s.send(b"\x1b")

    s.clear(); s.send(b"4")
    c("4 -> Status", s.seen("Cartridge", "Disk", "Printer", "CALL PDASK", "MSX"),
      repr(s.screen[-500:]))
    c("...with live values, not just headings",
      s.seen("sectors read", "answered by", "image"), repr(s.screen[-500:]))

    # There is no fifth view: the digit must be ignored, not crash or land on
    # a pane that does not exist. Ctrl-A l after it forces a full repaint -
    # without one curses writes nothing at all, because an ignored key changes
    # no cell, and there would be no screen to assert on.
    s.clear(); s.send(b"5"); s.send(b"\x01l")
    c("a digit past the last view leaves you on Status", s.seen("CALL PDASK"),
      repr(s.screen[-300:]))

    s.send(b"\x01q", 1.5)
    c("Ctrl-A q quits", s.wait_exit())


# --- the spool pane appears only when the server is spooling ---------------
# The block is what tells you anything is being kept at all. Without --spool it
# must not appear, or an ordinary run looks like it is accumulating something
# the user would then go looking for.
with server(IMAGE, "--tui") as s:
    s.pump(2.0)
    s.clear(); s.send(b"2")
    c("no spool block without --spool", not s.seen("render every job"),
      repr(s.screen[-400:]))
    s.send(b"\x01q", 1.5); s.wait_exit()

with server(IMAGE, "--tui", "--spool", "--print", "off") as s:
    s.pump(2.0)
    s.clear(); s.send(b"2")
    c("--spool shows the capture", s.seen("spool/"), repr(s.screen[-500:]))
    c("and says nothing is in it yet", s.seen("nothing captured yet"),
      repr(s.screen[-500:]))
    c("and offers the two render keys",
      s.seen("render every job", "merge them into one"), repr(s.screen[-500:]))
    s.send(b"\x01q", 1.5); s.wait_exit()


# --- the menu bar is a focus zone (v0.35.0) ---------------------------------
# Left/Right pick the view while the bar has focus, Down or Enter steps in.
# Browsing the bar deliberately does not enter a view.
import curses as _curses                                  # noqa: E402
from pd_tui import Tui as _Tui, VIEWS as _VIEWS, VIEW_ZONES as _ZONES  # noqa: E402
from pd_tui import ESC as _ESC, TITLE as _TITLE, ITEM as _ITEM  # noqa: E402
from pd_tui import PAGE_BACK as _PAGE_BACK, PAGE_FWD as _PAGE_FWD  # noqa: E402
from pd_hub import Hub as _Hub, CH_IO as _CH_IO         # noqa: E402

class _Sink:
    """Just enough screen for the drawing code to run with no terminal."""
    def getmaxyx(self): return 24, 100
    def getch(self): return -1
    def addnstr(self, *a): pass
    def erase(self): pass
    def redrawwin(self): pass
    def refresh(self): pass
    def move(self, *a): pass


_t = _Tui("x.img")
_t.hub = _Hub()
_t.scr = _Sink()
c("focus starts on the menu bar", _t.menu_focus is True)

_names = [v[0] for v in _VIEWS]
c("four views: disk, print, ask, status",
  _names == ["disk", "print", "ask", "status"], _names)

_t.view = _names.index("disk")
_t._menu_key(_curses.KEY_RIGHT)
c("Right moves along the menu, staying on the bar",
  _t.menu_focus is True and _names[_t.view] == "print")
_t._menu_key(_curses.KEY_RIGHT)
c("Right moves on again", _names[_t.view] == "ask")
_t._menu_key(_curses.KEY_RIGHT)
c("Right moves on to the last view", _names[_t.view] == "status")
_t._menu_key(_curses.KEY_RIGHT)
c("Right at the last view stays there - the bar does not wrap",
  _names[_t.view] == "status", _names[_t.view])
for _ in range(len(_names) + 2):
    _t._menu_key(_curses.KEY_LEFT)
c("...and Left stops at the first", _names[_t.view] == "disk", _names[_t.view])

# Enter is what commits, and only then do keys belong to the pane. Disk has
# nothing to commit to, so it must not move the focus at all - a step into an
# empty view leaves you where you were and teaches you the key is broken.
_t.view = _names.index("disk")
_t._menu_key(10)
c("Enter on a view with no sections does not step in", _t.menu_focus is True)
_t._menu_key(_curses.KEY_DOWN)
c("...and Down there scrolls the pane instead of entering it",
  _t.menu_focus is True, (_t.menu_focus, _t.scroll))
_t.view = _names.index("print")
_t._menu_key(10)
c("Enter steps into a view that has sections", _t.menu_focus is False)
_t._escape()
c("Esc returns to the menu bar", _t.menu_focus is True)

# Every view that can be entered must climb back out to the menu bar on Esc
# alone, one level per press. Held down from the deepest point it has to
# arrive - and stop there rather than doing something else to prove it works.
for _name in _names:
    _t.view = _names.index(_name)
    _t.menu_focus = True
    _t._menu_key(_curses.KEY_DOWN)
    if not _ZONES[_name]:
        c(f"{_name}: has no sections, so Down leaves the focus on the bar",
          _t.menu_focus is True)
        continue
    _t._zone_go(_ZONES[_name][-1], _ITEM)              # ...to the far end
    _presses = 0
    while not _t.menu_focus and _presses < 8:
        _t._escape()
        _presses += 1
    c(f"{_name}: Esc x{_presses} climbs back to the menu bar",
      _t.menu_focus is True and _presses <= 2, _presses)
    _t._escape()
    c(f"{_name}: ...and Esc at the top does nothing more",
      _t.menu_focus is True)

# Tab is gone. It must not survive as a second way to do any of this: a key
# that still half-works is worse than one that does nothing, because only one
# of the two teaches you to stop reaching for it.
c("the section-cycling handler is gone", not hasattr(_t, "_zone_cycle"))
_t.view = _names.index("print")
_t.menu_focus = True
_t._menu_key(ord("\t"))
c("Tab on the menu bar does not step in", _t.menu_focus is True)
_t._zone_go("set")
_t._item_key(ord("\t"))
c("Tab inside a view does not move section",
  _t._zone_name() == "set" and _t.menu_focus is False, _t._zone_name())

# A digit switches view but leaves you on the menu bar, so Left/Right keep
# working right after arriving. Enter/Down is the single, uniform way in.
_t.menu_focus = False
_t._command(ord("2"))
c("a digit switches view and returns to the menu bar",
  _t.menu_focus is True and _names[_t.view] == "print")
_t._menu_key(_curses.KEY_RIGHT)
c("Left/Right work straight after a digit", _names[_t.view] == "ask")

# --- the arrows reach everything (v0.69.0) ---------------------------------
# The complaint that produced this: changing one printer setting meant reaching
# for Tab. Three levels now, and an arrow moves between every pair of them -
# Down/Enter from the bar onto a section title, Right into its fields, Left
# back out of either. Tab still works; nothing has to use it.
from pd_tui import PRN_SETTINGS as _PRN                # noqa: E402


class _FakePrinter:
    mode, charset, glyphs, spool = "auto", "cp437", "msx", None


class _FakeAsk:
    MODES = ("manual", "google")
    mode, state, waiting = "manual", "idle", False
    limit, width, charset, engine, lang, msx = 512, 40, "cp437", "ddg", "en", []

    def set_mode(self, m):
        self.mode = m


_t.attach_printer(_FakePrinter())
_t.attach_ask(_FakeAsk())
_t.prn_scan = float("inf")        # never rescan output/ from under these checks

_t.view = _names.index("print")
_t.menu_focus, _t.level = True, _TITLE
_t._menu_key(_curses.KEY_DOWN)
c("Down from the bar lands on the first section title, not inside it",
  (_t.menu_focus, _t._zone_name(), _t.level) == (False, "set", _TITLE),
  (_t.menu_focus, _t._zone_name(), _t.level))

_t._title_key(_curses.KEY_DOWN)
c("Down again steps to the next section title",
  (_t._zone_name(), _t.level) == ("files", _TITLE), _t._zone_name())
_t._title_key(_curses.KEY_DOWN)
c("Down at the last title stays there - the bar is above, not below",
  (_t.menu_focus, _t._zone_name()) == (False, "files"),
  (_t.menu_focus, _t._zone_name()))

# Up is the way back up the column, because the bar is where up leads.
_t._title_key(_curses.KEY_UP)
c("Up returns to the previous title",
  (_t.menu_focus, _t._zone_name()) == (False, "set"), _t._zone_name())
_t._title_key(_curses.KEY_UP)
c("Up off the first title lands on the menu bar", _t.menu_focus is True)
_t._menu_key(_curses.KEY_UP)
c("...and Up on the bar itself does nothing - there is nothing above it",
  _t.menu_focus is True and _t.scroll == 0, (_t.menu_focus, _t.scroll))
_t._menu_key(_curses.KEY_DOWN)
c("Down from the bar steps back in", (_t.menu_focus, _t._zone_name()) == (False, "set"))

# Left is not part of that column, so it still does nothing on a title.
_t._menu_key(_curses.KEY_DOWN)
_t._title_key(_curses.KEY_LEFT)
c("Left on a title does nothing - out is Esc, or the ends of the column",
  _t.menu_focus is False and _t._zone_name() == "set")

# Right and Enter go in; the arrows move inside a level and stop at its ends.
_t._zone_go("set")
_t.prn_field = 2                                   # left mid-row by an Up/Down
_t._title_key(_curses.KEY_RIGHT)
c("Right on a title does not step in", _t.level == _TITLE)
_t._title_key(10)
c("Enter steps into the fields, onto the first one",
  (_t.level, _t.prn_field) == (_ITEM, 0), (_t.level, _t.prn_field))
_t._prn_key(_curses.KEY_RIGHT)
c("Right picks the next field", _t.prn_field == 1)
_t._prn_key(_curses.KEY_RIGHT)
_t._prn_key(_curses.KEY_RIGHT)
c("Right at the last field stays there rather than wrapping",
  _t.prn_field == len(_PRN) - 1, _t.prn_field)
_t._prn_key(_curses.KEY_LEFT)
c("Left picks the previous one", _t.prn_field == len(_PRN) - 2)
_t.prn_field = 0
_t._prn_key(_curses.KEY_LEFT)
c("Left on the first field stays there", (_t.level, _t.prn_field) == (_ITEM, 0),
  (_t.level, _t.prn_field))
_t._prn_key(_curses.KEY_UP)
_t._prn_key(_curses.KEY_DOWN)
c("...and Up/Down on the row do nothing at all",
  (_t.level, _t._zone_name(), _t.menu_focus) == (_ITEM, "set", False),
  (_t.level, _t._zone_name()))

# Enter opens the values. Moving in the list must not change anything: the
# whole point of a list over a cycling key is that you can look before you pick.
_CHARSETS = _PRN[1][2]
_t._zone_go("set", _ITEM)
_t.prn_field, _t.printer.charset = 1, _CHARSETS[0]
_t._prn_key(10)
c("Enter on a field opens its values",
  _t.drop is not None and _t.drop["values"] == list(_CHARSETS), _t.drop)
_t._drop_key(_curses.KEY_DOWN)
c("moving in the list changes nothing yet",
  _t.drop["cur"] == 1 and _t.printer.charset == _CHARSETS[0], _t.printer.charset)
_t._drop_key(_curses.KEY_LEFT)
c("Left does not close it either", _t.drop is not None)
_t._escape()
c("Esc closes it and leaves the setting alone",
  _t.drop is None and _t.printer.charset == _CHARSETS[0], _t.printer.charset)
_t._prn_key(10)
_t._drop_key(_curses.KEY_DOWN)
_t._drop_key(10)
c("Enter takes the one under the cursor",
  _t.drop is None and _t.printer.charset == _CHARSETS[1], _t.printer.charset)

# Esc closes the list before it moves anything: the first press answers the
# question in front of you, and only the next one leaves. A list that vanished
# *and* took you up a level would make one keystroke do two things.
_t._zone_go("set", _ITEM)
_t._prn_key(10)
c("the list is open", _t.drop is not None)
_t._escape()
c("Esc closes the list and stays on the field",
  _t.drop is None and _t.level == _ITEM and _t.menu_focus is False)
_t._escape()
c("...and the next Esc leaves the field", _t.level == _TITLE)

# A list left open while the focus walks away is a list pointing at a field
# nobody can see any more.
_t._zone_go("set", _ITEM)
_t._prn_key(10)
_t._title_step(1)
c("stepping to another section takes the open list with it", _t.drop is None)

# The file list is the one section that runs down the pane instead of across,
# so the arrows turn - but they stop at its ends like everywhere else.
_t.view = _names.index("print")
_t._zone_go("files", _ITEM)
_t.prn_files = [("a.prn", 1, 0), ("b.prn", 1, 0)]
_t.prn_cur = 1
_t._prn_key(_curses.KEY_UP)
c("Up walks the file list", (_t.prn_cur, _t.level) == (0, _ITEM))
_t._prn_key(_curses.KEY_UP)
c("Up off the top of the list stays on the first row",
  (_t.prn_cur, _t.level) == (0, _ITEM), (_t.prn_cur, _t.level))
_t._prn_key(_curses.KEY_LEFT)
c("...and Left does nothing there", _t.level == _ITEM)
_t._escape()
c("Esc is what leaves the list", _t.level == _TITLE)

# Ask: same rules, and the answer field is proof they hold where every
# printable key is content.
_t.view = _names.index("ask")
_t._zone_go("mode", _ITEM)
_t.ask.mode = "manual"
for _k in (_curses.KEY_LEFT, _curses.KEY_RIGHT,
           _curses.KEY_UP, _curses.KEY_DOWN):
    _t._ask_key(_k)
c("no arrow leaves the By field, and none of them picks anything",
  (_t.level, _t._zone_name(), _t.ask.mode) == (_ITEM, "mode", "manual"),
  (_t.level, _t._zone_name(), _t.ask.mode))
_t._escape()
_t._title_step(1)
c("Esc out, then Down, is how the next section is reached",
  (_t._zone_name(), _t.level) == ("input", _TITLE), _t._zone_name())
c("a printable key is not a title key", _t._title_key(ord("h")) is False)
_t.level = _ITEM                                  # ...which is why it falls in
_t._ask_key(ord("h"))
c("...so typing on a title lands in the answer", _t.ask_text == "h", _t.ask_text)
_t._ask_key(_curses.KEY_LEFT)
c("Left does not leave the answer field, and types nothing",
  _t.level == _ITEM and _t.ask_text == "h", (_t.level, _t.ask_text))
_t._escape()
c("Esc leaves it", _t.level == _TITLE and _t.ask_text == "h")

# Disk and Status have no sections at all, so the focus never leaves the menu
# bar there. Scrolling still has to work from it, or the log is unreadable.
for _name in ("disk", "status"):
    _t.view = _names.index(_name)
    _t.menu_focus, _t.level, _t.scroll = True, _TITLE, 0
    for _k in (10, _curses.KEY_DOWN, _curses.KEY_UP):
        _t._menu_key(_k)
    c(f"{_name}: Enter and the arrows leave the focus on the bar, and the "
      f"pane where it was",
      _t.menu_focus is True and _t.scroll == 0, (_t.menu_focus, _t.scroll))
    # ...and the log is still reachable, by the keys that only ever scroll.
    # They ask the pane how tall it is; there is no terminal here, so say.
    _t._body_h = lambda: 20
    _saved_hub, _t.hub = _t.hub, _Hub()
    for _i in range(40):
        _t.hub.emit(_CH_IO, "read", lba=_i, count=1)
    _t._menu_key(_PAGE_BACK)
    c(f"{_name}: Ctrl-B is what scrolls it", _t.scroll > 0, _t.scroll)
    # Held, it stops at the oldest line rather than running past the content -
    # which is what lets one key come back, and why the jump keys could go.
    for _ in range(20):
        _t._menu_key(_PAGE_BACK)
        _t._draw_lines(_t._view_disk(), height=20)
    _held = _t.scroll
    _presses = 0
    while _t.scroll and _presses < 30:
        _t._menu_key(_PAGE_FWD)
        _t._draw_lines(_t._view_disk(), height=20)
        _presses += 1
    c(f"{_name}: held, it stops at the oldest and Ctrl-F returns in {_presses}",
      _held > 0 and _presses <= 4, (_held, _presses))
    _t.hub = _saved_hub
    _t.scroll = 0

# Ctrl-A k hides this pane's history and leaves the hub's rings alone, because
# the other pane is reading the same events.
_t.view = _names.index("disk")
for _lba in range(3):
    _t.hub.emit(_CH_IO, "read", lba=_lba, count=1)
_t._clear_view()
c("Ctrl-A k hides only this pane's backlog",
  _t.hidden_before == {"disk": _t.hub.last_seq} and _t.hub.last_seq > 0,
  _t.hidden_before)

# There is no host -> MSX direction: read() is the redraw pump and nothing else,
# so it must never hand the server bytes to send.
c("read() sends nothing to the MSX", _t.read() == b"")


sys.exit(c.done())
