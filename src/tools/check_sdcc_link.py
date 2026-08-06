#!/usr/bin/env python3
"""check_sdcc_link.py - inspect an sdcc link log and pass only *analysed* warnings.

    check_sdcc_link.py <link.log> <expected-output-file>

Why this exists
---------------
The picodock-menu build mixes two calling-convention worlds:

  * menu.c        - sdcccall(1) (sdcc 4.5's default). It has to be this one to
                    match the sdcc standard library (printf/strlen/division
                    helpers).
  * Fusion-C      - sdcccall(0). The release library was built in that era and
                    its assembly modules have the convention baked in
                    (locate.s: `ld h,4(ix)` reads arguments off the stack).

menu.c declares only the Fusion functions with the `__sdcccall(0)` attribute, so
those call sites use the old convention (see src/fusion_sdcccall0.h). The
generated code was checked:

    __sdcccall(0):  push af / inc sp / push hl / call / pop af / inc sp
                    -> arguments on the stack, caller cleans = what Fusion reads

So **the calls are correct**. But sdcc's linker checks conventions per *module*,
cannot see per-function attributes, and warns purely because the module tags
differ - and sdcc then exits non-zero, failing make.

Rather than ignoring the warnings wholesale, only the module combinations that
have been analysed are whitelisted; anything else fails. A new convention
mismatch will still be caught.
"""

import os
import re
import sys

# Analysed: menu (sdcccall 1) <-> vpeek/vpoke (sdcccall 0).
# The call sites carry __sdcccall(0), so the runtime behaviour is correct.
ALLOWED_MODULES = {"menu", "vpeek", "vpoke"}

FATAL_PAT = re.compile(r"\?ASlink-Error|\berror \d+:|\bsyntax error\b", re.I)
CONFLICT_PAT = re.compile(r"\?ASlink-Warning-Conflicting")
MODULE_PAT = re.compile(r'in module "([^"]+)"')


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2

    log_path, out_path = argv[1], argv[2]
    log = open(log_path, encoding="utf-8", errors="replace").read()

    fatal = [ln for ln in log.splitlines() if FATAL_PAT.search(ln)]
    if fatal:
        print(log)
        print("[-] link failed (fatal error):")
        for ln in fatal[:10]:
            print("   ", ln.strip())
        return 1

    # Are all modules named in convention conflicts on the whitelist?
    unexpected = set()
    for line_no, line in enumerate(log.splitlines()):
        if CONFLICT_PAT.search(line):
            block = log.splitlines()[line_no:line_no + 3]
            for b in block:
                for mod in MODULE_PAT.findall(b):
                    if mod not in ALLOWED_MODULES:
                        unexpected.add(mod)

    if unexpected:
        print(log)
        print(f"[-] unexpected calling-convention conflict: {', '.join(sorted(unexpected))}")
        print("    whitelist:", ", ".join(sorted(ALLOWED_MODULES)))
        print("    Check that module's convention. If it is genuinely correct, add it")
        print("    to ALLOWED_MODULES in src/tools/check_sdcc_link.py with the reasoning.")
        return 1

    if not os.path.exists(out_path):
        print(log)
        print(f"[-] output file was not produced: {out_path}")
        return 1

    n_conflicts = len(CONFLICT_PAT.findall(log))
    if n_conflicts:
        print(f"[*] {n_conflicts} convention warning(s) - the analysed "
              f"menu<->vpeek/vpoke pair (expected)")
    print(f"[+] link OK: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
