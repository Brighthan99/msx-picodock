// SPDX-License-Identifier: GPL-2.0-only
//
// askshape.js — 답을 1983 년 화면에 맞춘다: 자르고, 40 칼럼으로 접고, MSX 가
// 찍을 바이트로 바꾼다. 그리고 PDINFO 가 보낸 기계 기록에 이름을 붙인다.
//
// src/host/pd_ask.py 의 shape() 와 그 아래를 옮겼다 (2026-09-25). 전부 **실기에서
// 다듬은 정책**이라 같은 바이트가 나와야 한다 - test/askshape_crosscheck.py 가
// 파이썬과 견준다. 그래서 파이썬이 기대는 것들도 그대로 가져왔다:
//
//   * 길이는 코드 포인트로 센다 (JS 의 length 는 UTF-16 단위다)
//   * 공백은 파이썬의 공백이다 (fat.js 의 pyStrip)
//   * 줄 접기는 CPython 의 textwrap 알고리즘이다
//   * 악센트를 떼는 표와 HTML 엔티티 표는 파이썬에서 뽑았다 (textdata.js)
//
// twWrap 은 CPython Lib/textwrap.py 를 JS 로 옮긴 것이라 PSF-2.0 고지를 따른다 -
// NOTICE.md 와 LICENSES/Python-PSF-2.0.txt.

import { pyStrip, pyRstrip } from './fat.js';
import { encode as encodeCs, EncodeError } from './codecs.js';
import { COMBINING } from './textdata.js';

//: 자르는 자리. ask.js 의 LIMIT 과 같은 값이어야 한다 (거기서 넘겨준다).
export const WIDTH = 40;
export const CHARSETS = ['ascii', 'cp949', 'raw'];

const cps = (s) => Array.from(s);
const clen = (s) => Array.from(s).length;

// --------------------------------------------------------------------- ASCII

//: 웹에 흔하고 MSX 에는 글리프가 없는 문장부호. NFKD 에 맡기면 둥근 따옴표가
//: 아무것도 아닌 것이 되므로 손으로 짝지었다.
const FIXUPS = [
  ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'],
  ['\u2013', '-'], ['\u2014', '-'], ['\u2212', '-'], ['\u00a0', ' '],
  ['\u2026', '...'], ['\u2022', '*'], ['\u00b7', '*'], ['\u00ab', '"'],
  ['\u00bb', '"'], ['\u2039', "'"], ['\u203a', "'"], ['\u00ad', ''],
];

function isCombining(cp) {
  let lo = 0, hi = COMBINING.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = COMBINING[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 할 수 있는 만큼 ASCII 로. 라틴 글자는 악센트를 잃고, ASCII 철자가 없는 나머지는
 * '?' 가 된다 - 보인다. 조용히 버리면 틀린 답이 완전한 답처럼 보인다.
 */
export function toAscii(text) {
  for (const [src, dst] of FIXUPS) text = text.split(src).join(dst);
  text = text.normalize('NFKD');
  text = cps(text).filter((c) => !isCombining(c.codePointAt(0))).join('');
  // 떼어 놓은 것을 도로 붙인다. 한글은 NFKD 에서 자모 셋으로 갈라지는데 결합
  // 글자가 아니라 살아남는다 - 그대로 두면 한 음절이 "???" 로 간다.
  text = text.normalize('NFC');
  return cps(text).map((c) => (c.codePointAt(0) < 0x80 ? c : '?')).join('');
}

// ------------------------------------------------------------ 자르기, 접기

/** `limit` 글자에서 자르고, 잘랐다고 표시한다. 0 은 한도 없음. */
export function truncate(text, limit) {
  const c = cps(text);
  if (!limit || c.length <= limit) return [text, false];
  return [`${pyRstrip(c.slice(0, limit).join(''))}...`, true];
}

//: textwrap 의 _whitespace. 이것만 공백으로 바꾸고, 이것만 단어를 가른다.
const TW_WS = new Set(['\t', '\n', '\x0b', '\x0c', '\r', ' ']);

/** str.expandtabs(8) - 칼럼을 세다가 \n 과 \r 에서 0 으로. */
function expandTabs(s) {
  let out = '';
  let col = 0;
  for (const ch of cps(s)) {
    if (ch === '\t') { const n = 8 - (col % 8); out += ' '.repeat(n); col += n; }
    else if (ch === '\n' || ch === '\r') { out += ch; col = 0; }
    else { out += ch; col += 1; }
  }
  return out;
}

/**
 * textwrap.wrap(line, width, break_long_words=True, break_on_hyphens=False).
 * CPython 의 _split_chunks / _wrap_chunks / _handle_long_word 를 그대로 옮겼다.
 * 조각은 코드 포인트 배열로 다룬다.
 */
export function twWrap(text, width) {
  if (width <= 0) throw new Error(`invalid width ${width} (must be > 0)`);
  const munged = cps(expandTabs(text)).map((c) => (TW_WS.has(c) ? ' ' : c));
  // (\s+) 로 가르고 빈 조각은 버린다: 공백 덩어리와 단어 덩어리가 번갈아 온다.
  const chunks = [];
  let cur = [];
  let curSpace = null;
  for (const c of munged) {
    const sp = c === ' ';
    if (curSpace !== null && sp !== curSpace) { chunks.push(cur); cur = []; }
    cur.push(c);
    curSpace = sp;
  }
  if (cur.length) chunks.push(cur);

  const isWs = (chunk) => pyStrip(chunk.join('')) === '';
  const lines = [];
  chunks.reverse();
  while (chunks.length) {
    const line = [];
    let len = 0;
    // 줄 첫머리의 공백 조각은 버린다 - 글 전체의 맨 처음만 빼고.
    if (isWs(chunks[chunks.length - 1]) && lines.length) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (len + l <= width) { line.push(chunks.pop()); len += l; } else break;
    }
    // 이 줄은 찼고, 다음 조각은 **어느 줄에도** 안 들어갈 만큼 길다.
    if (chunks.length && chunks[chunks.length - 1].length > width) {
      const spaceLeft = width < 1 ? 1 : width - len;
      const chunk = chunks[chunks.length - 1];
      line.push(chunk.slice(0, spaceLeft));
      chunks[chunks.length - 1] = chunk.slice(spaceLeft);
      len = line.reduce((a, c) => a + c.length, 0);
    }
    // 줄 끝의 공백 조각도 버린다.
    if (line.length && isWs(line[line.length - 1])) { len -= line[line.length - 1].length; line.pop(); }
    if (line.length) lines.push(line.map((c) => c.join('')).join(''));
  }
  return lines;
}

/** 긴 줄을 `width` 에서 단어 경계로 접는다. 0 이면 그대로. */
export function wrap(text, width) {
  if (!width) return text;
  const out = [];
  for (const line of text.split('\n')) {
    if (!pyStrip(line)) { out.push(''); continue; }
    const w = twWrap(line, width);
    out.push(...(w.length ? w : ['']));
  }
  return out.join('\n');
}

/**
 * 글 -> MSX 가 찍을 바이트. 줄 끝은 CHPUT 이 원하는 CR LF 로, 떠돌이 제어 문자는
 * 버린다 - 웹 페이지에서 온 0x1B 하나가 MSX 화면을 이스케이프 시퀀스로 넣지
 * 못하게.
 */
export function encodeFor(text, charset) {
  let data;
  if (charset === 'ascii') data = Buffer.from(toAscii(text), 'latin1');
  else if (charset === 'cp949') data = encodeReplace(text, 'cp949');
  else data = encodeReplace(text, 'utf-8');     // raw: 원래 글 그대로
  const keep = [];
  const crlf = [];
  // replace(b"\r\n", b"\n").replace(b"\r", b"\n")
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0d) { crlf.push(0x0a); if (data[i + 1] === 0x0a) i += 1; }
    else crlf.push(data[i]);
  }
  for (const b of crlf) {
    if (b === 0x0a) keep.push(0x0d, 0x0a);
    else if (b === 0x09) keep.push(0x20);
    else if (b >= 0x20) keep.push(b);          // NUL 은 이 선에서 예약이다 - 버린다
  }
  return Buffer.from(keep);
}

/** text.encode(cs, "replace"): 못 쓰는 글자마다 '?'. */
function encodeReplace(text, cs) {
  const parts = [];
  for (const ch of cps(text)) {
    try { parts.push(encodeCs(ch, cs)); } catch (e) {
      if (!(e instanceof EncodeError)) throw e;
      parts.push(Buffer.from('?'));
    }
  }
  return Buffer.concat(parts);
}

/**
 * 전부: 자르고, 접고, 바꾼다. [bytes, 잘렸는가].
 *
 * **한도는 글이 아니라 선에 나가는 바이트에 걸린다.** 글을 한도에서 자른 뒤
 * 접으면 40 칸마다 줄바꿈이 붙고 끝에 점 셋이 붙어 한도를 넘는다. 넘친 만큼
 * 예산을 줄여 다시 접는다.
 */
export function shape(text, { limit, width = WIDTH, charset = 'ascii' } = {}) {
  text = pyStrip(String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  let budget = limit;
  for (;;) {
    const [t, cut] = truncate(text, budget);
    const data = encodeFor(wrap(t, width), charset);
    // 예산 1 이 바닥이다: truncate 는 0 을 "한도 없음" 으로 읽는다.
    if (!limit || data.length <= limit || budget <= 1) return [data, cut];
    budget = Math.max(1, budget - (data.length - limit));
  }
}

// ------------------------------------------------------------------ PDINFO

const GENERATION = { 0: 'MSX1', 1: 'MSX2', 2: 'MSX2+', 3: 'MSX turbo R' };
const CHARSET = { 0: 'Japanese', 1: 'International', 2: 'Korean' };
const KEYBOARD = { 0: 'Japanese', 1: 'International', 2: 'French', 3: 'UK',
                   4: 'German', 5: 'Spanish' };
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** 슬롯 바이트를 MSX 가 적는 모양으로: 확장이면 3-1, 아니면 2. */
function slotName(b) {
  const prim = b & 3;
  return b & 0x80 ? `${prim}-${(b >> 2) & 3}` : `${prim}`;
}

/**
 * PDINFO 의 기록 -> [[이름, 값], ...]. 보내지 않은 것은 건너뛴다 - 앞으로의
 * PDINFO 가 더 보내도, 옛것이 덜 보내도 그대로 돈다.
 */
export function describeMsx(rec) {
  const out = [];
  if (rec.length > 0) out.push(['machine', GENERATION[rec[0]] ?? `unknown (0x${hex2(rec[0])})`]);
  if (rec.length > 1)
    out.push(['region', `${CHARSET[rec[1] & 0x0f] ?? `charset ${rec[1] & 0x0f}`}   ${rec[1] & 0x80 ? 50 : 60}Hz`]);
  if (rec.length > 2)
    out.push(['keyboard', `${KEYBOARD[rec[2] & 0x0f] ?? `type ${rec[2] & 0x0f}`}   BASIC ${(rec[2] >> 4) === 0 ? 'Japanese' : 'International'}`]);
  if (rec.length > 4) {
    let dos = rec[3] ? `${rec[3]}.${rec[4]}` : '1.x (no version call)';
    if (rec.length > 6 && rec[5]) dos += `   system ${rec[5]}.${rec[6]}`;
    out.push(['MSX-DOS', dos]);
  }
  if (rec.length > 8) {
    const tpa = rec[7] | (rec[8] << 8);
    out.push(['TPA', `${Math.floor(tpa / 1024)} KB free (BDOS at ${tpa.toString(16).toUpperCase().padStart(4, '0')}h)`]);
  }
  if (rec.length > 9) out.push(['cartridge in', `slot ${slotName(rec[9])}`]);
  return out;
}
