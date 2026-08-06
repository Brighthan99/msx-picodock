#!/usr/bin/env python3
"""Naming the mount point when the server pauses.

"picodock.img is mounted here" does not say which of two images open in Finder
to eject. mount_points() has always known; it just was not wired to the message.
The lookup is best-effort - hdiutil, and macOS only - so the interesting cases
are the ones where it comes back with nothing and the line has to stay sensible.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from pdtest import Checks
import pd_hub, pd_diskserver

c = Checks("mount point naming")
v = pd_hub.TextView()

ev = {"ch":"disk","ev":"paused","path":"a.img","reason":"mounted","at":["/Volumes/A"]}
c("paused names where", "(at /Volumes/A)" in v.format(ev), v.format(ev))

ev = {"ch":"disk","ev":"paused","path":"a.img","reason":"mounted","at":[]}
c("no mount point -> no parenthetical", "(at" not in v.format(ev), v.format(ev))

ev = {"ch":"disk","ev":"paused","path":"a.img","reason":"mounted"}
c("missing key is not an error", "(at" not in v.format(ev), v.format(ev))

ev = {"ch":"disk","ev":"paused","path":"a.img","reason":"mounted","at":["/Volumes/A","/Volumes/B"]}
c("two mounts are both named", "(at /Volumes/A, /Volumes/B)" in v.format(ev), v.format(ev))

ev = {"ch":"disk","ev":"mounted_at_start","path":"a.img","at":["/Volumes/A"]}
c("startup refusal names where too", "(at /Volumes/A)" in v.format(ev), v.format(ev))

# disk_put pauses have no mount point - that path must not grow one
ev = {"ch":"disk","ev":"paused","path":"a.img","reason":"disk_put"}
c("disk_put pause is unchanged", "borrowing it" in v.format(ev) and "(at" not in v.format(ev),
  v.format(ev))

c("mount_points on a path that is not mounted returns nothing",
  pd_diskserver.mount_points("/tmp/definitely-not-mounted.img") == [])
sys.exit(c.done())
