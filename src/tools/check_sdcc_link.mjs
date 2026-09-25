#!/usr/bin/env node
// check_sdcc_link.mjs - inspect an sdcc link log and pass only *analysed* warnings.
//
//     check_sdcc_link.mjs <link.log> <expected-output-file>
//
// Why this exists
// ---------------
// The picodock-menu build mixes two calling-convention worlds:
//
//   * menu.c        - sdcccall(1) (sdcc 4.5's default). It has to be this one to
//                     match the sdcc standard library (printf/strlen/division
//                     helpers).
//   * Fusion-C      - sdcccall(0). The release library was built in that era and
//                     its assembly modules have the convention baked in
//                     (locate.s: `ld h,4(ix)` reads arguments off the stack).
//
// menu.c declares only the Fusion functions with the `__sdcccall(0)` attribute, so
// those call sites use the old convention (see src/fusion_sdcccall0.h). The
// generated code was checked:
//
//     __sdcccall(0):  push af / inc sp / push hl / call / pop af / inc sp
//                     -> arguments on the stack, caller cleans = what Fusion reads
//
// So **the calls are correct**. But sdcc's linker checks conventions per *module*,
// cannot see per-function attributes, and warns purely because the module tags
// differ - and sdcc then exits non-zero, failing make.
//
// Rather than ignoring the warnings wholesale, only the module combinations that
// have been analysed are whitelisted; anything else fails. A new convention
// mismatch will still be caught.
//
// This was check_sdcc_link.py; it moved to Node so that building needs no Python.

import fs from 'node:fs';

// Analysed: menu (sdcccall 1) <-> vpeek/vpoke (sdcccall 0).
// The call sites carry __sdcccall(0), so the runtime behaviour is correct.
const ALLOWED_MODULES = new Set(['menu', 'vpeek', 'vpoke']);

const FATAL_PAT = /\?ASlink-Error|\berror \d+:|\bsyntax error\b/i;
const CONFLICT_PAT = /\?ASlink-Warning-Conflicting/;
const MODULE_PAT = /in module "([^"]+)"/g;

function main(argv) {
  if (argv.length !== 2) {
    console.log('usage: check_sdcc_link.mjs <link.log> <expected-output-file>');
    return 2;
  }
  const [logPath, outPath] = argv;
  const log = fs.readFileSync(logPath, 'utf8');
  const lines = log.split(/\r?\n/);

  const fatal = lines.filter((ln) => FATAL_PAT.test(ln));
  if (fatal.length) {
    console.log(log);
    console.log('[-] link failed (fatal error):');
    for (const ln of fatal.slice(0, 10)) console.log('   ', ln.trim());
    return 1;
  }

  // Are all modules named in convention conflicts on the whitelist?
  const unexpected = new Set();
  lines.forEach((line, n) => {
    if (!CONFLICT_PAT.test(line)) return;
    for (const b of lines.slice(n, n + 3))
      for (const m of b.matchAll(MODULE_PAT))
        if (!ALLOWED_MODULES.has(m[1])) unexpected.add(m[1]);
  });

  if (unexpected.size) {
    console.log(log);
    console.log(`[-] unexpected calling-convention conflict: ${[...unexpected].sort().join(', ')}`);
    console.log('    whitelist:', [...ALLOWED_MODULES].sort().join(', '));
    console.log("    Check that module's convention. If it is genuinely correct, add it");
    console.log('    to ALLOWED_MODULES in src/tools/check_sdcc_link.mjs with the reasoning.');
    return 1;
  }

  if (!fs.existsSync(outPath)) {
    console.log(log);
    console.log(`[-] output file was not produced: ${outPath}`);
    return 1;
  }

  const conflicts = lines.filter((ln) => CONFLICT_PAT.test(ln)).length;
  if (conflicts)
    console.log(`[*] ${conflicts} convention warning(s) - the analysed `
      + 'menu<->vpeek/vpoke pair (expected)');
  console.log(`[+] link OK: ${outPath}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
