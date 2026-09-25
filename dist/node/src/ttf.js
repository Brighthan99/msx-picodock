// SPDX-License-Identifier: GPL-2.0-only
//
// ttf.js — TrueType 글꼴을 읽어 글자를 회색 그림으로 그린다.
//
// 파이썬은 이 일을 Pillow (FreeType) 에 맡겼다: 한글 프린터의 출력(한글 ROM 은
// 없다), 한자 ROM 이 없을 때의 한자, 문서의 host 스타일. Node 에는 글꼴을 그리는
// 것이 없어서 (2026-09-25) 여기서 한다. 번들 글꼴(resources/fonts/*.ttf)이 전부
// TrueType 윤곽이라 필요한 것은 적다: cmap, loca/glyf (합성 글리프 포함), hmtx.
//
// **FreeType 과 점 단위로 같지는 않다.** 힌팅이 없고 안티앨리어싱 방식이 다르다.
// 대신 줄을 어디서 접는지, 글자가 어디 놓이는지는 같은 수치 (전진 폭, 어센더)
// 로 계산한다 - test/print_crosscheck.py 는 그 둘을 본다.
//
// 그리기는 면적 누적(font-rs 와 같은 방식)이다: 선분마다 덮는 넓이를 칸에 더하고
// 줄마다 누적합을 내면 그 칸의 덮임이 나온다. 겹치는 윤곽은 1 에서 자른다.

import fs from 'node:fs';

export class Font {
  constructor(buf) {
    this.buf = buf;
    const n = buf.readUInt16BE(4);
    this.tables = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
    }
    for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf'])
      if (!this.tables[t]) throw new Error(`not a TrueType-outline font (no ${t} table)`);
    const head = this.tables.head.off;
    this.upem = buf.readUInt16BE(head + 18);
    this.locFormat = buf.readInt16BE(head + 50);
    const hhea = this.tables.hhea.off;
    this.ascender = buf.readInt16BE(hhea + 4);
    this.descender = buf.readInt16BE(hhea + 6);
    this.numHMetrics = buf.readUInt16BE(hhea + 34);
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.off + 4);
    this._cmap = this._readCmap();
    this._glyphCache = new Map();
  }

  static load(path) { return new Font(fs.readFileSync(path)); }

  _readCmap() {
    const b = this.buf, base = this.tables.cmap.off;
    const n = b.readUInt16BE(base + 2);
    let best = null, bestRank = -1;
    for (let i = 0; i < n; i++) {
      const pid = b.readUInt16BE(base + 4 + i * 8), eid = b.readUInt16BE(base + 6 + i * 8);
      const off = base + b.readUInt32BE(base + 8 + i * 8);
      const fmt = b.readUInt16BE(off);
      const rank = fmt === 12 ? 3 : fmt === 4 && (pid === 3 || pid === 0) ? 2 : 0;
      if (rank > bestRank && (fmt === 4 || fmt === 12)) { best = { off, fmt }; bestRank = rank; }
    }
    if (!best) throw new Error('no usable cmap');
    const map = new Map();
    const { off, fmt } = best;
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(off + 6);
      const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = b.readUInt16BE(ends + s * 2), start = b.readUInt16BE(starts + s * 2);
        const delta = b.readInt16BE(deltas + s * 2), ro = b.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else {
            const at = ranges + s * 2 + ro + (c - start) * 2;
            g = b.readUInt16BE(at);
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) map.set(c, g);
        }
      }
    } else {
      const groups = b.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const o = off + 16 + g * 12;
        const s = b.readUInt32BE(o), e = b.readUInt32BE(o + 4), id = b.readUInt32BE(o + 8);
        for (let c = s; c <= e; c++) map.set(c, id + (c - s));
      }
    }
    return map;
  }

  glyphId(cp) { return this._cmap.get(cp) || 0; }
  has(cp) { return this._cmap.has(cp); }

  advance(gid) {
    const h = this.tables.hmtx.off;
    const i = Math.min(gid, this.numHMetrics - 1);
    return this.buf.readUInt16BE(h + i * 4);
  }

  _glyfOffset(gid) {
    const l = this.tables.loca.off;
    if (this.locFormat === 0)
      return [this.buf.readUInt16BE(l + gid * 2) * 2, this.buf.readUInt16BE(l + gid * 2 + 2) * 2];
    return [this.buf.readUInt32BE(l + gid * 4), this.buf.readUInt32BE(l + gid * 4 + 4)];
  }

  /** 글리프의 윤곽: [[{x, y, on}], ...] (글꼴 단위, y 는 위로). */
  contours(gid, depth = 0) {
    if (this._glyphCache.has(gid)) return this._glyphCache.get(gid);
    const [a, e] = this._glyfOffset(gid);
    let out = [];
    if (e > a && depth < 8) {
      const b = this.buf, o = this.tables.glyf.off + a;
      const nc = b.readInt16BE(o);
      out = nc >= 0 ? this._simple(o, nc) : this._composite(o, depth);
    }
    this._glyphCache.set(gid, out);
    return out;
  }

  _simple(o, nc) {
    const b = this.buf;
    const ends = [];
    for (let i = 0; i < nc; i++) ends.push(b.readUInt16BE(o + 10 + i * 2));
    const np = nc ? ends[nc - 1] + 1 : 0;
    let p = o + 10 + nc * 2;
    p += 2 + b.readUInt16BE(p);                     // 명령어는 건너뛴다 (힌팅 없음)
    const flags = [];
    while (flags.length < np) {
      const f = b[p++];
      flags.push(f);
      if (f & 8) { let r = b[p++]; while (r--) flags.push(f); }
    }
    const xs = [], ys = [];
    let v = 0;
    for (const f of flags) {
      if (f & 2) { const d = b[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += b.readInt16BE(p); p += 2; }
      xs.push(v);
    }
    v = 0;
    for (const f of flags) {
      if (f & 4) { const d = b[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += b.readInt16BE(p); p += 2; }
      ys.push(v);
    }
    const out = [];
    let s = 0;
    for (const e of ends) {
      const c = [];
      for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
      out.push(c);
      s = e + 1;
    }
    return out;
  }

  _composite(o, depth) {
    const b = this.buf;
    let p = o + 10;
    const out = [];
    for (;;) {
      const flags = b.readUInt16BE(p), gid = b.readUInt16BE(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; }
      else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
      let m = [1, 0, 0, 1];
      const f2 = (at) => b.readInt16BE(at) / 16384;
      if (flags & 8) { const s = f2(p); m = [s, 0, 0, s]; p += 2; }
      else if (flags & 0x40) { m = [f2(p), 0, 0, f2(p + 2)]; p += 4; }
      else if (flags & 0x80) { m = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)]; p += 8; }
      if (!(flags & 2)) { dx = 0; dy = 0; }          // 점 맞추기는 드물다 - 원점에 둔다
      for (const c of this.contours(gid, depth + 1))
        out.push(c.map((q) => ({ x: q.x * m[0] + q.y * m[2] + dx, y: q.x * m[1] + q.y * m[3] + dy, on: q.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  }
}

/** FreeType 이 크기에 맞춘 어센더 (반올림하여 올림) 와 전진 폭 (반올림). */
export const ascentPx = (font, size) => Math.ceil((font.ascender * size) / font.upem);
export const advancePx = (font, size, cp) => Math.round((font.advance(font.glyphId(cp)) * size) / font.upem);

/** 한 줄의 폭 (ImageDraw.textlength). */
export function textLength(font, size, text) {
  let w = 0;
  for (const ch of text) w += advancePx(font, size, ch.codePointAt(0));
  return w;
}

/**
 * `text` 를 회색 그림 `img` 의 (x, y) 에 검정으로 그린다. y 는 어센더 선 (Pillow 의
 * 기본 기준점 "la") 이다.
 */
export function drawText(img, font, size, x, y, text) {
  const scale = size / font.upem;
  const base = y + ascentPx(font, size);
  let pen = x;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    drawGlyph(img, font.contours(font.glyphId(cp)), scale, pen, base);
    pen += advancePx(font, size, cp);
  }
}

function drawGlyph(img, contours, scale, ox, base) {
  if (!contours.length) return;
  const segs = [];
  for (const c of contours) {
    const pts = c.map((q) => ({ x: ox + q.x * scale, y: base - q.y * scale, on: q.on }));
    // 곡선이 아닌 점 둘 사이에는 가운데 점이 숨어 있다 (TrueType 규칙).
    const full = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      full.push(a);
      if (!a.on && !b.on) full.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    }
    let start = full.findIndex((q) => q.on);
    if (start < 0) continue;
    const seq = [...full.slice(start), ...full.slice(0, start), full[start]];
    let prev = seq[0];
    for (let i = 1; i < seq.length; i++) {
      const q = seq[i];
      if (q.on) { segs.push([prev.x, prev.y, q.x, q.y]); prev = q; continue; }
      const end = seq[i + 1];
      // 2 차 베지어를 잘게 편다.
      const n = Math.max(1, Math.ceil(Math.hypot(end.x - prev.x, end.y - prev.y) / 2));
      let px = prev.x, py = prev.y;
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const nx = u * u * prev.x + 2 * u * t * q.x + t * t * end.x;
        const ny = u * u * prev.y + 2 * u * t * q.y + t * t * end.y;
        segs.push([px, py, nx, ny]);
        px = nx; py = ny;
      }
      prev = end;
      i += 1;
    }
  }
  fill(img, segs);
}

/** 면적 누적 래스터라이즈. 덮인 만큼 검정으로 섞는다 (흰 바탕 가정 아님 - 곱한다). */
function fill(img, segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x0, y0, x1, y1] of segs) {
    minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
  }
  const X0 = Math.floor(minX), Y0 = Math.floor(minY);
  const W = Math.ceil(maxX) - X0 + 2, H = Math.ceil(maxY) - Y0 + 1;
  if (W <= 0 || H <= 0 || W * H > 1 << 24) return;
  const acc = new Float32Array(W * H + 1);
  for (const [ax, ay, bx, by] of segs) line(acc, W, H, ax - X0, ay - Y0, bx - X0, by - Y0);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const py = Y0 + y;
    for (let x = 0; x < W; x++) {
      s += acc[y * W + x];
      const cov = Math.min(1, Math.abs(s));
      const px = X0 + x;
      if (cov > 0 && py >= 0 && py < img.height && px >= 0 && px < img.width) {
        const i = py * img.width + px;
        img.data[i] = Math.round(img.data[i] * (1 - cov));
      }
    }
  }
}

function line(acc, W, H, x0, y0, x1, y1) {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; dir = -1; }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) { x -= y0 * dxdy; y0 = 0; }
  const yEnd = Math.min(H, y1);
  for (let y = Math.floor(y0); y < yEnd; y++) {
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xNext = x + dxdy * dy;
    const d = dy * dir;
    const [xa, xb] = x < xNext ? [x, xNext] : [xNext, x];
    const row = y * W;
    const xai = Math.floor(xa), xbi = Math.floor(xb);
    if (xai < 0 || xbi + 1 >= W) { x = xNext; continue; }
    if (xai === xbi) {
      const f = (xa + xb) / 2 - xai;
      acc[row + xai] += d * (1 - f);
      acc[row + xai + 1] += d * f;
    } else {
      const s = 1 / (xb - xa);
      const x0f = xa - xai;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = xb - xbi;
      const am = 0.5 * s * x1f * x1f;
      acc[row + xai] += d * a0;
      if (xbi === xai + 1) acc[row + xai + 1] += d * (1 - a0 - am);
      else {
        const a1 = s * (1.5 - x0f);
        acc[row + xai + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbi; xi++) acc[row + xi] += d * s;
        const a2 = a1 + (xbi - xai - 2) * s;
        acc[row + xbi] += d * (1 - a2 - am);
      }
      acc[row + xbi + 1] += d * am;
    }
    x = xNext;
  }
}
