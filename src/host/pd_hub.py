#!/usr/bin/env python3
"""pd_hub.py - the one place everything the server has to say goes through.

Why this exists
---------------
Several independent things happen at once while the server runs: sector traffic,
printer jobs, the link coming and going. Until now each of them called print()
directly, which works for exactly one consumer - a single
scrolling terminal - and forecloses every other one. Interleaved text cannot be
separated back into channels, and a sector read that was already baked into
"    read  lba=1234 x8" can never be drawn as a table row or a graph.

So nothing prints any more. Everything emits a *structured* event on a
*channel*, and views subscribe. TextView below reproduces the plain output the
server has always had, so this change is invisible from the outside; a
split-screen curses view and a browser over WebSocket are simply more
subscribers, and neither the server nor the other views need to know they exist.

Two rules make those later views possible, and both are easy to break by
accident:

  * **Emit fields, not sentences.** emit(CH_IO, "read", lba=1234, count=8) can
    be rendered as a text line, a table row, or a graph. A pre-formatted string
    can only ever be text - and then a browser is just a worse terminal, with
    nothing to justify the machinery it costs.

  * **Keep per-channel scrollback.** Switching to the printer view has to show
    what already happened rather than an empty pane, and a browser connecting
    late needs exactly the same backfill. One ring buffer per channel serves
    both, and keeps high-rate sector traffic from evicting the one message that
    actually mattered.

Standard library only, and no syntax past Python 3.9 - macOS ships 3.9 with the
command line tools, and Raspberry Pi OS refuses `pip install` outside a venv
(PEP 668), so anything this needs to be installed is something a user has to
fight with before the MSX ever boots.

(c) 2026 - part of the msx-serial project
"""

import collections
import sys
import threading
import time

# ---------------------------------------------------------------------------
# Channels
#
# Split by rate as much as by topic: io alone can produce hundreds of events a
# second, and sharing a ring buffer with it would mean a pause/resume notice
# scrolls out of history within a second of a busy transfer.
# ---------------------------------------------------------------------------
CH_LINK = "link"        # the cartridge: waiting, connected, lost
CH_DISK = "disk"        # the image as a whole: size, pause/resume, refusals
CH_IO = "io"            # per-sector traffic and throughput
CH_PRINT = "print"      # printer jobs
CH_ASK = "ask"          # CALL PDASK: questions from the MSX and their answers

# The mailbox has one consumer again. It carried the remote keyboard once, then
# nothing at all, and now pd_ask.py: questions the MSX asks with CALL PDASK and the
# answers a person or a search sends back. Its own channel rather than a note on
# CH_LINK, because a question sitting unanswered is a thing a view has to be
# able to show on its own - not a line that scrolls past.
CHANNELS = (CH_LINK, CH_DISK, CH_IO, CH_PRINT, CH_ASK)

SCROLLBACK = {CH_LINK: 200, CH_DISK: 500, CH_IO: 4000, CH_PRINT: 500,
              CH_ASK: 300}


class Hub:
    """Fan-out of structured events to any number of views.

    Thread-safe on purpose. Today only the serial loop emits and only TextView
    listens, both on the main thread - but a curses view redrawing on a timer,
    and a WebSocket view serving several browsers, each arrive with their own
    thread. Getting that wrong later is a race that shows up as a corrupted
    screen once an hour; getting it right now is one lock.
    """

    def __init__(self, scrollback=None):
        sizes = dict(SCROLLBACK)
        if scrollback:
            sizes.update(scrollback)
        self._history = {c: collections.deque(maxlen=sizes[c]) for c in CHANNELS}
        self._subs = []
        self._lock = threading.RLock()
        self._seq = 0

    def emit(self, channel, event, **fields):
        """Record one thing that happened and hand it to every view.

        `fields` carry data, never a formatted sentence. The returned event is
        the same dict the views receive, so a caller can keep a reference to it.
        """
        ev = dict(fields)
        with self._lock:
            self._seq += 1
            ev["seq"] = self._seq          # total order, across all channels
            ev["t"] = time.time()
            ev["ch"] = channel
            ev["ev"] = event
            if channel in self._history:
                self._history[channel].append(ev)
            subs = list(self._subs)        # copy: a view may unsubscribe itself
        for fn in subs:
            try:
                fn(ev)
            except Exception:
                # A broken view must never take the server down. The MSX may be
                # mid-write, and a traceback escaping from here would leave a
                # half-written sector on a filesystem the MSX still believes in.
                pass
        return ev

    def subscribe(self, fn, backfill=False):
        """Attach a view. With backfill=True it first receives the scrollback,
        oldest first, so a view that starts late is not looking at a blank pane.
        """
        with self._lock:
            past = self.history() if backfill else []
            self._subs.append(fn)
        for ev in past:
            try:
                fn(ev)
            except Exception:
                pass
        return fn

    def unsubscribe(self, fn):
        with self._lock:
            if fn in self._subs:
                self._subs.remove(fn)

    @property
    def last_seq(self):
        """The sequence number of the most recent event.

        A view that has been cleared remembers this and draws nothing older,
        which empties the pane without destroying scrollback the other views -
        and, later, a browser - are reading from the same rings.
        """
        with self._lock:
            return self._seq

    def history(self, channel=None):
        """Past events, oldest first: one channel, or all of them merged back
        into the order they actually happened (that is what `seq` is for)."""
        with self._lock:
            if channel is not None:
                return list(self._history.get(channel, ()))
            out = [ev for c in CHANNELS for ev in self._history[c]]
        out.sort(key=lambda e: e["seq"])
        return out


# The server-wide instance. A singleton rather than an argument threaded through
# every function, so that emitting stays as ordinary as print() used to be and
# call sites stay one line - the moment it is a chore, someone reaches for
# print() again and the next view silently loses that message.
HUB = Hub()


def emit(channel, event, **fields):
    return HUB.emit(channel, event, **fields)


# ---------------------------------------------------------------------------
# The text view
# ---------------------------------------------------------------------------
def _where(ev):
    """"  (at /Volumes/X)" when the mount point is known, else nothing.

    Worth saying: with two images open in Finder, "it is mounted" does not tell
    you which one to eject. The lookup is best-effort - on Linux, or if hdiutil
    is slow or odd, it returns nothing and the message is simply shorter.
    """
    at = ev.get("at")
    if not at:
        return ""
    return "  (at " + ", ".join(at) + ")"


class TextView:
    """The plain terminal output the server has always produced.

    Deliberately identical, line for line: this refactor is meant to be
    invisible until a second view exists. It also stays the right answer for
    every case curses cannot serve - output redirected to a file, a pipe, a
    systemd unit, or an ssh session with no tty.
    """

    def __init__(self, verbose=False, stream=None):
        self.verbose = verbose
        self.stream = stream or sys.stdout

    def __call__(self, ev):
        text = self.format(ev)
        if text is None:
            return
        self.stream.write(text + "\n")
        self.stream.flush()

    def format(self, ev):
        """Render one event, or None to show nothing in a plain terminal."""
        ch, name = ev["ch"], ev["ev"]

        if ch == CH_LINK:
            if name == "server":
                return f"[*] PicoDock v{ev['version']}"
            if name == "waiting":
                text = (f"[*] waiting for the cartridge "
                        f"(VID {ev['vid']:04X}/PID {ev['pid']:04X}) - Ctrl-C to quit")
                # macOS device names carry no VID/PID, so a port we can see but
                # cannot identify is worth naming rather than silently ignoring.
                seen = ev.get("candidates")
                if seen:
                    text += "\n    unidentified serial ports are present:"
                    for c in seen:
                        text += f"\n      {c}"
                    text += "\n    if one of these is the cartridge, pass --port"
                return text
            if name == "several":
                text = ("[!] more than one PicoDock is plugged in - name the one"
                        "\n    this server should serve, with --serial:")
                for dev, sn, short in ev["devices"]:
                    text += (f"\n      {dev:<28} --serial {short}"
                             if short else f"\n      {dev:<28} (no serial)")
                text += ("\n    Each cartridge needs its own image and its own"
                         "\n    server; they do not share one.")
                return text
            if name == "ambiguous":
                text = "[!] cannot tell these PicoDocks apart:"
                for dev in ev["devices"]:
                    text += f"\n      {dev}"
                return text + f"\n    {ev['reason']}"
            if name == "connected":
                sn = ev.get("serial")
                return (f"[+] connected: {ev['port']}"
                        + (f"  (serial {sn})" if sn else ""))
            if name == "lost":
                return f"[!] link lost ({ev['error']}) - waiting for it to come back"
            if name == "closed":
                return "\n[*] closed"
            if name == "note":
                return f"[*] {ev['text']}"

        elif ch == CH_DISK:
            if name == "image":
                return (f"[*] {ev['path']}: {ev['size'] // 1024 // 1024}MB, "
                        f"{ev['blocks']} blocks x {ev['sector']}B"
                        + (" (read-only)" if ev.get("readonly") else ""))
            if name == "mounted_at_start":
                return (f"[!] {ev['path']} is mounted here - will wait until it is ejected"
                        + _where(ev))
            if name == "info":
                return (f"[+] INFO -> {ev['blocks']} blocks x {ev['sector']}B "
                        f"({ev['blocks'] * ev['sector'] // 1024 // 1024}MB)"
                        + (" [read-only]" if ev.get("readonly") else ""))
            if name == "paused":
                if ev.get("reason") == "disk_put":
                    return f"[!] {ev['path']}: disk_put.sh is borrowing it - serving PAUSED"
                return (f"[!] {ev['path']} is mounted here - serving PAUSED"
                        + _where(ev) + "\n"
                        "    eject it to resume; MSX disk access will fail until then")
            if name == "resumed":
                return ("[+] image handed back - serving resumed\n"
                        "    run PDSYNC on the MSX to pick up the changes")
            if name == "normalized":
                return f"    {ev['text']}"
            if name == "normalize_failed":
                return f"[!] could not normalise names: {ev['error']}"

        elif ch == CH_IO:
            if name == "stats":
                return f"[*] {ev['reads']} reads, {ev['writes']} writes"
            # Per-sector events are always emitted - a disk view wants them all -
            # but they only reach a plain terminal under --verbose, where they
            # were the only way to watch traffic.
            if name == "read":
                return f"    read  lba={ev['lba']} x{ev['count']}" if self.verbose else None
            if name == "write":
                return f"    write lba={ev['lba']} x{ev['count']}" if self.verbose else None
            if name == "read_error":
                return f"[!] read past end: lba={ev['lba']} count={ev['count']}"
            if name == "write_refused":
                return f"[!] write refused (read-only): lba={ev['lba']}"
            if name == "write_error":
                return (f"[!] bad write: lba={ev['lba']} count={ev['count']} "
                        f"len={ev['length']}")

        elif ch == CH_ASK:
            if name == "enabled":
                cut = f"cut at {ev['limit']}" if ev["limit"] else "uncut"
                return (f"[*] CALL PDASK: answered by {ev['mode']}, {cut}, "
                        f"{ev['charset']}")
            if name == "question":
                # The prompt itself, not just a log line: in a plain terminal
                # this is what tells the person at the keyboard that the MSX is
                # waiting for them to type something.
                text = f"\n[?] MSX asks: {ev['text']}"
                if ev.get("mode") == "manual":
                    text += ("\n    type the answer and press Enter"
                             "  (/g search it, /x refuse, /? keys)")
                return text
            if name == "msx":
                fields = ev.get("fields") or []
                text = "[*] the MSX says what it is:"
                for label, value in fields:
                    text += f"\n    {label:<14} {value}"
                return text
            if name == "searching":
                return f"[*] searching: {ev['text']}"
            if name == "answer":
                cut = " (cut)" if ev.get("truncated") else ""
                return (f"[+] answering from {ev['source']}: "
                        f"{ev['bytes']} bytes{cut}")
            if name == "delivered":
                return "[+] the MSX has it"
            if name == "error":
                return f"[-] no answer: {ev['text']}"
            if name == "cancelled":
                return f"[!] question dropped (by the {ev['by']})"
            if name == "timeout":
                return (f"[!] the MSX stopped reading after {ev['after']}s - "
                        "answer abandoned")
            if name == "mode":
                return f"[*] answers now come from: {ev['mode']}"
            if name == "note":
                return f"[*] {ev['text']}"

        elif ch == CH_PRINT:
            if name == "enabled":
                return (f"[*] printer: MSX print jobs -> {ev.get('out', 'output')}/ "
                        f"as {ev['mode']}")
            if name == "job_start":
                return f"[*] print job starting ({ev['mode']})"
            if name == "msg":
                # Relayed from msx_printer_render, which owns the saving and has
                # its own wording for each output mode.
                prefix = {"ok": "[+]", "error": "[-]"}.get(ev.get("level"), "[*]")
                return f"{prefix} {ev['text']}"

        # An event no view knows about is a bug in the emitter, but dropping it
        # is better than crashing the server over a log line.
        return None
