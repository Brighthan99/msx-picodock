// SPDX-License-Identifier: GPL-2.0-only  (ported from src/host/printer/ - see NOTICE.md)
// printrender.js — MSX 가 찍은 바이트를 볼 수 있는 것으로: 글, PNG, PDF.
//
// src/host/printer/ 의 msx_printer_render.save_print_job, msx_printer_recharset
// (render / render_host), msx_printer_kanji_render (한자 ROM, 번들 글꼴),
// msx_printer_spool.merge 를 옮겼다 (2026-09-25). 사용자가 파이썬을 깔지 않아도
// 되게 하려고.
//
// ESC/P 를 그리는 것은 이미 옮겨 두었던 escp.js 이고 (test/escp_crosscheck.py),
// 여기서는 그 페이지를 파이썬과 **같은 모양으로 잘라** PNG/PDF 로 낸다. 같은
// 이름, 같은 폴더, 같은 말. test/print_crosscheck.py 가 파이썬과 견준다.
//
// TTF 로 글자를 다시 그리는 곳(한글, ROM 없는 한자, host 스타일)만은 파이썬
// (FreeType)과 점 단위로 같을 수 없다 - ttf.js 의 머리말을 볼 것.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render as escpRender, Renderer as EscpRenderer, nativeBitmap, hasPicoprinterMark, HEAD_DPI } from './escp.js';
import { KanjiRenderer, extractText as kanjiText } from './kanji.js';
import { decode as hangulDecode } from './hangul.js';
import { detect } from './printer_detect.js';
import { decodeMsx } from './printer_text.js';
import { decodeReplace, LookupError } from './codecs.js';
import { Spool } from './printer.js';
import { gray, fromBits, resizeLanczos, paste } from './imageops.js';
import { png1bit, pngGray, pngBilevel } from './png.js';
import { pagesPdf, textPdf } from './pdfwrite.js';
import { Font, textLength, drawText } from './ttf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 저장소의 뿌리 - resources/ (글꼴, 한자 ROM) 를 찾을 곳. 거슬러 올라가며 VERSION 과
 * dist/ (또는 resources/) 가 함께 있는 곳을 찾는다. **VERSION 하나로는 안 된다**:
 * node/ 에도 VERSION 이 있어서 거기서 멈췄다. resources/ 하나로도 안 된다 - git 에
 * 없는 폴더라 새로 받은 저장소에는 없다.
 */
export function repoRoot(start = HERE) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, 'VERSION'))
        && (fs.existsSync(path.join(d, 'resources')) || fs.existsSync(path.join(d, 'dist')))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start, '..', '..');
    d = up;
  }
}
const REPO = repoRoot();
export const FONT_DIR = path.join(REPO, 'resources', 'fonts');

/** 시각 도장: 20260925_101530. 파이썬의 time.strftime("%Y%m%d_%H%M%S"). */
export function stamp(epoch = null) {
  const d = epoch === null ? new Date() : new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 파이썬의 round(x): 정확히 반이면 짝수 쪽. */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 보여 줄 경로: 여기서 읽기에 짧은 쪽 (msx_printer_paths.rel). */
export function rel(p) {
  try {
    const r = path.relative(process.cwd(), p);
    return r && r.length < p.length ? r : p;
  } catch { return p; }
}

/** 파이썬 decode_msx 그대로: 모르는 이름은 cp437, 깨진 바이트는 한 바이트씩 U+FFFD. */
export function decodeText(data, charset = 'cp437') {
  const cs = String(charset || 'cp437');
  if (cs.toLowerCase() === 'cp437') return decodeMsx(data, 'cp437');
  try { return decodeReplace(Buffer.from(data), cs); } catch (e) {
    if (!(e instanceof LookupError)) throw e;
  }
  // 표가 여기 없는 코덱 (cp932, euc_jp ...): 브라우저식으로 풀거나, 그것도
  // 모르면 cp437 - 파이썬의 LookupError 폴백과 같다.
  return decodeMsx(data, cs);
}

// ---------------------------------------------------------------- 페이지

/**
 * escp 의 Page -> 파이썬 Page.to_png 와 같은 자름: 찍힌 줄의 위아래 8 점, 가로는
 * 0 부터 찍힌 오른쪽 끝 + 8 점을 바이트로 올림. 1 비트 줄들 + 폭.
 */
export function pageCrop(page, margin = 8) {
  if (page.empty) return { width: 8, rows: Array.from({ length: 8 }, () => new Uint8Array(1)) };
  const y0 = Math.max(0, page.miny - margin);
  const y1 = Math.min(page.rows.length - 1, page.maxy + margin);
  const stride = ((page.maxx + margin) >> 3) + 1;
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    const r = new Uint8Array(stride);
    const src = page.rows[y];
    if (src) r.set(src.subarray(0, Math.min(stride, src.length)));
    rows.push(r);
  }
  return { width: stride * 8, rows };
}

/** 그린 페이지 하나: 1 비트 줄들과 그 회색 그림, PNG 에 적을 dpi. */
const sheetOf = ({ width, rows }, dpi = null) => ({ width, rows, dpi, img: fromBits(rows, width) });

/** ESC/P 를 그린 페이지들 (빈 페이지는 빼되, 다 비었으면 첫 장 하나). */
export function renderEscpSheets(data, glyphs = 'msx') {
  const pages = escpRender(Buffer.from(data), { charset: glyphs });
  const keep = pages.filter((p) => !p.empty);
  return (keep.length ? keep : pages.slice(0, 1)).map((p) => sheetOf(pageCrop(p)));
}

/**
 * msx-picoprinter 에 쓴 작업은 ESC/P 가 아니라 203 dpi 헤드에 1:1 로 놓이는
 * 비트 이미지다 (recharset._picoprinter_page). 글자가 있으면 null.
 */
export function picoprinterSheet(data) {
  if (!hasPicoprinterMark(data)) return null;
  const got = nativeBitmap(Buffer.from(data), { head: 384 });
  if (!got) return null;
  const rows = [];
  for (let y = 0; y < got.rows; y++) rows.push(got.data.subarray(y * got.rowBytes, (y + 1) * got.rowBytes));
  return sheetOf({ width: got.rowBytes * 8, rows }, HEAD_DPI);
}

/** recharset.render: picoprinter 작업이면 1:1, 아니면 ESC/P. */
export function renderSheets(data, glyphs = 'msx') {
  const pico = picoprinterSheet(data);
  return pico ? [pico] : renderEscpSheets(data, glyphs);
}

/** 쪽마다 `{prefix}_pN.png`, 한 쪽이면 `{prefix}.png` - 파이썬의 이름 짓기. */
export const pageName = (prefix, idx, n) => (n > 1 ? `${prefix}_p${idx}.png` : `${prefix}.png`);

/** 페이지들을 PNG 로 쓴다. 쓴 경로들. */
export function writeSheets(sheets, prefix) {
  return sheets.map((s, i) => {
    const p = pageName(prefix, i + 1, sheets.length);
    fs.writeFileSync(p, s.rows ? png1bit(s.width, s.rows, s.dpi) : pngGray(s.img, s.dpi));
    return p;
  });
}

// ------------------------------------------------------------------ 글꼴

//: 번들 글꼴, 좋은 것부터. DotGothic16 이 일본어의 앞인 이유: 16 점 디자인이라
//: 대신하는 ROM 비트맵에 가장 가깝다.
export const BUNDLED_JP = ['DotGothic16.ttf', 'NotoSansJP.ttf', 'BIZUDGothic.ttf', 'IBMPlexSansJP.ttf'];
export const BUNDLED_KR = ['NeoDunggeunmo.ttf', 'Galmuri11.ttf', 'NotoSansKR.ttf', 'Pretendard.otf'];

export function findBundledFont(script = 'jp') {
  for (const n of script === 'kr' ? BUNDLED_KR : BUNDLED_JP) {
    const p = path.join(FONT_DIR, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const ROM_DIRS = ['.', REPO, path.join(REPO, 'resources'), path.join(REPO, 'resources', 'font-roms'),
                  path.join(REPO, 'resources', 'msx-roms'), path.join(REPO, 'resources', 'roms'), HERE];
const ROM_NAMES = ['KNJFNT16.ROM', 'knjfnt16.rom', 'KNJFNT16.rom', 'KNJDRV16.ROM', 'kanji.rom', 'KANJI.ROM'];
const ROM_GLOBS = [/kanjifont.*\.rom$/, /kanjifont.*\.ROM$/, /knjfnt/, /KNJFNT/];

/**
 * 한자 ROM 을 찾는다. $MSX_KANJI_ROM 먼저, 그다음 이름, 그다음 모양. 크기를
 * 본다 (128/256 KB) - 같은 폴더의 게임 ROM 을 글꼴로 잘못 읽지 않게.
 */
export function findRom() {
  const cands = process.env.MSX_KANJI_ROM ? [process.env.MSX_KANJI_ROM] : [];
  for (const d of ROM_DIRS) for (const n of ROM_NAMES) cands.push(path.join(d, n));
  for (const d of ROM_DIRS)
    for (const g of ROM_GLOBS) {
      let names = [];
      try { names = fs.readdirSync(d).filter((n) => g.test(n)).sort(); } catch { /* 없다 */ }
      cands.push(...names.map((n) => path.join(d, n)));
    }
  for (const p of cands) {
    try { const s = fs.statSync(p).size; if (s === 0x20000 || s === 0x40000) return p; } catch { /* 다음 */ }
  }
  return null;
}

const fontCache = new Map();
function loadFont(p) {
  if (!fontCache.has(p)) fontCache.set(p, Font.load(p));
  return fontCache.get(p);
}

/**
 * 줄들을 번들 글꼴로 조판 (kanji_render.render_text_to_files). 크기 48, 여백
 * 반 글자, 줄 간격 1.4 글자. 쪽마다 회색 그림 하나.
 */
export function typesetSheets(pages, fontPath, size = 48) {
  const font = loadFont(fontPath);
  if (!pages.length) pages = [['']];
  const margin = Math.trunc(size * 0.5);
  const leading = Math.trunc(size * 1.4);
  return pages.map((lines) => {
    const width = Math.max(...(lines.length ? lines.map((l) => Math.trunc(textLength(font, size, l))) : [size]))
      + 2 * margin;
    const height = lines.length * leading + 2 * margin;
    const img = gray(Math.max(width, size), height);
    lines.forEach((l, i) => drawText(img, font, size, margin, margin + i * leading, l));
    return { img, dpi: null };
  });
}

//: host 스타일: US Letter 150 dpi. 프린터의 기하가 아니라 호스트 프린터의 종이다.
export const HOST_PAGE = [1275, 1650];
export const HOST_MARGIN = 96;
export const HOST_SIZE = 22;

/**
 * host 스타일 (recharset.render_host): 글자를 번들 글꼴로 다시 조판한다. 읽기
 * 좋지만 ESC/P 가 말한 배치는 잃는다. 폭으로 접는다 - 한자·한글은 라틴의 두 배다.
 */
export function hostSheets(data, charset = 'cp437', size = HOST_SIZE) {
  let text = decodeText(data, charset).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = Array.from(text).filter((c) => c === '\t' || c === '\n' || c >= ' ').join('');
  const kr = Array.from(text).some((c) => (c >= '가' && c <= '힣') || (c >= 'ㄱ' && c <= 'ㅣ'));
  const fp = findBundledFont(kr ? 'kr' : 'jp') || findBundledFont(kr ? 'jp' : 'kr');
  if (!fp) throw new Error('no bundled font in resources/fonts to typeset with');
  const font = loadFont(fp);
  const [W, H] = HOST_PAGE;
  const inner = W - 2 * HOST_MARGIN;
  const lines = [];
  for (let para of text.split('\n')) {
    para = para.replace(/\t/g, '    ');
    if (!para) { lines.push(''); continue; }
    let cur = '';
    let curW = 0;
    for (const ch of para) {
      const w = textLength(font, size, ch);
      if (curW + w > inner && cur) { lines.push(cur); cur = ch; curW = w; }
      else { cur += ch; curW += w; }
    }
    lines.push(cur);
  }
  const leading = Math.trunc(size * 1.5);
  const perPage = Math.max(1, Math.floor((H - 2 * HOST_MARGIN) / leading));
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);
  const sheets = pages.map((pl) => {
    const img = gray(W, H);
    pl.forEach((ln, k) => drawText(img, font, size, HOST_MARGIN, HOST_MARGIN + k * leading, ln));
    return { img, dpi: null };
  });
  return { sheets, used: path.basename(fp) };
}

// ------------------------------------------------------------ 작업 하나를 파일로

/** --print pdf 의 배치 (reportlab 이 하던 것): [[x, y, 글], ...] 의 쪽들. */
export function textPdfLayout(text) {
  const [pw] = [612, 792];
  const left = 50, top = 750, bottom = 50, leading = 12;
  const maxChars = Math.max(1, Math.trunc((pw - left - 40) / 6.0));
  const clean = (line) => Array.from(line.replace(/\t/g, '    ')).filter((c) => { const o = c.codePointAt(0); return o >= 32 && o !== 127; }).join('');
  const wrapLine = (line) => {
    if (!line) return [''];
    const c = Array.from(line);
    const out = [];
    for (let i = 0; i < c.length; i += maxChars) out.push(c.slice(i, i + maxChars).join(''));
    return out;
  };
  const pages = [[]];
  let y = top;
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    for (const seg of wrapLine(clean(raw))) {
      pages[pages.length - 1].push([left, y, seg]);
      y -= leading;
      // reportlab 은 여기서 showPage 하고 글꼴을 다시 건다 - 그 뒤 아무것도 안 써도
      // save() 가 그 쪽을 내보낸다. 끝에 빈 쪽이 붙는 것까지 같게.
      if (y < bottom) { pages.push([]); y = top; }
    }
  }
  return pages;
}

/**
 * 끝난 작업 하나를 `mode` 로 저장한다 (msx_printer_render.save_print_job).
 * 무엇을 했는지 `say(level, text)` 로 말하고 ('*' 알림, '+' 성공, '-' 실패),
 * 쓴 파일들을 돌려준다.
 */
export function savePrintJob(data, mode, baseName, { charset = 'cp437', glyphs = null, timestamp = null,
                                                     outDir = 'output', kanjiRom = null,
                                                     say = () => {} } = {}) {
  data = Buffer.from(data);
  if (!data.length) return [];
  timestamp = timestamp || stamp();
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const stem = path.join(outDir, `${baseName}_${timestamp}`);

  if (mode === 'auto') {
    // 날것이 **먼저, 언제나.** 판별이 틀려도 잃는 것이 없다 - 다시 그리면 된다.
    const rawName = `${stem}.prn`;
    fs.writeFileSync(rawName, data);
    files.push(rawName);
    let d;
    try { d = detect(data); } catch (e) {
      say('-', `auto-detect failed (${e.message}); kept RAW only: ${rawName}`);
      return files;
    }
    say('*', `auto -> ${d.mode}${d.charset ? ` --charset ${d.charset}` : ''}  (${d.why})`);
    if (d.mode === 'off' || d.mode === 'raw') {
      say('+', `Saved RAW print job to: ${rel(rawName)}`);
      return files;
    }
    if (d.mode === 'msx-kanji' || d.mode === 'msx-hangul') {
      files.push(...saveDialect(data, d.mode, stem, rawName, kanjiRom, say));
      return files;
    }
    files.push(...savePrintJob(data, d.mode, baseName,
      { charset: d.charset || charset, glyphs, timestamp, outDir, kanjiRom, say }));
    say('*', `raw kept alongside: ${rawName}`);
    return files;
  }
  if (mode === 'raw') {
    fs.writeFileSync(`${stem}.prn`, data);
    say('+', `Saved RAW print job to: ${rel(`${stem}.prn`)}`);
    return [`${stem}.prn`];
  }
  if (mode === 'text') {
    fs.writeFileSync(`${stem}.txt`, decodeText(data, charset), 'utf8');
    say('+', `Saved TEXT print job to: ${rel(`${stem}.txt`)}`);
    return [`${stem}.txt`];
  }
  if (mode === 'pdf') {
    try {
      fs.writeFileSync(`${stem}.pdf`, textPdf(textPdfLayout(decodeText(data, charset))));
      say('+', `Saved PDF print job to: ${rel(`${stem}.pdf`)}`);
      return [`${stem}.pdf`];
    } catch (e) {
      say('-', `Failed to generate PDF: ${e.message}`);
      return [];
    }
  }
  if (mode === 'raster') {
    try {
      const r = new EscpRenderer({ charset: glyphs || 'msx' }).feed(data);
      const keep = r.pages.filter((p) => !p.empty);
      const sheets = (keep.length ? keep : r.pages.slice(0, 1)).map((p) => pageCrop(p));
      const paths = writeSheets(sheets.map((s) => ({ ...s, dpi: null })), stem);
      let extra = '';
      if (r.textBytes) extra += `  (${r.textBytes} text bytes, charset ${r.charset})`;
      if (r.unknown.size) {
        const u = `{${[...r.unknown].map(([k, v]) => `${pyKey(r.unknownKeys?.get(k), k)}: ${v}`).join(', ')}}`;
        extra += `  unhandled ESC: ${u} (extend msx_printer_escp_render for this dialect)`;
      }
      say('+', `Rendered ESC/P to ${paths.length} PNG page(s): ${paths.join(', ')}${extra}`);
      return paths;
    } catch (e) {
      say('-', `ESC/P raster render failed (${e.message}); saving RAW instead.`);
      return savePrintJob(data, 'raw', baseName, { charset, glyphs, outDir, say });
    }
  }
  return files;
}

/** 파이썬 repr 로 적는다: 문자열 'x', 튜플 ('ESC (', 'P'), 수 27. */
function pyRepr(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s.includes("'") && !s.includes('"')) return `"${s.replace(/\\/g, '\\\\')}"`;
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
const pyKey = (tuple, fallback) => (tuple ? `(${tuple.map(pyRepr).join(', ')})` : pyRepr(fallback));

/** 한자·한글 방언. 한자는 기계의 ROM 을 먼저, 한글은 ROM 이 없으니 번들 글꼴로. */
function saveDialect(data, dialect, prefix, rawName, kanjiRom, say) {
  try {
    let sheets, how;
    if (dialect === 'msx-kanji') {
      // 주어진 ROM (서버의 --kanji-rom: 내용 또는 경로) 이 먼저, 없으면 찾는다.
      const given = !!kanjiRom;
      const romPath = typeof kanjiRom === 'string' ? kanjiRom : given ? null : findRom();
      const rom = Buffer.isBuffer(kanjiRom) ? kanjiRom : romPath ? fs.readFileSync(romPath) : null;
      if (rom) {
        const r = new KanjiRenderer(rom).feed(data);
        const keep = r.pages.filter((p) => !p.empty);
        sheets = (keep.length ? keep : r.pages.slice(0, 1)).map((p) => pageCrop(p));
        how = `kanji ROM ${romPath ? path.basename(romPath) : '--kanji-rom'} (${given ? 'given' : 'auto-detected'})`;
        if (r.missing) how += `  (${r.missing} chars beyond ROM size - JIS2 needs 256kB)`;
      } else {
        const fp = findBundledFont('jp');
        if (!fp) throw new Error('nothing to draw with: pass --kanji-rom KNJFNT16.ROM (128/256kB) or add a font');
        sheets = typesetSheets(kanjiText(data), fp);
        how = `font ${path.basename(fp)} (bundled; no kanji ROM found)`;
      }
    } else {
      const fp = findBundledFont('kr');
      if (!fp) { say('-', `no hangul font in resources/fonts; kept RAW only: ${rawName}`); return []; }
      sheets = typesetSheets(hangulDecode(data), fp);
      how = `font ${path.basename(fp)} (bundled)`;
    }
    const paths = writeSheets(sheets, prefix);
    say('+', `Rendered ${dialect} with ${how}: ${paths.join(', ')}`);
    say('*', `raw kept alongside: ${rawName}`);
    return paths;
  } catch (e) {
    say('-', `${dialect} render failed (${e.message}); kept RAW: ${rawName}`);
    return [];
  }
}

// ----------------------------------------------------------- 스풀 -> 문서

//: 쌓기: US Letter 150 dpi 한 장에 이어 붙인다.
export const STACK_SHEET = [1275, 1650];
export const STACK_MARGIN = 60;
export const STACK_GAP = 28;

/**
 * 그림들을 가능한 적은 장에 위에서 아래로 (spool.stack_to_pdf). 장보다 넓은
 * 그림은 자르지 않고 줄인다 (LANCZOS) - 오른쪽이 조용히 잘리는 것이 더 나쁘다.
 */
export function stackSheets(imgs, sheet = STACK_SHEET, margin = STACK_MARGIN, gap = STACK_GAP) {
  const [W, H] = sheet;
  const inner = W - 2 * margin;
  const out = [];
  let cur = null, y = 0;
  for (let im of imgs) {
    if (im.width > inner) im = resizeLanczos(im, inner, Math.max(1, pyRound(im.height * inner / im.width)));
    if (cur === null || y + im.height > H - margin) {
      if (cur) out.push(cur);
      cur = gray(W, H);
      y = margin;
    }
    paste(cur, im, margin, y);
    y += im.height + gap;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 스풀의 작업들을 **문서 하나로** (spool.merge, raster 모드). ESC/P 는 줄 간격과
 * 피치가 작업 경계를 넘어 살아남으므로, 바이트를 이어 붙이지 않고 작업마다 깨끗한
 * 인터프리터로 그린 뒤 **페이지를** 합친다. host 스타일로 쌓을 때만 글을 이어
 * 붙인다 - 글에는 넘어가는 상태가 없다.
 *
 * { images, dpi, stamp } - PDF 는 부르는 쪽이 만든다 (mergePdf).
 */
export function mergeSheets(spool, seqs, { style = null, charset = 'cp437', glyphs = 'msx', stack = false } = {}) {
  const jobs = spool.jobs().filter((j) => !seqs || !seqs.length || seqs.includes(j.seq));
  if (!jobs.length) return null;
  const when = stamp(jobs[0].t0);
  let pages = [];
  if (stack && style === 'host') {
    pages = hostSheets(Buffer.concat(jobs.map((j) => spool.read(j))), charset).sheets.map((s) => s.img);
  } else {
    for (const j of jobs) {
      const bytes = spool.read(j);
      if (style === 'host') pages.push(...hostSheets(bytes, charset).sheets.map((s) => s.img));
      else pages.push(...renderSheets(bytes, glyphs).map((s) => s.img));
    }
  }
  if (!pages.length) return null;
  return stack ? { images: stackSheets(pages), dpi: 150, stamp: when }
               : { images: pages, dpi: 300, stamp: when };
}

/** merge 의 PDF. 경로를 돌려준다: `{outDir}/{이름}_merged_{도장}.pdf`. */
export function mergePdf(stem, seqs, opts = {}) {
  const spool = new Spool(stem);
  const got = mergeSheets(spool, seqs, opts);
  if (!got) return null;
  const outDir = opts.outDir || 'output';
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${opts.baseName || path.basename(spool.stem)}_merged_${got.stamp}.pdf`);
  fs.writeFileSync(out, pagesPdf(got.images, got.dpi));
  return out;
}

export { pngBilevel };
