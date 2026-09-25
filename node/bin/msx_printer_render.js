#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only  (ported from src/host/printer/ - see NOTICE.md)
// msx_printer_render.js — 잡아 둔 인쇄 (.prn) 를 다시 그린다. 한 앞문.
//
// src/host/printer/ 의 명령줄 도구 넷 - msx_printer_escp_render.py,
// msx_printer_recharset.py, msx_printer_kanji_render.py, msx_printer_hangul_render.py -
// 이 하던 일을 하나로 모았다 (2026-09-25). 넷 다 캡처 하나를 받아 PNG 나 글로
// 그리는 도구였고, 어느 것을 불러야 하는지는 방언을 알아야 고를 수 있었다.
// 여기서는 방언을 먼저 가린다 (--dialect 로 못 박을 수도 있다).
//
//   node bin/msx_printer_render.js job.prn                     # 방언을 가려 PNG
//   node bin/msx_printer_render.js job.prn out                 # -> out.png (out_p1.png ...)
//   node bin/msx_printer_render.js job.prn --charset msx-jp    # 글리프 세트
//   node bin/msx_printer_render.js job.prn --all               # 글리프 세트마다 한 벌
//   node bin/msx_printer_render.js job.prn --text --text-charset shift_jis
//   node bin/msx_printer_render.js job.prn --dialect msx-kanji --kanji-rom KNJFNT16.ROM
//   node bin/msx_printer_render.js job.prn --dialect msx-hangul --font Galmuri11.ttf
//   node bin/msx_printer_render.js job.prn --dialect msx-hangul --text   # 한글을 글로, 글꼴 없이
//   node bin/msx_printer_render.js --list | --list-fonts
//   node bin/msx_printer_render.js --selftest [out_prefix]      # 상자와 X 를 그려 확인

import fs from 'node:fs';
import path from 'node:path';

import { TABLES, DEFAULT_CHARSET } from '../src/escp-fonts.js';
import { Renderer } from '../src/escp.js';
import { detectDialect } from '../src/printer_detect.js';
import { KanjiRenderer, extractText as kanjiText } from '../src/kanji.js';
import { decode as hangulDecode } from '../src/hangul.js';
import {
  pageCrop, writeSheets, typesetSheets, findRom, findBundledFont, FONT_DIR, BUNDLED_JP, BUNDLED_KR,
  decodeText, picoprinterSheet,
} from '../src/printrender.js';
import { pagesPdf } from '../src/pdfwrite.js';

const say = (s = '') => console.log(s);
const GLYPHS = [...Object.keys(TABLES), 'cp437'].filter((v, i, a) => a.indexOf(v) === i);
const DESCRIPTIONS = {
  msx: 'MSX International character ROM (Philips NMS8250) - the default',
  'msx-din': 'MSX International, DIN variant (slashless zero)',
  'msx-jp': 'MSX Japanese ROM (Sony HB-F1XV), katakana at 0xA1-0xDF',
  fx80: 'Epson FX-80 ROM, period-correct (high bit = italics)',
  cp437: 'FX-80 glyphs with the CP437 upper region mapped onto them',
};
const TEXT_CHARSETS = ['cp437', 'shift_jis', 'cp932', 'utf-8', 'latin-1'];

function usage(err) {
  say('usage: msx_printer_render <job.prn> [out_prefix] [--dialect auto|escp|msx-kanji|msx-hangul]');
  say('                          [--charset GLYPHS] [--all] [--text [--text-charset CS] [-o FILE]]');
  say('                          [--kanji-rom ROM] [--font X.ttf] [--font-size N] [--pdf]');
  say('       msx_printer_render --list | --list-fonts | --selftest [out_prefix]');
  if (err) say(`msx_printer_render: error: ${err}`);
  return err ? 2 : 0;
}

function listGlyphs() {
  say('glyph sets (--charset):');
  for (const cs of GLYPHS) say(`  ${cs.padEnd(9)} ${DESCRIPTIONS[cs] || ''}${cs === DEFAULT_CHARSET ? '  <- default' : ''}`);
  say('\ntext codecs (--text-charset):');
  say(`  ${TEXT_CHARSETS.join(' ')}`);
  return 0;
}

function listFonts() {
  const rom = findRom();
  say("kanji ROM (preferred - what the machine itself printed):");
  say(rom ? `  ${rom}` : '  (none found; set $MSX_KANJI_ROM or pass --kanji-rom)');
  say(`\nbundled fonts in ${FONT_DIR}, best first:`);
  for (const [script, names] of [['jp', BUNDLED_JP], ['kr', BUNDLED_KR]])
    names.forEach((n, rank) => {
      let note = fs.existsSync(path.join(FONT_DIR, n)) ? '' : '   (missing)';
      if (rank === 0 && !note) note = '   <- fallback for this script';
      say(`  [${script}] ${n}${note}`);
    });
  return 0;
}

// 64x48 상자에 X 와 채운 모서리 - 파이썬 escp_render --selftest 와 같은 그림이다.
// ESC * 39 (180 dpi 24 점) 로 싸서 인터프리터에 다시 먹이고 점 몇 개를 확인한다.
function selftestGrid() {
  const W = 64, H = 48, m = Math.min(W, H) - 1;
  const g = Array.from({ length: H }, () => new Uint8Array(W));
  for (let x = 0; x < W; x++) g[0][x] = g[H - 1][x] = 1;
  for (let y = 0; y < H; y++) g[y][0] = g[y][W - 1] = 1;
  for (let i = 0; i <= m; i++) {
    g[Math.floor(i * (H - 1) / m)][Math.floor(i * (W - 1) / m)] = 1;
    g[Math.floor(i * (H - 1) / m)][W - 1 - Math.floor(i * (W - 1) / m)] = 1;
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) g[2 + y][2 + x] = 1;
  return g;
}

function bitmapToEscp(grid, mode = 39) {
  const h = grid.length, w = h ? grid[0].length : 0;
  const out = [0x1b, 0x33, 24];
  for (let top = 0; top < h; top += 24) {
    out.push(0x0d, 0x1b, 0x2a, mode, w & 0xff, (w >> 8) & 0xff);
    for (let x = 0; x < w; x++)
      for (let b = 0; b < 3; b++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) {
          const ry = top + b * 8 + bit;
          if (ry < h && grid[ry][x]) v |= 0x80 >> bit;
        }
        out.push(v);
      }
    out.push(0x0a);
  }
  return Buffer.from(out);
}

function selftest(prefix) {
  const stream = bitmapToEscp(selftestGrid());
  const r = new Renderer().feed(stream);
  const page = r.pages[0];
  const at = (x, y) => (y < page.rows.length && x < page.width && (page.rows[y][x >> 3] & (0x80 >> (x & 7))) ? 1 : 0);
  const checks = [
    ['top-left corner set', at(0, 0) === 1],
    ['inner block set', at(4, 4) === 1],
    ['interior gap empty', at(20, 40) === 0],
    ['bottom-right corner set', at(63, 47) === 1],
    ['outside is blank', at(70, 5) === 0],
  ];
  for (const [name, v] of checks) say(`  [${v ? 'OK' : '!!'}] ${name}`);
  const paths = writeSheets(r.pages.filter((p) => !p.empty).map((p) => pageCrop(p)), prefix);
  say(`  stream: ${stream.length} bytes -> ${paths.join(', ')}  (${page.maxx + 1}x${page.maxy + 1} px)`);
  return checks.every(([, v]) => v) ? 0 : 1;
}

function printPages(pages) {
  pages.forEach((lines, n) => { say(`--- page ${n + 1}`); for (const l of lines) say(l); });
}

function write(sheets, prefix, pdf) {
  const paths = writeSheets(sheets, prefix);
  if (pdf) {
    const out = `${prefix}.pdf`;
    fs.writeFileSync(out, pagesPdf(sheets.map((s) => s.img), 300));
    paths.push(out);
  }
  return paths;
}

function escpSheets(data, glyphs) {
  const r = new Renderer({ charset: glyphs }).feed(data);
  const keep = r.pages.filter((p) => !p.empty);
  return { r, sheets: (keep.length ? keep : r.pages.slice(0, 1)).map((p) => pageCrop(p)) };
}

async function main(argv) {
  const a = { job: null, prefix: null, dialect: 'auto', charset: DEFAULT_CHARSET, all: false, text: false,
              textCharset: 'cp437', out: null, rom: null, font: null, size: 48, pdf: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    try {
      if (k === '-h' || k === '--help') return usage();
      if (k === '--list') return listGlyphs();
      if (k === '--list-fonts') return listFonts();
      if (k === '--selftest') return selftest(argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : 'escp_selftest');
      if (k === '--dialect') a.dialect = val();
      else if (k === '--charset') a.charset = val();
      else if (k === '--all') a.all = true;
      else if (k === '--text') a.text = true;
      else if (k === '--text-charset') a.textCharset = val();
      else if (k === '-o' || k === '--output') a.out = val();
      else if (k === '--kanji-rom') a.rom = val();
      else if (k === '--font') a.font = val();
      else if (k === '--font-size' || k === '--size') a.size = Number.parseInt(val(), 10);
      else if (k === '--pdf') a.pdf = true;
      else if (k.startsWith('-')) return usage(`unrecognized arguments: ${k}`);
      else if (!a.job) a.job = k;
      else if (!a.prefix) a.prefix = k;
      else return usage(`unrecognized arguments: ${k}`);
    } catch (e) { return usage(e.message); }
  }
  if (!a.job) return usage();
  if (!GLYPHS.includes(a.charset)) { say(`[-] unknown --charset '${a.charset}' (${GLYPHS.join('|')})  - see --list`); return 1; }
  if (!['auto', 'escp', 'msx-kanji', 'msx-hangul'].includes(a.dialect)) return usage(`unknown --dialect '${a.dialect}'`);
  let data;
  try { data = fs.readFileSync(a.job); } catch (e) { say(`[-] ${e.message}`); return 1; }
  // 한글·한자 방언을 못 박고 --text 면 코덱이 아니라 방언으로 푼 글이다 - 자모를
  // cp437 로 풀면 쓰레기다. 파이썬 hangul_render 가 글꼴 없이 하던 출력과 같다.
  if (a.text && (a.dialect === 'msx-hangul' || a.dialect === 'msx-kanji')) {
    printPages(a.dialect === 'msx-hangul' ? hangulDecode(data) : kanjiText(data));
    return 0;
  }
  say(`[*] ${a.job}: ${data.length} bytes`);
  const prefix = a.out && !a.text ? a.out : a.prefix || a.job.replace(/\.[^./]+$/, '');

  if (a.text) {
    const text = decodeText(data, a.textCharset);
    const target = a.out || (a.prefix ? `${a.prefix}.txt` : null);
    if (target) { fs.writeFileSync(target, text, 'utf8'); say(`[+] text (${a.textCharset}) -> ${target}`); }
    else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  if (a.all) {
    for (const cs of GLYPHS) {
      const { sheets } = escpSheets(data, cs);
      say(`[+] ${cs.padEnd(9)} -> ${writeSheets(sheets, `${prefix}_${cs}`).join(', ')}`);
    }
    return 0;
  }

  const dialect = a.dialect === 'auto' ? detectDialect(data) : a.dialect;
  if (dialect === 'msx-kanji') {
    // --font 가 무엇보다 앞선다, 그다음 --kanji-rom, 찾은 ROM, 딸린 글꼴 (kanji_render.resolve_font).
    const romPath = a.font ? null : a.rom || findRom();
    if (romPath) {
      const r = new KanjiRenderer(fs.readFileSync(romPath)).feed(data);
      const keep = r.pages.filter((p) => !p.empty);
      const paths = write((keep.length ? keep : r.pages.slice(0, 1)).map((p) => pageCrop(p)), prefix, a.pdf);
      say(`[+] msx-kanji with kanji ROM ${path.basename(romPath)}: ${paths.join(', ')}`
        + (r.missing ? `  (${r.missing} chars beyond ROM size - JIS2 needs 256kB)` : ''));
      return 0;
    }
    const fp = a.font || findBundledFont('jp');
    if (!fp) { say('[-] nothing to draw with: pass --kanji-rom KNJFNT16.ROM (128/256kB) or --font X.ttf'); return 1; }
    const paths = write(typesetSheets(kanjiText(data), fp, a.size), prefix, a.pdf);
    say(`[+] msx-kanji with font ${path.basename(fp)}: ${paths.join(', ')}`);
    return 0;
  }
  if (dialect === 'msx-hangul') {
    const fp = a.font || findBundledFont('kr');
    if (!fp) {
      say('[-] no hangul font to draw with (--font Galmuri11.ttf); here is the text:');
      printPages(hangulDecode(data));
      return 1;
    }
    const paths = write(typesetSheets(hangulDecode(data), fp, a.size), prefix, a.pdf);
    say(`[+] msx-hangul with font ${path.basename(fp)}: ${paths.join(', ')}`);
    return 0;
  }
  // ESC/P. picoprinter 에 쓴 작업은 1:1 로 (recharset 이 그랬다).
  const pico = picoprinterSheet(data);
  if (pico) {
    const paths = write([pico], prefix, a.pdf);
    say(`[+] 1 page(s), msx-picoprinter bit image laid 1:1 -> ${paths.join(', ')}`);
    return 0;
  }
  const { r, sheets } = escpSheets(data, a.charset);
  const paths = write(sheets, prefix, a.pdf);
  let note = `charset ${r.charset}`;
  if (r.charset === 'cp437') note += ' (FX-80 glyphs, CP437 upper region mapped)';
  say(`[+] ${paths.length} page(s), ${note}, ${r.textBytes} text bytes -> ${paths.join(', ')}`);
  if (r.unknown.size) say(`    unhandled ESC codes: ${[...r.unknown].map(([k, v]) => `${k} x${v}`).join(', ')}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
