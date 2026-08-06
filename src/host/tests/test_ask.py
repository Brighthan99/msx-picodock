#!/usr/bin/env python3
"""CALL PDASK: the protocol, the shaping, and a whole question answered by hand.

The end-to-end half is the one that matters. Everything in between the MSX and
the person typing - frame, mailbox opcode, chunk, ack - is a place where a byte
can go missing, and the only test that covers all of them at once is to be the
cartridge: write a question into the server's serial port and read the answer
back out of it.

The search engines are not called. A test that depends on google.com answering
fails for reasons that have nothing to do with this code; `AskService` takes its
searcher as an argument for exactly that reason, and the parsers are checked
against saved HTML instead.
"""

import os
import select
import sys
import time

import pdtest
from pdtest import Checks, server

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pd_ask

TMP = os.environ.get("TMPDIR", "/tmp")
IMAGE = pdtest.scratch_image(os.path.join(TMP, "pdtest-ask.img"))

SOF, MB_TO_HOST, MB_TO_MSX = 0x5A, 0x30, 0x31

c = Checks("CALL PDASK: mailbox protocol and answering")


def frame(cmd, payload=b""):
    body = bytes([cmd, len(payload) & 0xFF, (len(payload) >> 8) & 0xFF]) + payload
    chk = 0
    for b in body:
        chk ^= b
    return bytes([SOF]) + body + bytes([chk])


def ask_frame(text):
    q = text.encode("ascii")
    return frame(MB_TO_HOST,
                 bytes([pd_ask.OP_REQ, len(q) & 0xFF, len(q) >> 8]) + q)


def read_mailbox(fd, seconds=3.0):
    """Every mailbox payload the server sends, until it goes quiet."""
    buf, out, end = bytearray(), [], time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            buf += os.read(fd, 65536)
        while len(buf) >= 5:
            if buf[0] != SOF:
                del buf[0]
                continue
            length = buf[2] | (buf[3] << 8)
            if len(buf) < 5 + length:
                break
            if buf[1] == MB_TO_MSX:
                out.append(bytes(buf[4:4 + length]))
            del buf[:5 + length]
    return out


# ---------------------------------------------------------------------------
# The parser
# ---------------------------------------------------------------------------
p = pd_ask.RequestParser()
c("reads a question", p.feed(bytes([0x01, 3, 0]) + b"hi!") == [("ask", "hi!")])
c("reads cancel and ack",
  p.feed(bytes([pd_ask.OP_CANCEL, pd_ask.OP_ACK])) == [("cancel",), ("ack",)])

# A question split across two mailbox frames is the normal case - 256B frames,
# and the MSX writes a byte at a time.
p = pd_ask.RequestParser()
c("survives being split", p.feed(bytes([0x01, 5, 0]) + b"ab") == []
  and p.feed(b"cde") == [("ask", "abcde")])

# An MSX reset mid-request leaves half a request on the wire. The next one has
# to work anyway, which is what skipping unknown opcodes buys.
p = pd_ask.RequestParser()
p.feed(bytes([0x01, 200, 0]) + b"only some of it")
p.reset()
c("resyncs after a reset", p.feed(bytes([0x01, 2, 0]) + b"ok") == [("ask", "ok")])

p = pd_ask.RequestParser()
c("refuses an absurd length",
  p.feed(bytes([0x01, 0xFF, 0xFF])) == [("garbled", 0xFFFF)])

# PDINFO's one-way report, on the same pipe as the questions
p = pd_ask.RequestParser()
c("reads an info record",
  p.feed(bytes([0x02, 3, 0x02, 0x81, 0x11])) == [("info", b"\x02\x81\x11")])
c("...and the next question still parses",
  p.feed(bytes([0x01, 2, 0]) + b"hi") == [("ask", "hi")])


# ---------------------------------------------------------------------------
# What the MSX said it is
# ---------------------------------------------------------------------------
REC = bytes([2, 0x80 | 1, 0x11, 2, 31, 2, 45, 0x00, 0xC0, 0x82])
d = dict(pd_ask.describe_msx(REC))
c("generation", d["machine"] == "MSX2+", d)
c("region and refresh rate", d["region"] == "International   50Hz", d)
c("keyboard", d["keyboard"].startswith("International"), d)
c("MSX-DOS version", d["MSX-DOS"].startswith("2.31"), d)
c("TPA", d["TPA"].startswith("49 KB") or d["TPA"].startswith("48 KB"), d)
c("expanded slot reads as n-n", d["cartridge in"] == "slot 2-0", d)

d = dict(pd_ask.describe_msx(bytes([0, 0x00, 0x00])))
c("a short record says only what it carried",
  d["machine"] == "MSX1" and "TPA" not in d, d)
c("60Hz when the bit is clear", d["region"].endswith("60Hz"), d)

d = dict(pd_ask.describe_msx(bytes([3, 0, 0, 0, 0, 0, 0, 0, 0, 0x03])))
c("turbo R", d["machine"] == "MSX turbo R", d)
c("no version call -> said so", d["MSX-DOS"].startswith("1.x"), d)
c("plain slot has no dash", d["cartridge in"] == "slot 3", d)


# ---------------------------------------------------------------------------
# Shaping: the part the --ask-limit option is for
# ---------------------------------------------------------------------------
data, cut = pd_ask.shape("x" * 900, limit=500, width=0)
c("cuts at the limit", len(data) == 503 and cut, len(data))
c("says so with an ellipsis", data.endswith(b"..."))

data, cut = pd_ask.shape("short", limit=500, width=0)
c("leaves short answers alone", data == b"short" and not cut)

data, _ = pd_ask.shape("x" * 900, limit=0, width=0)
c("0 means no limit", len(data) == 900, len(data))

data, _ = pd_ask.shape("the quick brown fox jumps over the lazy dog", limit=0, width=20)
c("folds on word boundaries",
  all(len(l) <= 20 for l in data.split(b"\r\n")) and b"quic\r\nk" not in data, data)

c("line ends are CR LF", pd_ask.shape("a\nb", width=0)[0] == b"a\r\nb")

data, _ = pd_ask.shape("café naïve “quoted” — dash …", width=0)
c("ascii: accents stripped, punctuation replaced",
  data == b'cafe naive "quoted" - dash ...', data)

data, _ = pd_ask.shape("한글", charset="ascii", width=0)
c("ascii: what has no spelling becomes ?", data == b"??", data)
data, _ = pd_ask.shape("한글", charset="cp949", width=0)
c("cp949: Korean goes out as cp949", data == "한글".encode("cp949"), data)
data, _ = pd_ask.shape("한글", charset="raw", width=0)
c("raw: bytes untouched", data == "한글".encode("utf-8"), data)

# An escape sequence out of a web page would put the MSX screen into a mode
# nobody asked for, and there is no way back from BASIC.
data, _ = pd_ask.shape("a\x1b[2Jb\x00c", width=0)
c("control characters are dropped", data == b"a[2Jbc", data)


# ---------------------------------------------------------------------------
# The service, without a serial port
# ---------------------------------------------------------------------------
def drive(svc, seconds=3.0):
    """Be the MSX: take each chunk, ack it, until the exchange ends. Returns
    every payload the service sent."""
    out, end = [], time.time() + seconds
    while time.time() < end:
        before = len(out)
        svc.pump(out.append)
        if len(out) > before and out[-1][0] == pd_ask.OP_CHUNK:
            svc.feed(bytes([pd_ask.OP_ACK]))
            continue
        if svc.state == "idle":
            break
        time.sleep(0.01)                 # an answerer on another thread
    return out


svc = pd_ask.AskService(mode="manual", limit=500, width=0)
svc.feed(ask_frame("q")[4:-1])
c("a question puts it in 'asking'", svc.waiting and svc.question == "q")
svc.submit("answer")
out = drive(svc)
c("the answer goes out as chunk then end",
  out[0] == bytes([pd_ask.OP_CHUNK, 6]) + b"answer" and out[-1] == b"\x82", out)
c("and it is idle again", svc.state == "idle")

# One chunk at a time: the cartridge RX ring is 1KB and drops what overruns it.
svc = pd_ask.AskService(mode="manual", limit=0, width=0, chunk=8)
svc.feed(ask_frame("q")[4:-1])
svc.submit("x" * 40)
sent = []
svc.pump(sent.append)
svc.pump(sent.append)
c("waits for the ack before the next chunk", len(sent) == 1, sent)
svc.feed(bytes([pd_ask.OP_ACK]))
svc.pump(sent.append)
c("...and sends it once acked", len(sent) == 2, sent)

# The MSX stopped reading (Ctrl+STOP, reset, crash). The server must not sit
# holding a half-sent answer for ever.
svc = pd_ask.AskService(mode="manual", width=0, chunk=8, ack_timeout=0.05)
svc.feed(ask_frame("q")[4:-1])
svc.submit("x" * 40)
svc.pump(lambda b: None)
time.sleep(0.1)
svc.pump(lambda b: None)
c("gives up when the acks stop", svc.state == "idle")

# Refusing has to be an answer of its own: silence would leave the MSX waiting
# for something that is never coming.
svc = pd_ask.AskService(mode="manual")
svc.feed(ask_frame("q")[4:-1])
svc.cancel()
out = drive(svc)
c("refusing sends an error, not silence",
  out and out[0] == bytes([pd_ask.OP_ERR, pd_ask.ERR_FAILED]), out)

c("two answerers, both of them real", set(pd_ask.AskService.MODES) == {"manual", "google"})
c("google answers by default - the MSX gets a reply with nobody at the computer",
  pd_ask.AskService.MODES[0] == "google" and pd_ask.AskService().mode == "google")
c("every answer is cut at 500", pd_ask.LIMIT == 500
  and pd_ask.AskService().limit == 500)

# Switching to google while a question is in hand must run *that* question,
# which is the whole point of being able to switch while it waits.
seen = []


def fake_search(query, engine="auto", lang="en", count=5, timeout=15.0):
    seen.append(query)
    return "1. Title\n   snippet", "ddg", ["google: blocked"]


svc = pd_ask.AskService(mode="manual", width=0, searcher=fake_search)
svc.feed(ask_frame("what is an msx")[4:-1])
svc.set_mode("google")
out = drive(svc)                         # the search runs on its own thread
c("switching to google answers the waiting question", seen == ["what is an msx"], seen)
c("...and the result reaches the wire",
  b"".join(o[2:] for o in out if o[0] == pd_ask.OP_CHUNK).startswith(b"1. Title"), out)

svc = pd_ask.AskService(mode="manual")
svc.feed(ask_frame("q")[4:-1])
svc.feed(bytes([pd_ask.OP_CANCEL]))
c("Ctrl+STOP on the MSX drops the question", svc.state == "idle")

# The report is kept, not consumed: the Status pane draws it whenever it likes.
svc = pd_ask.AskService()
svc.feed(bytes([pd_ask.OP_INFO, len(REC)]) + REC)
c("the service keeps what PDINFO said",
  dict(svc.msx)["machine"] == "MSX2+" and svc.msx_at > 0, svc.msx)
svc.feed(ask_frame("still works")[4:-1])
c("...and a question after it is unaffected", svc.question == "still works")


# ---------------------------------------------------------------------------
# Search result parsing, against saved HTML rather than the live web
# ---------------------------------------------------------------------------
DDG = ('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=x">'
       'MSX - Wikipedia</a>'
       '<a class="result__snippet" href="x"><b>MSX</b> is a standardized home '
       'computer architecture.</a>')
# _ddg fetches; the parsing half is what is worth testing, so drive it through
# the same regexes with the fetch replaced.
pd_ask._get = lambda url, timeout=15.0, ua=None, lang="en": DDG
res = pd_ask._ddg("msx", "en", 5, 5.0)
c("duckduckgo: title and snippet",
  res == [("MSX - Wikipedia", "MSX is a standardized home computer architecture.")], res)

pd_ask._get = lambda *a, **k: '<div>nothing here</div><script>enablejs</script>'
try:
    pd_ask._google_scrape("msx", "en", 5, 5.0)
    c("google's javascript wall is reported", False, "no error raised")
except pd_ask.SearchError as e:
    c("google's javascript wall is reported", "JavaScript wall" in str(e), e)

pd_ask._get = lambda *a, **k: (
    '<h3 class="LC20lb">MSX - Wikipedia</h3>'
    '<div class="VwiC3b">A standardized home computer architecture.</div>')
res = pd_ask._google_scrape("msx", "en", 5, 5.0)
c("google: results are read when a page has them",
  res == [("MSX - Wikipedia", "A standardized home computer architecture.")], res)

c("results are numbered for a small screen",
  pd_ask.format_results([("T", "S")]) == "1. T\n   S")


# ---------------------------------------------------------------------------
# The whole way through a running server
# ---------------------------------------------------------------------------
with server(IMAGE, "--print", "off", "--ask", "manual") as s:
    s.pump(1.5)
    c("the server says who answers", s.seen("CALL PDASK", "manual"), repr(s.screen[-300:]))

    os.write(s._link, ask_frame("give me a haiku"))
    s.pump(1.0)
    c("the question reaches the terminal",
      s.seen("MSX asks:", "give me a haiku"), repr(s.screen[-300:]))

    s.send(b"tape hiss in the dark\n", wait=0.5)
    payloads = read_mailbox(s._link, 2.0)
    text = b"".join(p[2:] for p in payloads if p and p[0] == pd_ask.OP_CHUNK)
    c("what was typed reaches the MSX", text == b"tape hiss in the dark", payloads)
    c("...and nothing more until it is acked", len(payloads) == 1, payloads)

    os.write(s._link, frame(MB_TO_HOST, bytes([pd_ask.OP_ACK])))
    payloads = read_mailbox(s._link, 2.0)
    c("the end marker follows the ack",
      payloads and payloads[0] == bytes([pd_ask.OP_END]), payloads)

    # /x refuses the question in hand, and the MSX is told rather than left
    # waiting for an answer that is not coming.
    s.clear()
    os.write(s._link, ask_frame("anything"))
    s.pump(1.0)
    s.send(b"/x\n", wait=0.5)
    payloads = read_mailbox(s._link, 2.0)
    c("/x refuses, and the MSX is told",
      payloads and payloads[0] == bytes([pd_ask.OP_ERR, pd_ask.ERR_FAILED]), payloads)

# ...and through the TUI, which is where manual answering actually happens.
# --ask manual is explicit here for that reason: google is the default now, and
# what these check is the typing path.
with server(IMAGE, "--tui", "--print", "off", "--ask", "manual") as s:
    s.pump(2.0)
    s.clear(); s.send(b"3")
    c("the Ask pane draws", s.seen("Answer Option", "By [manual]", "CALL PDASK"),
      repr(s.screen[-400:]))

    os.write(s._link, ask_frame("what is an msx"))
    s.pump(1.0)
    c("the question is shown there", s.seen("the MSX is waiting", "what is an msx"),
      repr(s.screen[-400:]))
    c("...and the status bar says so from another pane",
      "ANSWER ME" not in s.screen, "shown while the Ask pane is up")

    # Enter lands on a section title, Down moves on to the next one, and typing
    # there falls straight into the field - which is the whole reason the title
    # level costs nothing: no key that used to work has to be pressed twice.
    s.send(b"\r", wait=0.4)            # Enter: into the pane - Answer Option
    s.send(b"\x1bOB", wait=0.4)        # Down: on to Answer
    s.send(b"a home computer\r", wait=0.8)
    payloads = read_mailbox(s._link, 2.0)
    text = b"".join(p[2:] for p in payloads if p and p[0] == pd_ask.OP_CHUNK)
    c("typing in the pane answers the MSX", text == b"a home computer", payloads)

    # Round to the Answer Option title, Right onto the By field, Enter for its
    # values - the same shape, and the same keys, as the Printer's settings.
    s.clear(); s.send(b"\x1b", wait=0.4) # Esc: out of the answer, to its title
    s.send(b"\x1bOA", wait=0.4)          # Up: back to Answer Option
    s.send(b"\r", wait=0.4)              # Enter: onto By (Right does not enter)
    s.send(b"\r", wait=0.5)              # Enter again: the values
    c("Enter on By lists every answerer and no more",
      s.seen("manual", "google") and "off" not in s.screen.split("google")[-1][:40],
      repr(s.screen[-400:]))
    s.clear(); s.send(b"\x1bOB", wait=0.4); s.send(b"\r", wait=0.5)
    # curses only rewrites the cells that changed, so what lands on the pty
    # after a clear() is the delta - the log line, whole, is the reliable half.
    c("...and Enter takes the one under the cursor",
      s.seen("answers come from: google"), repr(s.screen[-300:]))
    s.clear(); s.send(b"m", wait=0.5)
    c("m still jumps straight back", s.seen("come from manual"),
      repr(s.screen[-300:]))
    # Left off the single field is the way back to the title, not a wrap round.
    s.clear(); s.send(b"\x1bOD", wait=0.5)
    c("Left leaves the field instead of picking something",
      not s.seen("come from google"), repr(s.screen[-300:]))

    # ...and back to typing. Every printable key belongs to the answer there,
    # so a digit must not switch view.
    s.clear(); s.send(b"\x1bOB", wait=0.4)   # Down: Answer Option -> Answer
    s.send(b"2", wait=0.5)
    c("a digit typed into the answer stays in the answer",
      not s.seen("printer mode"), repr(s.screen[-300:]))

# The answerer row is pinned above the log. It used to be the first line of the
# body, so a log long enough to fill the pane pushed it off the top - which is
# the moment somebody looks for it. Small screen, so a few questions overflow.
with server(IMAGE, "--tui", "--print", "off", "--ask", "manual", rows=14) as s:
    s.pump(1.5)
    s.send(b"3", wait=0.4)
    for i in range(6):
        os.write(s._link, ask_frame("question number %d" % i))
        s.pump(0.4)
    s.clear(); s.send(b"\x01l", wait=0.8)          # Ctrl-A l: full repaint
    c("the answerer row survives a full pane",
      s.seen("Answer Option", "By [manual]"), repr(s.screen[-400:]))
    c("...and the newest question is still shown",
      s.seen("question number 5"), repr(s.screen[-400:]))

# ...and the whole way: a PDINFO record off the wire, decoded, on the Status
# pane - which is where it is meant to be read.
with server(IMAGE, "--tui", "--print", "off") as s:
    s.pump(1.5)
    s.send(b"4", wait=0.5)
    c("Status asks for it before it has one",
      s.seen("PDINFO"), repr(s.screen[-400:]))

    os.write(s._link, frame(MB_TO_HOST, bytes([pd_ask.OP_INFO, len(REC)]) + REC))
    s.pump(1.0)
    s.clear(); s.send(b"\x01l", wait=0.8)
    c("...and shows it once the MSX has said",
      s.seen("MSX2+", "International", "slot 2-0"), repr(s.screen[-500:]))

sys.exit(c.done())
