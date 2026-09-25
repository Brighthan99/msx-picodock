// SPDX-License-Identifier: GPL-2.0-only
//
// escp.js — ESC/P 스트림을 페이지 비트맵으로.
//
// src/host/printer/msx_printer_escp_render.py 를 옮긴 것이다. 그쪽 해석 로직은
// 다시 두 에뮬레이터에서 옮겨 온 것이라(DOSBox-X 의 printer.cpp, openMSX 의
// Printer.cc), 파라미터를 몇 개 먹는지·단위가 무엇인지·페이지를 언제 넘기는지가
// 그것들과 비교 가능하게 유지된다. 글리프는 openMSX 에서 추출됐다. 그래서 이
// 파일과 printer/ 꾸러미 전체가 GPL-2.0-only 다.
//
// 9 핀 시대(엡손 FX-80 호환) 인터프리터다. 비트이미지(ESC * / K / L / Y / Z / ^),
// 글자, 꾸밈, 탭, 여백, 페이지 넘김을 1 비트 래스터로 되살린다. 일본어 워드
// 프로세서가 쓰는 24 핀 ESC * 모드(32..40, 71..73)도 같은 캔버스에서 돈다.
//
// **MSX 가 FX-80 보다 우선이다.** 기본 문자셋 `msx` 는 MSX 자신의 International
// 폰트라, 상위 영역(악센트·통화·박스·그리스 문자)이 그 기계가 실제로 찍던 대로
// 나온다. 시대 고증이 필요하면 `fx80` 을 고른다 - 거기서는 높은 비트가 이탤릭을
// 뜻하고 악센트는 0x00~0x1F 에 산다.
//
// **왜 브라우저에서 그리는가.** PSG 때와 같은 이유다. 서버가 PNG 를 만들려면
// 압축 라이브러리가 필요하고, 그건 이 포트가 피하려던 설치 단계를 다시 놓는다.
// 여기서는 비트맵까지만 만들고 그리는 일은 캔버스에 맡긴다 - 브라우저는 이미
// 픽셀을 그릴 줄 안다.
//
// ESC K 는 **두 방언이 겹쳐 쓰는 옵코드**다. MSX 한자 프로토콜에서는 JIS 코드가
// 따라오고 여기서는 열 개수가 따라온다. 어느 쪽인지는 printer_detect.js 가
// 가린다 - 이 파일은 ESC/P 라고 이미 정해진 다음에 불린다.

import { TABLES, MSX_CHARSETS, DEFAULT_CHARSET, INTL, CP437_TO_FX80, MODES }
  from './escp-fonts.js';

export { DEFAULT_CHARSET };

const ESC = 0x1b;
const FS = 0x1c;

/** 캔버스 해상도 (가로세로 같다), dots/inch. */
const VDPI = 180.0;

/**
 * 파이썬의 `round()` - **짝수로 반올림**한다.
 *
 * JS 의 `Math.round` 는 .5 를 늘 위로 올리고, 파이썬은 가까운 짝수로 보낸다.
 * `round(2.5)` 가 파이썬에서 2, JS 에서 3 이다. 여기서는 그 한 칸이 그대로
 * 픽셀 한 줄이 된다 - 세로 배율 180/72 = 2.5 가 도트마다 걸리므로, 점 하나가
 * 2 픽셀이 아니라 3 픽셀로 그려지고 페이지가 통째로 어긋난다.
 *
 * 픽셀 대조가 이걸 잡았다. 결과를 훑어봤으면 "비슷하네" 로 지나갔을 차이다.
 */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;      // 정확히 .5 - 짝수 쪽으로
}

function modeInfo(m) {
  if (MODES[m]) return MODES[m];
  // 목록에 없는 모드의 무난한 기본값: 24 핀 헤드는 m >= 32 를 쓴다.
  return m >= 32 ? [3, 180, 180, true] : [1, 72, 60, true];
}

// ---------------------------------------------------------------- 폰트

// **Buffer 를 쓰지 않는다.** 이 파일은 Node 와 브라우저 양쪽에서 돈다 -
// 그리는 일은 캔버스가 하고, 시험은 Node 가 한다. Buffer 는 Node 에만 있으므로
// Uint8Array 로만 짠다. hex 를 푸는 것도 그래서 직접 한다.
function unhex(h) {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const hexCache = new Map();

function fontData(name) {
  if (!hexCache.has(name)) {
    const t = TABLES[name];
    if (!t) throw new Error(`unknown charset '${name}' (have: ${Object.keys(TABLES).join(', ')})`);
    hexCache.set(name, { stride: t.stride, data: unhex(t.hex) });
  }
  return hexCache.get(name);
}

class Font {
  constructor(name) {
    const { stride, data } = fontData(name);
    this.name = name;
    this.stride = stride;
    this.data = data;
    this.msxCharset = MSX_CHARSETS.has(name);
  }

  /** 문자 하나의 글리프 열 수 (속성 바이트 제외). */
  get columns() { return this.stride - 1; }

  /**
   * `code` 의 열들과 비례 폭 구간.
   *
   * `[cols, start, end]` - cols 는 9 비트 세로 조각이고 속성의 상위 비트 시프트가
   * 이미 적용돼 있다. `cols[start..end)` 가 비례 폭, 전체가 고정 폭이다.
   */
  glyph(code) {
    const base = (code & 0xff) * this.stride;
    const attr = this.data[base];
    const shift = attr >> 7;
    const cols = [];
    for (let k = 1; k < this.stride; k++) cols.push(this.data[base + k] << shift);
    let start = (attr >> 4) & 0x07;
    let end = attr & 0x0f;
    // 속성보다 글리프를 믿는다.
    if (!(start >= 0 && start < end && end <= cols.length)) { start = 0; end = cols.length; }
    return [cols, start, end];
  }
}

// ---------------------------------------------------------------- 페이지

/** 1 비트 페이지. 행은 필요할 때 늘어난다 - 종이 길이를 미리 알 수 없다. */
export class Page {
  constructor(width) {
    this.width = width;
    this.stride = (width + 7) >> 3;
    this.rows = [];
    this.minx = this.miny = 1 << 30;
    this.maxx = this.maxy = -1;
  }

  _ensure(y) {
    while (this.rows.length <= y) this.rows.push(new Uint8Array(this.stride));
  }

  plot(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y > (1 << 20)) return;
    this._ensure(y);
    this.rows[y][x >> 3] |= 0x80 >> (x & 7);
    if (x < this.minx) this.minx = x;
    if (x > this.maxx) this.maxx = x;
    if (y < this.miny) this.miny = y;
    if (y > this.maxy) this.maxy = y;
  }

  get empty() { return this.maxx < 0; }

  /**
   * 찍힌 부분만 잘라 낸다. `{width, height, bits}` - bits 는 픽셀당 1 바이트로,
   * 1 이 검정이다. 캔버스에 그대로 올리기 좋은 모양이다.
   */
  crop(margin = 8) {
    if (this.empty) return { width: 8, height: 8, bits: new Uint8Array(64) };
    const y0 = Math.max(0, this.miny - margin);
    const y1 = Math.min(this.rows.length - 1, this.maxy + margin);
    const x0 = Math.max(0, this.minx - margin);
    const x1 = Math.min(this.width - 1, this.maxx + margin);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const bits = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) {
      const row = this.rows[y];
      if (!row) continue;
      const out = (y - y0) * w;
      for (let x = x0; x <= x1; x++)
        if (row[x >> 3] & (0x80 >> (x & 7))) bits[out + (x - x0)] = 1;
    }
    return { width: w, height: h, bits, x0, y0 };
  }
}

// ---------------------------------------------------------------- 인터프리터

export class Renderer {
  constructor({ width = 2000, charset = DEFAULT_CHARSET } = {}) {
    this.width = width;
    this.pages = [new Page(width)];
    this.unknown = new Map();          // "ESC x" -> 횟수
    this.textBytes = 0;
    this.charset = charset;
    // 'cp437' 은 FX-80 글리프 + 상위 영역 재매핑이다.
    this.cp437 = charset === 'cp437';
    this.font = new Font(this.cp437 ? 'fx80' : charset);
    this._reset();
  }

  /** ESC @ / 전원 투입 상태. 이미 그려진 페이지는 지우지 않는다. */
  _reset() {
    this.xf = 0.0;
    this.yf = 0.0;
    this.lineMode = 'default';         // 'default'|'3'|'A'|'fixed'
    this.lineVal = null;
    this.denom = 216;                  // ESC 3/J: 216(8/9핀) 또는 180(24핀)
    this.pagePx = pyRound(11.0 * VDPI);
    this.topPx = 0.0;
    this.bottomPx = this.pagePx;
    this.leftPx = 0.0;
    this.rightPx = this.width;
    this.cpi = 10.0;                   // 파이카
    this.condensed = false;
    this.doubleWidth = false;
    this.dwOneline = false;
    this.bold = false;
    this.doubleStrike = false;
    this.underline = false;
    this.italic = false;
    this.superscript = false;
    this.subscript = false;
    this.proportional = false;
    this.interspPx = 0.0;
    this.country = 0;                  // ESC R (0=USA .. 8=일본)
    this.upperCtrl = false;            // ESC 6/7
    this.altCtrl = false;              // ESC I
    this.msb = null;                   // ESC = / > / #
    this.htabs = null;                 // null = 8 칸마다
    this.vtabs = null;                 // null = 전원 투입 (VT 가 LF 처럼)
    this.dens = { 0x4b: 0, 0x4c: 1, 0x59: 2, 0x5a: 3 };   // ESC K/L/Y/Z
    this.ramChars = new Map();         // ESC & / ESC :
    this.useRam = false;               // ESC %
  }

  get page() { return this.pages[this.pages.length - 1]; }

  _newpage() {
    this.pages.push(new Page(this.width));
    this.xf = this.leftPx;
    this.yf = this.topPx;
  }

  /**
   * 지금의 줄 간격, 캔버스 px.
   *
   * ESC 3/J 는 `denom`(8/9 핀은 216, 24 핀은 180)을 쓴다 - 그래야 비트이미지
   * 띠가 어느 쪽에서든 빈틈없이 쌓인다.
   */
  _linePx() {
    if (this.lineMode === '3') return this.lineVal * VDPI / this.denom;
    if (this.lineMode === 'A') return this.lineVal * VDPI / 72.0;
    if (this.lineMode === 'fixed') return this.lineVal;
    return VDPI / 6.0;
  }

  _linefeed() {
    this.xf = this.leftPx;
    this.dwOneline = false;
    this.yf += this._linePx();
    if (this.yf > this.bottomPx - 0.5) this._newpage();
  }

  // -- 글자 -------------------------------------------------------------
  /** 자간·축소를 반영한 cpi (배폭은 절반으로 만든다). */
  _cpiEff() {
    let cpi = this.cpi;
    if (this.condensed) cpi = cpi >= 12 ? 20.0 : 17.16;
    if (this.doubleWidth || this.dwOneline) cpi /= 2.0;
    return cpi;
  }

  /** `ch` 의 [열, 시작, 끝]. RAM 문자셋(ESC & / %)을 존중한다. */
  _glyph(ch) {
    if (this.useRam && this.ramChars.has(ch)) {
      const [attr, cols] = this.ramChars.get(ch);
      if (attr === 'rom') return [cols, 0, cols.length];
      // 8 비트 다운로드 데이터: 속성 비트7 = 9 핀 중 위 8 개를 쓴다.
      const c = (attr & 0x80) ? cols.map((v) => v << 1) : cols.slice();
      return [c, 0, c.length];
    }
    return this.font.glyph(ch);
  }

  /** 문자 하나의 가로 전진, 캔버스 px. */
  _advancePx(ch) {
    let adv;
    if (this.proportional) {
      const [, start, end] = this._glyph(ch);
      adv = (end - start + 1) * (VDPI / this.cpi) / this.font.columns;
      if (this.doubleWidth || this.dwOneline) adv *= 2.0;
    } else {
      adv = VDPI / this._cpiEff();
    }
    return adv + this.interspPx;
  }

  /** 찍을 수 있는 바이트 하나 (이탤릭·국가 매핑은 이미 끝난 상태). */
  _text(ch) {
    this.textBytes++;
    const adv = this._advancePx(ch);
    if (this.xf + adv > this.rightPx) this._linefeed();   // FX-80 자동 CR/LF

    let [cols, start, end] = this._glyph(ch);
    if (cols.length) {
      if (this.proportional) cols = cols.slice(start, end);
      const cell = adv - this.interspPx;
      const step = cell / Math.max(1, cols.length);
      let pitch = VDPI / 72.0;                            // 9 핀 세로 간격
      let yoff = 0.0;
      if (this.superscript || this.subscript) {
        pitch /= 2.0;
        if (this.subscript) yoff = 4.5 * (VDPI / 72.0);
      }
      // MSX 문자셋에는 이탤릭 페이지가 없어서 손으로 기울인다 - 실제 MSX
      // 프린터도 ESC 4 에 대해 같은 일을 한다.
      const shear = (this.italic && this.font.msxCharset) ? pitch * 0.5 : 0.0;
      const dw = Math.max(1, Math.trunc(step) + 1);
      const dh = Math.max(1, Math.trunc(pitch) + 1);
      const passes = [[0.0, 0.0]];
      if (this.bold) passes.push([step / 2.0, 0.0]);      // 강조: 반 도트 오른쪽
      if (this.doubleStrike) passes.push([0.0, VDPI / 216.0]);

      for (const [ox, oy] of passes) {
        for (let k = 0; k < cols.length; k++) {
          const col = cols[k];
          if (!col) continue;
          const x0 = this.xf + ox + k * step;
          for (let i = 0; i < 9; i++) {
            if (col & (1 << (8 - i))) {
              const xi = pyRound(x0 + (8 - i) * shear);
              const yi = pyRound(this.yf + oy + yoff + i * pitch);
              for (let dy = 0; dy < dh; dy++)
                for (let dx = 0; dx < dw; dx++) this.page.plot(xi + dx, yi + dy);
            }
          }
        }
      }
    }
    if (this.underline) {
      const yi = pyRound(this.yf + 8 * (VDPI / 72.0));
      for (let x = pyRound(this.xf); x < pyRound(this.xf + adv); x++)
        for (let dy = 0; dy < 2; dy++) this.page.plot(x, yi + dy);
    }
    this.xf += adv;
  }

  // -- 그래픽 -----------------------------------------------------------
  _bitimage(m, data, ninepin = false) {
    let bpc, dotVdpi, hDpi, adjacent;
    if (ninepin) { bpc = 2; dotVdpi = 72; hDpi = m ? 120 : 60; adjacent = true; }
    else { [bpc, dotVdpi, hDpi, adjacent] = modeInfo(m); }

    this.denom = dotVdpi === 72 ? 216 : 180;
    const xadv = VDPI / hDpi;
    const vscale = VDPI / dotVdpi;
    const ncols = Math.floor(data.length / bpc);

    // **점은 제 자리에서 다음 점 자리까지 채운다.** 반올림한 고정 크기로
    // 그리면 간격이 정수가 아닐 때 틈이 남는다 - 8 도트 모드가 바로 그렇다.
    // 세로 72 dpi 라 180 dpi 캔버스에서 간격이 2.5 px 인데 높이를 2 로
    // 그리면 두 점마다 0.5 px 가 맨살로 남고, 검은 면에 빗살이 생긴다.
    // 진짜 8 핀 헤드는 핀이 간격만큼 굵어 맞닿는다.
    const span = (a, b) => {
      const lo = pyRound(a);
      return [lo, Math.max(1, pyRound(b) - lo)];
    };

    for (let c = 0; c < ncols; c++) {
      const [xi, xwSpan] = span(this.xf, this.xf + xadv);
      const xw = adjacent ? xwSpan : 1;            // 고속 모드는 1px 점
      const base = c * bpc;
      for (let bi = 0; bi < bpc; bi++) {
        const col = data[base + bi];
        if (!col) continue;
        if (ninepin && bi === 1) {                 // 둘째 바이트: MSB 가 9 번 핀
          if (col & 0x80) {
            const [yi, yh] = span(this.yf + 8 * vscale, this.yf + 9 * vscale);
            for (let dy = 0; dy < yh; dy++)
              for (let dx = 0; dx < xw; dx++) this.page.plot(xi + dx, yi + dy);
          }
          continue;
        }
        for (let bit = 0; bit < 8; bit++) {
          if (col & (0x80 >> bit)) {
            const k = bi * 8 + bit;
            const [yi, yh] = span(this.yf + k * vscale, this.yf + (k + 1) * vscale);
            for (let dy = 0; dy < yh; dy++)
              for (let dx = 0; dx < xw; dx++) this.page.plot(xi + dx, yi + dy);
          }
        }
      }
      this.xf += xadv;
    }
  }

  // -- 명령 해석 --------------------------------------------------------
  _u16(data, i) { return data[i] + (data[i + 1] << 8); }

  /**
   * ESC D / ESC B 의 탭 목록. NUL 로 끝나는 오름차순이며, 순서가 어긋나도
   * 거기서 끝난다 - 실제 프린터가 그렇게 한다.
   */
  _tablist(data, i, n, unit, limit) {
    const tabs = [];
    while (i < n && data[i] !== 0) {
      const v = data[i] * unit;
      if (tabs.length && v <= tabs[tabs.length - 1]) break;
      if (tabs.length < limit) tabs.push(v);
      i++;
    }
    if (i < n && data[i] === 0) i++;
    return [i, tabs];
  }

  _note(kind, code) {
    const printable = code >= 0x20 && code < 0x7f;
    const key = `${kind} ${printable ? String.fromCharCode(code) : code}`;
    this.unknown.set(key, (this.unknown.get(key) || 0) + 1);
    // 글자 '1' 과 코드 1 은 위의 열쇠로는 같아 보인다. 파이썬처럼 (종류, 글자|수)
    // 로도 들고 있는다 - 서버가 로그에 적을 때 그 모양 그대로 적는다.
    if (!this.unknownKeys) this.unknownKeys = new Map();
    this.unknownKeys.set(key, [kind, printable ? String.fromCharCode(code) : code]);
  }

  _escape(data, i, n) {
    if (i >= n) return n;
    const cmd = data[i];
    i++;

    // ---- 비트이미지 ----
    if (cmd === 0x2a) {                              // ESC * m nL nH data
      if (i + 2 >= n) return n;
      const m = data[i];
      const length = this._u16(data, i + 1) * modeInfo(m)[0];
      i += 3;
      this._bitimage(m, data.subarray(i, i + length));
      return i + length;
    }
    if (cmd === 0x4b || cmd === 0x4c || cmd === 0x59 || cmd === 0x5a) {
      if (i + 1 >= n) return n;
      const m = this.dens[cmd];
      const length = this._u16(data, i) * modeInfo(m)[0];
      i += 2;
      this._bitimage(m, data.subarray(i, i + length));
      return i + length;
    }
    if (cmd === 0x5e) {                              // ESC ^ d nL nH data (9 핀)
      // ESC/P2 는 ESC ^ 를 "다음 제어 코드를 찍어라" 로 바꿨지만, MSX 시절
      // 소프트가 쓰는 것은 FX-80 의 9 핀 그래픽 쪽이다.
      if (i + 2 >= n) return n;
      const m = data[i];
      const length = this._u16(data, i + 1) * 2;
      i += 3;
      this._bitimage(m, data.subarray(i, i + length), true);
      return i + length;
    }
    if (cmd === 0x3f) {                              // ESC ? c m : K/L/Y/Z 재할당
      if (i + 1 >= n) return n;
      if (data[i] in this.dens) this.dens[data[i]] = data[i + 1];
      return i + 2;
    }

    // ---- 줄 간격 ----
    if (cmd === 0x30) { this.lineMode = 'fixed'; this.lineVal = VDPI / 8.0; return i; }
    if (cmd === 0x31) { this.lineMode = 'fixed'; this.lineVal = VDPI * 7.0 / 72.0; return i; }
    if (cmd === 0x32) { this.lineMode = 'fixed'; this.lineVal = VDPI / 6.0; return i; }
    if (cmd === 0x33) {                              // ESC 3 n : n/216"
      if (i >= n) return n;
      this.lineMode = '3'; this.lineVal = data[i]; return i + 1;
    }
    if (cmd === 0x41) {                              // ESC A n : n/72"
      if (i >= n) return n;
      this.lineMode = 'A'; this.lineVal = data[i]; return i + 1;
    }
    if (cmd === 0x2b) {                              // ESC + n : n/360"
      if (i >= n) return n;
      this.lineMode = 'fixed'; this.lineVal = data[i] * VDPI / 360.0; return i + 1;
    }

    // ---- 종이 이송 / 페이지 ----
    if (cmd === 0x4a) {                              // ESC J n : 한 번 n/denom"
      if (i >= n) return n;
      this.yf += data[i] * VDPI / this.denom;
      if (this.yf > this.bottomPx - 0.5) this._newpage();
      return i + 1;
    }
    if (cmd === 0x6a) {                              // ESC j n : 역이송 n/216"
      if (i >= n) return n;
      this.yf = Math.max(this.topPx, this.yf - data[i] * VDPI / 216.0);
      return i + 1;
    }
    if (cmd === 0x0a) { this.yf = Math.max(this.topPx, this.yf - this._linePx()); return i; }
    if (cmd === 0x0c) { this.yf = this.topPx; return i; }
    if (cmd === 0x19) {                              // ESC EM n : 용지 넣기/빼기
      if (i >= n) return n;
      if (data[i] === 0x52) this._newpage();
      return i + 1;
    }
    if (cmd === 0x43) {                              // ESC C n / ESC C 0 m : 폼 길이
      if (i >= n) return n;
      if (data[i] === 0) {
        if (i + 1 >= n) return n;
        this.pagePx = pyRound(data[i + 1] * VDPI);
        i += 2;
      } else {
        this.pagePx = pyRound(data[i] * this._linePx());
        i += 1;
      }
      this.topPx = 0.0;
      this.bottomPx = this.pagePx;
      return i;
    }
    if (cmd === 0x4e) {                              // ESC N n : 미싱선 건너뛰기
      if (i >= n) return n;
      this.bottomPx = Math.max(this._linePx(), this.pagePx - data[i] * this._linePx());
      return i + 1;
    }
    if (cmd === 0x4f) { this.bottomPx = this.pagePx; return i; }

    // ---- 가로 위치 ----
    if (cmd === 0x24) {                              // ESC $ nL nH : 절대, n/60"
      if (i + 1 >= n) return n;
      const x = this.leftPx + this._u16(data, i) * VDPI / 60.0;
      if (x <= this.rightPx) this.xf = x;
      return i + 2;
    }
    if (cmd === 0x5c) {                              // ESC \ nL nH : 상대, n/120"
      if (i + 1 >= n) return n;
      let rel = this._u16(data, i);
      if (rel >= 0x8000) rel -= 0x10000;
      this.xf = Math.min(Math.max(0.0, this.xf + rel * VDPI / 120.0), this.rightPx);
      return i + 2;
    }
    if (cmd === 0x6c) {                              // ESC l n : 왼쪽 여백 (칸)
      if (i >= n) return n;
      this.leftPx = Math.max(0, data[i] - 1) * VDPI / this.cpi;
      this.xf = Math.max(this.xf, this.leftPx);
      return i + 1;
    }
    if (cmd === 0x51) {                              // ESC Q n : 오른쪽 여백 (칸)
      if (i >= n) return n;
      this.rightPx = Math.min(this.width, data[i] * VDPI / this.cpi);
      return i + 1;
    }

    // ---- 탭 ----
    if (cmd === 0x44) {
      [i, this.htabs] = this._tablist(data, i, n, VDPI / this.cpi, 32);
      return i;
    }
    if (cmd === 0x42) {
      [i, this.vtabs] = this._tablist(data, i, n, this._linePx(), 16);
      return i;
    }
    if (cmd === 0x62) {
      // 채널은 무시한다 (용지 경로가 하나뿐이다). DOSBox-X 와 같다.
      [i, this.vtabs] = this._tablist(data, i + 1, n, this._linePx(), 16);
      return i;
    }

    // ---- 꾸밈 ----
    if (cmd === 0x21) {                              // ESC ! n : 마스터 셀렉트
      if (i >= n) return n;
      const m = data[i];
      this.cpi = (m & 0x01) ? 12.0 : 10.0;
      this.proportional = !!(m & 0x02);
      this.condensed = !!(m & 0x04);
      this.bold = !!(m & 0x08);
      this.doubleStrike = !!(m & 0x10);
      this.doubleWidth = !!(m & 0x20);
      this.italic = !!(m & 0x40);
      this.underline = !!(m & 0x80);
      return i + 1;
    }
    if (cmd === 0x4d) { this.cpi = 12.0; return i; }
    if (cmd === 0x50) { this.cpi = 10.0; return i; }
    if (cmd === 0x67) { this.cpi = 15.0; return i; }
    if (cmd === 0x20) {                              // ESC SP n : 자간
      if (i >= n) return n;
      this.interspPx = data[i] * VDPI / 120.0; return i + 1;
    }
    if (cmd === 0x0e) { this.dwOneline = true; return i; }
    if (cmd === 0x0f) { this.condensed = true; return i; }
    if (cmd === 0x57) {                              // ESC W n : 배폭
      if (i >= n) return n;
      this.doubleWidth = data[i] === 1 || data[i] === 49; return i + 1;
    }
    if (cmd === 0x2d) {                              // ESC - n : 밑줄
      if (i >= n) return n;
      this.underline = data[i] === 1 || data[i] === 49; return i + 1;
    }
    if (cmd === 0x45) { this.bold = true; return i; }
    if (cmd === 0x46) { this.bold = false; return i; }
    if (cmd === 0x47) { this.doubleStrike = true; return i; }
    if (cmd === 0x48) { this.doubleStrike = false; return i; }
    if (cmd === 0x34) { this.italic = true; return i; }
    if (cmd === 0x35) { this.italic = false; return i; }
    if (cmd === 0x53) {                              // ESC S n : 윗/아랫첨자
      if (i >= n) return n;
      this.superscript = data[i] === 0 || data[i] === 48;
      this.subscript = data[i] === 1 || data[i] === 49;
      return i + 1;
    }
    if (cmd === 0x54) { this.superscript = this.subscript = false; return i; }
    if (cmd === 0x70) {                              // ESC p n : 비례 폭
      if (i >= n) return n;
      this.proportional = data[i] === 1 || data[i] === 49; return i + 1;
    }
    if (cmd === 0x52) {                              // ESC R n : 국가별 문자셋
      if (i >= n) return n;
      this.country = data[i] <= 8 ? data[i] : 0; return i + 1;
    }

    // ---- 문자셋 / 제어 코드 찍기 ----
    if (cmd === 0x36) { this.upperCtrl = true; return i; }
    if (cmd === 0x37) { this.upperCtrl = false; return i; }
    if (cmd === 0x49) {                              // ESC I n
      if (i >= n) return n;
      this.altCtrl = !!(data[i] & 1); return i + 1;
    }
    if (cmd === 0x25) {                              // ESC % n : ROM/RAM 문자셋
      if (i >= n) return n;
      this.useRam = !!(data[i] & 1); return i + 1;
    }
    if (cmd === 0x3a) {                              // ESC : 0 0 0 : ROM -> RAM
      for (let c = 0; c < 256; c++) {
        const [cols] = this.font.glyph(c);
        this.ramChars.set(c, ['rom', cols]);
      }
      return Math.min(i + 3, n);
    }
    if (cmd === 0x26) {                              // ESC & 0 c1 c2 (속성+11열)/문자
      if (i + 2 >= n) return n;
      const c1 = data[i + 1], c2 = data[i + 2];
      i += 3;
      for (let c = c1; c <= c2; c++) {
        if (i + 12 > n) return n;
        this.ramChars.set(c, [data[i], Array.from(data.subarray(i + 1, i + 12))]);
        i += 12;
      }
      return i;
    }

    // ---- MSB 제어 ----
    if (cmd === 0x23) { this.msb = null; return i; }
    if (cmd === 0x3d) { this.msb = 0; return i; }
    if (cmd === 0x3e) { this.msb = 1; return i; }

    if (cmd === 0x40) { this._reset(); return i; }

    // ---- ESC ( x nL nH ... : ESC/P2 확장 블록 ----
    // ESC ( 명령은 저마다 바이트 수를 들고 다니므로, 모르는 것도 **정확히**
    // 건너뛸 수 있다. 안 그러면 파라미터가 글자로 흩뿌려진다.
    if (cmd === 0x28) {
      if (i + 2 >= n) return n;
      const sub = data[i];
      const length = this._u16(data, i + 1);
      this._note('ESC (', sub);
      return Math.min(i + 3 + length, n);
    }

    // ---- 아는 무동작 (파라미터만 먹고 unknown 으로 세지 않는다) ----
    if (cmd === 0x3c || cmd === 0x38 || cmd === 0x39 || cmd === 0x02 || cmd === 0x7f)
      return i;
    if ([0x55, 0x69, 0x73, 0x2f, 0x6b, 0x78, 0x74, 0x77, 0x61, 0x68, 0x72].includes(cmd))
      return Math.min(i + 1, n);
    if (cmd === 0x63 || cmd === 0x65) return Math.min(i + 2, n);
    if (cmd === 0x58) return Math.min(i + 3, n);

    this._note('ESC', cmd);
    return i;                                        // 최선: 명령 바이트만 건너뛴다
  }

  /** FS (0x1C) 명령 - 일본어 24 핀 확장 (DOSBox-X 기준). */
  _fs(data, i, n) {
    if (i >= n) return n;
    const cmd = data[i];
    i++;
    if (cmd === 0x5a) {                              // FS Z nL nH : 360x180 24 비트
      if (i + 1 >= n) return n;
      const length = this._u16(data, i) * 3;
      i += 2;
      this._bitimage(40, data.subarray(i, i + length));
      return i + length;
    }
    if (cmd === 0x32) { this.lineMode = 'fixed'; this.lineVal = VDPI / 6.0; return i; }
    if (cmd === 0x34) { this.italic = true; return i; }
    if (cmd === 0x35) { this.italic = false; return i; }
    if (cmd === 0x46 || cmd === 0x52) return i;
    if (cmd === 0x41) {                              // FS A n : n/60"
      if (i >= n) return n;
      this.lineMode = 'fixed'; this.lineVal = data[i] * VDPI / 60.0; return i + 1;
    }
    if (cmd === 0x33) {                              // FS 3 n : n/360"
      if (i >= n) return n;
      this.lineMode = 'fixed'; this.lineVal = data[i] * VDPI / 360.0; return i + 1;
    }
    if ([0x43, 0x45, 0x49, 0x53, 0x56].includes(cmd)) return Math.min(i + 1, n);
    this._note('FS', cmd);
    return i;
  }

  _htab() {
    let x;
    if (this.htabs === null) {                       // 전원 투입: 8 칸마다
      const cell = 8 * VDPI / this.cpi;
      x = (Math.trunc((this.xf - this.leftPx) / cell) + 1) * cell + this.leftPx;
    } else {
      x = -1.0;
      for (const t of this.htabs) {
        if (t + this.leftPx > this.xf) { x = t + this.leftPx; break; }
      }
    }
    if (x >= 0 && x < this.rightPx) this.xf = x;
  }

  _vtab() {
    this.dwOneline = false;
    if (this.vtabs === null) { this._linefeed(); return; }   // 전원 투입: LF 처럼
    if (!this.vtabs.length) { this.xf = this.leftPx; return; }  // 전부 취소: CR 처럼
    let y = -1.0;
    for (const t of this.vtabs) if (t > this.yf) { y = t; break; }
    if (y < 0 || y > this.bottomPx) this._newpage();
    else this.yf = y;
  }

  _control(b) {
    if (b === 0x0d) this.xf = this.leftPx;
    else if (b === 0x0a) this._linefeed();
    else if (b === 0x0c) { this.dwOneline = false; this._newpage(); }
    else if (b === 0x09) this._htab();
    else if (b === 0x0b) this._vtab();
    else if (b === 0x08) this.xf = Math.max(this.leftPx, this.xf - VDPI / this._cpiEff());
    else if (b === 0x0e) this.dwOneline = true;
    else if (b === 0x0f) this.condensed = true;
    else if (b === 0x12) this.condensed = false;
    else if (b === 0x14) this.dwOneline = false;
    else if (b === 0x00 || b === 0x07 || b === 0x11 || b === 0x13
             || b === 0x18 || b === 0x7f) { /* NUL BEL DC1 DC3 CAN DEL */ }
    else if (this.altCtrl) this._text(b);            // ESC I 1
  }

  feed(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const n = data.length;
    let i = 0;
    while (i < n) {
      let b = data[i];
      if (b === ESC) { i = this._escape(data, i + 1, n); continue; }
      if (b === FS) { i = this._fs(data, i + 1, n); continue; }
      i++;
      if (this.msb === 0) b &= 0x7f;
      else if (this.msb === 1) b |= 0x80;

      if (this.font.msxCharset) {
        // MSX 가 FX-80 보다 먼저다: 글리프 표가 0x00~0xFF 를 통째로 덮으므로
        // 높은 비트는 데이터다. 이탤릭이라고 떼어내지 않고(_text 가 기울인다),
        // 0x80~0x9F 를 제어 코드로 접지 않고, ESC R 도 건너뛴다 - MSX ROM 이
        // 악센트 글자를 제 자리에 이미 갖고 있다.
        if (b >= 0x20) this._text(b); else this._control(b);
        continue;
      }
      // --charset cp437: 높은 비트가 이탤릭으로 읽히기 전에 상위 영역을
      // FX-80 자신의 악센트 코드로 옮긴다.
      if (this.cp437 && (b in CP437_TO_FX80)) { this._text(CP437_TO_FX80[b]); continue; }

      // FX-80 규칙: 높은 비트는 이탤릭, 0x80~0x9F 는 ESC 6 이 아니면 제어 코드
      // 별명, ESC R 이 12 자리를 치환한다.
      if (b >= 0x20) b = this.italic ? (b | 0x80) : (b & 0x7f);
      if (!this.upperCtrl && b >= 0x80 && b < 0xa0) b &= 0x1f;
      const low = b & 0x7f;
      if (low in INTL) b = (b & 0x80) | INTL[low][this.country];
      if (b >= 0x20) this._text(b); else this._control(b);
    }
    return this;
  }
}

/** ESC/P 스트림을 해석해 페이지들을 돌려준다. */
export function render(data, { charset = DEFAULT_CHARSET, width = 2000 } = {}) {
  return new Renderer({ charset, width }).feed(data).pages;
}

// --- msx-picoprinter 에 보내는 작업 --------------------------------------
//
// `src/host/printer/msx_printer_escpos.py` 의 `native_bitmap()` 을 옮긴 것이다.
// **둘은 픽셀까지 같아야 한다** — 화면의 미리보기와 영수증에 나가는 것이 같은
// 그림이어야 하기 때문이다. `test/native_crosscheck.py` 가 지킨다.
//
// 왜 따로 있는가: 위의 Renderer 는 **ESC/P 를 옳게** 읽는다. 그런데
// picoprinter 펌웨어에 보내는 작업은 ESC/P 가 아니다 — 203 dpi 헤드에 1:1 로
// 놓이는 것을 전제로 쓰였다. MSXLOGO 의 `ESC A 3` 은 그 헤드에서
// (3*203+36)/72 = 8 행이라 8 도트 밴드가 딱 이어지는데, 진짜 ESC/P 로 읽으면
// 7.5 px 이송에 20 px 밴드라 12.5 px 씩 겹쳐 9 분의 1 높이로 눌린다.

/** 헤드 해상도. 아래의 모든 수는 이 단위다. */
export const HEAD_DPI = 203;

/** 58mm 헤드. picoprinter 가 연속지에서 쓰는 폭이다. */
export const PICOPRINTER_HEAD = 384;

/** picoprinter 의 사설 명령 블록. 이것이 있으면 그 펌웨어에 말하는 작업이다. */
export const PICOPRINTER_MARK = [0x1b, 0x28, 0x50];

//: ESC 명령과 뒤따르는 인자 바이트 수. 비트이미지와 ESC ( 는 따로 다룬다.
//: 모르는 명령은 글자 하나만 건너뛴다 — 펌웨어의 S_SKIP 과 같은 회복이고,
//: 데이터를 인자로 삼켜 버리는 것보다 낫다.
const ESC_ARGS = {
  '@': 0, '0': 0, '1': 0, '2': 0, E: 0, F: 0, G: 0, H: 0,
  M: 0, P: 0, g: 0, T: 0, '<': 0, '4': 0, '5': 0, '6': 0,
  '7': 0, '8': 0, '9': 0, '#': 0,
  '3': 1, A: 1, J: 1, '-': 1, W: 1, '!': 1, x: 1, k: 1,
  U: 1, S: 1, p: 1, C: 1, N: 1, Q: 1, l: 1, R: 1,
  t: 1, j: 1, r: 1, w: 1, q: 1, a: 1, s: 1,
};

/** 바이트 하나가 이 작업에 picoprinter 표시가 있는지. */
export function hasPicoprinterMark(job) {
  const [a, b, c] = PICOPRINTER_MARK;
  for (let i = 0; i + 2 < job.length; i++)
    if (job[i] === a && job[i + 1] === b && job[i + 2] === c) return true;
  return false;
}

/**
 * ESC/P 비트이미지 작업을 **펌웨어가 놓는 그대로** 비트맵으로.
 *
 * 컬럼 하나가 도트 하나, 비트 하나가 도트 하나, MSB 가 위. 줄바꿈은 줄 간격을
 * 헤드 도트로 바꾼 만큼 내려간다. **리샘플링이 없다.**
 *
 * @returns {{rowBytes:number, rows:number, data:Uint8Array}|null}
 *   글자가 섞여 있거나 잉크가 없으면 null — 글자는 펌웨어 제 폰트라
 *   흉내 낼 일이 아니고, 그때는 부르는 쪽이 Renderer 로 넘긴다.
 */
export function nativeBitmap(job, { head = PICOPRINTER_HEAD, marginX = 0,
                                    padBottom = 0 } = {}) {
  const rb = (head + 7) >> 3;
  const rows = new Map();                 // y -> Uint8Array(rb)
  let maxY = -1;

  const dot = (x, y) => {
    if (x < 0 || x >= head || y < 0) return;
    let r = rows.get(y);
    if (!r) { r = new Uint8Array(rb); rows.set(y, r); }
    r[x >> 3] |= 0x80 >> (x & 7);
    if (y > maxY) maxY = y;
  };

  let x = marginX;
  let y = 0;
  let lineH = Math.floor(HEAD_DPI / 6);   // ESC/P 의 기본, 1/6"
  let i = 0;
  const n = job.length;
  while (i < n) {
    const b = job[i];
    if (b === 0x1b && i + 1 < n) {
      const ch = String.fromCharCode(job[i + 1]);
      if (ch === 'K' || ch === 'L' || ch === 'Y' || ch === 'Z' || ch === '*') {
        let cols, per;
        if (ch === '*') {
          const m = i + 2 < n ? job[i + 2] : 0;
          cols = i + 4 < n ? (job[i + 3] | (job[i + 4] << 8)) : 0;
          per = m >= 32 ? 3 : 1;          // 24 핀 모드는 컬럼당 3 바이트
          i += 5;
        } else {
          cols = i + 3 < n ? (job[i + 2] | (job[i + 3] << 8)) : 0;
          per = 1;
          i += 4;
        }
        for (let c = 0; c < cols; c++) {
          if (i + per > n) break;
          for (let k = 0; k < per; k++) {
            const col = job[i + k];
            for (let bit = 0; bit < 8; bit++)
              if (col & (0x80 >> bit)) dot(x, y + k * 8 + bit);
          }
          x += 1;
          i += per;
        }
        continue;
      }
      if (ch === '(') {                   // ESC ( <letter> lo hi <data>
        const ln = i + 4 < n ? (job[i + 3] | (job[i + 4] << 8)) : 0;
        // 'M' <폭 u16> — "내 내용은 이만큼 넓다, 가운데 놓아라".
        if (job[i + 2] === 0x50 && ln >= 3 && job[i + 5] === 0x4d) {
          const w = job[i + 6] | (job[i + 7] << 8);
          marginX = w < head ? Math.floor((head - w) / 2) : 0;
          x = marginX;
        }
        // 'V'(세로 가운데)는 일부러 안 따른다 — 펌웨어의 1024 행 버퍼
        // 가운데는 영수증에서 58mm 빈 앞머리다. 'D'(농도)도 무시한다.
        i += 5 + ln;
        continue;
      }
      const a = ESC_ARGS[ch];
      if (a === undefined) { i += 2; continue; }
      const arg = a && i + 2 < n ? job[i + 2] : 0;
      if (ch === '@') { x = marginX; y = 0; lineH = Math.floor(HEAD_DPI / 6); }
      else if (ch === 'A') lineH = Math.floor((arg * HEAD_DPI + 36) / 72);
      else if (ch === '3') lineH = Math.floor((arg * HEAD_DPI + 108) / 216);
      else if (ch === '0') lineH = Math.floor(HEAD_DPI / 8);
      else if (ch === '1') lineH = Math.floor((7 * HEAD_DPI + 36) / 72);
      else if (ch === '2') lineH = Math.floor(HEAD_DPI / 6);
      else if (ch === 'J') y += Math.floor((arg * HEAD_DPI + 108) / 216);
      i += 2 + a;
      continue;
    }
    if (b === 0x0a) { y += lineH; x = marginX; }
    else if (b === 0x0d) x = marginX;
    else if (b === 0x0c) x = marginX;     // FF: 펌웨어는 여기서 페이지를 넘긴다
    else if (b >= 0x20 && b !== 0x7f) return null;   // 글자 — 우리 것이 아니다
    i += 1;
  }

  if (maxY < 0) return null;
  const height = maxY + 1 + padBottom;
  const data = new Uint8Array(rb * height);
  for (const [yy, r] of rows) if (yy < height) data.set(r, yy * rb);
  return { rowBytes: rb, rows: height, data };
}
