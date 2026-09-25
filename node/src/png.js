// SPDX-License-Identifier: GPL-2.0-only
//
// png.js — PNG 를 쓰고 읽는다. 인쇄가 남기는 페이지와 영수증 미리보기용이다.
//
// 쓰는 쪽은 msx_printer_escp_render.write_png_1bit 와 같은 모양이다 (필터 없음,
// zlib 9). 압축된 바이트는 zlib 구현마다 다를 수 있지만 풀어 낸 점은 같다 - 대조
// 시험도 점을 비교한다. 읽는 쪽은 사람이 넘겨준 페이지 그림을 위해 있고, 흔한
// 모양 (회색 1/2/4/8/16 비트, 회색+알파, RGB, RGBA, 팔레트) 을 Pillow 가 "L" 로
// 바꾸는 식 그대로 회색으로 바꾼다.

import zlib from 'node:zlib';
import { gray } from './imageops.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function pngOf(width, height, depth, colour, raw, dpi = null) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colour;
  const parts = [SIG, chunk('IHDR', ihdr)];
  if (dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const p = Buffer.alloc(9); p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1;
    parts.push(chunk('pHYs', p));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** 1 비트 줄들 (비트 1 = 찍힌 점) -> PNG. PNG 의 1 비트 회색은 0 이 검정이라 뒤집는다. */
export function png1bit(width, rows, dpi = null) {
  const stride = (width + 7) >> 3;
  const raw = Buffer.alloc(rows.length * (stride + 1));
  rows.forEach((r, y) => {
    const o = y * (stride + 1);
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = ~(r[i] ?? 0) & 0xff;
  });
  return pngOf(width, rows.length, 1, 0, raw, dpi);
}

/** 회색 그림 -> 8 비트 회색 PNG. */
export function pngGray(img, dpi = null) {
  const raw = Buffer.alloc(img.height * (img.width + 1));
  for (let y = 0; y < img.height; y++)
    raw.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1);
  return pngOf(img.width, img.height, 8, 0, raw, dpi);
}

/** 1 비트 흑백 그림 (0 = 검정) -> 1 비트 PNG. 영수증 미리보기가 이렇다. */
export function pngBilevel(img, dpi = null) {
  const stride = (img.width + 7) >> 3;
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    const r = new Uint8Array(stride);
    for (let x = 0; x < img.width; x++) if (!img.data[y * img.width + x]) r[x >> 3] |= 0x80 >> (x & 7);
    rows.push(r);
  }
  return png1bit(img.width, rows, dpi);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG -> 회색 그림 (Pillow 의 convert("L") 과 같은 식). */
export function readPng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8, hdr = null, plte = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8],
                                 colour: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!hdr) throw new Error('PNG without IHDR');
  if (hdr.interlace) throw new Error('interlaced PNG is not supported');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[hdr.colour];
  const bpp = Math.max(1, (chans * hdr.depth) >> 3);
  const stride = Math.ceil((hdr.w * chans * hdr.depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const img = gray(hdr.w, hdr.h);
  const L = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
  for (let y = 0; y < hdr.h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (line[i] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 0xff;
    }
    for (let x = 0; x < hdr.w; x++) {
      let v;
      if (hdr.depth < 8) {
        const bits = hdr.depth, per = 8 / bits;
        const s = (cur[Math.floor(x / per)] >> (8 - bits * (x % per + 1))) & ((1 << bits) - 1);
        v = hdr.colour === 3 ? L(plte[s * 3], plte[s * 3 + 1], plte[s * 3 + 2]) : Math.round(s * 255 / ((1 << bits) - 1));
      } else {
        const at = x * bpp, step = hdr.depth === 16 ? 2 : 1;
        const ch = (k) => cur[at + k * step];
        if (hdr.colour === 0 || hdr.colour === 4) v = ch(0);
        else if (hdr.colour === 3) v = L(plte[ch(0) * 3], plte[ch(0) * 3 + 1], plte[ch(0) * 3 + 2]);
        else v = L(ch(0), ch(1), ch(2));
      }
      img.data[y * hdr.w + x] = v;
    }
    prev.set(cur);
  }
  void trns;
  return img;
}
