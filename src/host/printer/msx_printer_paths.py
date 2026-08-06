#!/usr/bin/env python3
"""Where print jobs go, and how paths are shown.

Three rules, and the first two are the same rule from opposite ends:

**Nothing is anchored to an absolute path.** We do not know where anyone puts
this. Every default is worked out from the script's own location at run time -
`__file__` is the only fixed point that travels with the code.

**Nothing absolute is printed.** A message reading
`/Users/someone/work/msx-picodock/dist/output/job.txt` is noise: the reader
already knows where they are, and the useful part is the last few segments.
`rel()` turns a path into whatever is shortest to read from here.

**The default is `../output`, relative to the script.** Not the working
directory - that was the old behaviour, and it meant the same server started
from two places wrote to two folders while the TUI listed only one of them.
Not the repository root either, which would need a marker file to find and
would break the moment someone copied the tools somewhere else.

    dist/disk/serve.sh             ->  dist/output/       (passes --output ../output)
    dist/disk/tools/pd_*.py        ->  dist/disk/output/
    src/host/pd_*.py               ->  src/output/

`--output DIR` overrides all of it, and is the answer whenever the default is
not where you want things.
"""

import os


def script_output(script_file, *parts):
    """`<dir of script_file>/../output[/parts...]`.

    Resolved, because a stored relative path is only true for the working
    directory it was built in - and this is computed at import, before anything
    has had a chance to chdir. The relative form is for *showing*, which is what
    `rel()` is for; keeping one internally is how a saved path silently starts
    pointing somewhere else.
    """
    return os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(script_file)),
                     os.pardir, "output", *parts))


def repo_root(start):
    """The directory holding VERSION, walking up from `start`.

    Only for finding *optional* assets a person may have added - fonts, kanji
    ROM dumps - which live in resources/ at the top of the tree and are looked
    up, never written. Output does not use this: where a print job lands should
    not depend on finding a marker file, and a copy of the tools taken out of
    the tree should still know where to put things.
    """
    d = start
    while True:
        if os.path.isfile(os.path.join(d, "VERSION")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.abspath(os.path.join(start, "..", "..", ".."))
        d = parent


def rel(path, start=None):
    """`path` as seen from `start` (default: the working directory).

    Falls back to what it was given when no relative form exists - a different
    drive on Windows, or a path that would need more `..` than it is worth. A
    long relative path helps nobody, so an absolute one is kept when it is
    shorter.
    """
    try:
        r = os.path.relpath(path, start)
    except ValueError:
        return path
    return r if len(r) < len(path) else path
