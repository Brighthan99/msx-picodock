// SPDX-License-Identifier: GPL-2.0-only  (ported from src/host/printer/ - see NOTICE.md)
// escpos.js — 그린 페이지 -> 영수증 프린터의 ESC/POS, 그리고 프린터까지.
//
// src/host/printer/msx_printer_escpos.py 를 옮겼다 (2026-09-25). **바이트가
// 같아야 한다** - msx-picoprinter 의 동작하는 드라이버가 보내는 것과 같은 것을
// 보내려고 다섯 장의 영수증을 쓴 결과이기 때문이다 (머리말은 파이썬 쪽에 길게
// 남아 있다). test/print_crosscheck.py 가 가짜 장치로 바이트를 견준다.
//
//     ESC @                        1B 40         초기화
//     GS v 0 m xL xH yL yH <data>  1D 76 30 ...  래스터 비트맵 (기본)
//     ESC * m nL nH <data>                       옛 방식 (--mode bitimage)
//     LF LF LF                                   찢는 날을 지나게

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { resizeLanczos, threshold, floydSteinberg, rotate90, toRaster, gray } from './imageops.js';
import { nativeBitmap } from './escp.js';
import { Spool } from './printer.js';
import { renderSheets, writeSheets, stamp, pyRound } from './printrender.js';
import { png1bit, pngBilevel } from './png.js';

//: 종이 폭(mm) -> 헤드의 점 수. 프린터가 정한다 - 58mm 프린터는 무슨 롤을 넣든 384.
export const HEADS = { 58: 384, 80: 576, 112: 832 };
export const ESC_INIT = Buffer.from([0x1b, 0x40]);
export const FEED_END = Buffer.from('\n\n\n');
export const HALFTONES = ['threshold', 'dither'];
export const DEFAULT_HALFTONE = 'threshold';
export const THRESHOLD = 128;
export const MAX_BAND_DOTS = 255;
//: ESC * m -> (띠 높이, 가로 dpi, 세로 dpi)
export const BAND_MODES = { 0: [8, 90, 60], 1: [8, 180, 60], 32: [24, 90, 180], 33: [24, 180, 180] };
export const DEFAULT_BAND_MODE = 33;
export const DEFAULT_MODE = 'raster';
export const HEAD_DPI = 203;
export const PAD_BOTTOM = 0;
export const MERGE_GAP = 8;

/** 회색 -> 흑백. 기본은 문턱값 - MSX 가 찍는 것은 선화라 망점이 빗살이 된다. */
export function to1bit(img, halftone = DEFAULT_HALFTONE, level = THRESHOLD) {
  return halftone === 'dither' ? floydSteinberg(img) : threshold(img, level);
}

/**
 * 그림 -> GS v 0 이 원하는 (행 바이트, 행 수, 데이터). **언제나 헤드 폭으로,
 * 늘리든 줄이든** - picoprinter 의 영수증 도구가 그렇게 해서 롤을 채운다.
 * `on` 이면 옆으로 돌린다 (종이를 쓰는 대신 해상도를 산다).
 */
export function pageToRaster(img, widthDots, rotate = 'auto', halftone = DEFAULT_HALFTONE) {
  let im = img;
  if (rotate === 'on') im = rotate90(im);
  const h = Math.max(1, pyRound(im.height * widthDots / im.width));
  im = resizeLanczos(im, widthDots, h);
  const bw = to1bit(im, halftone);
  const r = toRaster(bw);
  return [r.rb, r.rows, Buffer.from(r.data)];
}

/** 같은 그림을 ESC * 로 - 띠마다, 열마다, 맨 위 점이 최상위 비트. */
export function bitimageCommand(rowBytes, rows, data, m = DEFAULT_BAND_MODE, spacing = null, msbTop = true) {
  const [height, , vdpi] = BAND_MODES[m];
  const perCol = height / 8;
  const width = rowBytes * 8;
  const out = [Buffer.from([0x1b, 0x33, spacing !== null ? spacing : pyRound(height * 180 / vdpi)])];
  for (let top = 0; top < rows; top += height) {
    const col = Buffer.alloc(width * perCol);
    for (let bit = 0; bit < height; bit++) {
      const y = top + bit;
      if (y >= rows) break;
      const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
      const byte = Math.floor(bit / 8), inByte = bit % 8;
      const mask = msbTop ? 0x80 >> inByte : 1 << inByte;
      for (let x = 0; x < width; x++)
        if (row[x >> 3] & (0x80 >> (x & 7))) col[x * perCol + byte] |= mask;
    }
    out.push(Buffer.from([0x1b, 0x2a, m, width & 0xff, width >> 8]), col, Buffer.from('\n'));
  }
  out.push(Buffer.from([0x1b, 0x32]));
  return Buffer.concat(out);
}

export function rasterCommand(rowBytes, rows, data) {
  return Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8,
                                     rows & 0xff, rows >> 8]), Buffer.from(data)]);
}

/** 풀어 놓은 래스터 -> 흑백 그림 (0 = 검정). 종이가 실제로 보여 줄 것. */
export function unpack(rowBytes, rows, data) {
  const img = gray(rowBytes * 8, rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < rowBytes * 8; x++)
      if (data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) img.data[y * img.width + x] = 0;
  return img;
}

/** **보낼 바이트를 되푼 것**을 미리보기로. 원본에서 만든 미리보기는 뜻한 것을 보여 줄 뿐이다. */
export function savePreview(images, p) {
  const gap = 12;
  const w = Math.max(...images.map((i) => i.width));
  const h = images.reduce((a, i) => a + i.height, 0) + gap * (images.length - 1);
  const sheet = gray(w, h);
  let y = 0;
  for (const i of images) {
    for (let r = 0; r < i.height; r++) sheet.data.set(i.data.subarray(r * i.width, (r + 1) * i.width), (y + r) * w);
    y += i.height + gap;
  }
  fs.writeFileSync(p, pngBilevel(sheet));
}

/** 이미 묶인 래스터들 [(rb, rows, data)] -> 한 줄기. 1:1 경로. */
export function buildRasters(rasters, { init = true, feed = true, mode = DEFAULT_MODE, preview = null } = {}) {
  const out = [];
  if (init) out.push(ESC_INIT);
  for (const [rb, rows, data] of rasters)
    out.push(mode === 'bitimage' ? bitimageCommand(rb, rows, data) : rasterCommand(rb, rows, data));
  if (feed) out.push(FEED_END);
  if (preview !== null && rasters.length) savePreview(rasters.map(([rb, rows, d]) => unpack(rb, rows, d)), preview);
  return Buffer.concat(out);
}

/**
 * 그림들 -> 한 줄기. **ESC * 는 헤드를 다 못 쓴다** - 띠는 한 명령 한 줄이라
 * band_max 에 맞추고, 바이트 단위로 내린다.
 */
export function build(images, widthDots = 384, { init = true, feed = true, rotate = 'auto', preview = null,
                                                 mode = DEFAULT_MODE, bandMax = MAX_BAND_DOTS,
                                                 halftone = DEFAULT_HALFTONE } = {}) {
  const out = [];
  const shown = [];
  const cap = Math.floor(bandMax / 8) * 8;
  const fit = mode === 'bitimage' ? Math.min(widthDots, cap) : widthDots;
  if (init) out.push(ESC_INIT);
  for (const im of images) {
    const [rb, rows, data] = pageToRaster(im, fit, rotate, halftone);
    if (preview !== null) shown.push(unpack(rb, rows, data));
    out.push(mode === 'bitimage' ? bitimageCommand(rb, rows, data) : rasterCommand(rb, rows, data));
  }
  if (feed) out.push(FEED_END);
  if (preview !== null && shown.length) savePreview(shown, preview);
  return Buffer.concat(out);
}

/** "3", "1-7", "1,3,5-6" -> [3], [1..7], [1,3,5,6]. 순서대로, 겹침 없이. */
export function jobNumbers(spec) {
  const out = [];
  for (let part of String(spec).split(',')) {
    part = part.trim();
    if (!part) continue;
    let rng;
    if (part.includes('-')) {
      const [a, b] = part.split('-', 2);
      const lo = pyInt(a), hi = pyInt(b);
      rng = Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
    } else rng = [pyInt(part)];
    for (const n of rng) if (!out.includes(n)) out.push(n);
  }
  return out;
}

function pyInt(s) {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return Number.parseInt(s, 10);
}

/** 여러 래스터를 한 쪽에 위에서 아래로 - **바이트가 아니라 그림을** 잇는다. */
export function stackRasters(parts, gap = 0) {
  if (!parts.length) return null;
  const rb = Math.max(...parts.map((p) => p[0]));
  const rows = parts.reduce((a, p) => a + p[1], 0) + gap * (parts.length - 1);
  const out = Buffer.alloc(rb * rows);
  let y = 0;
  parts.forEach(([prb, prows, data], i) => {
    if (i) y += gap;
    for (let r = 0; r < prows; r++) out.set(data.subarray(r * prb, (r + 1) * prb), (y + r) * rb);
    y += prows;
  });
  return [rb, rows, out];
}

/** picoprinter 의 사적인 블록 (ESC ( P <len16> ...) 을 뺀다 - 보통 ESC/P 는 그걸 글로 찍는다. */
export function stripPicoprinter(job) {
  const out = [];
  let i = 0;
  const n = job.length;
  while (i < n) {
    if (job[i] === 0x1b && i + 4 < n && job[i + 1] === 0x28 && job[i + 2] === 0x50) {
      i += 5 + (job[i + 3] | (job[i + 4] << 8));
      continue;
    }
    out.push(job[i]);
    i += 1;
  }
  return Buffer.from(out);
}

function findJobs(stem, seqs) {
  const spool = new Spool(stem);
  const want = typeof seqs === 'number' ? [seqs] : [...seqs];
  const found = new Map(spool.jobs().map((j) => [j.seq, j]));
  for (const s of want) if (!found.has(s)) throw new Error(`no job ${s} in ${path.basename(stem)}`);
  return { spool, want, found };
}

/** 스풀 작업의 제 바이트 - ESC/P 를 스스로 아는 프린터에게. 둘째부터는 ESC @ 를 앞에. */
export function rawFromSpool(stem, seqs, priv = false) {
  const { spool, want, found } = findJobs(stem, seqs);
  const out = [];
  want.forEach((seq, i) => {
    let data = spool.read(found.get(seq));
    data = priv ? Buffer.from(data) : stripPicoprinter(data);
    if (i && !data.subarray(0, 2).equals(ESC_INIT)) out.push(ESC_INIT);
    out.push(data);
  });
  return Buffer.concat(out);
}

/** 1:1 로 놓인 스풀 작업들 -> [rb, rows, data, 남긴PNG] 또는 null (글자가 있다). */
export function nativeFromSpool(stem, seqs, head = 384, keepDir = null, padBottom = PAD_BOTTOM, gap = MERGE_GAP) {
  const { spool, want, found } = findJobs(stem, seqs);
  const parts = [];
  let first = null;
  for (const seq of want) {
    const got = nativeBitmap(spool.read(found.get(seq)), { head, padBottom });
    if (!got) return null;
    parts.push([got.rowBytes, got.rows, Buffer.from(got.data)]);
    if (!first) first = found.get(seq);
  }
  const [rb, rows, data] = stackRasters(parts, gap);
  let kept = null;
  if (keepDir) {
    fs.mkdirSync(keepDir, { recursive: true });
    const tag = want.length === 1 ? `j${String(want[0]).padStart(3, '0')}`
                                  : `j${String(want[0]).padStart(3, '0')}+${want.length - 1}`;
    kept = path.join(keepDir, `${path.basename(stem)}_${tag}_${stamp(first.t0)}.png`);
    const r = [];
    for (let y = 0; y < rows; y++) r.push(data.subarray(y * rb, (y + 1) * rb));
    fs.writeFileSync(kept, png1bit(rb * 8, r));
  }
  return [rb, rows, data, kept];
}

/**
 * 스풀 작업 하나 -> 그린 페이지들 (파일로 남긴다). `keepDir` 가 없으면 임시 폴더에
 * 두고 [경로들, 임시폴더] 를 돌려준다 - 치우는 것은 부른 쪽이다.
 */
export function pagesFromSpool(stem, seq, keepDir = null, glyphs = 'msx') {
  const spool = new Spool(stem);
  const job = spool.jobs().find((j) => j.seq === seq);
  if (!job) throw new Error(`no job ${seq} in ${path.basename(stem)}`);
  let tmp = null;
  let outDir = keepDir;
  if (keepDir) fs.mkdirSync(keepDir, { recursive: true });
  else tmp = outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdescpos-'));
  const prefix = path.join(outDir, `${path.basename(stem)}_j${String(seq).padStart(3, '0')}_${stamp(job.t0)}`);
  const sheets = renderSheets(spool.read(job), glyphs);
  if (!sheets.length) throw new Error(`job ${seq} drew no pages`);
  return [writeSheets(sheets, prefix), tmp, sheets.map((s) => s.img)];
}

// ------------------------------------------------------------------ 시험 띠

/** 대각선과 32 점마다 눈금이 있는 정사각형 - 세로 밀도가 틀리면 직사각형으로 나온다. */
export function square(side = 96) {
  const rb = (side + 7) >> 3;
  const out = Buffer.alloc(rb * side);
  const dot = (x, y) => { if (x >= 0 && x < side && y >= 0 && y < side) out[y * rb + (x >> 3)] |= 0x80 >> (x & 7); };
  for (let i = 0; i < side; i++) { dot(i, 0); dot(i, side - 1); dot(0, i); dot(side - 1, i); dot(i, i); }
  for (let x = 0; x < side; x += 32) for (let y = 0; y < 8; y++) dot(x, y);
  return [rb, side, out];
}

//: 시험 띠가 해 보는 것들: (이름, m, 줄 간격, 맨 위 최상위).
export const PROBE_TRIES = [['A GS v 0', null, null, null], ['B ESC* m33', 33, 24, true]];

export function probe(side = 96, tries = PROBE_TRIES) {
  const [rb, rows, data] = square(side);
  const out = [ESC_INIT];
  for (const [label, m, spacing, msb] of tries) {
    out.push(Buffer.from(`${label}\n`));
    out.push(m === null ? rasterCommand(rb, rows, data) : bitimageCommand(rb, rows, data, m, spacing, msb));
    out.push(Buffer.from('\n'));
  }
  out.push(FEED_END);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ 보내기

export const CUPS_USB_BACKEND = '/usr/libexec/cups/backend/usb';
export const USB_CHUNK = 4096;
export const USB_TIMEOUT_MS = 5000;
export const CLS_PRINTER = 0x07;

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000, maxBuffer: 1 << 20, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/** lpinfo 가 말하는 USB 프린터 가운데 CMD:ESCPOS 라고 스스로 밝힌 것의 URI. */
export async function findUsbPrinter() {
  const r = await run('lpinfo', ['--include-schemes', 'usb', '-l', '-v']);
  if (r.err && !r.stdout) return null;
  let uri = null;
  for (let line of r.stdout.split('\n')) {
    line = line.trim();
    if (line.includes('uri = ')) uri = line.split('uri = ')[1].trim();
    else if (line.startsWith('device-id = ') && uri) {
      const u = line.toUpperCase();
      if (u.includes('ESCPOS') || u.includes('ESC/POS')) return uri;
    }
  }
  return null;
}

async function loadUsb() {
  try { return (await import('usb')).usb; } catch {
    throw new Error('the usb package is needed to reach the printer: run npm install in the node folder '
      + '(and libusb on Linux: apt install libusb-1.0-0)');
  }
}

//: usb 3.x 는 WebUSB 식 API 만 남겼다 (usb.getDevices, open, claimInterface,
//: transferOut). pyusb 가 하던 것 - 인터페이스 잡기, 벌크 OUT 찾기, 4 KB 씩 5 초 -
//: 은 그대로다.
//: 쓰는 중이거나 우리 것이 아닌 장치는 서술자를 읽다 던진다 - 건너뛴다 (파이썬도
//: get_active_configuration 이 실패하면 continue 했다).
function isPrinter(d) {
  try {
    return (d.configurations || []).some((c) => (c.interfaces || []).some(
      (i) => (i.alternates || [i.alternate]).some((a) => a && a.interfaceClass === CLS_PRINTER)));
  } catch { return false; }
}
const hex4 = (n) => n.toString(16).padStart(4, '0');
const idOf = (d) => `${hex4(d.vendorId)}:${hex4(d.productId)}`;

/** 프린터 장치: VID:PID 가 있으면 그것, 없으면 프린터 클래스 인터페이스가 있는 단 하나. */
export async function findUsbDevice(vidPid = null) {
  const usb = await loadUsb();
  const all = await usb.getDevices();
  if (vidPid) {
    const [v, p] = vidPid.split(':').map((t) => Number.parseInt(t, 16));
    const d = all.find((x) => x.vendorId === v && x.productId === p);
    if (!d) throw new Error(`no USB device ${vidPid}`);
    return d;
  }
  const found = all.filter(isPrinter);
  if (!found.length) throw new Error('no USB printer-class device - plug it in with a cable that carries data');
  if (found.length > 1)
    throw new Error(`more than one USB printer (${found.map(idOf).join(', ')}); pick one with --usb VID:PID`);
  return found[0];
}

/** 벌크 OUT 끝점에 4 KB 씩, 5 초 시한으로 - 동작하는 도구가 하는 그대로. */
export async function sendUsbBulk(data, vidPid = null) {
  const d = await findUsbDevice(vidPid);
  await d.open();
  try {
    if (!d.configuration) await d.selectConfiguration(1);
    let ep = null, itf = null;
    for (const i of d.configuration.interfaces) {
      const alt = i.alternate || i.alternates[0];
      for (const e of alt.endpoints)
        if (e.direction === 'out' && e.type === 'bulk') { ep = e; itf = i.interfaceNumber; break; }
      if (ep) break;
    }
    if (!ep) throw new Error('the printer has no bulk OUT endpoint');
    try { await d.detachKernelDriver(itf); } catch { /* 리눅스가 아니거나 붙은 것이 없다 */ }
    await d.claimInterface(itf);
    try {
      let sent = 0;
      for (let i = 0; i < data.length; i += USB_CHUNK) {
        const chunk = new Uint8Array(data.subarray(i, i + USB_CHUNK));
        const r = await d.transferOut(ep.endpointNumber, chunk, USB_TIMEOUT_MS);
        if (r && r.status && r.status !== 'ok') throw new Error(`USB transfer ${r.status}`);
        sent += r && typeof r.bytesWritten === 'number' ? r.bytesWritten : chunk.length;
      }
      return sent;
    } finally { await d.releaseInterface(itf); }
  } finally { try { await d.close(); } catch { /* 이미 닫혔다 */ } }
}

/** CUPS 의 USB 백엔드로. **1 KB 쯤에서 잘리는 것이 알려져 있다** - libusb 가 없는 기계를 위해 둔다. */
export async function sendUsbCups(data, uri, title = 'picodock') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdescpos-'));
  const p = path.join(dir, 'job.escpos');
  try {
    fs.writeFileSync(p, data);
    const r = await run(CUPS_USB_BACKEND, ['1', process.env.USER || 'msx', title, '1', '', p],
      { env: { ...process.env, DEVICE_URI: uri }, timeout: 180000 });
    const bad = r.stderr.split('\n').filter((l) => l.startsWith('ERROR:')).map((l) => l.slice(7));
    if (bad.length) throw new Error(bad.join('; '));
    return data.length;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** USB 프린터로. `target` 은 auto, VID:PID, 또는 CUPS 의 usb:// URI. */
export async function sendUsb(data, target = 'auto', via = 'pyusb') {
  if (via === 'cups' || String(target).startsWith('usb://')) {
    const uri = target === 'auto' ? await findUsbPrinter() : target;
    if (!uri) throw new Error('no USB printer that says CMD:ESCPOS');
    return sendUsbCups(data, uri);
  }
  return sendUsbBulk(data, target === 'auto' ? null : target);
}

/** 직렬 포트로, 버퍼를 넘기지 않게 256 바이트씩 비우며. */
export async function sendSerial(data, port, baud = 9600) {
  let SerialPort;
  try { ({ SerialPort } = await import('serialport')); } catch {
    throw new Error('the serialport package is needed to print to a serial port: run npm install in the node folder');
  }
  const sp = new SerialPort({ path: port, baudRate: baud, autoOpen: false });
  await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())));
  try {
    for (let i = 0; i < data.length; i += 256) {
      await new Promise((resolve, reject) => sp.write(data.subarray(i, i + 256), (e) => (e ? reject(e) : resolve())));
      await new Promise((resolve, reject) => sp.drain((e) => (e ? reject(e) : resolve())));
    }
    return data.length;
  } finally { await new Promise((resolve) => sp.close(() => resolve())); }
}

/** 프린터 클래스 USB 장치들 [[VID:PID, 이름]]. */
export async function listUsb(say = console.log) {
  let usb;
  try { usb = await loadUsb(); } catch {
    say('USB printers: the usb package is not installed, so this cannot look.');
    say('  npm install   (in the node folder)');
    return [];
  }
  const found = (await usb.getDevices()).filter(isPrinter)
    .map((d) => [idOf(d), d.productName || d.manufacturerName || '?']);
  say('USB printers:');
  if (!found.length) {
    say('  none. A charge-only cable, or two adapters stacked, gives a');
    say('  printer power and no data - it lights up and stays invisible.');
  }
  for (const [vp, n] of found) say(`  ${vp}   ${n}`);
  return found;
}
