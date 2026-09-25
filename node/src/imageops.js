// SPDX-License-Identifier: GPL-2.0-only
//
// imageops.js — 인쇄가 쓰는 Pillow 의 그림 연산 몇 가지를, Pillow 의 C 코드
// 그대로 (2026-09-25).
//
// 파이썬 인쇄 도구가 Pillow 에 맡기던 것은 셋이다: 페이지를 헤드 폭으로 줄이는
// LANCZOS (Resample.c), 회색을 흑백으로 가르는 Floyd-Steinberg (Convert.c 의
// tobilevel), 옆으로 돌리는 ROTATE_90. 영수증에 나가는 바이트가 같으려면 이
// 셋이 **같은 정수 산술**이어야 해서, 근사가 아니라 C 를 줄 단위로 옮겼다.
// 실제 Pillow 와 픽셀 단위로 같은지는 test/print_crosscheck.py 가 본다.
//
// 출처: Pillow (https://github.com/python-pillow/Pillow) src/libImaging/Resample.c,
// Convert.c, Geometry.c. Pillow 는 MIT-CMU (HPND) 라이선스다:
//   Copyright (c) 1997-2011 by Secret Labs AB, (c) 1995-2011 by Fredrik Lundh and
//   contributors, (c) 2010 by Jeffrey A. Clark and contributors. 이 고지를 남기는
//   조건으로 쓰고 고치고 나눌 수 있다. 전문은 LICENSES/Pillow.MIT-CMU.txt, 출처는 NOTICE.md.
//
// 그림은 { width, height, data: Uint8Array } 하나뿐이다 - 회색 한 채널, 0 이
// 검정이고 255 가 흰색 (Pillow 의 "L").

export const gray = (width, height, fill = 255) =>
  ({ width, height, data: new Uint8Array(width * height).fill(fill) });

/** 점 하나에 한 비트 (1 = 찍힘) 인 줄들 -> 회색. PNG 의 "1" 을 "L" 로 바꾼 것과 같다. */
export function fromBits(rows, width) {
  const img = gray(width, rows.length);
  rows.forEach((r, y) => {
    for (let x = 0; x < width; x++)
      if (r[x >> 3] & (0x80 >> (x & 7))) img.data[y * width + x] = 0;
  });
  return img;
}

// ------------------------------------------------------------------ resize

const PRECISION_BITS = 32 - 8 - 2;

function sinc(x) {
  if (x === 0.0) return 1.0;
  x *= Math.PI;
  return Math.sin(x) / x;
}
const lanczos = (x) => (x >= -3.0 && x < 3.0 ? sinc(x) * sinc(x / 3) : 0.0);

/** Resample.c 의 precompute_coeffs + normalize_coeffs_8bpc. */
function coeffs(inSize, outSize) {
  let filterscale = inSize / outSize;
  const scale = filterscale;
  if (filterscale < 1.0) filterscale = 1.0;
  const support = 3.0 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0.0;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = lanczos((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) if (ww !== 0.0) k[x] /= ww;
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax ? k[x] : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS))
                                 : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

function clip8(v) {
  if (v >= (1 << PRECISION_BITS) * 256) return 255;
  if (v <= 0) return 0;
  return Math.floor(v / (1 << PRECISION_BITS));
}

/**
 * Image.resize((w, h), Image.LANCZOS), 8 비트 한 채널. 가로를 먼저, 세로를
 * 나중에 - 가로는 세로가 쓸 줄들에만 한다 (ImagingResampleInner).
 *
 * 누적은 정수다. 32 비트를 넘을 일이 없게 C 가 PRECISION_BITS 를 골랐고,
 * JS 의 double 은 2^53 까지 정확하므로 같은 값이 나온다.
 */
export function resizeLanczos(img, w, h) {
  if (img.width === w && img.height === h) return { width: w, height: h, data: img.data.slice() };
  const needH = w !== img.width;
  const needV = h !== img.height;
  const hz = coeffs(img.width, w);
  const vt = coeffs(img.height, h);
  const yFirst = vt.bounds[0];
  const yLast = vt.bounds[h * 2 - 2] + vt.bounds[h * 2 - 1];
  let src = img;
  const vb = Int32Array.from(vt.bounds);
  if (needH) {
    for (let i = 0; i < h; i++) vb[i * 2] -= yFirst;
    const rows = yLast - yFirst;
    const tmp = { width: w, height: rows, data: new Uint8Array(w * rows) };
    const half = 1 << (PRECISION_BITS - 1);
    for (let yy = 0; yy < rows; yy++) {
      const row = (yy + yFirst) * img.width;
      for (let xx = 0; xx < w; xx++) {
        const xmin = hz.bounds[xx * 2], xmax = hz.bounds[xx * 2 + 1];
        const base = xx * hz.ksize;
        let ss = half;
        for (let x = 0; x < xmax; x++) ss += img.data[row + x + xmin] * hz.kk[base + x];
        tmp.data[yy * w + xx] = clip8(ss);
      }
    }
    src = tmp;
  }
  if (!needV) return src;
  const out = { width: src.width, height: h, data: new Uint8Array(src.width * h) };
  const half = 1 << (PRECISION_BITS - 1);
  for (let yy = 0; yy < h; yy++) {
    const ymin = vb[yy * 2], ymax = vb[yy * 2 + 1];
    const base = yy * vt.ksize;
    for (let xx = 0; xx < src.width; xx++) {
      let ss = half;
      for (let y = 0; y < ymax; y++) ss += src.data[(y + ymin) * src.width + xx] * vt.kk[base + y];
      out.data[yy * src.width + xx] = clip8(ss);
    }
  }
  return out;
}

// ------------------------------------------------------------- 흑백으로

/** im.point(lambda p: 255 if p >= level else 0) */
export function threshold(img, level = 128) {
  return { width: img.width, height: img.height,
           data: img.data.map((p) => (p >= level ? 255 : 0)) };
}

/** convert("1", dither=FLOYDSTEINBERG) - Convert.c 의 tobilevel. */
export function floydSteinberg(img) {
  const out = new Uint8Array(img.width * img.height);
  const errors = new Int32Array(img.width + 1);
  const clip = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < img.height; y++) {
    let l = 0, l0 = 0, l1 = 0;
    const row = y * img.width;
    let x = 0;
    for (; x < img.width; x++) {
      l = clip(img.data[row + x] + Math.trunc((l + errors[x + 1]) / 16));
      const o = l > 128 ? 255 : 0;
      out[row + x] = o;
      l -= o;
      const l2 = l;
      const d2 = l + l;
      l += d2;
      errors[x] = l + l0;
      l += d2;
      l0 = l + l1;
      l1 = l2;
      l += d2;
    }
    errors[x] = l0;
  }
  return { width: img.width, height: img.height, data: out };
}

/** transpose(ROTATE_90) - 반시계로 한 번. */
export function rotate90(img) {
  const W = img.width, H = img.height;
  const out = { width: H, height: W, data: new Uint8Array(W * H) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) out.data[(W - 1 - x) * H + y] = img.data[y * W + x];
  return out;
}

/** 흰 바탕에 붙인다 (paste). 넘치는 곳은 잘린다. */
export function paste(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = ox + x;
      if (tx >= 0 && tx < dst.width) dst.data[ty * dst.width + tx] = src.data[y * src.width + x];
    }
  }
  return dst;
}

/** 회색 -> 1 비트 줄 (0 = 검정 -> 비트 1). GS v 0 이 원하는 모양. */
export function toRaster(img) {
  const rb = (img.width + 7) >> 3;
  const data = new Uint8Array(rb * img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (!img.data[y * img.width + x]) data[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return { rb, rows: img.height, data };
}
