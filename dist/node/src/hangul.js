// SPDX-License-Identifier: GPL-2.0-only
//
// hangul.js — 대우 MSX 한글 프린터 스트림을 글자로.
//
// src/host/printer/msx_printer_hangul_render.py 를 옮긴 것이다. 원본은 DPC-200
// (Qnix "IQ-1000 한글" v2.0 드라이버) 의 LPRINT 캡처를 뜯어 알아낸 것이다.
//
// **그 드라이버는 한글을 KS 코드로 보내지 않는다.** 자모 하나에 바이트 하나씩
// 보내고, 조합은 (대우 한글) 프린터가 한다. 그래서 캡처에는 완성된 글자가 없고
// 자모만 줄줄이 들어 있다. ASCII 는 그대로 지나가므로 영문과 섞여도 된다.
//
//     0x86-0x98   자음 ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ (19)
//     0x99-0xA6   모음 ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ (14, 두벌식 자판 배열)
//     0x20-0x7E   ASCII, 그대로
//     CR LF / FF  줄바꿈 / 쪽 넘김
//
//     한 = 98 99 88 (ㅎㅏㄴ)   드 = 89 a5 (ㄷㅡ)
//
// **여기에 ROM 이 필요 없다.** 나오는 것은 유니코드 글자이고, 그리는 일은
// 폰트가 한다 - 브라우저에는 이미 한글 폰트가 있다. 한자 쪽과 결정적으로
// 다른 점이다.
//
// 자판 배열에 없는 모음(ㅘㅝㅢ...)과 겹받침(ㄳㄼ...)은 두 자모가 합쳐져
// 만들어지고, **도깨비불**까지 재현한다 - 받침이 있는 글자 뒤에 모음이 오면
// 받침이 다음 글자의 초성으로 넘어간다 (한 + ㅏ -> 하나).

const CONS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';        // 0x86..0x98
const VOWS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ';                  // 0x99..0xA6

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

const VOW_COMPOUND = new Map([
  ['ㅗㅏ', 'ㅘ'], ['ㅗㅐ', 'ㅙ'], ['ㅗㅣ', 'ㅚ'],
  ['ㅜㅓ', 'ㅝ'], ['ㅜㅔ', 'ㅞ'], ['ㅜㅣ', 'ㅟ'],
  ['ㅡㅣ', 'ㅢ'],
]);
const JONG_COMPOUND = new Map([
  ['ㄱㅅ', 'ㄳ'], ['ㄴㅈ', 'ㄵ'], ['ㄴㅎ', 'ㄶ'],
  ['ㄹㄱ', 'ㄺ'], ['ㄹㅁ', 'ㄻ'], ['ㄹㅂ', 'ㄼ'],
  ['ㄹㅅ', 'ㄽ'], ['ㄹㅌ', 'ㄾ'], ['ㄹㅍ', 'ㄿ'],
  ['ㄹㅎ', 'ㅀ'], ['ㅂㅅ', 'ㅄ'],
]);
const JONG_SPLIT = new Map([...JONG_COMPOUND].map(([k, v]) => [v, [k[0], k[1]]]));

/** 두벌식 자모를 한글 음절로. 도깨비불 포함. */
export class Composer {
  constructor() {
    this.out = [];
    this.cho = this.jung = this.jong = null;
  }

  _flush() {
    if (this.cho !== null && this.jung !== null) {
      let s = 0xac00 + (CHO.indexOf(this.cho) * 21 + JUNG.indexOf(this.jung)) * 28;
      if (this.jong !== null) s += JONG.indexOf(this.jong) + 1;
      this.out.push(String.fromCodePoint(s));
    } else if (this.cho !== null) {
      this.out.push(this.cho);
    } else if (this.jung !== null) {
      this.out.push(this.jung);
    }
    this.cho = this.jung = this.jong = null;
  }

  consonant(c) {
    if (this.jung !== null && this.jong === null && JONG.includes(c)) {
      this.jong = c;
    } else if (this.jong !== null && JONG_COMPOUND.has(this.jong + c)) {
      this.jong = JONG_COMPOUND.get(this.jong + c);
    } else {
      this._flush();
      this.cho = c;
    }
  }

  vowel(v) {
    if (this.jong !== null) {
      // 도깨비불: 받침이 다음 글자의 초성으로 넘어간다 (한 + ㅏ -> 하나).
      const jong = this.jong;
      this.jong = null;
      let carry;
      if (JONG_SPLIT.has(jong)) [this.jong, carry] = JONG_SPLIT.get(jong);
      else carry = jong;
      this._flush();
      this.cho = CHO.includes(carry) ? carry : null;
      if (this.cho === null) this.out.push(carry);
      this.jung = v;
    } else if (this.jung !== null && VOW_COMPOUND.has(this.jung + v)) {
      this.jung = VOW_COMPOUND.get(this.jung + v);
    } else if (this.cho !== null && this.jung === null) {
      this.jung = v;
    } else {
      this._flush();
      this.jung = v;
    }
  }

  other(ch) {
    this._flush();
    this.out.push(ch);
  }

  result() {
    this._flush();
    return this.out.join('');
  }
}

/** 자모/ASCII 스트림을 쪽들로. 각 쪽은 줄의 배열. */
export function decode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const pages = [];
  let lines = [];
  let comp = new Composer();

  const endline = (final = false) => {
    const text = comp.result();
    comp = new Composer();
    if (text || (lines.length && !final)) lines.push(text);
  };

  for (const b of bytes) {
    if (b >= 0x86 && b <= 0x98) comp.consonant(CONS[b - 0x86]);
    else if (b >= 0x99 && b <= 0xa6) comp.vowel(VOWS[b - 0x99]);
    else if (b === 0x0d) continue;
    else if (b === 0x0a) endline();
    else if (b === 0x0c) {
      endline();
      if (lines.length) { pages.push(lines.slice()); lines.length = 0; }
    } else if (b >= 0x20 && b <= 0x7e) comp.other(String.fromCharCode(b));
    // 그 밖의 제어·모르는 높은 바이트는 무시한다
  }
  endline(true);
  if (lines.length) pages.push(lines);
  return pages;
}

/** 유니코드를 자모 스트림으로 (decode 의 역함수, 시험이 쓴다). */
export function encode(text) {
  const out = [];
  for (const ch of text) {
    const o = ch.codePointAt(0);
    if (o >= 0xac00 && o <= 0xd7a3) {
      const k = o - 0xac00;
      const cho = CHO[Math.floor(k / 588)];
      const jung = JUNG[Math.floor((k % 588) / 28)];
      const jong = k % 28;
      out.push(0x86 + CONS.indexOf(cho));
      for (const v of splitVowel(jung)) out.push(0x99 + VOWS.indexOf(v));
      if (jong) for (const c of splitJong(JONG[jong - 1])) out.push(0x86 + CONS.indexOf(c));
    } else if (o >= 0x20 && o <= 0x7e) {
      out.push(o);
    } else if (ch === '\n') {
      out.push(0x0d, 0x0a);
    }
  }
  return Uint8Array.from(out);
}

function splitVowel(v) {
  for (const [k, comp] of VOW_COMPOUND) if (comp === v) return [k[0], k[1]];
  return [v];
}

function splitJong(c) {
  if (JONG_SPLIT.has(c)) return JONG_SPLIT.get(c);
  return [c];
}
