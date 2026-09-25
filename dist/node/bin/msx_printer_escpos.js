#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only  (ported from src/host/printer/ - see NOTICE.md)
// msx_printer_escpos.js — 그린 페이지를 영수증 프린터의 ESC/POS 로, 그리고
// 프린터까지. src/host/printer/msx_printer_escpos.py 의 Node 판이고 사용법과
// 찍는 말이 같다. 하는 일은 ../src/escpos.js 에 있다.
//
//   node bin/msx_printer_escpos.js page.png -o out.bin
//   node bin/msx_printer_escpos.js --spool output/spool/X -j 3 --usb
//   node bin/msx_printer_escpos.js --list

import fs from 'node:fs';
import path from 'node:path';

import * as E from '../src/escpos.js';
import { readPng } from '../src/png.js';

const say = (s) => console.log(s);

const USAGE = `usage: msx_printer_escpos [pages ...] [-o OUT] [--port PORT] [--usb [USB]] [--usb-via {pyusb,cups}]
                          [--raw] [--keep-private] [--pad-bottom N] [--no-native] [--baud N]
                          [--paper {58,80,112}] [--dots N] [--halftone {threshold,dither}]
                          [--band-max N] [--rotate {auto,on,off}] [--mode {bitimage,raster}]
                          [--preview FILE] [--spool STEM] [-j JOB] [--keep DIR] [--glyphs SET]
                          [--list] [--probe]`;

class UsageError extends Error {}

function parse(argv) {
  const a = { pages: [], out: null, port: null, usb: null, usbVia: 'pyusb', raw: false, keepPrivate: false,
              padBottom: E.PAD_BOTTOM, native: true, baud: 9600, paper: 58, dots: null,
              halftone: E.DEFAULT_HALFTONE, bandMax: E.MAX_BAND_DOTS, rotate: 'auto', mode: E.DEFAULT_MODE,
              preview: null, spool: null, job: null, keep: null, glyphs: 'msx', list: false, probe: false };
  const choice = (k, v, ok) => { if (!ok.includes(v)) throw new UsageError(`argument ${k}: invalid choice: '${v}'`); return v; };
  const int = (k, v) => { if (!/^[+-]?\d+$/.test(v)) throw new UsageError(`argument ${k}: invalid int value: '${v}'`); return Number.parseInt(v, 10); };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`argument ${k}: expected one argument`); return argv[++i]; };
    switch (k) {
      case '-h': case '--help': say(USAGE); process.exit(0); break;
      case '-o': case '--out': a.out = val(); break;
      case '--port': a.port = val(); break;
      case '--usb':
        // nargs="?": 값이 없거나 다음이 옵션이면 auto.
        a.usb = i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[++i] : 'auto'; break;
      case '--usb-via': a.usbVia = choice(k, val(), ['pyusb', 'cups']); break;
      case '--raw': a.raw = true; break;
      case '--keep-private': a.keepPrivate = true; break;
      case '--pad-bottom': a.padBottom = int(k, val()); break;
      case '--no-native': a.native = false; break;
      case '--baud': a.baud = int(k, val()); break;
      case '--paper': a.paper = int(k, choice(k, val(), ['58', '80', '112'])); break;
      case '--dots': a.dots = int(k, val()); break;
      case '--halftone': a.halftone = choice(k, val(), E.HALFTONES); break;
      case '--band-max': a.bandMax = int(k, val()); break;
      case '--rotate': a.rotate = choice(k, val(), ['auto', 'on', 'off']); break;
      case '--mode': a.mode = choice(k, val(), ['bitimage', 'raster']); break;
      case '--preview': a.preview = val(); break;
      case '--spool': a.spool = val(); break;
      case '-j': case '--job': a.job = val(); break;
      case '--keep': a.keep = val(); break;
      case '--glyphs': a.glyphs = val(); break;
      case '--list': a.list = true; break;
      case '--probe': a.probe = true; break;
      default:
        if (k.startsWith('-')) throw new UsageError(`unrecognized arguments: ${k}`);
        a.pages.push(k);
    }
  }
  return a;
}

async function deliver(data, a) {
  if (a.out) {
    fs.writeFileSync(a.out, data);
    say(`[+] wrote ${a.out}`);
    say(`    send it with:  cat ${a.out} > /dev/cu.YOURPRINTER`);
    return 0;
  }
  if (a.usb) {
    let n;
    try { n = await E.sendUsb(data, a.usb, a.usbVia); } catch (e) {
      say(`[-] usb: ${e.message}`);
      if (e.message.includes('no USB')) {
        say('    a charge-only cable, or two adapters stacked, gives the');
        say('    printer power and nothing else');
      }
      return 1;
    }
    say(`[+] sent ${n} bytes over ${a.usbVia}`);
    return 0;
  }
  if (!a.port) {
    say('[-] nowhere to send it: pass --usb, --port or -o');
    say('    --list shows the ports');
    return 1;
  }
  try { const n = await E.sendSerial(data, a.port, a.baud); say(`[+] sent ${n} bytes to ${a.port}`); return 0; }
  catch (e) { say(`[-] ${a.port}: ${e.message}`); return 1; }
}

async function listPorts() {
  const usb = await E.listUsb(say);
  say('');
  let found = [];
  try { found = fs.readdirSync('/dev').filter((n) => n.startsWith('cu.')).sort().map((n) => `/dev/${n}`); } catch { /* 윈도우 */ }
  say('serial ports:');
  if (!found.length) say('  none');
  for (const p of found) {
    const low = p.toLowerCase();
    const hint = low.includes('usbserial') || low.includes('usbmodem') ? '   <- USB'
      : low.includes('blth') || low.includes('bluetooth') ? '   <- Bluetooth' : '';
    say(`  ${p}${hint}`);
  }
  say('\n/dev/cu.usbmodem* is most likely the PicoDock cartridge - not a printer.');
  say('A Bluetooth port exists whether or not the printer is connected, and');
  say('swallows everything written to it. Prefer the USB list above.');
  if (usb.length) {
    const vp = usb[0][0];
    say(`\nTo print a spooled job to ${vp}:`);
    say(`  msx_printer_escpos --spool output/spool/X -j 1 --raw --usb ${vp}`);
    say('  (--raw for an ESC/P printer; leave it off for an ESC/POS receipt)');
  }
  return 0;
}

async function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`${USAGE}\nmsx_printer_escpos: error: ${e.message}`); return 2; }
    throw e;
  }
  const fail = (m) => { console.error(`${USAGE}\nmsx_printer_escpos: error: ${m}`); return 2; };

  if (a.list) return listPorts();
  if (a.probe) {
    const side = Math.min(96, Math.floor(a.bandMax / 8) * 8);
    const data = E.probe(side);
    const mm = E.PROBE_TRIES.reduce((s, [, m]) => s + side / (m === null ? 203 : E.BAND_MODES[m][2]) + 24 / 180, 0) * 25.4;
    say(`[+] probe: ${E.PROBE_TRIES.length} attempts, ${data.length} bytes, roughly ${(mm / 10).toFixed(1)}cm of paper`);
    say('    Each draws the SAME square. A square means that one is right;');
    say('    a tall rectangle means the vertical density is wrong.');
    if (a.out) { fs.writeFileSync(a.out, data); say(`[+] wrote ${a.out}`); return 0; }
    if (!a.usb && !a.port) { say('[-] nowhere to send it: pass --usb, --port or -o'); return 1; }
    try {
      const n = a.usb ? await E.sendUsb(data, a.usb, a.usbVia) : await E.sendSerial(data, a.port, a.baud);
      say(`[+] sent ${n} bytes`);
      say('    Which of the three came out as a clean bar with ticks?');
      return 0;
    } catch (e) { say(`[-] ${e.message}`); return 1; }
  }

  let jobs = [];
  if (a.job !== null) {
    try { jobs = E.jobNumbers(a.job); } catch { return fail(`-j wants job numbers like 3 or 1,3,5-6 (got '${a.job}')`); }
    if (!jobs.length) return fail('-j picked no jobs');
  }

  if (a.raw) {
    if (!a.spool || !jobs.length) return fail('--raw needs --spool and -j/--job');
    let data;
    try { data = E.rawFromSpool(a.spool, jobs, a.keepPrivate); } catch (e) { say(`[-] ${e.message}`); return 1; }
    const which = jobs.length === 1 ? jobs[0] : jobs.join(', ');
    say(`[+] job ${which}: ${data.length} bytes of ESC/P, as the MSX wrote them${a.keepPrivate ? '' : ' (private blocks removed)'}`);
    return deliver(data, a);
  }

  let native = null;
  let images = [];
  let scratch = null;
  const dots = a.dots || E.HEADS[a.paper];
  try {
    if (a.spool) {
      if (a.pages.length) return fail('give either page images or --spool, not both');
      if (!jobs.length) return fail('--spool needs -j/--job');
      // **1:1 먼저.** 비트 이미지 작업은 펌웨어가 놓는 그대로 - 그리지도 줄이지도 않는다.
      if (a.native) {
        try { native = E.nativeFromSpool(a.spool, jobs, dots, a.keep, a.padBottom); }
        catch (e) { say(`[-] ${e.message}`); return 1; }
      }
      if (native === null) {
        try {
          for (const seq of jobs) {
            const [paths, tmp, imgs] = E.pagesFromSpool(a.spool, seq, a.keep, a.glyphs);
            a.pages.push(...paths);
            images.push(...imgs);
            scratch = scratch || tmp;
          }
        } catch (e) { say(`[-] ${e.message}`); return 1; }
        if (a.keep) for (const p of a.pages) say(`[+] kept ${p}`);
      }
    } else if (!a.pages.length) return fail('give at least one page image, or --spool, or --list');
    else {
      for (const p of a.pages) {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { say(`[-] no such page: ${p}`); return 1; }
        images.push(readPng(fs.readFileSync(p)));
      }
    }

    let data;
    if (native !== null) {
      const [rb, rows, raw, kept] = native;
      if (kept) say(`[+] kept ${kept}`);
      const which = jobs.length === 1 ? jobs[0] : `${jobs.length} jobs merged`;
      say(`[+] ${which}: bit image laid 1:1, ${rb * 8} x ${rows} dots`);
      data = E.buildRasters([[rb, rows, raw]], { mode: a.mode, preview: a.preview });
      a.pages = [kept || '(native)'];
    } else {
      data = E.build(images, dots, { rotate: a.rotate, preview: a.preview, mode: a.mode,
                                     bandMax: a.bandMax, halftone: a.halftone });
    }
    const drawn = a.mode === 'bitimage' ? Math.min(dots, Math.floor(a.bandMax / 8) * 8) : dots;
    say(`[+] ${a.pages.length} page(s) -> ${data.length} bytes at ${drawn} dots wide`
      + (drawn < dots ? ` (head is ${dots}; ESC * cannot use it all)` : ''));
    if (a.preview) say(`[+] preview: ${a.preview}`);
    return await deliver(data, a);
  } finally {
    // 페이지는 이미 읽었으니 임시 사본은 할 일을 다 했다. **우리가 만든 폴더만** -
    // --keep 은 부른 쪽이 고른 곳이다.
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    void path;
  }
}

process.exitCode = await main(process.argv.slice(2));
