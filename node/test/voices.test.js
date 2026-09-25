// voices.test.js — 무엇으로 말하고, 어떻게 건네줄 것인가.
//
// **아무것도 말하지 않는다.** 합성기는 남의 프로그램이고 깔려 있을 수도 아닐
// 수도 있다. 여기서 보는 것은 **고르는 일**뿐이다 - 그리고 그 고르는 일이
// 이 파일의 존재 이유다. 펌웨어를 다시 굽지 않은 카트리지에서 스트리밍을
// 고르면 조용히 안 되는 것이 아니라 **까닭을 대고 거절해야** 한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINES, REPLY_MODES, isReplyMode, voiceStatus } from '../src/voices.js';

const NEW = { voiceWindow: true };    // 스트리밍 창이 있는 펌웨어
const OLD = {};                       // 없는 것

// --- 고르기 -----------------------------------------------------------------

test('글만 · 소리만 · 둘 다', () => {
  assert.deepEqual(Object.keys(REPLY_MODES), ['text', 'voice', 'both']);
  for (const m of Object.keys(REPLY_MODES)) assert.ok(isReplyMode(m));
  assert.ok(!isReplyMode('sound'));
  assert.ok(!isReplyMode('toString'), '물려받은 것은 모드가 아니다');
});

// --- 지금 어떤가 -------------------------------------------------------------

test('기본은 글만, 메아리는 꺼짐', () => {
  const s = voiceStatus({}, OLD);
  assert.equal(s.reply, 'text');
  assert.equal(s.engine, 'auto');
});

test('목소리와 언어가 그대로 실린다', () => {
  const s = voiceStatus({ engine: 'say', lang: 'ko', voice: 'Yuna' }, NEW);
  assert.equal(s.engine, 'say');
  assert.equal(s.lang, 'ko');
  assert.equal(s.voice, 'Yuna');
});
