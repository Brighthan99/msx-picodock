// SPDX-License-Identifier: GPL-2.0-only
//
// voices.js — MSX 가 말하게 하는 일. 무엇으로 합성하고, 어떻게 건네줄 것인가.
//
// 두 가지가 들어 있고 둘은 별개다.
//
//   1. **합성기.** `src/host/pd_voice.py` 가 부르는 것들 - say(맥 내장),
//      espeak-ng(어디서나, 포먼트), piper(신경망). 우리가 만들지 않는다.
//      음성 합성기는 몇 년짜리 일이고 좋은 것이 이미 깔려 있다.
//
//   2. **전달 경로.** 합성한 것은 PSG 볼륨 스트림 한 덩어리다 - 11 kHz 로
//      초당 10.8 KB, `안녕하세요` 한 마디가 9.8 KB. 그걸 MSX 에 어떻게
//      넘기느냐가 셋으로 갈리고, **셋 다 MSX 쪽 코드가 다르다.**
//
// 호스트에서 경로를 고르는 것은 싸다(함수 하나씩). 비싼 것은 MSX 쪽이라,
// 여기 자리를 셋 다 만들어 두되 만드는 것은 하나씩 한다.

//: 합성기. voice.js 의 ENGINES 와 같은 이름을 쓴다 - 거기가 진짜 목록이고 여기는
//: 화면에 보일 이름을 붙일 뿐이다. sapi 는 Node 판에만 있다 (voice.js 머리말).
export const ENGINES = {
  auto: 'Whichever is installed (say on a Mac, Windows voices on Windows, else espeak-ng)',
  'say': 'macOS built-in — the best of these',
  'sapi': 'Windows built-in voices',
  'espeak-ng': 'Formant, 141 languages, runs anywhere',
  'piper': 'Neural, needs a model per voice',
};

/*
 * 전달 경로가 셋 있었다: 카트리지의 링(stream), 디스크에 파일로(disk),
 * ask 채널로 통째로(mailbox). 실기에서 셋을 다 들어보고 stream 만 남겼다.
 *
 * **셋의 소리가 같았다.** 그것이 이 실험의 수확이다 - disk 와 mailbox 는
 * 통째로 받아 RAM 에서 틀어서 재생 중 버스를 전혀 안 읽는데도 stream 과
 * 구별되지 않았으므로, 남은 잡음은 버스가 아니라 볼륨 표와 양자화다.
 * 그쪽을 더 파지 않아도 된다는 것을 알려 준 값이 이 코드의 값이었고,
 * 알고 난 뒤에는 코드가 아니라 이 문단이 그 값을 들고 있으면 된다.
 *
 * 그리고 둘 다 stream 보다 못했다:
 *   mailbox  청크당 112 ms, 11 KB 한 마디에 10 초 (실측 2026-09-24)
 *   disk     128 KB 에 갇히고, FAT 직접 쓰기와 Nextor 캐시 비우기가 붙는다
 *
 * 지운 것: DELIVERY / chooseDelivery / deliveryList / deliveryLabel,
 * voicefile.js, pd_play_ram 과 pd_snd_* 와 pd_load_file, OP_SND.
 * 되살리려면 git 에 있다 (v1.18.3).
 */

export const REPLY_MODES = {
  text: 'Text only',
  voice: 'Voice only',
  both: 'Text and voice',
};

export function isReplyMode(m) { return Object.hasOwn(REPLY_MODES, m); }

/**
 * 지금 어떤가. 화면이 그대로 그린다.
 *
 * `caps` 를 받아서 도는 이유: 카트리지를 다시 구우면 `voiceWindow` 가 참이
 * 되고, 그러면 `auto` 의 답이 **말없이 바뀐다.** 화면이 그것을 보여야 한다.
 */
export function voiceStatus(opts = {}) {
  return {
    reply: opts.reply || 'text',
    engine: opts.engine || 'auto',
    lang: opts.lang || 'en',
    voice: opts.voice || null,
  };
}
