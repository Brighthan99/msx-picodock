#!/usr/bin/env python3
"""pd_tui.py - a split-screen view of the server, in the terminal.

The server does several unrelated things at once and used to narrate them down
one scrolling column, where a printed page and a sector trace shredded each
other. This gives each one a pane and a key to reach it: Disk, Printer, Ask -
and Status, which is not a log at all but what is true right now.

How it attaches
---------------
Two hooks, both already there:

  * It subscribes to the hub, so it sees every event without the server knowing
    it exists (pd_hub.py).
  * It presents the same read() contract as Console, so serve() calls it exactly
    where it used to ask the terminal for keystrokes - not one line of the
    serial loop changes.

Single-threaded on purpose. curses is not thread-safe, and a background redraw
thread racing the serial loop is a corrupted screen once an hour and an
impossible bug to reproduce. read() is called constantly by the serial loop, so
that is where input and redraw happen, rate-limited to REDRAW_HZ.

Keys
----
Ctrl-A is a prefix, as in tmux. Nothing here needs it - the digits, q and ? work
on their own - but it is kept so the same keys work in the larger build this is
a subset of.

  Arrows        all of it: the menu bar, the sections, the fields, the values
  Enter         in, and take what is under the cursor
  Esc           out, one level per press
  Ctrl-A 1..4   switch view
  Ctrl-A ?      help                 Ctrl-A q   quit
  Ctrl-A l      repaint, when something else has drawn over the screen
  Ctrl-A k      clear this pane
  Ctrl-B / Ctrl-F  scroll a page back / forward, wherever the focus is.
                   Held, they reach the oldest line and live. PgUp/PgDn and
                   Home/End do the same where the keyboard has them

Getting around
--------------
Three levels, and three keys reach all of them: the arrows, Enter and Esc.
Tab used to walk the sections and is gone - having to reach for it to change
one setting is what produced this arrangement, and leaving it in as a second
way to do the same thing would have kept the hand travelling.

  menu bar   Left/Right pick the view and stop at the ends, Down or Enter
             steps in - where there is anything to step into
  section    the title of one part of the pane. Up/Down pick the section,
             Enter steps into it
  field      Left/Right pick the field, Enter opens its values

Enter, and only Enter, goes in; Esc, and only Esc, comes out, one level per
press. No arrow crosses between levels - they move within the one they are on.

**Inside a section the arrows stay put**: they pick a field or a row and stop at
the ends. Left used to mean "out" there as well, which made it mean two things
at once - in a row it also means "the field to my left" - so pressing it on the
first field, where you most wanted nothing to happen, was exactly where it moved
you somewhere else.

**The section titles are the exception, and they are not really one.** The menu
bar and the titles under it are a single column - Printer, then Options, then
Output - so Up from the first title lands on the bar. Nothing is being escaped
there; the column just carries on upwards.

It does not carry on downwards. Down from the last title stays where it is, and
Up on the bar does nothing at all, because the bar is at the top: a key that
says "down" while moving the cursor up is the one thing here nobody can learn,
and Up used to fall through to the scrollback, which made it mean something
different in every view.

Esc is safe to use here because ncurses does the hard part: with keypad(True) it
holds a lone 0x1b back to see whether an arrow key is arriving behind it, and
reassembles the sequence even across two reads. What it costs is the wait - see
ESCDELAY_MS, which is why Esc used to take a full second to do anything.

The output/ file list is the one place where the arrows turn: a hundred files do
not fit along a line, so there Up/Down pick a row and Left is the way back to
the title. The rule underneath is the same both times - the arrow along the
section's own axis moves inside it, the arrow across it leaves.

Enter on a field opens its values as a list under it: Up/Down move, Enter takes
one, Esc leaves the setting as it was. It is drawn inside the pane
rather than in a curses window of its own, because a window would need a
position and could land off the bottom of a short terminal; lines in the pane
cannot.

Browsing the bar deliberately does not enter anything. A digit switches view but
leaves focus on the bar as well, so Left/Right keep working the moment you
arrive; Enter or Down is the one uniform way in.

Disk and Status have no sections at all - one is a log and the other a table,
and there is nothing in either to pick. Enter on them does nothing rather than
opening something empty: a step in that leaves you where you already were
teaches you the key is broken. Their arrows scroll the pane from the menu bar,
which is the only place the focus can be in those views.

The re-render keys (p/f/t/a) and the two headless ones (v previews a .txt in
place, y prints the full path) exist because a Raspberry Pi over ssh has no
viewer to open anything with. They work from the section title too, which is
what keeps the extra level cheap: anything that is not an arrow falls through
into the section as though you had already stepped in. Every key is spelled out
in the pane itself, so nothing here has to be memorised.

An input method (Hangul, Japanese, Chinese) draws its composition straight onto
the terminal. curses knows nothing about that, and its refresh only rewrites the
cells *it* changed, so the leftovers stay.

What made this destructive rather than untidy was *where* the composition
landed. curses leaves the cursor wherever the last write ended - the status bar,
on the bottom line - so the composition filled that line and scrolled the whole
screen, header and all. The cursor is now parked deliberately (_park_cursor) on
the first body row, and hidden. Never the last row.

Do not try to rub the leftovers out by repainting automatically. That was tried,
and Terminal.app 2.14 aborted on heap corruption inside its own
attributed-string drawing twice within two minutes: rewriting the whole screen
while a composition is active is the state that breaks it. Ctrl-A l repaints on
demand, which is safe because by then the user has stopped composing.

Ctrl-C quits. read() returns nothing and exists to drive the redraw from the
serial loop: the one thing typed here that reaches the MSX - an answer to
CALL PDASK - goes into the AskService rather than back through this return value,
because it is a whole answer at a time, not a keystroke stream. (Keystrokes were
the remote keyboard, which a disk + printer build does not carry.)

(c) 2026 - part of the PicoDock project
"""

# curses is in the standard library everywhere except Windows, where it is the
# separate windows-curses package. Import it defensively so that not having it
# means "no split view" rather than "the server will not start": every use below
# is inside a function that only runs once available() has said yes, and the two
# module-level constants get harmless stand-ins.
try:
    import curses
except ImportError:                             # Windows without windows-curses
    curses = None
import os
import shutil
import subprocess
import sys
import textwrap
import time

from pd_hub import CH_LINK, CH_DISK, CH_IO, CH_PRINT, CH_ASK
from pd_version import DISPLAY

REDRAW_HZ = 20.0                     # the serial loop calls read() far faster
PREFIX = 0x01                        # Ctrl-A
# Esc, which ncurses hands over as itself: with keypad(True) it holds a lone
# 0x1b back long enough to see whether an arrow key is arriving behind it, and
# reassembles the sequence even when it lands in two separate reads. That is
# what makes this usable as a key of its own rather than a guess.
ESC = 0x1b

# ...and how long it holds it back. ncurses defaults to a full second, which is
# how long Esc took to do anything: pressing it and watching nothing happen for
# 1055ms measured, every time. The wait exists because an arrow key *is* an Esc
# sequence, so it is the price of telling the two apart - but a tenth of it is
# plenty on a local terminal, and still four times the gap a cursor key leaves.
#
# Raised, not removed, because the other end can be a Raspberry Pi over ssh: too
# short and a cursor key split across two packets reads as Esc followed by
# rubbish. ESCDELAY in the environment wins, which is the knob ncurses documents
# and the one to reach for on a link slow enough to matter.
ESCDELAY_MS = 50

# Scrolling, on keys every keyboard has. PgUp/PgDn/Home/End still work and are
# still the first thing to reach for where they exist - but a Mac laptop has
# none of the four, only Fn with an arrow, and a two-handed chord is not a key
# you press while reading a log.
#
# Control keys rather than letters, because in the Ask pane every printable key
# belongs to the answer being typed and could not be a command there. They are
# also the ones the tty does not eat first: ^Y and ^T look free and are not
# (DSUSP and STATUS on macOS), nor are ^C ^\ ^Z ^Q ^S ^O ^V.
#
# One pair, not three. A line at a time (^P/^N) and a jump to either end
# (Ctrl-A b/e) were both here and both went: holding one of these arrives at the
# ends anyway, now that the offset is clamped to what the pane actually holds -
# see _draw_lines, without which Ctrl-B ran the offset past the content and it
# took as many presses to come back.
PAGE_BACK, PAGE_FWD = 0x02, 0x06     # Ctrl-B / Ctrl-F, as in less and vi

# Colour roles, resolved to pairs at start-up if the terminal has colour.
C_HEAD, C_READ, C_WRITE, C_ERR, C_OK, C_NOTE, C_DIM = range(1, 8)

# How the one thing under the cursor is drawn. Reverse video rather than colour,
# so the focus is findable on a terminal that has none; and rather than an
# underline, which is what this was and which changed so little as the cursor
# moved from field to field that the arrow key looked dead.
FIELD = (curses.A_REVERSE | curses.A_BOLD) if curses else 0

# Section titles - Options, Output, Answer Option. Bold in the terminal's own
# foreground, which is black on a light background and white on a dark one.
# Deliberately no colour pair: they were drawn in the dim blue everything
# secondary uses, and a heading that is fainter than the rows beneath it reads
# as a caption rather than as the thing you are meant to steer. Naming an actual
# black would have been the literal reading and would have made them invisible
# on half the terminals in use.
HEADING = curses.A_BOLD if curses else 0

VIEWS = [("disk", "Disk"), ("print", "Printer"), ("ask", "Ask"),
         ("status", "Status")]

# The sections of the Printer view, in the order the arrows walk them. The job
# log is deliberately not one: there is nothing to pick in it, so stopping there
# on the way round would just be a dead step.
PRN_FOCI = ["set", "files"]

# The settings the Printer pane can retune live, each a (label, attribute,
# values) triple. Pressing the key steps to the next value; it takes effect on
# the next job, since a job in flight has already been buffered.
PRN_SETTINGS = [
    ("mode", "mode",
     ["auto", "text", "pdf", "raster", "off"]),
    ("charset", "charset",
     ["cp437", "shift_jis", "cp932", "utf-8"]),
    ("glyphs", "glyphs",
     ["msx", "msx-din", "msx-jp", "fx80", "cp437"]),
]

# How many files the list shows at once; the window scrolls to follow the
# cursor rather than clipping it, so the selection is always on screen. It is a
# ceiling, not a promise: on a short terminal the list gives up rows so that the
# settings above it and a little of the job log below it both stay visible.
PRN_ROWS = 12
PRN_LOG_MIN = 3              # rows of job log the file list may not eat into
PRN_SET_X = 4                # where the settings row starts, and its open list

# The sections of each view, in the order Up/Down walks them. Disk and Status
# have none, and that is the point rather than an omission: they are a log and a
# table, with nothing in either to pick. Enter does not open them, because a step
# in that leaves you exactly where you were is a step that teaches you the key
# is broken. Their arrows scroll the pane straight from the menu bar instead.
VIEW_ZONES = {
    "disk":   [],
    "print":  PRN_FOCI,
    "ask":    ["mode", "input"],
    "status": [],
}
MENU = "<menu>"

# Which way a section runs, which is the whole of the arrow rule: the arrow
# along a section's own axis moves inside it, the arrow across it leaves.
#
#   row     fields side by side, so Left/Right move between them
#   list    rows down the pane, so Up/Down move between them
#   text    one field, typed into; every printable key is content
#
# Whichever way a section runs, its arrows stop at its ends. None of them leaves
# it - that is Esc, and only Esc.
ZONE_KIND = {"set": "row", "files": "list", "mode": "row", "input": "text"}

# The titles the sections are drawn under - the rows Up/Down walk between, and
# the only text in a pane that names a place rather than a value. Capitalised
# for that reason: they are the menu, and everything under them is its content.
ZONE_TITLE = {"set": "Options", "files": "Output",
              "mode": "Answer Option", "input": "Answer"}

# Focus levels below the menu bar. TITLE is the resting place the arrows come
# back to; ITEM is inside a section, on a field or a row.
TITLE, ITEM = "title", "item"

# Panes that read top-down rather than newest-last. A log wants its tail on
# screen; a table of what is true right now wants its head, and scrolling to
# reach the rest is the normal way round for it.
#
# The Printer pane is here for a different reason: it does its own scrolling,
# inside the job log at the bottom, so that the settings and the file list stay
# where they are. Anchoring it to the head is what stops _draw_lines spending
# the same offset a second time on the pane as a whole.
HEAD_ANCHORED = {"print", "status"}

# Ask pane: who answers comes first, so stepping in lands on a section the arrows
# work rather than in the middle of a sentence. Every printable key belongs to
# the answer while `input` has focus - which is why the choice is a section of
# its own instead of single-letter keys that would eat the letters.
ASK_FOCI = VIEW_ZONES["ask"]

# Extensions the file pane knows how to act on.
PRN_VIEWABLE = (".txt",)             # can be shown inside the TUI
PRN_RENDERABLE = (".prn",)           # can be re-rendered to png/pdf/text

HELP = [
    "Keys - the arrows do all of it",
    "",
    "menu bar   Left/Right pick the view and stop at the ends (1-4 jump),",
    "           Down or Enter steps in where there is something to step into",
    "section    Up/Down another one; Up off the first returns to the menu",
    "           bar. Enter steps into it",
    "field      Left/Right pick it, Enter opens its values: Up/Down move,",
    "           Enter takes one, Esc cancels. In the file list the arrows",
    "           turn: Up/Down pick a row.",
    "",
    "Inside a section no arrow leaves it - Esc does, one level per press.",
    "",
    "  Ctrl-A 1 Disk   Ctrl-A 2 Printer   Ctrl-A 3 Ask   Ctrl-A 4 Status",
    "  (1-4 alone work too - except while typing an answer in Ask, where every",
    "   printable key is part of the answer; Ctrl-A 4 still gets you out.)",
    "  Esc steps out one level   (there is no Tab here - the arrows are it)",
    "  Ctrl-A k clear pane   Ctrl-A l repaint   Ctrl-A q quit  (Ctrl-C too)",
    "  ^B/^F scroll a page back/forward - hold them for the two ends",
    "  (PgUp/PgDn/Home/End too, on a keyboard that has them)",
    "",
    "Disk (1)     every sector read and written. Nothing to pick, so nothing",
    "             to step into: ^B/^F scroll it.",
    "Printer (2)  Options: m/c/g jump to a field.  Output: Enter opens, p/f/t",
    "             PNG/PDF/text, a all charsets, v preview .txt, y path, r",
    "             rescan.  Headless (ssh): v and y, not Enter.  --spool: s",
    "             each job, S merges them into one.  Logs: nothing to pick.",
    "Ask (3)      Answer Option: m/g jump to one, x refuses the one in hand.",
    "             Answer: type it, Enter sends, Ctrl-U clears, \\n breaks a line.",
    "Status (4)   what is true right now - what the logs leave open. Nothing",
    "             to step into here either.",
    "",
    "  (any key closes this)",
]


def _size(n):
    """Byte count in the narrowest human form - the file list has one column."""
    for unit, step in (("B", 1), ("KB", 1024), ("MB", 1024 * 1024)):
        if n < step * 1024:
            return f"{n // step} {unit}" if unit == "B" else f"{n / step:.1f} {unit}"
    return f"{n / (1024 * 1024):.1f} MB"


def _hhmmss(t):
    return time.strftime("%H:%M:%S", time.localtime(t))


def _hms(seconds):
    """Uptime, in the shortest form that is still exact."""
    h, rem = divmod(int(seconds), 3600)
    m, sec = divmod(rem, 60)
    if h:
        return "%dh %02dm" % (h, m)
    return "%dm %02ds" % (m, sec) if m else "%ds" % sec


def _fold(text, width):
    """Wrap for the pane. Empty in, empty out - a question with no text is a
    question the MSX asked badly, and it should still get a row."""
    out = []
    for para in (text or "").split("\n"):
        out.extend(textwrap.wrap(para, width=width) or [""])
    return out


class Tui:
    """The screen. Also the input source, standing in for Console."""

    enabled = True                   # serve() checks this before calling read()

    def __init__(self, image, verbose=False, out_dir="output"):
        self.image = image
        self.verbose = verbose
        self.out_dir = out_dir       # where the printer writes; the server decides
        self.hub = None              # set by attach()
        self.view = 0
        self.scroll = 0              # lines back from live; 0 = following
        self.help = False
        self.awaiting_prefix = False
        self.quit = False
        self.last_draw = 0.0
        self.dirty = True
        self.repaint = False         # force a full redraw, not just changed cells
        self.hidden_before = {}      # view name -> seq cleared at; older is hidden
        self.to_top = False          # honour a Home keypress at the next draw
        self.started = time.time()   # for the Status pane's uptime
        self.state = {"port": None, "serial": None, "connected": False,
                      "paused": None, "reads": 0, "writes": 0, "jobs": 0,
                      "asks": 0, "blocks": 0, "size": 0, "readonly": False,
                      "print_mode": None, "spool": None, "usb": {}}
        # Printer pane: a settings bar, the output/ file list and the job log,
        # one focused at a time.
        # `printer` is the live Printer object the server owns; changing a
        # setting here mutates it directly, which is safe because the TUI and
        # the serve loop are the same thread (serve() calls ui.read()).
        # Where the keys go, in three levels: the menu bar, a section title
        # inside a view, or a field inside a section. Starting on the bar means
        # the first thing anyone sees is highlighted and steerable.
        self.menu_focus = True
        self.level = TITLE           # TITLE | ITEM, once off the menu bar
        self.drop = None             # the open list of values, or None
        self.printer = None          # set by attach_printer()
        self.prn_focus = "set"       # set | files
        self.prn_field = 0           # which setting the arrows act on
        self.prn_cur = 0             # index into prn_files (0 = newest)
        self.prn_top = 0             # first visible row of the file list
        self.prn_files = []          # [(name, size, mtime)], newest last
        self.prn_scan = 0.0          # when the list was last rebuilt
        self.prn_msg = ""            # result of the last file action
        self.prn_spool = None        # the live capture, when --spool is on
        self.prn_jobs = []           # its job index, refreshed with the list
        # Ask pane: the answer being typed, and the live AskService it goes to.
        self.ask = None              # set by attach_ask()
        self.ask_focus = "mode"      # mode | input
        self.ask_text = ""           # what has been typed so far
        self.ask_msg = ""            # result of the last action in the pane
        self.scr = None
        self.colour = {}

    def attach_printer(self, printer):
        """Take the server's live Printer so the pane can retune it in place."""
        self.printer = printer

    def attach_ask(self, ask):
        """Take the server's live AskService. Same arrangement as the printer:
        this thread and the serial loop are one, so typing into it needs no
        lock - and the answer reaches the MSX from the loop's next pass."""
        self.ask = ask

    # -- lifecycle --------------------------------------------------------
    def start(self, hub):
        # No locale.setlocale here on purpose. It would put ncurses into UTF-8
        # output mode, which is the correct thing *when there is non-ASCII to
        # draw* - and there is none: the MSX's output is never sent back. It was
        # added once and backed out together with the forced repaint below,
        # because between them they turned screen corruption into two Terminal
        # crashes. Add it back only with the output-return path, and test it.
        self.hub = hub
        self.scr = curses.initscr()
        curses.noecho()
        curses.cbreak()              # not raw: Ctrl-C must still kill the server
        self.scr.keypad(True)
        self.scr.nodelay(True)
        try:
            curses.set_escdelay(int(os.environ.get("ESCDELAY") or ESCDELAY_MS))
        except (AttributeError, ValueError, curses.error):
            pass                     # older Python, or a nonsense ESCDELAY
        try:
            curses.curs_set(0)
        except curses.error:
            pass                     # some terminals cannot hide the cursor
        if curses.has_colors():
            curses.start_color()
            try:
                curses.use_default_colors()
                bg = -1
            except curses.error:
                bg = curses.COLOR_BLACK
            for pair, fg in ((C_HEAD, curses.COLOR_WHITE),
                             (C_READ, curses.COLOR_CYAN),
                             (C_WRITE, curses.COLOR_YELLOW),
                             (C_ERR, curses.COLOR_RED),
                             (C_OK, curses.COLOR_GREEN),
                             (C_NOTE, curses.COLOR_MAGENTA),
                             (C_DIM, curses.COLOR_BLUE)):
                try:
                    curses.init_pair(pair, fg, bg)
                    self.colour[pair] = curses.color_pair(pair)
                except curses.error:
                    self.colour[pair] = 0
        hub.subscribe(self)
        self.dirty = True

    def restore(self):
        """Give the terminal back. Called from the server's finally, so it runs
        even when the server dies of something else - a curses program that
        skips this leaves a shell with no echo and no newlines."""
        if self.scr is None:
            return
        try:
            self.scr.keypad(False)
            curses.nocbreak()
            curses.echo()
            curses.endwin()
        except curses.error:
            pass
        self.scr = None

    # -- hub subscriber ---------------------------------------------------
    def __call__(self, ev):
        """Every event, for the counters. The panes themselves read back out of
        the hub's scrollback at redraw time, so nothing needs buffering twice."""
        ch, name = ev["ch"], ev["ev"]
        st = self.state
        if ch == CH_LINK:
            if name == "connected":
                st["port"], st["connected"] = ev["port"], True
                st["serial"] = ev.get("serial")
                st["usb"] = ev.get("usb") or {}
            elif name in ("lost", "closed"):
                st["connected"] = False
        elif ch == CH_DISK:
            if name == "image":
                st.update(size=ev["size"], blocks=ev["blocks"],
                          readonly=ev.get("readonly", False))
            elif name == "paused":
                st["paused"] = ev.get("reason")
            elif name == "resumed":
                st["paused"] = None
        elif ch == CH_IO:
            if name == "read":
                st["reads"] += ev["count"]
            elif name == "write":
                st["writes"] += ev["count"]
        elif ch == CH_PRINT:
            if name == "enabled":
                st["print_mode"] = ev["mode"]
            elif name == "job_start":
                st["jobs"] += 1
            elif name == "spool_open":
                st["spool"] = ev.get("path")
        elif ch == CH_ASK:
            if name == "question":
                st["asks"] += 1
                # A question is the one event here that wants attention: the
                # MSX is stopped, waiting. Nothing is stolen from under anyone's
                # hands - the pane is announced, not forced - but the count in
                # the status bar starts saying "answer me".
                self.ask_text = ""
                self.ask_msg = ""
        self.dirty = True

    # -- driven from the serial loop --------------------------------------
    def read(self):
        """Handle keys and redraw. Called every pass of the serial loop, which
        is the only thread there is - curses is not thread-safe, so this is
        where drawing has to happen.

        The name is historical: it used to hand back keystrokes bound for the
        MSX. That was the remote keyboard; there is no host -> MSX direction in
        a disk + printer build, so the return value is always empty."""
        if self.scr is None:
            return b""
        try:
            self._keys()
            self._maybe_draw()
        except curses.error:
            pass                     # a resize mid-draw; the next pass redraws
        if self.quit:
            raise KeyboardInterrupt   # the same exit the server already handles
        return b""

    def _keys(self):
        while True:
            try:
                k = self.scr.getch()
            except curses.error:
                return
            if k == -1:
                return
            self.dirty = True

            if k == curses.KEY_RESIZE:
                continue
            if self.help:
                self.help = False
                continue
            if self.awaiting_prefix:
                self.awaiting_prefix = False
                self._command(k)
                continue
            if k == PREFIX:
                self.awaiting_prefix = True
                continue

            # An open list of values is modal. It is a question, and a key that
            # answered something else instead would change a setting nobody was
            # looking at.
            if self.drop is not None:
                self._drop_key(k)
                continue

            # The menu bar owns the keys until you step into the view.
            if self.menu_focus:
                self._menu_key(k)
                continue

            # Esc is out, one level per press, from wherever you are. It is the
            # only key here that does not have to be aimed: Left means "out" too
            # but shares its row with "the field to my left", so in the middle of
            # a row it takes two or three presses to leave. Esc is one.
            if k == ESC:
                self._escape()
                continue

            # On a section title the arrows navigate and everything else falls
            # through into the section, as though you had stepped in first.
            # That is what keeps the extra level free: no key that used to work
            # has to be pressed twice now.
            if self.level == TITLE:
                if self._title_key(k):
                    continue
                self.level = ITEM

            self._item_key(k)

    def _item_key(self, k):
        """Keys inside a section, handed to whichever one has focus."""
        view = VIEWS[self.view][0]
        if view == "print":
            self._prn_key(k)
        elif view == "ask":
            self._ask_key(k)
        else:
            self._command(k)             # arrows scroll; Esc is the way out

    # -- focus: the menu bar, the section titles, the fields ---------------
    def _zone_name(self):
        """Which section has focus right now, as a name from VIEW_ZONES."""
        if self.menu_focus:
            return MENU
        view = VIEWS[self.view][0]
        if view == "print":
            return self.prn_focus
        if view == "ask":
            return self.ask_focus
        return "body"

    def _zones(self):
        return VIEW_ZONES.get(VIEWS[self.view][0], ["body"])

    def _focus(self, zone):
        """How `zone` is focused - TITLE, ITEM, or None if it is not."""
        if self.menu_focus or self._zone_name() != zone:
            return None
        return self.level

    def _zone_go(self, name, level=TITLE):
        """Put focus on `name`, which may be MENU or a section of this view.

        Every section has a title worth resting on - a view whose contents
        cannot be picked has no sections at all, so there is nothing here that
        wants entering at a different level.
        """
        self.drop = None
        if name == MENU:
            self.menu_focus = True
            return
        self.menu_focus = False
        self.level = level
        view = VIEWS[self.view][0]
        if view == "print":
            self.prn_focus = name
        elif view == "ask":
            self.ask_focus = name

    def _escape(self):
        """Esc: up one level, and never further than that.

        A single key that always means the same thing is worth more here than
        the two it replaces. It undoes exactly one step - a field goes back to
        its section title, a title back to the menu bar - so holding it walks
        out the way you came in rather than dumping you somewhere.
        """
        if self.drop is not None:
            self.drop = None             # the list, leaving the value alone
        elif self.level == ITEM:
            self.level = TITLE
        else:
            self.menu_focus, self.level = True, TITLE

    def _title_step(self, step):
        """Up/Down between section titles, and off the top onto the menu bar.

        The bar and the titles under it are one column - Printer, then Options,
        then Output - so Up from the first title arrives where the eye says it
        should. Down from the last does not: the bar is *above*, and a key that
        says "down" while moving the cursor up is the one thing here nobody can
        learn. The column simply ends at the bottom.

        Fields stay enclosed either way. Their arrows pick a field and stop at
        the ends, because there Left already means "the one to my left" and
        cannot also mean "out" - see _prn_key.
        """
        zones = self._zones()
        cur = self._zone_name()
        i = zones.index(cur) if cur in zones else 0
        if i + step < 0:
            self.drop = None
            self.menu_focus, self.level = True, TITLE
        elif i + step < len(zones):
            self._zone_go(zones[i + step])

    def _title_key(self, k):
        """Keys on a section title. True if this was one of them."""
        if k == curses.KEY_UP:
            self._title_step(-1)
        elif k == curses.KEY_DOWN:
            self._title_step(1)
        elif k in (curses.KEY_ENTER, 10, 13):
            self._enter_zone()
        elif k in (curses.KEY_LEFT, curses.KEY_RIGHT):
            # Neither of them crosses a level. Right used to step in, which made
            # it the one arrow that did, and left Enter as a duplicate of it -
            # so the same gesture had two keys while every other crossing had
            # exactly one. Enter goes in, Esc comes out, and the arrows move.
            pass
        else:
            return False
        return True

    def _enter_zone(self):
        """Step from a section title into the section itself.

        A row of fields starts again at its first one. Left already leaves a row
        from its left end, so this only shows after Up/Down took you away
        mid-row - and coming back into the middle of a row you did not choose is
        a surprise. A list keeps its cursor instead: there the row *is* the thing
        you picked, and losing it to a step out and back would be the worse of
        the two surprises.
        """
        self.level = ITEM
        if self._zone_name() == "set":
            self.prn_field = 0

    def _menu_key(self, k):
        """Keys while the menu bar has focus: Left/Right pick the view, Down or
        Enter steps in to its first section title.

        Left/Right stop at the ends rather than wrapping. The bar reads as a row
        of four, and a row that comes out at the other end is one you cannot
        feel your way along - Right at Status landing on Disk is a jump, not a
        step. The digits still reach any of them in one key.

        Up and Esc do nothing: this is the top of the column and of the levels,
        and there is nothing above either. Up used to fall through to the
        scrollback, which meant one key did something different in every view -
        invisible in Printer, a jumping log in Disk - and a key you cannot
        predict is worse than one that is not bound. PgUp/PgDn still scroll,
        from here as from anywhere.
        """
        if k == curses.KEY_LEFT:
            self._switch(max(0, self.view - 1))
        elif k == curses.KEY_RIGHT:
            self._switch(min(len(VIEWS) - 1, self.view + 1))
        elif k in (curses.KEY_DOWN, curses.KEY_ENTER, 10, 13):
            zones = self._zones()
            if zones:                    # ...and nothing at all if there are none
                self._zone_go(zones[0])
        elif k in (curses.KEY_UP, ESC):
            pass
        else:
            self._command(k)

    # -- the list of values under a field ----------------------------------
    def _drop_open(self):
        """Enter on a field: its values, as a list drawn under it.

        Lines of the pane rather than a curses window of its own, because a
        window needs a position and the field it belongs to can be on the last
        row of a short terminal - a list hanging off the bottom is a list you
        cannot answer. Lines cannot land anywhere the pane is not.
        """
        zone = self._zone_name()
        if zone == "set":
            if self.printer is None:
                self.prn_msg = "no printer attached"
                return
            label, attr, values = PRN_SETTINGS[self.prn_field]
            cur = self._prn_setting(attr)
        elif zone == "mode":
            if self.ask is None:
                self.ask_msg = "no server attached"
                return
            label, attr, values = "answered by", "mode", self._ask_modes()
            cur = self.ask.mode
        else:
            return                       # nothing here has a value to choose
        values = list(values)
        self.drop = {"zone": zone, "label": label, "attr": attr,
                     "values": values,
                     "cur": values.index(cur) if cur in values else 0}

    def _drop_key(self, k):
        d = self.drop
        n = len(d["values"])
        if k == curses.KEY_UP:
            d["cur"] = (d["cur"] - 1) % n
        elif k == curses.KEY_DOWN:
            d["cur"] = (d["cur"] + 1) % n
        elif k == curses.KEY_HOME:
            d["cur"] = 0
        elif k == curses.KEY_END:
            d["cur"] = n - 1
        elif k in (curses.KEY_ENTER, 10, 13):
            self._drop_take()
        elif k == ESC:                       # ...and only Esc closes it
            self.drop = None
        # Everything else is swallowed on purpose - see _keys.

    def _drop_take(self):
        d, self.drop = self.drop, None
        value = d["values"][d["cur"]]
        if d["zone"] == "set":
            if self.printer is None:
                return
            setattr(self.printer, d["attr"], value)
            self.prn_msg = f"{d['label']} = {value}   (applies to the next job)"
        else:
            self._ask_mode(value)

    def _drop_lines(self, zone, x):
        """The open list, if it belongs to `zone`, indented to column `x`."""
        d = self.drop
        if d is None or d["zone"] != zone:
            return []
        note, dim = self.colour.get(C_NOTE, 0), self.colour.get(C_DIM, 0)
        # One column left of the field, so the highlight brackets the value
        # rather than sitting a character to the right of it.
        pad, w = " " * max(0, x - 1), max(len(v) for v in d["values"])
        out = [[(pad, 0), (" %-*s " % (w, v),
                           curses.A_REVERSE | curses.A_BOLD if i == d["cur"]
                           else note)]
               for i, v in enumerate(d["values"])]
        out.append([(pad, 0), ("^v move   Enter takes it   Esc leaves it as it was", dim)])
        return out

    def _command(self, k):
        if k in (ord("q"), ord("Q")):
            self.quit = True
        elif k in (ord("?"), ord("h")):
            self.help = True
        elif ord("1") <= k < ord("1") + len(VIEWS):
            # Land on the menu bar, not inside the view: arriving somewhere new
            # you usually want to look around first, and Left/Right have to work
            # straight away or the bar is only half a control. Enter or Down
            # steps in - one key, and the same one everywhere.
            self._switch(k - ord("1"))
            self.menu_focus = True
        elif k == ord("l"):
            self.repaint = True                # something drew over us
        elif k in (curses.KEY_PPAGE, PAGE_BACK):
            self.scroll += max(1, self._body_h() - 1)
        elif k in (curses.KEY_NPAGE, PAGE_FWD):
            self.scroll = max(0, self.scroll - max(1, self._body_h() - 1))
        elif k == curses.KEY_END:
            self.scroll = 0
        elif k == curses.KEY_HOME:
            self.to_top = True                 # resolved at draw time; only then
                                               # is the line count known
        elif k == ord("k"):
            self._clear_view()

    def _clear_view(self):
        """Empty the pane in front of you.

        The hub's rings are left alone: the other view is reading the same
        events, and tidying one pane is no reason to destroy history that a
        browser will also want later. Each view just remembers where it was
        cleared and draws nothing older.
        """
        name = VIEWS[self.view][0]
        self.hidden_before[name] = self.hub.last_seq if self.hub else 0
        self.scroll = 0
        self.to_top = False

    def _switch(self, idx):
        self.view = idx
        self.scroll = 0
        self.drop = None
        self.level = TITLE           # the new view is entered from its top

    def _visible(self, events):
        """Drop whatever this view was cleared past."""
        cut = self.hidden_before.get(VIEWS[self.view][0], 0)
        return [e for e in events if e["seq"] > cut] if cut else events

    # -- drawing ----------------------------------------------------------
    def _body_h(self):
        # title, tabs, a blank spacer row, and the status bar
        return max(1, self.scr.getmaxyx()[0] - 4)

    def _maybe_draw(self):
        now = time.monotonic()
        if not self.dirty or now - self.last_draw < 1.0 / REDRAW_HZ:
            return
        self.last_draw = now
        self.dirty = False
        self._draw()

    def _put(self, y, x, text, attr=0):
        h, w = self.scr.getmaxyx()
        if not (0 <= y < h) or x >= w:
            return
        try:
            self.scr.addnstr(y, x, text, w - x - 1, attr)
        except curses.error:
            pass                     # the bottom-right cell always raises

    def _draw(self):
        if self.repaint:
            # Mark every cell dirty: the optimised refresh only rewrites what
            # curses itself changed, and cannot know about anything else that
            # wrote to this terminal.
            self.repaint = False
            self.scr.redrawwin()
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        st = self.state

        # title
        link = f"{st['port']}  connected" if st["connected"] else "waiting for the cartridge"
        if st["paused"]:
            link += f"  |  PAUSED ({st['paused']})"
        title = f" PicoDock {DISPLAY} "
        self._put(0, 0, title + link.rjust(max(0, w - len(title) - 1)),
                  curses.A_REVERSE)

        # tabs. When the menu bar has focus the current tab is reversed rather
        # than merely underlined, so it reads as "the arrows act here".
        x = 1
        for i, (_, label) in enumerate(VIEWS):
            tag = f" {i + 1} {label} "
            if i == self.view:
                attr = (curses.A_REVERSE | curses.A_BOLD if self.menu_focus
                        else curses.A_BOLD | curses.A_UNDERLINE)
            else:
                attr = self.colour.get(C_DIM, 0)
            self._put(1, x, tag, attr)
            x += len(tag) + 1
        # The hint tracks the focus level, because which arrow does what is the
        # one thing that changes as you go in - and the bar is where the eye
        # already is when it stops being obvious.
        if self.awaiting_prefix:
            hint = "Ctrl-A ...     "
        elif self.menu_focus:
            # Two different views from here: one you can step into and one that
            # is only a log. Offering "Enter in" on the log would be advertising
            # a key that does nothing.
            #
            # "^C quit" rides along at this level only. This is where you land
            # and where you come back to, so it is where someone wonders how to
            # get out - and the server otherwise looks like it has no way out,
            # since it is meant to sit there for hours. Deeper levels already
            # spend the room on Esc and the keys of the pane you are in.
            hint = ("<- -> view   Enter in " if self._zones()
                    else "<- -> view   ^B/^F scroll ")
            # ...but only when it fits beside the tabs. A narrow terminal clips
            # this bar from the left edge of the hint, so appending blindly
            # would push the navigation keys off the screen to advertise the
            # one key every terminal user already knows.
            if x + len(hint) + len("  ^C quit ") < w:
                hint += "  ^C quit "
        elif self.drop is not None:
            hint = "^v pick   Enter take   Esc cancel "
        elif self.level == TITLE:
            hint = "^v section   Enter in   Esc out "
        else:
            hint = "Esc out   Ctrl-A ? help "
        self._put(1, max(x, w - len(hint) - 1), hint, self.colour.get(C_DIM, 0))

        if self.help:
            body_end = self._draw_lines([(t, 0) for t in HELP])
        else:
            name = VIEWS[self.view][0]
            head = getattr(self, "_head_" + name, None)
            head_lines = head() if head else []
            self._paint(head_lines, 3)
            body_end = self._draw_lines(
                getattr(self, "_view_" + name)(),
                top=3 + len(head_lines),
                height=self._body_h() - len(head_lines),
                anchor="head" if name in HEAD_ANCHORED else "tail")

        # status bar
        bar = (f" reads {st['reads']}  writes {st['writes']}  "
               f"print jobs {st['jobs']}  questions {st['asks']}"
               + ("  ANSWER ME" if self.ask is not None and self.ask.waiting
                  and VIEWS[self.view][0] != "ask" else "")
               + f"  {self.image}")
        if self.scroll:
            bar += f"  [scrolled back {self.scroll} - Ctrl-F to follow]"
        self._put(h - 1, 0, bar.ljust(max(0, w - 1)), curses.A_REVERSE)

        self._park_cursor(body_end)
        self.scr.refresh()

    def _park_cursor(self, body_end):
        """Put the cursor somewhere it can do no harm - and somewhere useful.

        An input method draws its composition at the cursor, and curses leaves
        the cursor wherever the last write ended. The last write is the status
        bar, on the bottom line: composing there fills that line and the
        terminal scrolls, carrying the header off the top. That is the whole
        bug, and it is fixed by saying where the cursor goes rather than letting
        it fall out of the drawing order.

        Nothing here is typed into, so the cursor is hidden and parked on the
        first body row - never the last row, which is what scrolls.
        """
        h, w = self.scr.getmaxyx()

        # The one place there *is* something to type into: the Ask pane's answer
        # line, drawn last so body_end lands exactly on it. Only while it has
        # focus and the log is live - scrolled back, that line is not on screen
        # and a cursor sitting where it used to be would be a lie.
        typing = (not self.help and not self.menu_focus and not self.scroll
                  and self.level == ITEM and self.drop is None
                  and VIEWS[self.view][0] == "ask" and self.ask_focus == "input")
        try:
            curses.curs_set(1 if typing else 0)
        except curses.error:
            pass                     # some terminals cannot change the cursor
        y, x = body_end if typing else (min(3, h - 2), 0)
        try:
            self.scr.move(max(0, min(y, h - 2)), max(0, min(x, w - 2)))
        except curses.error:
            pass

    def _paint(self, lines, top):
        """Put these lines on the screen starting at row `top`, as they are.

        Split out of _draw_lines so a pane can pin something above the part that
        scrolls: the Ask pane's answerer row belongs on screen whatever the log
        is doing, and it used to slide off the top the moment the log filled the
        pane.
        """
        last = (top, 0)
        for i, item in enumerate(lines):
            if isinstance(item, list):
                # Segmented line: [(text, attr), ...] drawn left to right, so a
                # single field inside a line can be underlined on its own.
                x = 0
                for text, attr in item:
                    self._put(top + i, x, text, attr)
                    x += len(text)
                last = (top + i, x)
                continue
            text, attr = item if isinstance(item, tuple) else (item, 0)
            self._put(top + i, 0, text, attr)
            last = (top + i, len(text))
        return last

    def _title_row(self, zone, focus, hints=None, right=""):
        """A section title - the row the arrows rest on before going in.

        The marker is the whole point of this row. It sits here while the title
        has focus and moves down onto the content the moment you step in, so
        "which of the two levels am I on" is answered by where the > is, not by
        a shade of highlight. The first version of this lit the whole section up
        as soon as the title was reached, which made stepping in look like
        something that had already happened - and a step you cannot see is a
        step nobody believes in.
        """
        dim, note = self.colour.get(C_DIM, 0), self.colour.get(C_NOTE, 0)
        row = [(self._mark(focus == TITLE, 2), HEADING),
               (ZONE_TITLE.get(zone, zone),
                curses.A_REVERSE | curses.A_BOLD if focus == TITLE else HEADING)]
        # A title row describes while it is idle and instructs once it has the
        # focus - never both, because on an 80-column screen the second one to
        # be drawn is the one that gets cut off, and that would always be the
        # keys. What a section holds can wait until you are not steering it.
        hint = (hints or {}).get(focus, "")
        if hint:
            row.append(("   " + hint, note))
        elif right:
            row.append(("   " + right, dim))
        return row

    def _mark(self, here, width):
        """The marker every focusable row starts with, right-aligned in `width`
        so that what follows it stays in its column whether it is there or not.
        Titles use 2, the rows under them 4 - which is also the indent that
        makes content read as content."""
        return (">" if here else " ").rjust(width - 1) + " "

    def _draw_lines(self, lines, top=3, height=None, anchor="tail"):
        """Paint the body, honouring the scrollback offset.

        `anchor` says which end is worth seeing when there is more than fits: a
        log's newest line ("tail"), or a table's first row ("head"). Returns
        where the last line ended, so the cursor can be parked there - see
        _park_cursor for why that matters.
        """
        h = height if height is not None else self._body_h()
        # Clamp the offset to what there is to scroll through. Only the renderer
        # knows how many lines there turned out to be, so this is where it can
        # be done - and it has to be done, or Ctrl-B held on a five-line log
        # walks the offset to 114 and Ctrl-F needs six presses to undo a scroll
        # that never moved the screen. Clamped, holding one key reaches either
        # end and the other key comes straight back, which is what let the jump
        # keys go.
        self.scroll = min(self.scroll, max(0, len(lines) - h))
        if anchor == "head":
            return self._paint(lines[self.scroll:self.scroll + h], top)
        if self.to_top:
            # Home: as far back as the pane holds.
            self.to_top = False
            self.scroll = max(0, len(lines) - h)
        if self.scroll:
            end = max(0, len(lines) - self.scroll)
            lines = lines[max(0, end - h):end]
        else:
            lines = lines[-h:]
        return self._paint(lines, top)

    # -- the views --------------------------------------------------------
    def _merged(self, *channels):
        evs = [e for c in channels for e in self.hub.history(c)]
        evs.sort(key=lambda e: e["seq"])
        return self._visible(evs)

    def _view_disk(self):
        out = []
        for ev in self._merged(CH_IO, CH_DISK, CH_LINK):
            t, name = _hhmmss(ev["t"]), ev["ev"]
            c = self.colour
            if name == "read":
                out.append((f"{t}  R   lba {ev['lba']:<10} x{ev['count']}", c.get(C_READ, 0)))
            elif name == "write":
                out.append((f"{t}  W   lba {ev['lba']:<10} x{ev['count']}", c.get(C_WRITE, 0)))
            elif name == "stats":
                out.append((f"{t}  --  {ev['reads']} reads, {ev['writes']} writes",
                            c.get(C_DIM, 0)))
            elif name == "info":
                out.append((f"{t}  ID  {ev['blocks']} blocks x {ev['sector']}B"
                            + ("  [read-only]" if ev.get("readonly") else ""), c.get(C_OK, 0)))
            elif name == "read_error":
                out.append((f"{t}  !   read past end: lba {ev['lba']} x{ev['count']}",
                            c.get(C_ERR, 0)))
            elif name == "write_error":
                out.append((f"{t}  !   bad write: lba {ev['lba']} x{ev['count']} "
                            f"len {ev['length']}", c.get(C_ERR, 0)))
            elif name == "write_refused":
                out.append((f"{t}  !   write refused (read-only): lba {ev['lba']}",
                            c.get(C_ERR, 0)))
            elif name == "paused":
                why = ("disk_put.sh is borrowing the image" if ev.get("reason") == "disk_put"
                       else "the image is mounted here")
                out.append((f"{t}  ||  PAUSED - {why}", c.get(C_NOTE, 0)))
            elif name == "resumed":
                out.append((f"{t}  >   resumed - run PDSYNC on the MSX",
                            c.get(C_NOTE, 0)))
            elif name == "normalized":
                out.append((f"{t}      {ev['text']}", c.get(C_DIM, 0)))
            elif name == "normalize_failed":
                out.append((f"{t}  !   could not normalise names: {ev['error']}",
                            c.get(C_ERR, 0)))
            elif name == "connected":
                out.append((f"{t}  +   connected: {ev['port']}", c.get(C_OK, 0)))
            elif name == "lost":
                out.append((f"{t}  !   link lost ({ev['error']})", c.get(C_ERR, 0)))
            elif name == "server":
                out.append((f"{t}  ==  PicoDock v{ev['version']} started",
                            c.get(C_OK, 0)))
            elif name == "waiting":
                out.append((f"{t}  ..  waiting for the cartridge "
                            f"(VID {ev['vid']:04X}/PID {ev['pid']:04X})", c.get(C_DIM, 0)))
            elif name == "image":
                out.append((f"{t}  ID  {ev['path']}: {ev['size'] // 1024 // 1024}MB, "
                            f"{ev['blocks']} blocks", c.get(C_DIM, 0)))
        if not out:
            out = [("  nothing yet - the MSX has not asked for a sector.", 0)]
        return out

    # -- ask pane: the question, the answer being typed, the log ----------
    def _ask_key(self, k):
        """Keys in the Ask pane.

        Two sections, exactly like the Printer pane: `mode` is a field the
        arrows reach, and `input` is the answer being typed. Inside
        the answer every printable key is content - there can be no
        single-letter commands there, or the letters could not be typed - which
        is why the choice is a section of its own rather than a key.
        """
        if self.ask_focus == "input":
            if k in (curses.KEY_ENTER, 10, 13):
                self._ask_send()
            elif k in (curses.KEY_BACKSPACE, 127, 8):
                self.ask_text = self.ask_text[:-1]
            elif k == 21:                        # Ctrl-U: start the answer again
                self.ask_text = ""
            elif k in (curses.KEY_LEFT, curses.KEY_RIGHT,
                       curses.KEY_UP, curses.KEY_DOWN):
                # Nothing moves a cursor about inside the text - it is only ever
                # appended to and rubbed out from the end - and no arrow leaves
                # the field either. Esc does that.
                pass
            elif 32 <= k < 127:
                self.ask_text += chr(k)
            else:
                self._command(k)                 # PgUp/PgDn, Home/End: the log
            return

        if k in (curses.KEY_LEFT, curses.KEY_RIGHT,
                 curses.KEY_UP, curses.KEY_DOWN):
            pass                                 # one field, and no way out but Esc
        elif k in (curses.KEY_ENTER, 10, 13):
            self._drop_open()
        elif k in (ord("m"), ord("g")):          # ...and the direct way there
            self._ask_mode({"m": "manual", "g": "google"}[chr(k)])
        elif k == ord("x"):
            if self.ask and self.ask.state != "idle":
                self.ask.cancel()
                self.ask_msg = "refused - the MSX gets an error"
            else:
                self.ask_msg = "nothing to refuse"
        else:
            self._command(k)

    def _ask_send(self):
        if self.ask is None:
            self.ask_msg = "no server attached"
            return
        text = self.ask_text.strip()
        if not text:
            self.ask_msg = "nothing typed"
            return
        if not self.ask.waiting:
            # Refusing to send is the kind thing here: with nothing waiting the
            # bytes would go nowhere, and an answer that vanished silently is
            # worse than one that was never accepted.
            self.ask_msg = "the MSX is not waiting for anything"
            return
        self.ask.submit(text.replace("\\n", "\n"))
        self.ask_text = ""
        self.ask_msg = "sent"

    def _ask_mode(self, mode):
        if self.ask is None:
            self.ask_msg = "no server attached"
            return
        self.ask.set_mode(mode)
        self.ask_msg = "answers come from: %s" % mode

    def _ask_modes(self):
        return list(self.ask.MODES) if self.ask else ["manual", "google"]

    def _head_ask(self):
        """The row that stays put: who answers, and how the answer is shaped.

        Pinned rather than drawn with the log, because it is the state of the
        pane rather than something that happened - and because it used to slide
        off the top as soon as the log filled the pane, which is exactly when
        somebody is looking for it.
        """
        c = self.colour
        head, dim, note = (c.get(C_HEAD, 0), c.get(C_DIM, 0), c.get(C_NOTE, 0))
        f = self._focus("mode")
        facts = ("cut at %d   %s   engine %s"
                 % (self.ask.limit, self.ask.charset, self.ask.engine)
                 if self.ask else "")
        out = [self._title_row("mode", f, {
            TITLE: "Enter in   ^v section",
            ITEM: "Enter lists them   x refuses the one in hand   Esc out",
        }, right=facts)]
        # One field, drawn the way the Printer's three are: a label, the value
        # in brackets, and the list one Enter away. Two panes that offer the
        # same kind of choice should not need two sets of fingers.
        lit = f == ITEM
        out.append([(self._mark(lit, PRN_SET_X), head if lit else dim),
                    ("By [", head if lit else dim),
                    (self.ask.mode if self.ask else "-",
                     FIELD if lit else (note if f else dim)),
                    ("]", head if lit else dim)])
        out.extend(self._drop_lines("mode", PRN_SET_X + len("By [")))
        out.append("")
        return out

    def _view_ask(self):
        c = self.colour
        out = []

        # the question in hand
        if self.ask and self.ask.waiting:
            out.append(("  the MSX is waiting:", c.get(C_OK, 0) | curses.A_BOLD))
            for line in _fold(self.ask.question or "", 70):
                out.append(("    " + line, curses.A_BOLD))
        elif self.ask and self.ask.state == "sending":
            out.append(("  sending the answer to the MSX...", c.get(C_NOTE, 0)))
        else:
            out.append(("  nothing waiting - CALL PDASK(\"...\") on the MSX asks.",
                        c.get(C_DIM, 0)))
        out.append("")

        # Logs. Not a section, but a heading of the same rank and drawn like
        # one: leaving it dim while its siblings are bold made the pane look
        # like it had two kinds of heading. That you cannot stop here is already
        # said by the marker, which never appears on this row.
        out.append(("  Logs", HEADING))
        before = len(out)
        for ev in self._visible(self.hub.history(CH_ASK)):
            t, name = _hhmmss(ev["t"]), ev["ev"]
            if name == "question":
                out.append((f"{t}  Q   {ev['text']}", c.get(C_HEAD, 0)))
            elif name == "answer":
                cut = " (cut)" if ev.get("truncated") else ""
                out.append((f"{t}  A   [{ev['source']}] {ev['bytes']} bytes{cut}"
                            f"  in {ev.get('took', 0)}s", c.get(C_OK, 0)))
                for line in _fold(ev.get("text", ""), 70)[:6]:
                    out.append((f"          {line}", c.get(C_DIM, 0)))
            elif name == "searching":
                out.append((f"{t}  ..  searching ({ev['engine']})", c.get(C_DIM, 0)))
            elif name == "delivered":
                out.append((f"{t}  >   the MSX has it", c.get(C_DIM, 0)))
            elif name == "error":
                out.append((f"{t}  !   {ev['text']}", c.get(C_ERR, 0)))
            elif name == "cancelled":
                out.append((f"{t}  !   dropped (by the {ev['by']})", c.get(C_ERR, 0)))
            elif name == "timeout":
                out.append((f"{t}  !   the MSX stopped reading after {ev['after']}s",
                            c.get(C_ERR, 0)))
            elif name == "mode":
                out.append((f"{t}  ==  answers now come from {ev['mode']}",
                            c.get(C_NOTE, 0)))
            elif name in ("note", "enabled"):
                text = ev.get("text") or ("answered by %s, cut at %s"
                                          % (ev.get("mode"), ev.get("limit")))
                out.append((f"{t}      {text}", c.get(C_DIM, 0)))

        if len(out) == before:
            out.append(("    (nothing asked yet)", c.get(C_DIM, 0)))
        if self.ask_msg:
            out.append(("  " + self.ask_msg, c.get(C_NOTE, 0)))

        # ...and the line being typed, last so the cursor can be parked on it.
        # It stays at the bottom rather than following its title up the pane:
        # a line you type into belongs where a terminal puts one, and it is the
        # only row _park_cursor can find without counting scrolled-away lines.
        f = self._focus("input")
        out.append(self._title_row("input", f, {
            TITLE: "Enter in   ^v section",
            ITEM: "Enter sends it   \\n breaks a line   Esc out",
        }))
        out.append([(self._mark(f == ITEM, PRN_SET_X),
                     c.get(C_OK, 0) | curses.A_BOLD),
                    (self.ask_text, curses.A_BOLD)]
                   + ([] if self.ask_text
                      else [("(nothing typed)", c.get(C_DIM, 0))]))
        return out

    # -- status pane: everything the server knows, in one place -----------
    def _view_status(self):
        """What is true right now, rather than what happened.

        The other three panes are logs - they answer "what did it do". This one
        answers "what is it doing", which is the question asked when something
        looks wrong and there is nothing in any log to explain it.

        Kept to one screen on a 24-line terminal, which is what decides how much
        goes on each row: a fact you have to scroll to reach is one this pane
        failed to tell you.
        """
        st = self.state
        c = self.colour
        ok, dim, note = c.get(C_OK, 0), c.get(C_DIM, 0), c.get(C_NOTE, 0)
        head = curses.A_BOLD

        def row(label, value, attr=0):
            return ("      %-11s %s" % (label, value), attr)

        usb = st.get("usb") or {}
        up = _hms(int(time.time() - self.started))
        out = [("  Cartridge", head)]
        if st["connected"]:
            out.append(row("link", "connected   server up %s" % up, ok))
            board = usb.get("product") or "PicoDock"
            vendor = usb.get("vendor") or ""
            if vendor and vendor.lower() != board.lower():
                board += " by %s" % vendor
            if usb.get("vid") is not None:
                board += "   %04X:%04X" % (usb["vid"], usb["pid"])
            out.append(row("board", board))
            out.append(row("port", (st["port"] or "-")
                           + ("   serial %s" % st["serial"] if st["serial"] else "")))
        else:
            out.append(row("link", "waiting for the cartridge   up %s" % up, dim))
        out.append("")

        out.append(("  Disk", head))
        out.append(row("image", self.image))
        out.append(row("volume", "%d MB, %d blocks x 512B%s"
                       % (st["size"] // 1024 // 1024, st["blocks"],
                          "   [read-only]" if st["readonly"] else "")))
        out.append(row("serving", ("PAUSED (%s)" % st["paused"] if st["paused"]
                                   else "yes")
                       + "   %d sectors read, %d written"
                       % (st["reads"], st["writes"]),
                       note if st["paused"] else 0))
        out.append("")

        p = self.printer
        out.append(("  Printer", head))
        mode = (p.mode if p else st["print_mode"]) or "off"
        out.append(row("mode", mode + ("   %s / %s" % (p.charset, p.glyphs)
                                       if p and mode != "off" else ""),
                       dim if mode == "off" else 0))
        out.append(row("output", "%s   %d job%s%s"
                       % (self.out_dir, st["jobs"], "" if st["jobs"] == 1 else "s",
                          "   spooling" if st["spool"] else "")))
        out.append("")

        a = self.ask
        out.append(("  CALL PDASK", head))
        if a is None:
            out.append(row("answered by", "-", dim))
        else:
            state = {"idle": "nothing waiting", "asking": "WAITING FOR AN ANSWER",
                     "sending": "sending to the MSX"}.get(a.state, a.state)
            out.append(row("answered by", "%s   %s" % (a.mode, state),
                           note if a.waiting else 0))
            out.append(row("shaping", "cut at %d, %d cols, %s   search %s (%s)"
                           % (a.limit, a.width, a.charset, a.engine, a.lang)))
        out.append(row("questions", "%d this session" % st["asks"]))
        out.append("")

        # What the MSX *is*, as opposed to what it has done, is not something
        # the host can find out: the cartridge answers sector reads, and no
        # frame carries a word about the machine the slot is in. The MSX has to
        # say so, which is what PDINFO.COM is for - by hand, when you want it.
        out.append(("  MSX", head))
        if a is not None and a.msx:
            for label, value in a.msx:
                out.append(row(label, value))
        else:
            seen = st["reads"] or st["writes"] or st["asks"] or st["jobs"]
            out.append(row("seen", "yes - it has used the disk" if st["reads"]
                           else ("yes" if seen else "nothing from it yet"),
                           ok if seen else dim))
            out.append(row("machine", "not reported yet", dim))
            out.append(("        run  A>PDINFO  on the MSX and it appears here",
                        note))

        return out

    # -- printer pane: settings, files, log -------------------------------
    def _prn_setting(self, name):
        """Current value of a live printer setting, or '-' with no server."""
        if self.printer is None:
            return "-"
        return str(getattr(self.printer, name, "-"))

    def _prn_cycle(self, attr):
        """Step a setting to its next value, in place on the live Printer."""
        if self.printer is None:
            self.prn_msg = "no printer attached"
            return
        for label, name, values in PRN_SETTINGS:
            if name != attr:
                continue
            cur = str(getattr(self.printer, name, values[0]))
            nxt = values[(values.index(cur) + 1) % len(values)] \
                if cur in values else values[0]
            setattr(self.printer, name, nxt)
            self.prn_msg = f"{label} = {nxt}   (applies to the next job)"
            return

    def _prn_rescan(self, force=False):
        """Rebuild the output listing, at most a few times a second."""
        now = time.time()
        if not force and now - self.prn_scan < 1.0:
            return
        self.prn_scan = now
        try:
            names = os.listdir(self.out_dir)
        except OSError:
            self.prn_files = []
            return
        rows = []
        for n in names:
            p = os.path.join(self.out_dir, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if os.path.isfile(p):
                rows.append((n, st.st_size, st.st_mtime))
        # Newest first: the file you just printed is the one you want, and
        # putting it at row 0 means the cursor starts somewhere visible.
        rows.sort(key=lambda r: r[2], reverse=True)
        self.prn_files = rows
        if self.prn_cur >= len(rows):
            self.prn_cur = max(0, len(rows) - 1)
        self._spool_rescan()

    def _spool_rescan(self):
        """Re-read the live capture's job index, if the server is spooling.

        Read from the index file rather than tracked in memory: the writer
        fsyncs a line per job, so the file is the truth, and it also picks up
        the unclosed tail - the job being printed right now - which no
        in-memory counter here would know about.
        """
        writer = getattr(self.printer, "spool", None) if self.printer else None
        if writer is None:
            self.prn_spool, self.prn_jobs = None, []
            return
        try:
            import msx_printer_spool
            if self.prn_spool is None or self.prn_spool.prn_path != writer.prn_path:
                self.prn_spool = msx_printer_spool.Spool(writer.prn_path)
            self.prn_jobs = self.prn_spool.jobs()
        except Exception:
            self.prn_spool, self.prn_jobs = None, []

    def _prn_selected(self):
        if not self.prn_files or not (0 <= self.prn_cur < len(self.prn_files)):
            return None
        return os.path.join(self.out_dir, self.prn_files[self.prn_cur][0])

    def _prn_open(self):
        """Hand the file to the desktop. Three platforms, three ways.

        macOS has `open` and Linux has `xdg-open`, but Windows has neither -
        it has os.startfile, which is a stdlib call rather than a program, so
        there is nothing to look up with shutil.which. Assuming xdg-open
        everywhere-but-macOS told Windows users "no xdg-open here (headless?)"
        on a perfectly good desktop.

        Headless is still the common case on a Pi over ssh, and there the
        launcher either does not exist or fails silently - so say so and point
        at the in-TUI alternatives rather than looking like nothing happened."""
        path = self._prn_selected()
        if not path:
            return

        if sys.platform == "win32":
            try:
                os.startfile(path)                      # noqa: B606 (Windows)
                self.prn_msg = f"opened {os.path.basename(path)}"
            except OSError as exc:
                # Usually "no application associated with this file type",
                # which is a real answer and not a failure of ours.
                self.prn_msg = f"could not open: {exc}"
            self._reclaim_terminal()
            return

        opener = "open" if sys.platform == "darwin" else "xdg-open"
        if not shutil.which(opener):
            self.prn_msg = (f"no {opener} here (headless?) - use v to preview,"
                            " y for the full path")
            return
        if sys.platform != "darwin" and not (os.environ.get("DISPLAY")
                                             or os.environ.get("WAYLAND_DISPLAY")):
            self.prn_msg = ("no desktop session - use v to preview,"
                            " y for the full path")
            return
        try:
            # stdin must be detached too, and the child put in its own session.
            # Inheriting our stdin let `open` share the controlling terminal:
            # it competed for keystrokes and left the tty in a state curses had
            # not asked for, so the pane went deaf after the first Enter.
            subprocess.Popen([opener, path],
                             stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL,
                             start_new_session=True)
            self.prn_msg = f"opened {os.path.basename(path)}"
        except OSError as exc:
            self.prn_msg = f"could not open: {exc}"
        # Whatever the launcher did to the terminal, take it back.
        self._reclaim_terminal()

    def _reclaim_terminal(self):
        """Reassert the curses input modes and force a full repaint.

        A desktop launcher can hand the tty back with echo on or in cooked
        mode; without this the next keypress is printed instead of read."""
        try:
            curses.noecho()
            curses.cbreak()
            self.scr.keypad(True)
            self.scr.nodelay(True)
            curses.flushinp()
        except curses.error:
            pass
        self.repaint = True
        self.dirty = True

    def _png_to_pdf(self, png_paths, out):
        """Wrap rendered pages into one PDF. Needs Pillow, as the pages are
        images - the daemon's own pdf mode is a different thing, it typesets
        decoded *text* with reportlab. The spool tool merges jobs the same way,
        so the implementation lives there and this is the one caller in here."""
        import msx_printer_spool
        return msx_printer_spool.pages_to_pdf(png_paths, out)

    def _prn_render(self, kind):
        """Re-render the selected .prn as png / pdf / text, or all charsets."""
        path = self._prn_selected()
        if not path:
            return
        if not path.endswith(PRN_RENDERABLE):
            self.prn_msg = "only .prn captures can be re-rendered"
            return
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "printer"))
        keep = os.path.basename(path)            # re-select this after rescanning
        try:
            import msx_printer_recharset as rc
            data = open(path, "rb").read()
            stem = os.path.splitext(path)[0]
            glyphs = self._prn_setting("glyphs")
            if kind == "all":
                made = rc.render_all(data, stem)
                self.prn_msg = (f"rendered {len(made)} charsets: "
                                + ", ".join(sorted(made)))
            elif kind == "text":
                cs = self._prn_setting("charset")
                out = stem + ".txt"
                with open(out, "w", encoding="utf-8", newline="") as fh:
                    fh.write(rc.decode_text(data, cs))
                self.prn_msg = f"text ({cs}) -> {os.path.basename(out)}"
            elif kind == "pdf":
                paths, _ = rc.render(data, stem, glyphs)
                try:
                    out = self._png_to_pdf(paths, stem + ".pdf")
                    self.prn_msg = (f"pdf ({glyphs}, {len(paths)} page(s))"
                                    f" -> {os.path.basename(out)}")
                except ImportError:
                    self.prn_msg = ("pdf needs Pillow (pip install pillow);"
                                    f" wrote {os.path.basename(paths[0])} instead")
            else:                                    # png
                paths, _ = rc.render(data, stem, glyphs)
                self.prn_msg = f"png ({glyphs}) -> {os.path.basename(paths[0])}"
        except Exception as exc:
            self.prn_msg = f"render failed: {exc}"
        finally:
            # Rendering adds files, and the list is newest-first, so without
            # this the cursor would silently slide onto the file just written -
            # and the next keypress would act on the wrong thing.
            self._prn_rescan(force=True)
            self._prn_select(keep)

    def _prn_select(self, name):
        """Put the cursor back on `name` if it is still in the list."""
        for i, row in enumerate(self.prn_files):
            if row[0] == name:
                self.prn_cur = i
                return

    def _prn_spool_render(self, merge):
        """Turn the capture into files, now that someone has asked.

        Every job, or all of them as one document - the two things wanted often
        enough to deserve a key. Anything narrower ("just job 3", "1-7 only")
        is printer/msx_printer_spool.py, which has the whole range syntax; there
        is no point growing a second cursor in here to duplicate it.

        Synchronous, like the file-list renders next to it: a render can take a
        second and the serial loop is this thread. Disk requests wait that long.
        """
        if not self.prn_spool or not self.prn_jobs:
            self.prn_msg = "nothing captured yet"
            return
        # Close the job in flight first, or its bytes render as an "unclosed"
        # fragment and then again as part of the next complete job.
        if self.printer and self.printer.spool and self.printer.spool.open_job:
            self.printer.flush()
            self._spool_rescan()
        try:
            import msx_printer_spool as ms
            mode = self._prn_setting("mode")
            if mode == "off":
                mode = "auto"            # "off" means don't render *live*
            if merge:
                out = ms.merge(self.prn_spool, set(), mode,
                               charset=self._prn_setting("charset"),
                               glyphs=self._prn_setting("glyphs"))
                self.prn_msg = (f"merged {len(self.prn_jobs)} jobs -> "
                                f"{os.path.basename(out)}" if out else "nothing to merge")
            else:
                done = ms.render(self.prn_spool, set(), mode,
                                 charset=self._prn_setting("charset"),
                                 glyphs=self._prn_setting("glyphs"))
                self.prn_msg = f"rendered {len(done)} job(s) as {mode}"
        except Exception as exc:
            self.prn_msg = f"spool render failed: {exc}"
        finally:
            self.prn_cur = 0             # new files land at the top of the list
            self._prn_rescan(force=True)

    def _prn_preview(self):
        """Show a text file inside the TUI - the headless answer to Enter."""
        path = self._prn_selected()
        if not path:
            return
        if not path.endswith(PRN_VIEWABLE):
            self.prn_msg = "preview only handles .txt (use p to render a .prn)"
            return
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(2000).splitlines()[:20]
            self.prn_msg = " | ".join(l.strip() for l in head if l.strip())[:400] \
                or "(empty)"
        except OSError as exc:
            self.prn_msg = f"could not read: {exc}"

    def _prn_field_x(self, idx):
        """The column where field `idx`'s value starts, so the open list of
        values lines up under it.

        Counted the same way the row is built, a few lines further down. curses
        cannot be asked after the fact where something ended up, so the two have
        to agree by construction - keep them next to each other.
        """
        x = PRN_SET_X
        for i, (label, name, _values) in enumerate(PRN_SETTINGS):
            if i == idx:
                return x + len(label) + 2            # past "label ["
            x += len(label) + 2 + len(self._prn_setting(name)) + 4
        return x

    def _prn_key(self, k):
        """Keys inside the Printer pane.

        The settings run across the pane, so Left/Right pick one and Up/Down
        leave. The file list runs down it, so Up/Down pick one and Left leaves.
        Enter means "act on this" in both: open a setting's values, open a file.
        """
        if self.prn_focus == "set":
            if k == curses.KEY_LEFT:
                # Stops at the first field. It used to carry on out to the
                # section title, which meant Left did two different things
                # depending on where you already were - and the one time you
                # wanted it to do nothing was the one time it moved you.
                self.prn_field = max(0, self.prn_field - 1)
            elif k == curses.KEY_RIGHT:
                self.prn_field = min(len(PRN_SETTINGS) - 1, self.prn_field + 1)
            elif k in (curses.KEY_UP, curses.KEY_DOWN):
                pass                     # the row has no second line; Esc is out
            elif k in (curses.KEY_ENTER, 10, 13):
                self._drop_open()
            # The letter keys still work as shortcuts to a field's next value,
            # which is the fast way when you already know what you want.
            elif k == ord("m"):
                self.prn_field = 0; self._prn_cycle("mode")
            elif k == ord("c"):
                self.prn_field = 1; self._prn_cycle("charset")
            elif k == ord("g"):
                self.prn_field = 2; self._prn_cycle("glyphs")
            else:
                self._command(k)
            return

        # files
        self._prn_rescan()
        if k == curses.KEY_UP:
            self.prn_cur = max(0, self.prn_cur - 1)
        elif k == curses.KEY_DOWN:
            self.prn_cur = min(max(0, len(self.prn_files) - 1), self.prn_cur + 1)
        elif k in (curses.KEY_LEFT, curses.KEY_RIGHT):
            pass                         # a row has nothing to either side
        elif k == curses.KEY_HOME:
            self.prn_cur = 0
        elif k == curses.KEY_END:
            self.prn_cur = max(0, len(self.prn_files) - 1)
        elif k in (curses.KEY_ENTER, 10, 13):
            self._prn_open()
        elif k == ord("p"):
            self._prn_render("png")
        elif k == ord("f"):
            self._prn_render("pdf")
        elif k == ord("t"):
            self._prn_render("text")
        elif k == ord("a"):
            self._prn_render("all")
        elif k == ord("s"):
            self._prn_spool_render(False)
        elif k == ord("S"):
            self._prn_spool_render(True)
        elif k == ord("v"):
            self._prn_preview()
        elif k == ord("y"):
            path = self._prn_selected()
            self.prn_msg = os.path.abspath(path) if path else "no file"
        elif k == ord("r"):
            self._prn_rescan(force=True)
            self.prn_msg = f"{len(self.prn_files)} files"
        else:
            self._command(k)

    def _view_print(self):
        self._prn_rescan()
        dim = self.colour.get(C_DIM, 0)
        note = self.colour.get(C_NOTE, 0)
        head = self.colour.get(C_HEAD, 0)
        out = []

        cursor = curses.A_UNDERLINE | curses.A_BOLD

        # -- settings --
        # A title row of its own, so there is somewhere to rest that is not on
        # any one field: it is what Up/Down walk between and what Left backs out
        # to. The value the arrows act on is underlined, so the cursor is
        # visible without a second highlight competing with the focus marker.
        sel = self._focus("set")
        out.append(self._title_row("set", sel, {
            TITLE: "Enter in   ^v section",
            ITEM: "<- -> pick   Enter lists its values   Esc out",
        }))
        # Dim until the focus has actually stepped in. Lighting the fields up
        # while the cursor is still on the title above them is what made the
        # title look like a row you pass through rather than one you stop on.
        lit = sel == ITEM
        seg = [(self._mark(lit, PRN_SET_X), head if lit else dim)]
        for i, (label, name, _values) in enumerate(PRN_SETTINGS):
            here = lit and i == self.prn_field
            seg.append((f"{label} [", head if lit else dim))
            # Reversed, not underlined. An underline is all this used to be, and
            # moving from one field to the next changed so little on screen that
            # the key looked dead - the same mistake the section titles made.
            seg.append((self._prn_setting(name), FIELD if here else
                        (note if lit else dim)))
            seg.append(("]   ", head if lit else dim))
        seg.append(("raw: always kept", dim))
        out.append(seg)
        out.extend(self._drop_lines("set", self._prn_field_x(self.prn_field)))

        # -- spool --
        # Only when the server was started with --spool. Deliberately above the
        # file list: while spooling, "what has arrived" is the live thing and
        # output/ is only what has been asked for so far.
        if self.prn_spool is not None:
            total = sum(j["len"] for j in self.prn_jobs)
            out.append(("  spool/".ljust(52)
                        + f"{len(self.prn_jobs)} jobs  {_size(total)}", dim))
            for j in self.prn_jobs[-4:]:
                mark = "  (printing)" if j["end"] == "unclosed" else ""
                out.append((f"    #{j['seq']:<3} {_hhmmss(j['t0'])}"
                            f"  {_size(j['len']):>9}{mark}",
                            note if mark else dim))
            if len(self.prn_jobs) > 4:
                out.append((f"    ... {len(self.prn_jobs) - 4} earlier"
                            f" (printer/msx_printer_spool.py list)", dim))
            if not self.prn_jobs:
                out.append(("    (nothing captured yet)", dim))
            out.append(("    s  render every job          S  merge them into one",
                        note))

        # -- file list --
        sel = self._focus("files")
        out.append(self._title_row(
            "files", sel, {
                TITLE: "Enter in   ^v section",
                ITEM: "^v pick   Enter opens it   Esc out",
            },
            right="%d file%s   %s/" % (len(self.prn_files),
                                       "" if len(self.prn_files) == 1 else "s",
                                       self.out_dir)))
        if not self.prn_files:
            out.append(("    (nothing yet - print something from the MSX)", dim))
        else:
            # How many rows the list may have. The settings above it and a few
            # lines of job log below are worth more than the twelfth filename,
            # so the list is what gives way. Without this the pane overflowed
            # and the anchor decided what you saw - which is how a focused row
            # ends up off-screen with the arrows apparently doing nothing.
            after = 5 + PRN_LOG_MIN + (1 if self.prn_msg else 0)
            rows = max(3, min(PRN_ROWS, self._body_h() - len(out) - after))
            # The window follows the cursor, so the underline is never on a row
            # that scrolled away - which is what made stepping in look like it
            # did nothing when the list was longer than the pane.
            total = len(self.prn_files)
            if self.prn_cur < self.prn_top:
                self.prn_top = self.prn_cur
            elif self.prn_cur >= self.prn_top + rows:
                self.prn_top = self.prn_cur - rows + 1
            self.prn_top = max(0, min(self.prn_top, max(0, total - rows)))
            if self.prn_top:
                out.append((f"    ... {self.prn_top} newer above ...", dim))
            for idx in range(self.prn_top, min(self.prn_top + rows, total)):
                name, size, mtime = self.prn_files[idx]
                here = sel == ITEM and idx == self.prn_cur
                shown = name[:42]
                # Underline the name itself, not the column padding after it.
                out.append([(self._mark(here, PRN_SET_X), head),
                            (shown, cursor if here else 0),
                            (" " * (42 - len(shown)), 0),
                            (f" {_size(size):>9}   {_hhmmss(mtime)}",
                             note if here else 0)])
            hidden = total - (self.prn_top + rows)
            if hidden > 0:
                out.append((f"    ... {hidden} older below -"
                            f" keep pressing down ...", dim))
        # The key hints stay up whether or not this section has focus - they are
        # what makes the pane discoverable, and there is room for two lines.
        out.append(("    up/down pick a file   Enter open   p PNG  f PDF  t text",
                    note if sel else dim))
        out.append(("    a all-charsets  v preview(txt)  y path  r rescan"
                    "   Esc out", note if sel else dim))
        if self.prn_msg:
            out.append((f"    {self.prn_msg}", self.colour.get(C_OK, 0)))

        # -- Logs (not a section: nothing in it to pick, so the arrows would
        # have nowhere to go once they arrived - but a heading all the same) --
        out.append(("  Logs", HEADING))
        log = []
        for ev in self._visible(self.hub.history(CH_PRINT)):
            t, name = _hhmmss(ev["t"]), ev["ev"]
            if name == "enabled":
                log.append((f"  {t}  printer mode: {ev['mode']} -> {self.out_dir}/", dim))
            elif name == "job_start":
                log.append((f"  {t}  job started ({ev['mode']})", note))
            elif name == "job_end":
                log.append((f"  {t}  job ended, {ev['size']} bytes", dim))
            elif name == "msg":
                colour = {"ok": C_OK, "error": C_ERR}.get(ev.get("level"), C_DIM)
                log.append((f"  {t}  {ev['text']}", self.colour.get(colour, 0)))
        if not log:
            log = [("  no print jobs yet.", 0),
                   ("  Print from the MSX as you always would: LPRINT, LLIST,", dim),
                   ("  COPY <file> PRN.  On an OCM, A>PDFRCPRN once first.", dim)]

        # The controls stay put and the log takes whatever room is left, with
        # PgUp/PgDn walking back through it. Scrolling the pane as a whole - as
        # it used to - carried the settings row off the top after a handful of
        # jobs, and a control that has scrolled away is a control that silently
        # does nothing. This is also why the view is head-anchored: the offset
        # is spent here, so _draw_lines must not spend it a second time.
        room = max(0, self._body_h() - len(out))
        if self.to_top:
            self.to_top = False                  # Home: as far back as it holds
            self.scroll = max(0, len(log) - room)
        # Clamped here for the same reason _draw_lines clamps: this pane spends
        # the offset itself, so nothing else can bound it.
        self.scroll = min(self.scroll, max(0, len(log) - room))
        end = len(log) - self.scroll
        return out + (log[max(0, end - room):end] if room else [])


def available():
    """Whether a TUI can run here at all.

    Three ways it cannot: no curses module (Windows without windows-curses), or
    either end redirected - curses needs a real terminal on both, and a piped
    stdout means the text view is what was wanted anyway.
    """
    return curses is not None and sys.stdout.isatty() and sys.stdin.isatty()
