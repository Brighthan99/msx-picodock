#!/usr/bin/env python3
"""disk_hold.py - borrow a served image from the disk server, and give it back.

The server serves blocks straight out of the image file - no cache - so a write
made here is visible to the MSX at once. That is convenient and it is exactly
the problem: "at once" includes half-way through updating a FAT, and an MSX that
reads the directory in that moment sees a filesystem nobody wrote.

So the server is asked to stand aside first. Three files beside the image carry
the conversation, and the whole thing is one directory away from being visible,
which is deliberate - a stuck lock should be something you can see and delete:

    <image>.srv    the server's PID, written while it is serving
    <image>.hold   our PID; asks the server to let go
    <image>.held   the server's answer: the handle is closed, go ahead

Removing .hold releases it. That happens on the way out however this exits,
including a crash, because a server paused forever is worse than a failed copy.

This used to live in disk_put.sh, in shell. It is here because the thing it
protects - disk_put.py - now runs on Windows too, and a machine that can write
to the image but cannot take the lock would corrupt exactly what the lock is
for.
"""

import os
import time


def sidecars(image):
    base = os.path.abspath(image)
    return base + ".srv", base + ".hold", base + ".held"


def _alive(pid):
    try:
        os.kill(pid, 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


class Hold:
    """Context manager. Pauses a running server for the duration, if there is one.

    Not an error when no server is running - that is the normal case for someone
    building an image before the MSX is even switched on.
    """

    def __init__(self, image, timeout=30.0, report=print):
        self.srv, self.hold, self.held = sidecars(image)
        self.timeout = timeout
        self.report = report
        self.holding = False

    def __enter__(self):
        try:
            pid = int(open(self.srv).read().strip())
        except (OSError, ValueError):
            return self                     # nobody is serving it
        if not _alive(pid):
            # A stale .srv from a server that died. Left in place rather than
            # deleted: this is not the program that put it there, and guessing
            # wrong would mean writing under a server that is very much alive.
            self.report("[!] stale %s (no process %d) - proceeding"
                        % (os.path.basename(self.srv), pid))
            return self

        self.report("[*] a server is serving this image - asking it to pause")
        try:
            os.remove(self.held)
        except OSError:
            pass
        with open(self.hold, "w") as f:
            f.write(str(os.getpid()))
        self.holding = True

        deadline = time.time() + self.timeout
        while not os.path.exists(self.held):
            if time.time() > deadline:
                self.release()
                raise IOError(
                    "the server did not confirm the pause within %gs; stopping "
                    "rather than writing underneath it.\n"
                    "    If nothing is actually serving it, remove the stale "
                    "lock:\n      rm -f %s" % (self.timeout, self.srv))
            time.sleep(0.1)
        self.report("[*] server paused - safe to proceed")
        return self

    def release(self):
        if self.holding:
            try:
                os.remove(self.hold)
            except OSError:
                pass
            self.holding = False

    def __exit__(self, *exc):
        self.release()
        return False
