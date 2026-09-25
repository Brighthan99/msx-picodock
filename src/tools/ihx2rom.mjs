#!/usr/bin/env node
// ihx2rom.mjs - Intel HEX (.ihx) to a fixed-size MSX ROM image, or a .COM.
//
// The original msx/Makefile uses `hex2bin -e ROM -s 0x4000 -l 0x8000`, but hex2bin
// is not available on macOS (there is no brew formula either). sdcc's makebin
// always emits from address 0, so getting an image that starts at 0x4000 would
// need post-processing. Doing the conversion explicitly is clearer - it leaves no
// ambiguity about the layout.
//
//     ihx2rom.mjs <in.ihx> <out.rom> [--start 0x4000] [--size 0x8000] [--fill 0xFF]
//     ihx2rom.mjs <in.ihx> <out.com> --start 0x100 --exact
//
// --exact writes the bytes from --start to the last one used, no padding, and
// requires the code to begin exactly at --start. That is a .COM: MSX-DOS loads it
// as-is at 0x0100, so a gap in front would move every address in it.
//
// Records outside the start/size window are an error rather than being silently
// truncated: silent truncation is very hard to diagnose later.
//
// This was ihx2rom.py, and msx-tools/build.sh carried a second copy of the parser
// in Python for the .COM case. Node is what the host side needs anyway, so the
// build no longer needs Python at all.

import fs from 'node:fs';

const hex4 = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

// Flatten the file into a Map address -> byte. Segment/extended records are not
// used here, so only type 00 (data) and 01 (EOF) are accepted; anything else is
// rejected explicitly.
function parseIhx(path) {
  const mem = new Map();
  const lines = fs.readFileSync(path, 'ascii').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `${path}:${i + 1}`;
    if (!line.startsWith(':')) throw new Error(`${where}: does not start with ':'`);
    const raw = Buffer.from(line.slice(1), 'hex');
    if (raw.length * 2 !== line.length - 1) throw new Error(`${where}: not hex`);
    const [count, hi, lo, type] = raw;
    if ((raw.reduce((s, b) => s + b, 0) & 0xFF) !== 0) throw new Error(`${where}: checksum mismatch`);
    if (type === 0x01) break;
    if (type !== 0x00)
      throw new Error(`${where}: unsupported record type ${type.toString(16).toUpperCase().padStart(2, '0')}`);
    const addr = (hi << 8) | lo;
    for (let k = 0; k < count; k++) mem.set(addr + k, raw[4 + k]);
  }
  return mem;
}

function main(argv) {
  if (argv.length < 2) {
    console.log('usage: ihx2rom.mjs <in.ihx> <out> [--start N] [--size N] [--fill N] [--exact]');
    return 1;
  }
  const [src, dst] = argv;
  let start = 0x4000, size = 0x8000, fill = 0xFF, exact = false;
  for (let i = 2; i < argv.length; i++) {
    const opt = argv[i];
    if (opt === '--exact') { exact = true; continue; }
    const val = Number(argv[++i]);
    if (!Number.isInteger(val)) { console.log(`bad value for ${opt}: ${argv[i]}`); return 1; }
    if (opt === '--start') start = val;
    else if (opt === '--size') size = val;
    else if (opt === '--fill') fill = val;
    else { console.log(`unknown option: ${opt}`); return 1; }
  }

  let mem;
  try {
    mem = parseIhx(src);
  } catch (e) {
    console.log(`[-] ${e.message}`);
    return 1;
  }
  if (!mem.size) {
    console.log('[-] no data records found');
    return 1;
  }
  const addrs = [...mem.keys()];
  const lo = Math.min(...addrs), hi = Math.max(...addrs);

  if (exact) {
    if (lo !== start) {
      console.log(`[-] code starts at ${hex4(lo)}, expected ${hex4(start)}`);
      return 1;
    }
    const out = Buffer.alloc(hi - lo + 1, 0);
    for (const [a, b] of mem) out[a - lo] = b;
    fs.writeFileSync(dst, out);
    console.log(`[+] ${dst}  ${out.length} bytes  (${hex4(lo)}-${hex4(hi)})`);
    return 0;
  }

  if (lo < start || hi >= start + size) {
    console.log(`[-] code falls outside the image window: `
      + `${hex4(lo)}-${hex4(hi)} vs ${hex4(start)}-${hex4(start + size - 1)}`);
    return 1;
  }
  const rom = Buffer.alloc(size, fill);
  for (const [a, b] of mem) rom[a - start] = b;
  fs.writeFileSync(dst, rom);
  const used = mem.size;
  console.log(`[+] ${dst}  ${size} bytes  (start ${hex4(start)}, `
    + `code ${hex4(lo)}-${hex4(hi)}, used ${used} bytes / ${Math.floor(used * 100 / size)}%)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
