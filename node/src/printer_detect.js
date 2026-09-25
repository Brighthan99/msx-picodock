// SPDX-License-Identifier: GPL-2.0-only
//
// printer_detect.js — 잡아 둔 인쇄 작업을 보고 어떻게 그릴지 말한다.
//
// src/host/printer/msx_printer_detect.py 를 옮긴 것이다. 작업이 다 끝난 뒤에
// (스풀은 조용한 시간으로 작업을 닫는다) 모든 바이트를 손에 들고 판단한다.
//
//     const { mode, charset, why } = detect(bytes);
//
//     off           빈 작업
//     text          ASCII/제어 바이트뿐이거나, CJK 가 문자 코드로 왔다
//                   (그때 charset 이 어느 코덱인지 말한다)
//     raster        ESC/P: 점 그래픽이거나, 글자 꾸밈 명령이 섞여 있다
//     msx-kanji     ESC K + JIS X 0208 - 한자 ROM 이나 폰트가 필요하다
//     msx-hangul    대우 자모 스트림 - 한글 폰트가 필요하다
//     raw           높은 바이트가 있는데 아는 구조가 없다
//
// **자동 판별은 편의이지 신탁이 아니다.** 원본 .prn 은 언제나 함께 남으므로
// 틀린 추측에 드는 값은 0 이다 - 다시 그리면 된다.

// 점 그래픽 명령: ESC * / K / L / Y / Z / ^ 와 FS Z. 하나라도 있으면 스트림이
// 점을 나르는 것이라, 렌더러만이 그 쪽을 재현할 수 있다.
const GFX = /\x1b[\x2a\x4b\x4c\x59\x5a\x5e]|\x1cZ/;

// 꾸밈·배치 명령 - 점은 아니지만 자간·굵게·밑줄·탭·여백이 글자로만 옮기면
// 사라진다. 그래서 렌더러 쪽을 고른다.
const STYLE = /\x1b[\x21\x2d\x34\x35\x45\x46\x47\x48\x4d\x50\x53\x54\x57\x67\x70\x44\x42\x51\x6c\x24\x5c]/;

// ESC/P 구조는 없는데 높은 바이트가 있을 때 시도하는 코덱들.
//
// utf-8 이 먼저다: 여기서 유일하게 **검증되는** 인코딩이다. 아무 8 비트
// 데이터가 올바른 다중바이트 UTF-8 을 이루는 일은 거의 없으므로, 깨끗한
// 디코드는 추측이 아니라 증거다. MSX 시절 소프트가 내보내는 것이 아니라
// 요즘 크로스 개발 도구가 내보낸다.
//
// 한국어 코덱은 없다. 한국에 MSX 가 많았지만(대우 CPC/DPC, 재믹스) 거기서
// 나온 한국어 *코덱*이 확인된 적이 없다. 확인된 것은 대우 프린터 드라이버의
// 자모 스트림이고, 그건 msx-hangul 방언이지 text 가 아니다.
//
// 중국어는 더 분명한 이유로 빠졌다 - MSX 는 중국 본토에서 팔린 적이 없다.
const CJK_CODECS = ['utf-8', 'shift_jis'];

// 디코드가 답으로 인정받으려면 나온 것의 대부분이 CJK 여야 한다. 아무 8 비트
// 코덱이나 남의 바이트에도 "성공" 한다 - euc_kr 글을 shift_jis 로 읽으면
// 반각 가나 잡음에 한자가 드문드문 섞여 나온다. 이 문턱이 없으면 우연한
// 한 번이 정직한 "모르겠다" 를 이긴다.
const CJK_MIN_DENSITY = 0.30;

const between = (c, lo, hi) => c >= lo && c <= hi;

/**
 * CJK 바이트 스트림의 코덱을 짐작한다.
 *
 * 점수: 가나와 한글 음절은 한자보다 무겁게 친다 - 각각을 낼 수 있는 코덱이
 * 하나뿐이라, 가나가 이어지면 shift_jis 라는 것이 거의 증명된다. utf-8 은
 * 스스로 검증되므로 한 번 더 얹는다.
 */
export function sniffCharset(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const scores = {};
  for (const cs of CJK_CODECS) {
    let t;
    try {
      // fatal 로 열어야 "이 코덱이 아니다" 를 알 수 있다. 관대하게 읽으면
      // 무엇이든 U+FFFD 를 섞어 가며 성공해 버린다.
      t = new TextDecoder(cs, { fatal: true }).decode(bytes);
    } catch {
      scores[cs] = -1;
      continue;
    }
    let kana = 0, hang = 0, han = 0, body = 0;
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (between(c, 0x3040, 0x30ff)) kana++;
      else if (between(c, 0xac00, 0xd7a3)) hang++;
      else if (between(c, 0x4e00, 0x9fff)) han++;
      if (!/\s/.test(ch)) body++;
    }
    body = body || 1;
    const cjk = kana + hang + han;
    if (cjk / body < CJK_MIN_DENSITY) { scores[cs] = 0; continue; }
    let score = kana * 3 + hang * 3 + han;
    if (cs === 'utf-8') score *= 2;
    scores[cs] = score;
  }
  let best = CJK_CODECS[0];
  for (const cs of CJK_CODECS) if (scores[cs] > scores[best]) best = cs;
  return { best: scores[best] > 0 ? best : null, scores };
}

/**
 * 끝난 인쇄 작업 하나에 대해 `{mode, charset, why}`.
 *
 * `charset` 은 mode 가 'text' 이고 바이트가 CJK 문자 코드로 보일 때만 값이 있다.
 */
export function detect(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!bytes.length) return { mode: 'off', charset: null, why: 'empty job' };

  // 정규식에 태우려고 바이트를 그대로 코드포인트로 본다 (latin1).
  const s = bytes.toString('latin1');

  const dialect = detectDialect(bytes);
  if (dialect === 'msx-kanji')
    return { mode: 'msx-kanji', charset: null,
             why: 'ESC K + JIS codes (kanji ROM or font needed)' };
  if (dialect === 'msx-hangul')
    return { mode: 'msx-hangul', charset: null,
             why: 'Daewoo jamo stream (hangul font needed)' };

  if (GFX.test(s))
    return { mode: 'raster', charset: null, why: 'ESC/P bit-image opcodes' };
  if (STYLE.test(s))
    return { mode: 'raster', charset: null,
             why: 'ESC/P styling opcodes (a text decode drops them)' };

  let hi = 0;
  for (const b of bytes) if (b >= 0x80) hi++;
  if (hi) {
    const { best, scores } = sniffCharset(bytes);
    if (best) {
      // 파이썬과 **글자 그대로** 같아야 한다. 이 문자열은 로그에도 나가고
      // 대조 시험도 여기를 본다.
      const ranked = Object.entries(scores)
        .sort((a, b2) => b2[1] - a[1])
        .map(([k, v]) => `${k}=${v}`).join(', ');
      return { mode: 'text', charset: best, why: `CJK character codes (${ranked})` };
    }
    return { mode: 'raw', charset: null, why: `${hi} high bytes, no structure recognised` };
  }
  return { mode: 'text', charset: 'cp437', why: 'ASCII and control codes only' };
}

export function describe(data) {
  const { mode, charset, why } = detect(data);
  return `${mode}${charset ? ' --charset ' + charset : ''}  (${why})`;
}

/**
 * 'escp' · 'msx-kanji' · 'msx-hangul'.
 *
 * msx_printer_kanji_render.py 의 detect_dialect() 를 옮긴 것이다. 그 모듈은
 * 그리는 일까지 하지만(477 줄), 여기서 필요한 것은 이 판별뿐이라 이것만 왔다.
 *
 * 순서가 규칙의 일부다:
 *
 *   1. **ESC/P 에만 있는 명령이 이긴다.** 그게 있으면 MSX 한자 프로토콜이
 *      아니다.
 *   2. ESC K 다음의 두 바이트가 둘 다 JIS 범위이고 **그 뒤에 제어 바이트나
 *      끝**이 오면 MSX 한자다. ESC/P 에서 그 두 바이트는 열 *개수*이고 뒤에
 *      픽셀 데이터가 따라오므로, 뒤에 무엇이 오는지가 둘을 가른다.
 *   3. DC1 이 여덟 번 이어지면 (동기 신호) 역시 MSX 한자다.
 *   4. ESC 가 아예 없고, 높은 바이트가 넷 이상이며, **그 전부가** 자모
 *      범위이면 대우 한글이다.
 *
 * 4 번의 "전부" 가 핵심이다. 자모 범위 바이트를 **세기만** 하던 때는 일본어
 * 문서를 한글이라고 불렀다 - shift_jis 의 선행·후행 바이트가 0x86~0xA6 에
 * 걸쳐 있어서 `日本語のテスト文書です` 만으로 6 개가 나온다. 진짜 대우 캡처는
 * 그 범위 밖이 하나도 없다. (파이썬 쪽 v0.34.0 에서 고친 것이다.)
 */
export function detectDialect(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const s = bytes.toString('latin1');

  if (/\x1b[\x2a\x33\x40\x4a\x30\x31\x32]/.test(s)) return 'escp';
  if (/\x1bK[\x21-\x7e][\x21-\x7e](?:[\x00-\x1f]|$)/.test(s)) return 'msx-kanji';
  if (s.includes('\x11'.repeat(8))) return 'msx-kanji';

  let hiCount = 0, allJamo = true;
  for (const b of bytes) {
    if (b < 0x80) continue;
    hiCount++;
    if (b < 0x86 || b > 0xa6) allJamo = false;
  }
  if (!s.includes('\x1b') && hiCount >= 4 && allJamo) return 'msx-hangul';
  return 'escp';
}
