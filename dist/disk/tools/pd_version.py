#!/usr/bin/env python3
"""pd_version.py - the project's version, in one place.

The number lives in the VERSION file at the repository root rather than in here,
so that it is one edit for the whole project - host tools, MSX tools and, when it
matters, the firmware - instead of a constant per language to keep in step.

Semantic versioning, and it moves with every change that ships: the server
prints it on every start and the split view carries it in the title bar, which
is the point. A bug report that says "v0.3.2" is answerable; one that says "the
version I built some time in July" is not.
"""

import os

def _find_root(start, fallback_up):
    """The directory holding VERSION, walking up from `start`.

    Counting ".." would do if this file only ever lived in src/host/, but it is
    also staged into dist/disk/tools/, which is a level deeper. Searching for the
    marker makes the same file correct in both.
    """
    d = start
    while True:
        if os.path.isfile(os.path.join(d, "VERSION")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.abspath(os.path.join(start, *([os.pardir] * fallback_up)))
        d = parent


_ROOT = _find_root(os.path.dirname(os.path.abspath(__file__)), 2)
def _read():
    try:
        with open(os.path.join(_ROOT, "VERSION"), encoding="ascii") as f:
            v = f.read().strip()
        if v:
            # Tolerate a leading "v" in the file so that writing either form
            # cannot produce "vv0.1.1" downstream.
            return v[1:] if v[:1] in "vV" else v
    except OSError:
        pass
    # Running from a copy that left the VERSION file behind. Say so rather than
    # invent a number - a wrong version is worse than an obviously absent one.
    return "0.0.0-unknown"


VERSION = _read()          # bare semver, for comparing
DISPLAY = "v" + VERSION    # what a human should see
