// SPDX-License-Identifier: GPL-2.0-only
//
// kanji.js — MSX 한자 프린터 스트림(ESC K + JIS)을 페이지로.
//
// src/host/printer/msx_printer_kanji_render.py 를 옮긴 것이다.
//
// MSX-Write(ASCII, 1986)와 동시대 소프트는 한자를 ESC/P 비트이미지로 찍지
// **않는다.** 전각 한 글자를 `ESC 'K' j1 j2` (JIS X 0208 두 바이트)로 내보내고,
// 글리프는 **프린터 자신의 한자 ROM** 이 댄다. 그래서 캡처에는 픽셀이 하나도
// 없다 - 래스터로 만들려면 한자 폰트 ROM 이 있어야 한다.
//
// **그 ROM 은 재배포 대상이 아니다** (resources/font-roms/README.md). 그래서 이
// 모듈은 둘로 갈라져 있다:
//
//   records   ROM 없이 파싱만 한다. 글자마다 (쪽, x, y, j1, j2) 를 모은다.
//             여기에는 저작권 있는 데이터가 하나도 없다.
//   glyphs    ROM 이 있을 때만. 16x16 비트맵을 캔버스에 찍는다.
//
// 브라우저는 records 만 받아서 **제 폰트로** 그릴 수 있다. JIS 코드를 유니코드로
// 바꾸는 데도 표가 필요 없다 - (j1|0x80, j2|0x80) 이 곧 EUC-JP 라서 TextDecoder
// 가 읽는다. 시대 고증이 필요하면 ROM 을 쥔 쪽에서 glyphs 로 그린다.
//
// 줄 간격 의미는 openMSX 의 ImagePrinterMSX 를 따른다.
//
//     ESC 'K' j1 j2   전각 한 글자, JIS 코드 (각 0x21-0x7E)
//     ESC 'T' n n     줄 이송 nn/144" (ASCII 숫자 두 개)
//     ESC 'A' / 'B'   줄 이송 1/6" / 1/9"
//     DC1 (0x11)      프린터 선택/동기 - 무시
//     CAN (0x18)      줄 취소 - 무시
//     CR LF FF        복귀 / 줄 이송 / 쪽 넘김
//     ESC <그 외>     한 바이트 이스케이프 - 건너뛰고 센다

import { Page } from './escp.js';

export { Page };

const ESC = 0x1b;

// 캔버스 기하: escp.js 와 같은 180 dpi. 한자 프린터의 점 하나를 2x2 px 로
// 그리므로 16 점 글리프가 32 px 이 되고, 전진은 한 글자 + 작은 틈이다.
const VDPI = 180.0;
const DOT = 2;
const CELL = 16 * DOT;
const ADVANCE = CELL + 4;

/**
 * JIS X 0208 코드 -> KNJFNT16 형식 ROM 의 글리프 번호.
 *
 * ROM 형식은 EC-702 / FS-A1WX 덤프를 뜯어 알아내고 openMSX 의 한자 장치 출력과
 * 글자 하나하나 대조해 확인한 것이다.
 */
export function jisIndex(j1, j2) {
  if (j1 >= 0x50) return 0x1000 + 0x400 + (j1 - 0x50) * 96 + (j2 - 0x20);  // JIS 2 수준
  if (j1 >= 0x30) return 0x400 + (j1 - 0x30) * 96 + (j2 - 0x20);           // JIS 1 수준
  return (j1 - 0x20) * 96 + (j2 - 0x20);            // 기호 / 가나 / 전각 영숫자
}

/**
 * 글리프 한 자의 16 행 (bit15 가 맨 왼쪽 픽셀). ROM 이 그 번호에 못 미치면 null.
 *
 * ROM 의 32 바이트는 8x8 사분면 넷으로 놓여 있다 - 바이트 0~7 이 좌상, 8~15 가
 * 우상, 16~23 이 좌하, 24~31 이 우하다.
 */
export function glyphRows(rom, j1, j2) {
  const off = jisIndex(j1, j2) * 32;
  if (off + 32 > rom.length) return null;
  const rows = [];
  for (let r = 0; r < 8; r++) rows.push((rom[off + r] << 8) | rom[off + 8 + r]);
  for (let r = 0; r < 8; r++) rows.push((rom[off + 16 + r] << 8) | rom[off + 24 + r]);
  return rows;
}

/** glyphRows 의 역함수 - ROM 이미지를 만드는 도구와 시험이 쓴다. */
export function packGlyph(rows) {
  const out = new Uint8Array(32);
  for (let r = 0; r < 8; r++) {
    out[r] = rows[r] >> 8; out[8 + r] = rows[r] & 0xff;
    out[16 + r] = rows[8 + r] >> 8; out[24 + r] = rows[8 + r] & 0xff;
  }
  return out;
}

export class KanjiRenderer {
  /** `rom` 이 null 이면 그리지 않고 파싱만 한다 - records 는 그래도 다 모인다. */
  constructor(rom = null, width = 2000) {
    this.rom = rom;
    this.width = width;
    this.pages = [new Page(width)];
    this.x = 0;
    this.y = 0;
    this.linePx = Math.round(VDPI / 6);    // 기본 1/6"
    this.chars = 0;
    this.missing = 0;                      // ROM 크기를 넘는 글자
    this.unknown = new Map();
    this.records = [];                     // [쪽, x, y, j1, j2]
  }

  get page() { return this.pages[this.pages.length - 1]; }

  _draw(j1, j2) {
    this.records.push([this.pages.length - 1, this.x, this.y, j1, j2]);
    if (this.rom === null) { this.chars++; return; }
    const rows = glyphRows(this.rom, j1, j2);
    if (rows === null) { this.missing++; return; }
    for (let ry = 0; ry < 16; ry++) {
      const row = rows[ry];
      if (!row) continue;
      for (let rx = 0; rx < 16; rx++) {
        if (row & (0x8000 >> rx)) {
          const px = this.x + rx * DOT, py = this.y + ry * DOT;
          for (let dy = 0; dy < DOT; dy++)
            for (let dx = 0; dx < DOT; dx++) this.page.plot(px + dx, py + dy);
        }
      }
    }
    this.chars++;
  }

  _escape(data, i, n) {
    if (i >= n) return n;
    const cmd = data[i];
    i++;
    if (cmd === 0x4b && i + 1 < n
        && data[i] >= 0x21 && data[i] <= 0x7e
        && data[i + 1] >= 0x21 && data[i + 1] <= 0x7e) {
      this._draw(data[i], data[i + 1]);    // ESC K j1 j2
      this.x += ADVANCE;
      return i + 2;
    }
    if (cmd === 0x54 && i + 1 < n) {       // ESC T n n : nn/144"
      // 파이썬은 int(b"..") 로 읽고 실패하면 24 로 떨어진다. 두 바이트가 ASCII
      // 숫자가 아니면 그 자리다 - 숫자 아닌 것을 관대하게 읽으면 갈라진다.
      const s = String.fromCharCode(data[i], data[i + 1]);
      const nn = /^[ \t]*[+-]?\d+[ \t]*$/.test(s) ? parseInt(s, 10) : 24;
      this.linePx = Math.max(1, Math.round(nn * VDPI / 144));
      return i + 2;
    }
    if (cmd === 0x41) { this.linePx = Math.round(VDPI / 6); return i; }
    if (cmd === 0x42) { this.linePx = Math.round(VDPI / 9); return i; }
    const key = (cmd >= 0x20 && cmd < 0x7f) ? String.fromCharCode(cmd) : cmd;
    this.unknown.set(key, (this.unknown.get(key) || 0) + 1);
    return i;                              // 한 바이트 이스케이프: 건너뛴다
  }

  feed(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const n = data.length;
    let i = 0;
    while (i < n) {
      const b = data[i];
      if (b === ESC) i = this._escape(data, i + 1, n);
      else if (b === 0x0d) { this.x = 0; i++; }
      else if (b === 0x0a) { this.y += this.linePx; i++; }
      else if (b === 0x0c) { this.pages.push(new Page(this.width)); this.x = 0; this.y = 0; i++; }
      else i++;                            // DC1/CAN/그 외: 무시
    }
    return this;
  }
}

/** 스트림을 해석해 페이지들을 돌려준다. rom 이 null 이면 다 빈 페이지다. */
export function render(data, rom = null) {
  return new KanjiRenderer(rom).feed(data).pages;
}

/**
 * 스트림의 JIS 코드를 유니코드 글로. **폰트가 필요 없다.**
 *
 * (j1|0x80, j2|0x80) 이 곧 EUC-JP 라서 TextDecoder 가 그대로 읽는다. 표를
 * 따로 들고 있지 않아도 되는 이유다.
 *
 * 쪽마다 줄의 배열을 돌려준다.
 */
export function extractText(data) {
  const r = new KanjiRenderer(null).feed(data);
  const dec = new TextDecoder('euc-jp', { fatal: false });
  const pages = [];
  for (let pi = 0; pi < r.pages.length; pi++) {
    const lines = new Map();
    for (const [recPage, x, y, j1, j2] of r.records) {
      if (recPage !== pi) continue;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push([x, j1, j2]);
    }
    const page = [];
    for (const y of [...lines.keys()].sort((a, b) => a - b)) {
      const row = lines.get(y).slice().sort((a, b) => a[0] - b[0]);
      const raw = new Uint8Array(row.length * 2);
      row.forEach(([, j1, j2], k) => { raw[k * 2] = j1 | 0x80; raw[k * 2 + 1] = j2 | 0x80; });
      page.push(dec.decode(raw));
    }
    if (page.length) pages.push(page);
  }
  return pages;
}
