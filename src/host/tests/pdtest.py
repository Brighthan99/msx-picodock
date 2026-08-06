#!/usr/bin/env python3
"""pdtest.py - shared scaffolding for the host tests.

Never touch a real cartridge
----------------------------
These tests start real servers, and a server looks for the cartridge by VID/PID
and opens it exclusively. Run one while the MSX is plugged in and it takes the
port away from whatever session is actually using it - which is not a
hypothetical: it happened, and the symptom was "the MSX suddenly will not
connect" with nothing in either log to explain it.

Two defences, in that order:

  * `fake_port()` hands the server a pseudo-terminal through `--port`, so
    find_port() is never called and there is nothing to take. This is the one
    that matters: it holds even when a cartridge is present.
  * `require_no_cartridge()` refuses to run at all if one is plugged in, for any
    test that cannot use a fake port. Override with PD_TEST_ALLOW_HARDWARE=1
    when that is genuinely what you want.

And `server()` guarantees the child is gone on the way out, however the test
ends. A stray server does not announce itself; it just quietly wins the next
race for the port.
"""

import os
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HOST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HOST)
sys.path.insert(0, os.path.join(HOST, "printer"))   # msx_printer_* modules

import fcntl
import termios

VID, PID = 0x2E8A, 0x000A
SERVER = os.path.join(HOST, "pd_diskserver.py")


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
class Checks:
    def __init__(self, title):
        print(f"=== {title} ===")
        self.failed = []

    def __call__(self, name, ok, detail=""):
        print(("  OK   " if ok else "  FAIL ") + name
              + (("\n         " + str(detail)) if not ok and detail else ""))
        if not ok:
            self.failed.append(name)

    def done(self):
        print("  all passed" if not self.failed
              else f"  {len(self.failed)} failed: {self.failed}")
        return 1 if self.failed else 0


# ---------------------------------------------------------------------------
# Hardware safety
# ---------------------------------------------------------------------------
def cartridge_present():
    try:
        from pd_port import find_port
        return find_port(VID, PID)
    except (Exception, SystemExit):
        # SystemExit too: without pyserial, importing pd_port prints how to
        # install it and exits. That must not take the test run with it - a
        # missing dependency is not a cartridge.
        return None


def require_no_cartridge(why="this test starts a server"):
    port = cartridge_present()
    if port and not os.environ.get("PD_TEST_ALLOW_HARDWARE"):
        sys.exit(f"[-] the cartridge is plugged in ({port}) and {why}.\n"
                 f"    It would take the port from whatever is using it.\n"
                 f"    Unplug it, or set PD_TEST_ALLOW_HARDWARE=1 to insist.")


# ---------------------------------------------------------------------------
# A terminal, and a server attached to it
# ---------------------------------------------------------------------------
def open_pty(rows=30, cols=100):
    """A pty with a believable window size - curses lays out for 0x0 without one."""
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    return master, slave


def fake_port():
    """A pty the server can open as its 'cartridge'.

    Returns (master_fd, device_path). Passing the path as --port means the
    server never calls find_port, so a real cartridge is never even looked at.
    """
    master, slave = os.openpty()
    path = os.ttyname(slave)
    os.close(slave)            # the server opens it again by name
    return master, path


class server:
    """A running server on a pty, guaranteed to be gone afterwards."""

    def __init__(self, image, *args, rows=30, cols=100, use_fake_port=True):
        self.image = image
        self.args = list(args)
        self.rows, self.cols = rows, cols
        self.use_fake_port = use_fake_port
        self.screen = ""
        self.proc = None
        self._link = None
        self._out = None

    def __enter__(self):
        argv = [sys.executable, SERVER, self.image] + self.args
        # Somewhere disposable, unless the test asked for a particular place.
        # Without this the server falls back to its script-relative default,
        # which is src/output/ - so a test that spools quietly leaves print
        # captures inside the source tree, two per run, for ever.
        if not any(a == "--output" or a.startswith("--output=") for a in self.args):
            self._out = tempfile.mkdtemp(prefix="pdtest-output-")
            argv += ["--output", self._out]
        if self.use_fake_port:
            self._link, path = fake_port()
            argv += ["--port", path]
        else:
            require_no_cartridge()
        self.master, slave = open_pty(self.rows, self.cols)
        self.proc = subprocess.Popen(
            argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
            env=dict(os.environ, TERM="xterm-256color", PYTHONUNBUFFERED="1"))
        os.close(slave)
        return self

    def __exit__(self, *exc):
        if self._out:
            shutil.rmtree(self._out, ignore_errors=True)
            self._out = None
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        for fd in (getattr(self, "master", None), self._link):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        return False

    # -- talking to it -----------------------------------------------------
    def pump(self, seconds=1.0):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.1)
            if r:
                try:
                    self.screen += strip_ansi(
                        os.read(self.master, 65536).decode("utf-8", "replace"))
                except OSError:
                    break
        return self.screen

    def send(self, data, wait=0.7):
        os.write(self.master, data)
        return self.pump(wait)

    def clear(self):
        self.screen = ""

    def seen(self, *words):
        return all(w in self.screen for w in words)

    def wait_exit(self, timeout=5):
        try:
            self.proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False


def strip_ansi(s):
    for pat in (r"\x1b\[[0-9;?]*[a-zA-Z]", r"\x1b[()][A-B0-2]", r"\x1b[=>]"):
        s = re.sub(pat, "", s)
    return s


def scratch_image(path, megabytes=4):
    """A throwaway image. Contents do not matter: no test mounts it."""
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.truncate(megabytes * 1024 * 1024)
    return path
