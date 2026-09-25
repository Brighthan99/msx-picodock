// SPDX-License-Identifier: GPL-2.0-only
//
// printer_text.js — MSX 가 찍은 바이트를 글자로 읽는다.
//
// src/host/printer/msx_printer_render.py 의 decode_msx() 를 옮긴 것이다.
//
// **cp437 만 표를 들고 있다.** 브라우저·Node 의 TextDecoder 는 Encoding
// Standard 가 정한 목록만 안다. shift_jis 와 utf-8 은 거기 있지만 cp437 은
// 없다 - MSX 의 International/Western ROM 이 내보내는 기본 인코딩인데도.
// 그래서 여기에 256 칸 표를 둔다. 표는 파이썬에서 뽑아 붙였다. 손으로 옮기면
// 반드시 한 칸이 틀리고, 그 한 칸은 몇 년 뒤에 엉뚱한 글자로 드러난다.
//
// **cp932 는 파이썬의 그것과 같지 않다.** 파이썬의 cp932 는 shift_jis 에 벤더
// 확장을 얹어 0xFD~0xFF 같은 바이트를 사용자 정의 영역(U+E000~U+F8FF)으로
// 보낸다. Encoding Standard 의 shift_jis 에는 그 매핑이 없어서 U+FFFD 가
// 나온다. 여기서는 별명으로 두되, 그 영역의 글자는 못 낸다는 것을 적어 둔다 -
// 어차피 폰트마다 뜻이 다른, 옮겨 다닐 수 없는 문자들이다.
//
// latin-1 도 직접 만든다. Encoding Standard 에서 `iso-8859-1` 이라는 이름은
// **windows-1252** 로 가고, 그쪽은 0x80~0x9F 를 따옴표 같은 활자로 바꾼다.
// 파이썬의 latin-1 은 그 구간을 제어문자 그대로 둔다. 이름이 같다고 같은
// 것이 아니다.

/** cp437: 바이트 -> 유니코드. 파이썬 `bytes([b]).decode('cp437')` 과 같다. */
const CP437 = (
  '\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007'
  + '\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f'
  + '\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017'
  + '\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f'
  + '\u0020\u0021\u0022\u0023\u0024\u0025\u0026\u0027'
  + '\u0028\u0029\u002a\u002b\u002c\u002d\u002e\u002f'
  + '\u0030\u0031\u0032\u0033\u0034\u0035\u0036\u0037'
  + '\u0038\u0039\u003a\u003b\u003c\u003d\u003e\u003f'
  + '\u0040\u0041\u0042\u0043\u0044\u0045\u0046\u0047'
  + '\u0048\u0049\u004a\u004b\u004c\u004d\u004e\u004f'
  + '\u0050\u0051\u0052\u0053\u0054\u0055\u0056\u0057'
  + '\u0058\u0059\u005a\u005b\u005c\u005d\u005e\u005f'
  + '\u0060\u0061\u0062\u0063\u0064\u0065\u0066\u0067'
  + '\u0068\u0069\u006a\u006b\u006c\u006d\u006e\u006f'
  + '\u0070\u0071\u0072\u0073\u0074\u0075\u0076\u0077'
  + '\u0078\u0079\u007a\u007b\u007c\u007d\u007e\u007f'
  + '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7'
  + '\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5'
  + '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9'
  + '\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192'
  + '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba'
  + '\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb'
  + '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556'
  + '\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510'
  + '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f'
  + '\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567'
  + '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b'
  + '\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580'
  + '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4'
  + '\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229'
  + '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248'
  + '\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0'
).split('');

/** MSX 프린터 바이트를 문자열로. 모르는 charset 은 cp437 로 떨어진다. */
export function decodeMsx(data, charset = 'cp437') {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const cs = String(charset || 'cp437').toLowerCase();

  if (cs === 'cp437' || cs === 'ibm437') {
    let out = '';
    for (const b of bytes) out += CP437[b];
    return out;
  }
  if (cs === 'latin-1' || cs === 'latin1' || cs === 'iso-8859-1') {
    return bytes.toString('latin1');     // 바이트 값이 곧 코드포인트
  }
  try {
    // cp932 는 Encoding Standard 에서 shift_jis 의 별명이다.
    const label = (cs === 'cp932' || cs === 'ms932') ? 'shift_jis' : cs;
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    let out = '';
    for (const b of bytes) out += CP437[b];
    return out;                          // 모르는 이름이면 기본값으로
  }
}

/**
 * 터미널이나 화면에 그대로 내보내도 안전하게.
 *
 * 탭·개행은 남기고 나머지 제어문자와 DEL 은 바꾼다. 안 그러면 ESC/P 열이
 * 커서를 옮기고 색을 바꾸고 화면을 망가뜨린다 - 프린터 캡처에는 그런
 * 바이트가 널려 있다.
 */
export function sanitize(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    out += (ch === '\t' || ch === '\r' || ch === '\n' || (c >= 32 && c !== 127))
      ? ch : '\u00b7';
  }
  return out;
}
