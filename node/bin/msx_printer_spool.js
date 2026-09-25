#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only  (ported from src/host/printer/ - see NOTICE.md)
// msx_printer_spool.js — 스풀을 보고, 작업을 파일로 그리고, 여러 작업을 문서
// 하나로 합친다. src/host/printer/msx_printer_spool.py 의 Node 판이고 사용법도
// 같다. 하는 일은 ../src/printrender.js 에 있다.
//
//   node bin/msx_printer_spool.js list
//   node bin/msx_printer_spool.js render -j 3 -m text
//   node bin/msx_printer_spool.js merge <spool> -j 1-3 -m raster --style host -o /tmp/x

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Spool } from '../src/printer.js';
import { detect } from '../src/printer_detect.js';
import { savePrintJob, mergePdf, stamp, rel } from '../src/printrender.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
//: 스크립트 기준이다 - 서버를 어디서 띄우든 같은 폴더. dist 에서는 dist/output.
export const DEFAULT_OUTPUT = path.resolve(HERE, '..', '..', 'output');
export const DEFAULT_DIR = path.join(DEFAULT_OUTPUT, 'spool');

const say = (s) => console.log(s);
const note = (level, text) => say(`[${level}] ${text}`);

/** "3", "1-7", "1,3,5-6" -> 번호들. 비었거나 all 이면 전부 (빈 배열). */
function parseSeqs(spec) {
  if (!spec || spec === 'all') return [];
  const out = new Set();
  for (let part of spec.split(',')) {
    part = part.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-', 2).map((x) => Number.parseInt(x, 10));
      for (let n = a; n <= b; n++) out.add(n);
    } else if (part) out.add(Number.parseInt(part, 10));
  }
  return [...out];
}

function fmtSize(n) {
  for (const [unit, step] of [['B', 1], ['KB', 1024], ['MB', 1024 * 1024]])
    if (n < step * 1024) return unit === 'B' ? `${n} ${unit}` : `${(n / step).toFixed(1)} ${unit}`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function latest(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.prn')).sort(); } catch { return null; }
  return names.length ? new Spool(path.join(dir, names[names.length - 1].slice(0, -4))) : null;
}

function list(spool) {
  const jobs = spool.jobs();
  say(`${spool.name}  (${jobs.length} job(s), ${fmtSize(fs.statSync(spool.prnPath).size)})`);
  if (!jobs.length) { say('  (empty)'); return; }
  say('  seq  when      size       guess');
  for (const j of jobs) {
    let guess;
    try { const d = detect(spool.read(j)); guess = d.mode + (d.charset ? ` --charset ${d.charset}` : ''); }
    catch { guess = '?'; }
    const t = new Date(j.t0 * 1000).toTimeString().slice(0, 8);
    say(`  ${String(j.seq).padStart(3)}  ${t}  ${fmtSize(j.len).padEnd(9)}  ${guess}${j.end === 'unclosed' ? '  [unclosed]' : ''}`);
  }
}

function usage(err) {
  console.error('usage: msx_printer_spool {list,render,merge} [spool] [-j JOBS] [-m MODE] [--charset CS]\n'
    + '                         [--glyphs SET] [--stack] [--style {msx,host}] [-d DIR] [-o OUT]');
  if (err) console.error(`msx_printer_spool: error: ${err}`);
  return 2;
}

async function main(argv) {
  const a = { command: null, spool: null, jobs: 'all', mode: null, charset: 'cp437', glyphs: 'msx',
              stack: false, style: null, dir: DEFAULT_DIR, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`argument ${k}: expected one argument`); return argv[++i]; };
    try {
      if (k === '-h' || k === '--help') { usage(); return 0; }
      if (k === '-j' || k === '--jobs') a.jobs = val();
      else if (k === '-m' || k === '--mode') a.mode = val();
      else if (k === '--charset') a.charset = val();
      else if (k === '--glyphs') a.glyphs = val();
      else if (k === '--stack') a.stack = true;
      else if (k === '--style') { a.style = val(); if (!['msx', 'host'].includes(a.style)) return usage(`argument --style: invalid choice: '${a.style}'`); }
      else if (k === '-d' || k === '--dir') a.dir = val();
      else if (k === '-o' || k === '--out') a.out = val();
      else if (!a.command) { if (!['list', 'render', 'merge'].includes(k)) return usage(`argument command: invalid choice: '${k}'`); a.command = k; }
      else if (!a.spool) a.spool = k;
      else return usage(`unrecognized arguments: ${k}`);
    } catch (e) { return usage(e.message); }
  }
  if (!a.command) return usage('the following arguments are required: command');

  let spool;
  try { spool = a.spool ? new Spool(a.spool) : latest(a.dir); } catch (e) { say(`[-] ${e.message}`); return 1; }
  if (!spool) { say(`[-] no spool found in ${a.dir}`); return 1; }
  if (a.command === 'list') { list(spool); return 0; }

  const seqs = parseSeqs(a.jobs);
  const outDir = a.out || DEFAULT_OUTPUT;
  if (a.command === 'render') {
    let n = 0;
    for (const j of spool.jobs()) {
      if (seqs.length && !seqs.includes(j.seq)) continue;
      savePrintJob(spool.read(j), a.mode || 'auto', `${spool.name}_j${String(j.seq).padStart(3, '0')}`,
        { charset: a.charset, glyphs: a.glyphs, timestamp: stamp(j.t0), outDir, say: note });
      n += 1;
    }
    say(`[+] rendered ${n} job(s) to ${rel(outDir)}`);
    return 0;
  }
  // merge
  const mode = a.mode || 'raw';
  let out = null;
  if (a.style !== 'host' && mode !== 'raster') {
    // 바이트를 이어 붙여도 되는 모드들: 이어 붙이고 그대로 그린다.
    const jobs = spool.jobs().filter((j) => !seqs.length || seqs.includes(j.seq));
    if (jobs.length) {
      const when = stamp(jobs[0].t0);
      savePrintJob(Buffer.concat(jobs.map((j) => spool.read(j))), mode, `${spool.name}_merged`,
        { charset: a.charset, glyphs: a.glyphs, timestamp: when, outDir, say: note });
      out = path.join(outDir, `${spool.name}_merged_${when}`);
    }
  } else {
    out = mergePdf(spool.stem, seqs, { style: a.style, charset: a.charset, glyphs: a.glyphs,
                                       stack: a.stack, outDir });
  }
  say(out ? `[+] merged -> ${out}` : '[-] nothing to merge');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
