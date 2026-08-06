#!/usr/bin/env python3
"""Be the cartridge: ask a running server a question, with no MSX in the room.

    ./src/host/tests/ask_msx.py "what is an msx"
    ./src/host/tests/ask_msx.py --engine ddg "z80 instruction set"
    ./src/host/tests/ask_msx.py --ask manual "give me a haiku"

This is the hand-driven twin of test_ask.py. That file asserts; this one lets you
watch. It starts a real pd_diskserver on a pty, plays the MSX side of the
mailbox conversation, and prints exactly the bytes `CALL PDASK` would have put on
screen - so a wrong answer here is a wrong answer on the machine, and a right one
means the only thing left untested is the cable.

Why a separate script rather than a flag on pd_ask.py: running pd_ask.py on its
own calls search() and prints the result, which tests the searching and nothing
else. Everything that actually breaks - framing, opcodes, chunking, the ack
handshake, the 500-byte cut - lives between the server and the cartridge, and the
only way to exercise it is to be the cartridge.

With --ask manual the server waits for someone to type the answer; do that in
the terminal it is running in. Here that server is a child process sharing this
terminal, so type into this window and it reaches it.
"""

import argparse
import os
import select
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdtest
from pdtest import server
import pd_ask

SOF, MB_TO_HOST, MB_TO_MSX = 0x5A, 0x30, 0x31


def frame(cmd, payload=b""):
    body = bytes([cmd, len(payload) & 0xFF, (len(payload) >> 8) & 0xFF]) + payload
    chk = 0
    for b in body:
        chk ^= b
    return bytes([SOF]) + body + bytes([chk])


def ask_frame(text):
    q = text.encode("ascii", "replace")
    return frame(MB_TO_HOST,
                 bytes([pd_ask.OP_REQ, len(q) & 0xFF, len(q) >> 8]) + q)


def collect(s, patience, verbose, forward_stdin):
    """The cartridge's side of it: chunk, ack, chunk, ack, ... END.

    The ack is the whole point of the loop. The server holds the next chunk
    until the cartridge says it took the last one, because an MSX that is busy
    printing cannot also be receiving. Getting a second chunk without acking
    would mean the server is not waiting, which is a real bug and one this
    reproduces.

    Three things are watched at once, and all three are necessary. The link is
    the answer coming back. The server's own terminal has to be drained or the
    server blocks writing to a full pty and never gets as far as answering -
    which looks exactly like a hung protocol and is not one. And with --ask
    manual the answer is typed here, so this window's stdin has to reach the
    child.
    """
    link, term = s._link, s.master
    watch = [link, term] + ([sys.stdin.fileno()] if forward_stdin else [])
    buf, text, chunks = bytearray(), bytearray(), 0
    quiet = time.time() + patience

    while time.time() < quiet:
        for fd in select.select(watch, [], [], 0.1)[0]:
            if fd == term:
                try:
                    s.screen += pdtest.strip_ansi(
                        os.read(term, 65536).decode("utf-8", "replace"))
                except OSError:
                    return text, chunks, "the server went away"
                continue
            if fd != link:                       # this terminal: pass it on
                typed = os.read(fd, 4096)
                if not typed:
                    # Piped input that has run out. A closed pipe stays readable
                    # for ever, so leaving it here would spin the loop and keep
                    # resetting the patience: the wait would never end.
                    watch.remove(fd)
                    continue
                os.write(term, typed)
                quiet = time.time() + patience   # they are still working
                continue
            buf += os.read(link, 65536)

        while len(buf) >= 5:
            if buf[0] != SOF:
                del buf[0]
                continue
            length = buf[2] | (buf[3] << 8)
            if len(buf) < 5 + length:
                break
            payload, to_msx = bytes(buf[4:4 + length]), buf[1] == MB_TO_MSX
            del buf[:5 + length]
            if not (to_msx and payload):
                continue

            quiet = time.time() + patience
            op = payload[0]
            if op == pd_ask.OP_CHUNK:
                text += payload[2:]
                chunks += 1
                if verbose:
                    print("    <- chunk %d, %d bytes" % (chunks, len(payload) - 2))
                os.write(link, frame(MB_TO_HOST, bytes([pd_ask.OP_ACK])))
            elif op == pd_ask.OP_END:
                if verbose:
                    print("    <- end")
                return text, chunks, "end"
            elif op == pd_ask.OP_ERR:
                code = payload[1] if len(payload) > 1 else 0
                return text, chunks, "error 0x%02X" % code
            elif verbose:
                print("    <- opcode 0x%02X" % op)

    return text, chunks, "silence"


def main():
    ap = argparse.ArgumentParser(
        description="Ask a real server a question, playing the MSX side.")
    ap.add_argument("question", nargs="*", default=[],
                    help="what to ask (default: what is an msx)")
    ap.add_argument("--engine", help="pass through as --ask-engine")
    ap.add_argument("--ask", default="google",
                    help="the answerer: google, manual, ... (default: google)")
    ap.add_argument("--limit", type=int, help="pass through as --ask-limit")
    ap.add_argument("--patience", type=float, default=20.0,
                    help="seconds to wait for each reply (default: 20)")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="show each chunk and ack as it happens")
    args = ap.parse_args()

    question = " ".join(args.question) or "what is an msx"

    opts = ["--print", "off", "--ask", args.ask]
    if args.engine:
        opts += ["--ask-engine", args.engine]
    if args.limit:
        opts += ["--ask-limit", str(args.limit)]

    image = pdtest.scratch_image(
        os.path.join(os.environ.get("TMPDIR", "/tmp"), "pdtest-ask-msx.img"))

    print("[*] server: pd_diskserver %s" % " ".join(opts))
    print("[*] asking: %s" % question)
    if args.ask == "manual":
        print("[*] --ask manual: type the answer here and press Enter.")
    print()

    with server(image, *opts) as s:
        s.pump(1.5)
        os.write(s._link, ask_frame(question))
        text, chunks, how = collect(s, args.patience, args.verbose,
                                    forward_stdin=sys.stdin.isatty()
                                    or args.ask == "manual")

    answer = text.decode("ascii", "replace").replace("\r\n", "\n")

    print()
    if how == "silence":
        print("[-] nothing came back within %gs." % args.patience)
        print("    What the server said:")
        print("    " + s.screen[-600:].replace("\n", "\n    "))
        return 1
    if how.startswith("error"):
        print("[-] the server refused: %s" % how)
        print("    That is what the MSX would print as a failure.")
        print("    What the server said:")
        print("    " + s.screen[-600:].replace("\n", "\n    "))
        return 1

    print("[+] %d bytes in %d chunk%s - this is what the MSX prints:"
          % (len(text), chunks, "" if chunks == 1 else "s"))
    print()
    print(answer)
    print()

    # 500 is the default cut and the reason shape() exists: 40 columns means a
    # long answer is pages of scrolling nobody reads.
    if len(text) >= (args.limit or 500):
        print("[*] at the limit - the answer was cut, which is normal.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
