#!/usr/bin/env python3
"""pd_ask.py - answer the MSX's CALL PDASK("...") over the mailbox.

    10 CALL PDASK("give me a haiku about cassette tapes")

The MSX asks a question; this decides who answers it and sends the answer back
for the MSX to print. Two answerers ship, and the server switches between them
while it runs:

  manual   a person types the answer here (the default)
  google   a web search runs and the top results come back

Manual is the default on purpose. It needs no key, no network and no
permission from anyone, it is the one that always works, and it is the honest
description of what the MSX is really talking to: a person at a bigger
computer.

Where this sits
---------------
The cartridge mailbox (0x7F08-0x7F0B, see ../pd_protocol.md) is a raw byte
pipe: the MSX writes bytes, the host reads them, and neither end is told what
they mean. Frames 0x30/0x31 carry those bytes across USB multiplexed with the
disk. This module is the protocol *on top of* that pipe - the first consumer it
has had since the remote keyboard was retired (archive/README.md), so it owns
the mailbox alone and cannot be raced for bytes.

Nothing here touches the serial port. `pump()` is handed a `send` callable, so
this module works the same whether the bytes go to a cartridge, a test double,
or a socket - and the serial loop keeps its single-threaded ownership of the
port.

The wire protocol
-----------------
MSX -> host                       host -> MSX
  01 LO HI <query bytes>   ask      81 LEN <bytes>   one chunk of the answer
  03                       cancel   82               end of answer
  06                       ack      8F CODE          no answer, and why

The MSX acknowledges every chunk before the next one is sent. That is not
ceremony: the cartridge RX ring is 1KB and drops bytes when it fills
(sunrise_ide.c), and a BASIC PEEK loop drains it far slower than USB fills it.
Waiting for the ack makes the MSX's own reading speed the transfer speed, which
is exactly the property the mailbox already relies on everywhere else.

An unknown opcode is skipped rather than fatal, so a half-written request from
an MSX that was reset mid-transfer resyncs on the next one.

Standard library only, and no syntax past Python 3.9 - same constraint as the
rest of host/ (macOS ships 3.9; Raspberry Pi OS refuses pip outside a venv).

(c) 2026 - part of the msx-serial project
"""

import html as _html
import os
import re
import textwrap
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from pd_hub import emit, CH_ASK

# ---------------------------------------------------------------------------
# Wire protocol
# ---------------------------------------------------------------------------
OP_REQ = 0x01           # MSX -> host: LO HI then that many query bytes
OP_INFO = 0x02          # MSX -> host: LEN then that many bytes about the machine
OP_CANCEL = 0x03        # MSX -> host: forget it (Ctrl+STOP)
OP_ACK = 0x06           # MSX -> host: chunk consumed, send the next

OP_CHUNK = 0x81         # host -> MSX: LEN then that many answer bytes
OP_END = 0x82           # host -> MSX: that was all of it
OP_ERR = 0x8F           # host -> MSX: CODE, no answer coming

ERR_OFF = 1             # reserved: no mode sends it since the modes became
                        # manual/google. The ROM handler decodes it, so the
                        # number stays spoken for.
ERR_FAILED = 2          # the answerer failed (search error, refused, ...)
ERR_BUSY = 3            # an answer for an older question is still going out

#: Bytes per chunk. Below the 256B mailbox frame limit and well below the 1KB
#: RX ring, so one chunk can never overrun it even if an ack is late.
CHUNK = 128

#: Where every answer is cut. Not a setting: a search result runs for pages, a
#: 40-column screen shows a handful of lines of it, and every 128 bytes past
#: that is another round trip the MSX has to acknowledge.
LIMIT = 500

#: A question longer than this is a desync, not a question - drop and resync.
MAX_QUERY = 1024

#: How long to wait for the MSX to acknowledge a chunk before giving up on it.
#: Generous: the MSX may be a 3.58MHz Z80 printing to a 40-column screen.
ACK_TIMEOUT = 20.0


class RequestParser:
    """Byte-at-a-time reader for the MSX -> host direction.

    Yields ("ask", text), ("cancel",) or ("ack",). Bytes that are not a known
    opcode are dropped where they stand, which is what lets a stream that was
    cut mid-request pick up again at the next one.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self.state = "op"
        self.want = 0
        self.buf = bytearray()

    def feed(self, data):
        out = []
        for b in data:
            if self.state == "op":
                if b == OP_REQ:
                    self.state = "len_lo"
                elif b == OP_INFO:
                    self.state = "info_len"
                elif b == OP_CANCEL:
                    out.append(("cancel",))
                elif b == OP_ACK:
                    out.append(("ack",))
                # anything else: noise, skipped
            elif self.state == "info_len":
                self.want = b
                self.buf = bytearray()
                self.state = "info" if b else "op"
                if not b:
                    out.append(("info", b""))
            elif self.state == "info":
                self.buf.append(b)
                if len(self.buf) >= self.want:
                    out.append(("info", bytes(self.buf)))
                    self.state = "op"
            elif self.state == "len_lo":
                self.want = b
                self.state = "len_hi"
            elif self.state == "len_hi":
                self.want |= b << 8
                self.buf = bytearray()
                if self.want == 0:
                    out.append(("ask", ""))
                    self.state = "op"
                elif self.want > MAX_QUERY:
                    out.append(("garbled", self.want))
                    self.state = "op"
                else:
                    self.state = "body"
            elif self.state == "body":
                self.buf.append(b)
                if len(self.buf) >= self.want:
                    out.append(("ask", self.buf.decode("ascii", "replace")))
                    self.state = "op"
        return out


def build_chunk(payload):
    return bytes([OP_CHUNK, len(payload)]) + bytes(payload)


def build_end():
    return bytes([OP_END])


def build_error(code):
    return bytes([OP_ERR, code])


# ---------------------------------------------------------------------------
# Shaping the answer for a 1983 screen
# ---------------------------------------------------------------------------
#: Punctuation the web is full of and an MSX has no glyph for. Mapped by hand
#: rather than left to NFKD, which turns a curly quote into nothing at all.
_ASCII_FIXUPS = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "−": "-", " ": " ",
    "…": "...", "•": "*", "·": "*", "«": '"',
    "»": '"', "‹": "'", "›": "'", "­": "",
}

CHARSETS = ("ascii", "cp949", "raw")


def to_ascii(text):
    """Best-effort ASCII. Accented Latin loses its accents (NFKD), everything
    else that has no ASCII spelling becomes '?', which is visible - silently
    dropping it would make a wrong answer look like a complete one."""
    for src, dst in _ASCII_FIXUPS.items():
        text = text.replace(src, dst)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    # Put back together what decomposing took apart. Latin lost its accents
    # above and stays as it is; Hangul came apart into jamo, which are not
    # combining marks and so survived - three of them per syllable, which would
    # arrive on the MSX as "???" where one "?" is the honest count.
    text = unicodedata.normalize("NFC", text)
    return text.encode("ascii", "replace").decode("ascii")


def truncate(text, limit):
    """Cut to `limit` characters, marking that it was cut. 0 means no limit.

    Length is the point of this: a search result runs for pages, and pages of
    it scroll off a 24-line screen faster than anyone can read - and every
    character is also a chunk-and-ack round trip over the mailbox.
    """
    if not limit or len(text) <= limit:
        return text, False
    cut = text[:limit].rstrip()
    return cut + "...", True


def wrap(text, width):
    """Fold long lines at `width`, on word boundaries. 0 leaves them alone.

    The MSX wraps at the screen edge by itself, but mid-word: this is what
    makes the result readable rather than merely fitting.
    """
    if not width:
        return text
    out = []
    for line in text.split("\n"):
        if not line.strip():
            out.append("")
            continue
        out.extend(textwrap.wrap(line, width=width,
                                 break_long_words=True,
                                 break_on_hyphens=False) or [""])
    return "\n".join(out)


def encode(text, charset):
    """Text -> the bytes the MSX will print. Line ends become CR LF, which is
    what CHPUT wants; stray control characters are dropped so a stray 0x1B out
    of a web page cannot put the MSX screen into an escape sequence."""
    if charset == "ascii":
        text = to_ascii(text)
        data = text.encode("ascii", "replace")
    elif charset == "cp949":
        data = text.encode("cp949", "replace")
    else:                                   # raw: whatever the source was
        data = text.encode("utf-8", "replace")
    data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    keep = bytearray()
    for b in data:
        if b == 0x0A:
            keep += b"\r\n"
        elif b == 0x09:
            keep += b" "
        elif b >= 0x20 or b == 0x00:
            if b:                           # NUL is reserved on this pipe
                keep.append(b)
    return bytes(keep)


def shape(text, limit=500, width=40, charset="ascii"):
    """The whole pipeline: cut, fold, encode. Returns (bytes, truncated)."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text, cut = truncate(text, limit)
    return encode(wrap(text, width), charset), cut


# ---------------------------------------------------------------------------
# What the MSX is (PDINFO.COM)
# ---------------------------------------------------------------------------
# The record arrives as the bytes the MSX read, in the order it read them, and
# all of the naming happens here. That is deliberate: a .COM that had to spell
# "MSX2+" would carry a table of strings, and improving the wording would mean
# rebuilding the disk. This way it is a line of Python.
#
#   [0] 002Dh generation   [3] BDOS 6Fh kernel major   [7..8] top of the TPA
#   [1] 002Bh region       [4]           kernel minor  [9]    cartridge slot
#   [2] 002Ch keyboard     [5..6]        MSXDOS2.SYS / Nextor version
GENERATION = {0: "MSX1", 1: "MSX2", 2: "MSX2+", 3: "MSX turbo R"}
CHARSET = {0: "Japanese", 1: "International", 2: "Korean"}
KEYBOARD = {0: "Japanese", 1: "International", 2: "French", 3: "UK",
            4: "German", 5: "Spanish"}


def _slot_name(b):
    """The slot byte as an MSX would write it: 3-1 for expanded, 2 for not."""
    prim = b & 3
    return "%d-%d" % (prim, (b >> 2) & 3) if b & 0x80 else "%d" % prim


def describe_msx(rec):
    """The record -> [(label, value), ...], skipping what it did not carry.

    Short records are fine: a future PDINFO can send more without this needing
    to know, and an older one keeps working.
    """
    out = []
    if len(rec) > 0:
        out.append(("machine", GENERATION.get(rec[0], "unknown (0x%02X)" % rec[0])))
    if len(rec) > 1:
        out.append(("region", "%s   %dHz"
                    % (CHARSET.get(rec[1] & 0x0F, "charset %d" % (rec[1] & 0x0F)),
                       50 if rec[1] & 0x80 else 60)))
    if len(rec) > 2:
        out.append(("keyboard", "%s   BASIC %s"
                    % (KEYBOARD.get(rec[2] & 0x0F, "type %d" % (rec[2] & 0x0F)),
                       "Japanese" if (rec[2] >> 4) == 0 else "International")))
    if len(rec) > 4:
        dos = "%d.%d" % (rec[3], rec[4]) if rec[3] else "1.x (no version call)"
        if len(rec) > 6 and rec[5]:
            dos += "   system %d.%d" % (rec[5], rec[6])
        out.append(("MSX-DOS", dos))
    if len(rec) > 8:
        tpa = rec[7] | (rec[8] << 8)
        out.append(("TPA", "%d KB free (BDOS at %04Xh)" % (tpa // 1024, tpa)))
    if len(rec) > 9:
        out.append(("cartridge in", "slot %s" % _slot_name(rec[9])))
    return out


# ---------------------------------------------------------------------------
# Searching
# ---------------------------------------------------------------------------
class SearchError(Exception):
    pass


_CHROME_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

ENGINES = ("auto", "google", "ddg")


def _get(url, timeout=15.0, ua=_CHROME_UA, lang="en"):
    req = urllib.request.Request(url, headers={
        "User-Agent": ua,
        "Accept-Language": "%s-US,%s;q=0.9" % (lang, lang) if lang == "en"
                           else "%s,%s;q=0.9,en;q=0.8" % (lang, lang),
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise SearchError("HTTP %s from %s" % (e.code, urllib.parse.urlsplit(url).netloc))
    except Exception as e:                  # URLError, socket.timeout, ssl, ...
        raise SearchError("%s: %s" % (e.__class__.__name__, e))


def _text(fragment):
    """Tag soup -> one line of readable text."""
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return re.sub(r"\s+", " ", _html.unescape(fragment)).strip()


def _google_scrape(query, lang, count, timeout):
    """google.com/search, read as HTML.

    Google now answers this with a JavaScript wall for current browsers and
    "update your browser" for old ones - measured 2026-08-02: zero results
    either way, from a residential connection, no captcha involved. The parser
    below is the one that works when a page with results does come back (some
    regions and some UAs still serve the light HTML), and the wall is detected
    and reported rather than silently returning nothing.
    """
    url = ("https://www.google.com/search?q=%s&num=%d&hl=%s"
           % (urllib.parse.quote_plus(query), max(count, 5), lang))
    page = _get(url, timeout=timeout, lang=lang)

    titles = re.findall(
        r'<(?:h3|div|span)[^>]*class="[^"]*(?:BNeawe vvjwJb|DKV0Md|LC20lb)[^"]*"[^>]*>(.*?)'
        r'</(?:h3|div|span)>', page, re.S)
    snippets = re.findall(
        r'<(?:div|span)[^>]*class="[^"]*(?:BNeawe s3v9rd|VwiC3b|lyLwlc)[^"]*"[^>]*>(.*?)'
        r'</(?:div|span)>', page, re.S)
    out = []
    for i, t in enumerate(titles):
        title = _text(t)
        if not title:
            continue
        snip = _text(snippets[i]) if i < len(snippets) else ""
        out.append((title, snip))
        if len(out) >= count:
            break
    if out:
        return out

    if "enablejs" in page or "/httpservice/retry" in page:
        raise SearchError("google served its JavaScript wall (no results in the HTML)")
    if "isn't supported any more" in page or "not supported any more" in page:
        raise SearchError("google refused the request as an unsupported browser")
    if "unusual traffic" in page or "/sorry/" in page:
        raise SearchError("google is showing a captcha for this address")
    raise SearchError("google returned a page with no results in it")


def _ddg(query, lang, count, timeout):
    """DuckDuckGo's no-JavaScript endpoint - the one that answers a plain HTTP
    GET with actual results, which is why it is here as the fallback."""
    url = "https://html.duckduckgo.com/html/?q=%s" % urllib.parse.quote_plus(query)
    page = _get(url, timeout=timeout, lang=lang)
    titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', page, re.S)
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', page, re.S)
    out = []
    for i, t in enumerate(titles[:count]):
        title = _text(t)
        if not title:
            continue
        out.append((title, _text(snippets[i]) if i < len(snippets) else ""))
    if not out:
        if "anomaly" in page or "captcha" in page.lower():
            raise SearchError("duckduckgo is asking for a captcha")
        raise SearchError("no results")
    return out


def format_results(results):
    """Search hits -> what the MSX prints. Numbered, title then snippet, which
    survives being cut off mid-way better than one long paragraph."""
    out = []
    for i, (title, snippet) in enumerate(results, 1):
        out.append("%d. %s" % (i, title))
        if snippet:
            out.append("   " + snippet)
    return "\n".join(out)


def search(query, engine="auto", lang="en", count=5, timeout=15.0):
    """Run a search. Returns (text, engine_used, notes).

    `auto` tries google.com and falls back to DuckDuckGo. Each failure is kept
    in `notes`, so when the answer comes from the second one the reason is
    visible rather than mysterious.

    No API keys anywhere. Both of these are the ordinary search page that a
    browser would get, which is the whole point: someone who has just plugged in
    a cartridge should get an answer, not a sign-up form.
    """
    if engine != "auto":
        fn = {"google": _google_scrape, "ddg": _ddg}[engine]
        return format_results(fn(query, lang, count, timeout)), engine, []

    notes = []
    for name, fn in (("google", _google_scrape), ("ddg", _ddg)):
        try:
            return format_results(fn(query, lang, count, timeout)), name, notes
        except SearchError as e:
            notes.append("%s: %s" % (name, e))
    raise SearchError("; ".join(notes))


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------
class AskService:
    """One question at a time, from the MSX to whoever is answering.

    States: idle -> asking (waiting for an answer) -> sending (chunk/ack) -> idle

    Threads: `feed` and `pump` are called from the serial loop and are the only
    things that touch the wire. A google search runs on its own thread and hands
    its result back through a small inbox, because the serial loop must keep
    answering sector reads while somebody's web request is in flight - a disk
    that stalls for 15 seconds is a disk the MSX gives up on.
    """

    #: google first because it is the default: a question from the MSX gets an
    #: answer without anyone being at the computer, which is the arrangement
    #: that survives leaving the machine on. Order matters - cycling with the
    #: arrow keys walks this list.
    MODES = ("google", "manual")

    def __init__(self, mode="google", limit=LIMIT, width=40, charset="ascii",
                 engine="auto", lang="en", results=5, chunk=CHUNK,
                 ack_timeout=ACK_TIMEOUT, searcher=None):
        self.mode = mode if mode in self.MODES else "google"
        self.limit = limit
        self.width = width
        self.charset = charset if charset in CHARSETS else "ascii"
        self.engine = engine
        self.lang = lang
        self.results = results
        self.chunk = chunk
        self.ack_timeout = ack_timeout
        self._search = searcher or search      # injectable for tests

        self.parser = RequestParser()
        self.state = "idle"
        self.question = None
        self.answer = None                     # what was sent, for the view
        self.asked_at = 0.0
        self.msx = []                          # last PDINFO report, decoded
        self.msx_at = 0.0

        # What is still to go out, one complete mailbox payload per entry: a
        # run of chunks and then the end marker, or a single error. Whole
        # payloads rather than a byte stream, because only chunks are acked -
        # wrapping the queue in a chunk header at send time (which is what an
        # earlier version did) put the error opcode *inside* a chunk, where the
        # MSX would have printed it as text.
        self._queue = []
        self._await_ack = False
        self._deadline = 0.0
        self._inbox = []                       # (kind, payload) from threads
        self._lock = threading.Lock()
        self._serial = 0                       # question id, so a late search
                                               # result cannot answer a newer one

    # -- state a view wants to show ---------------------------------------
    @property
    def waiting(self):
        """Is a question sitting here with nobody having answered it yet?"""
        return self.state == "asking"

    def status(self):
        return {"mode": self.mode, "state": self.state, "question": self.question,
                "limit": self.limit, "width": self.width, "charset": self.charset,
                "engine": self.engine}

    # -- from the MSX -----------------------------------------------------
    def feed(self, payload):
        """Mailbox bytes from the cartridge (frame 0x30)."""
        for item in self.parser.feed(payload):
            kind = item[0]
            if kind == "ask":
                self._begin(item[1])
            elif kind == "cancel":
                if self.state != "idle":
                    emit(CH_ASK, "cancelled", by="msx")
                self._idle()
            elif kind == "ack":
                self._await_ack = False
            elif kind == "info":
                self.msx = describe_msx(item[1])
                self.msx_at = time.time()
                emit(CH_ASK, "msx", fields=self.msx, raw=item[1].hex())
            elif kind == "garbled":
                emit(CH_ASK, "note",
                     text="ignored a %d-byte request - the pipe was out of step"
                          % item[1])

    def _begin(self, query):
        query = query.strip()
        self._serial += 1
        self.question = query
        self.answer = None
        self.asked_at = time.time()
        self._queue = []
        self._await_ack = False
        self.state = "asking"
        emit(CH_ASK, "question", text=query, mode=self.mode)

        if not query:
            self.fail("empty question")
        elif self.mode == "google":
            self._dispatch_search()

    def _dispatch_search(self):
        serial, query = self._serial, self.question
        emit(CH_ASK, "searching", text=query, engine=self.engine)

        def run():
            try:
                text, used, notes = self._search(query, engine=self.engine,
                                                 lang=self.lang, count=self.results)
                self._post(serial, "answer", (text, used, notes))
            except SearchError as e:
                self._post(serial, "error", str(e))
            except Exception as e:               # a parser bug must not be fatal
                self._post(serial, "error", "%s: %s" % (e.__class__.__name__, e))

        threading.Thread(target=run, name="pd-ask-search", daemon=True).start()

    def _post(self, serial, kind, payload):
        with self._lock:
            self._inbox.append((serial, kind, payload))

    # -- from whoever is answering ----------------------------------------
    def submit(self, text, source="manual"):
        """Hand in an answer. Safe from any thread."""
        self._post(self._serial, "answer", (text, source, []))

    def fail(self, reason, code=ERR_FAILED):
        self._post(self._serial, "error", reason if code == ERR_FAILED
                   else (reason, code))

    def cancel(self, by="host"):
        """Give up on the question in hand and tell the MSX so."""
        if self.state == "idle":
            return
        emit(CH_ASK, "cancelled", by=by)
        self._queue = [build_error(ERR_FAILED)]
        self._await_ack = False
        self.state = "sending"
        self.question = None

    def link_reset(self):
        """The cartridge came or went. Whatever was half-sent went with it, and
        the next question will arrive from a freshly booted MSX."""
        self.parser.reset()
        if self.state == "sending":
            emit(CH_ASK, "note", text="the link dropped mid-answer - abandoned it")
        self._idle()

    def set_mode(self, mode):
        """Switch answerer, including while a question is waiting - which is
        the point: read the question, decide it is a search after all, press g."""
        if mode not in self.MODES or mode == self.mode:
            return self.mode
        self.mode = mode
        emit(CH_ASK, "mode", mode=mode)
        if self.state == "asking" and self.question and mode == "google":
            self._dispatch_search()
        return self.mode

    def next_mode(self):
        return self.set_mode(self.MODES[(self.MODES.index(self.mode) + 1)
                                        % len(self.MODES)])

    # -- the wire ---------------------------------------------------------
    def pump(self, send):
        """Called every pass of the serial loop. `send(bytes)` puts a mailbox
        payload on the wire. Never blocks."""
        self._drain_inbox()

        if self.state != "sending":
            return
        if self._await_ack:
            if time.time() > self._deadline:
                emit(CH_ASK, "timeout", after=self.ack_timeout)
                self._idle()
            return
        if not self._queue:
            self._idle()
            return

        payload = self._queue.pop(0)
        send(payload)
        if payload[0] == OP_CHUNK:
            self._await_ack = True
            self._deadline = time.time() + self.ack_timeout
            return
        if payload[0] == OP_END:
            emit(CH_ASK, "delivered", chars=len(self.answer or ""))
        self._idle()                            # END and ERR both finish it

    def _drain_inbox(self):
        with self._lock:
            items, self._inbox = self._inbox, []
        for serial, kind, payload in items:
            if serial != self._serial or self.state != "asking":
                continue                        # answer to a question long gone
            if kind == "answer":
                self._start_answer(*payload)
            else:
                code = ERR_FAILED
                text = payload
                if isinstance(payload, tuple):
                    text, code = payload
                emit(CH_ASK, "error", text=text)
                self._queue = [build_error(code)]
                self.state = "sending"

    def _start_answer(self, text, source, notes):
        for note in notes or []:
            emit(CH_ASK, "note", text=note)
        data, cut = shape(text, limit=self.limit, width=self.width,
                          charset=self.charset)
        if not data:
            emit(CH_ASK, "error", text="the answer was empty")
            self._queue = [build_error(ERR_FAILED)]
            self.state = "sending"
            return
        self.answer = text
        emit(CH_ASK, "answer", text=text, source=source, bytes=len(data),
             truncated=cut, took=round(time.time() - self.asked_at, 1))
        self._queue = [build_chunk(data[i:i + self.chunk])
                       for i in range(0, len(data), self.chunk)] + [build_end()]
        self.state = "sending"

    def _idle(self):
        self.state = "idle"
        self.question = None
        self._queue = []
        self._await_ack = False


# ---------------------------------------------------------------------------
# Trying it without an MSX
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    from pd_hub import HUB, TextView

    HUB.subscribe(TextView())
    q = " ".join(sys.argv[1:]) or "msx computer"
    try:
        text, used, notes = search(q, engine=os.environ.get("PD_ASK_ENGINE", "auto"))
    except SearchError as e:
        sys.exit("[-] %s" % e)
    for n in notes:
        print("[*] %s" % n)
    data, cut = shape(text, limit=int(os.environ.get("PD_ASK_LIMIT", "500")))
    print("[+] %s: %d bytes%s\n" % (used, len(data), " (cut)" if cut else ""))
    print(data.decode("ascii", "replace").replace("\r\n", "\n"))
