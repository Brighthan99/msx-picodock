// SPDX-License-Identifier: GPL-2.0-only
//
// codecs.js — 파이썬의 bytes.decode(cs) / str.encode(cs) 를 strict 그대로.
//
// disk_text 가 MSX 의 글 파일을 읽고 다시 쓸 때 쓴다. **읽는 표와 쓰는 표가
// 같아야** 손대지 않은 줄이 같은 바이트로 돌아간다. Shift-JIS 와 CP949 의 표는
// 파이썬의 코덱에서 뽑은 것이다 (codecs-data.js, scripts/make_codecs.py) - 이
// 프로젝트가 지금까지 써 온 것이 그 표였고, 브라우저식 디코더는 몇 글자가 다르다.
//
// 못 푸는 바이트나 못 쓰는 글자를 만나면 던진다 (파이썬의 errors="strict").
// 이름을 모르는 코덱이면 LookupError 를 던진다 - 부르는 쪽이 둘을 구별한다.

import { SHIFT_JIS, CP949 } from './codecs-data.js';

export class DecodeError extends Error {}
export class EncodeError extends Error {}
export class LookupError extends Error {}

const INVALID = 0xffff;

function load(b64) {
  const buf = Buffer.from(b64, 'base64');
  let o = 0;
  const single = new Uint16Array(256);
  for (let i = 0; i < 256; i++, o += 2) single[i] = buf.readUInt16LE(o);
  const nlead = buf.readUInt16LE(o); o += 2;
  const lead = new Map();
  for (let k = 0; k < nlead; k++) {
    const b = buf[o]; o += 1;
    const row = new Uint16Array(256);
    for (let t = 0; t < 256; t++, o += 2) row[t] = buf.readUInt16LE(o);
    lead.set(b, row);
  }
  // 인코드: 디코드표를 거꾸로, 처음 나온 것이 이긴다. 그다음 파이썬과 다른 것만 덮는다.
  const enc = new Map();
  for (let b = 0; b < 256; b++)
    if (single[b] !== INVALID && !enc.has(single[b])) enc.set(single[b], Buffer.from([b]));
  for (const [b, row] of lead)
    for (let t = 0; t < 256; t++)
      if (row[t] !== INVALID && !enc.has(row[t])) enc.set(row[t], Buffer.from([b, t]));
  const nover = buf.readUInt16LE(o); o += 2;
  for (let k = 0; k < nover; k++) {
    const cp = buf.readUInt16LE(o); const n = buf[o + 2]; o += 3;
    if (n) enc.set(cp, Buffer.from(buf.subarray(o, o + n)));
    else enc.delete(cp);                    // 풀리지만 파이썬은 쓰지 못하는 글자
    o += n;
  }
  return { single, lead, enc };
}

let TABLES = null;
function tables() {
  if (!TABLES) TABLES = { shift_jis: load(SHIFT_JIS), cp949: load(CP949) };
  return TABLES;
}

/** 파이썬이 받는 이름들 가운데 여기서 쓰는 것. 모르면 null. */
export function canonical(name) {
  const n = String(name || '').toLowerCase().replace(/[-\s]/g, '_');
  if (['ascii', 'us_ascii', '646'].includes(n)) return 'ascii';
  if (['latin_1', 'latin1', 'l1', 'iso8859_1', 'iso_8859_1', '8859', 'cp819', 'latin']
    .includes(n)) return 'latin-1';
  if (['shift_jis', 'shiftjis', 'sjis', 's_jis', 'csshiftjis'].includes(n)) return 'shift_jis';
  if (['cp949', '949', 'ms949', 'uhc'].includes(n)) return 'cp949';
  if (['utf_8', 'utf8', 'u8', 'utf'].includes(n)) return 'utf-8';
  return null;
}

/** bytes -> str. 파이썬의 data.decode(cs) (strict). */
export function decode(data, name) {
  const cs = canonical(name);
  if (!cs) throw new LookupError(`unknown encoding: ${name}`);
  if (cs === 'latin-1') return data.toString('latin1');
  if (cs === 'ascii') {
    const bad = data.findIndex((b) => b > 0x7f);
    if (bad >= 0) throw new DecodeError(`'ascii' codec can't decode byte 0x${data[bad].toString(16)} in position ${bad}`);
    return data.toString('latin1');
  }
  if (cs === 'utf-8') {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new DecodeError("'utf-8' codec can't decode"); }
  }
  const { single, lead } = tables()[cs];
  let out = '';
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (single[b] !== INVALID) { out += String.fromCharCode(single[b]); continue; }
    const row = lead.get(b);
    if (!row || i + 1 >= data.length || row[data[i + 1]] === INVALID)
      throw new DecodeError(`'${cs}' codec can't decode bytes in position ${i}`);
    out += String.fromCharCode(row[data[i + 1]]);
    i += 1;
  }
  return out;
}

/** str -> bytes. 파이썬의 text.encode(cs) (strict). */
export function encode(text, name) {
  const cs = canonical(name);
  if (!cs) throw new LookupError(`unknown encoding: ${name}`);
  text = String(text);
  const chars = Array.from(text);             // 파이썬처럼 코드 포인트 단위로
  if (cs === 'utf-8') {
    // 짝 없는 서로게이트는 파이썬이 인코드하지 못한다.
    const bad = (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff;
    const at = chars.findIndex(bad);
    if (at >= 0) throw encodeError(cs, chars, at, bad, 'surrogates not allowed');
    return Buffer.from(text, 'utf8');
  }
  if (cs === 'latin-1' || cs === 'ascii') {
    const top = cs === 'ascii' ? 0x7f : 0xff;
    const bad = (ch) => ch.codePointAt(0) > top;
    const at = chars.findIndex(bad);
    if (at >= 0) throw encodeError(cs, chars, at, bad, `ordinal not in range(${top + 1})`);
    return Buffer.from(chars.map((ch) => ch.codePointAt(0)));
  }
  const { enc } = tables()[cs];
  const parts = [];
  chars.forEach((ch, i) => {
    const got = ch.length === 1 ? enc.get(ch.charCodeAt(0)) : undefined;
    // CJK 코덱은 한 글자씩 말한다 (파이썬의 multibytecodec 이 그렇다).
    if (!got) throw encodeError(cs, chars, i, () => false, 'illegal multibyte sequence');
    parts.push(got);
  });
  return Buffer.concat(parts);
}

/**
 * 파이썬의 UnicodeEncodeError 문구. ascii/latin-1/utf-8 은 이어진 못 쓰는
 * 글자들을 한 번에 "position 0-1" 로 말하고, 글자 하나면 그 글자를 \\xNN /
 * \\uNNNN / \\UNNNNNNNN 으로 적는다.
 */
function encodeError(cs, chars, at, bad, reason) {
  let end = at + 1;
  while (end < chars.length && bad(chars[end])) end += 1;
  if (end - at > 1)
    return new EncodeError(`'${cs}' codec can't encode characters in position ${at}-${end - 1}: ${reason}`);
  const cp = chars[at].codePointAt(0);
  const esc = cp < 0x100 ? `\\x${cp.toString(16).padStart(2, '0')}`
    : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, '0')}`
      : `\\U${cp.toString(16).padStart(8, '0')}`;
  return new EncodeError(`'${cs}' codec can't encode character '${esc}' in position ${at}: ${reason}`);
}

/**
 * bytes.decode(cs, errors="replace"). 풀리지 않는 자리는 **한 바이트만**
 * U+FFFD 로 바꾸고 다음 바이트부터 다시 읽는다 - 파이썬의 CJK 코덱이 그렇다
 * (lead 바이트 뒤가 틀리면 lead 만 버리고 뒤 바이트는 제 글자로 읽힌다).
 * 브라우저식 디코더는 둘을 묶어 버리는 자리가 있어 결과가 다르다.
 */
export function decodeReplace(data, name) {
  const cs = canonical(name);
  if (!cs) throw new LookupError(`unknown encoding: ${name}`);
  if (cs === 'latin-1') return data.toString('latin1');
  if (cs === 'ascii') return Array.from(data, (b) => (b < 0x80 ? String.fromCharCode(b) : '�')).join('');
  if (cs === 'utf-8') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
  const { single, lead } = tables()[cs];
  let out = '';
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (single[b] !== INVALID) { out += String.fromCharCode(single[b]); continue; }
    const row = lead.get(b);
    if (row && i + 1 < data.length && row[data[i + 1]] !== INVALID) {
      out += String.fromCharCode(row[data[i + 1]]);
      i += 1;
    } else out += '�';
  }
  return out;
}
