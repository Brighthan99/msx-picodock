// voicestream.test.js — 링을 안 넘치고 안 굶기는가.
//
// **카트리지도 MSX 도 없다.** 보내는 자리에 가짜를 끼우고, 카트리지가
// 말했을 법한 상태를 손으로 먹인다. 그래도 이 파일이 보는 것은 진짜 문제다 -
// 링은 4KB 이고 한 마디는 10KB 라, 흐름 제어가 틀리면 **말의 앞이나 뒤가
// 통째로 사라진다.** 그것은 실기에서 "왜 반만 나오지" 로 나타난다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceStream, frame, RING, FRAME, LEAD,
         VOICE_DATA, VOICE_CTRL, CTRL_RESET, CTRL_CLOSE,
         ST_ARMED, ST_STARVED, ST_ENDED } from '../src/voicestream.js';
import { Hub, CH_ASK } from '../src/hub.js';

function rig() {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_ASK) seen.push(ev); });
  const out = [];
  const send = (buf) => out.push(buf);
  return { hub, seen, out, send, v: new VoiceStream(hub) };
}

/** 프레임을 뜯는다. 보낸 것을 세려면 보낸 모양대로 읽어야 한다. */
function parse(buf) {
  const len = buf[2] | (buf[3] << 8);
  return { cmd: buf[1], payload: buf.subarray(4, 4 + len) };
}
const datas = (out) => out.map(parse).filter((f) => f.cmd === VOICE_DATA);
const bytesSent = (out) => datas(out).reduce((n, f) => n + f.payload.length, 0);
const ctrls = (out) => out.map(parse).filter((f) => f.cmd === VOICE_CTRL)
                          .map((f) => f.payload[0]);

const evs = (seen, ev) => seen.filter((e) => e.ev === ev);

// --- 프레임 ------------------------------------------------------------------

test('프레임은 약속한 모양이다', () => {
  const f = frame(VOICE_DATA, [1, 2, 3]);
  assert.equal(f[0], 0x5A, 'SOF');
  assert.equal(f[1], VOICE_DATA);
  assert.equal(f[2] | (f[3] << 8), 3, '길이는 16 비트 리틀엔디안');
  assert.deepEqual([...f.subarray(4, 7)], [1, 2, 3]);
  // 체크섬은 CMD 와 길이와 몸통 전부의 XOR 다.
  assert.equal(f[7], VOICE_DATA ^ 3 ^ 0 ^ 1 ^ 2 ^ 3);
});

test('빈 프레임도 모양이 맞는다', () => {
  const f = frame(VOICE_CTRL, []);
  assert.equal(f.length, 5);
});

// --- 넘치지 않는다 -----------------------------------------------------------

test('자리를 듣기 전에는 링을 꽉 채우지 않는다', () => {
  // **꽉 채우면 상태가 오는 동안 MSX 가 먹은 만큼을 넣을 자리가 없다.**
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  assert.equal(bytesSent(out), LEAD, `${bytesSent(out)} 보냈다`);
  assert.ok(LEAD < RING, '링보다 적어야 한다');
});

test('더 눌러도 자리를 듣기 전에는 안 나간다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  const was = bytesSent(out);
  for (let i = 0; i < 10; i++) v.pump(send);
  assert.equal(bytesSent(out), was, '자리를 모르는데 더 보내면 넘친다');
});

test('자리를 들으면 그만큼만 더 보낸다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  const first = bytesSent(out);
  // MSX 가 1000 바이트를 먹었다고 카트리지가 말한다.
  v.onStatus(1000, 1000, ST_ARMED);
  v.pump(send);
  assert.equal(bytesSent(out), first + 1000, bytesSent(out));
});

test('자리가 없다고 하면 한 바이트도 안 보낸다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  const was = bytesSent(out);
  v.onStatus(0, 0, ST_ARMED);
  v.pump(send);
  assert.equal(bytesSent(out), was);
});

test('말도 안 되는 자리는 화면에도 그대로 나가지 않는다', () => {
  // `byRing` 이 이미 넘치는 것을 막으므로 자르는 것은 여분이다 - 그런데
  // 이 값은 화면에도 나간다. 자르지 않으면 "room 999999" 가 뜨고, 그것을
  // 본 사람은 링이 4KB 라는 것을 의심하게 된다.
  const { v, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  v.onStatus(999999, 0, ST_ARMED);
  assert.ok(v.status().room <= RING, `화면에 ${v.status().room} 이 나간다`);
  v.onStatus(-5, 0, ST_ARMED);
  assert.ok(v.status().room >= 0, `화면에 ${v.status().room} 이 나간다`);
});

test('카트리지가 말도 안 되는 자리를 말해도 링을 넘지 않는다', () => {
  // 프레임이 깨졌거나 펌웨어가 바뀌었을 때. 믿고 밀면 말이 잘린다.
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  v.onStatus(999999, 0, ST_ARMED);
  v.pump(send);
  assert.ok(bytesSent(out) <= RING, `${bytesSent(out)} 보냈다 - 링은 ${RING}`);
});

// --- 한 덩어리의 크기 --------------------------------------------------------

test('한 프레임에 512 바이트까지만 - 디스크와 파이프를 나눠 쓴다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  for (const f of datas(out))
    assert.ok(f.payload.length <= FRAME, `${f.payload.length} 바이트짜리 프레임`);
  assert.ok(datas(out).length > 1, '한 번에 다 밀면 섹터 읽기가 멈춘다');
});

// --- 처음과 끝 ---------------------------------------------------------------

test('새 마디는 카트리지의 링부터 비운다', () => {
  // 앞 마디가 남아 있으면 두 마디가 섞여 둘 다 못 알아듣는다.
  const { v, out, send } = rig();
  v.say(Buffer.alloc(100), send);
  assert.equal(ctrls(out)[0], CTRL_RESET, '첫 명령이 reset 이어야 한다');
});

test('다 보내면 닫는다 - 그러나 끝난 것은 아니다', () => {
  const { v, out, send, seen } = rig();
  v.say(Buffer.alloc(100), send);
  assert.ok(ctrls(out).includes(CTRL_CLOSE), '더 올 것이 없다고 말해야 한다');
  assert.equal(evs(seen, 'voice_done').length, 0,
               '링에 남은 것이 아직 나가는 중이다');
  assert.equal(v.busy, true);
});

test('끝은 카트리지가 말해 준다', () => {
  const { v, send, seen } = rig();
  v.say(Buffer.alloc(100), send);
  v.onStatus(RING, 100, ST_ENDED);
  v.pump(send);
  assert.equal(evs(seen, 'voice_done').length, 1);
  assert.equal(v.busy, false, '끝났으면 다음 마디를 받을 수 있어야 한다');
});

test('끝나고 나면 새 마디가 처음부터 간다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.from([1, 2, 3]), send);
  v.onStatus(RING, 3, ST_ENDED);
  v.pump(send);
  out.length = 0;
  v.say(Buffer.from([9, 8]), send);
  assert.deepEqual([...datas(out)[0].payload], [9, 8]);
  assert.equal(ctrls(out)[0], CTRL_RESET);
});

test('중간에 새 마디가 오면 앞의 것을 버린다', () => {
  const { v, out, send } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  out.length = 0;
  v.say(Buffer.from([7]), send);
  assert.equal(ctrls(out)[0], CTRL_RESET);
  assert.deepEqual([...datas(out)[0].payload], [7]);
  assert.equal(v.status().bytes, 1, '앞 마디의 길이가 남아 있으면 안 된다');
});

test('멈추면 링도 비운다', () => {
  const { v, out, send, seen } = rig();
  v.say(Buffer.alloc(RING * 3), send);
  out.length = 0;
  v.stop(send);
  assert.equal(ctrls(out)[0], CTRL_RESET, '멈췄는데 남은 것이 나오면 멈춘 것이 아니다');
  assert.equal(v.busy, false);
  assert.equal(evs(seen, 'voice_stop').length, 1);
});

test('아무것도 안 하고 있을 때 멈추는 것은 무동작', () => {
  const { v, out, send, seen } = rig();
  v.stop(send);
  assert.equal(out.length, 0);
  assert.equal(evs(seen, 'voice_stop').length, 0);
  assert.equal(v.pump(send), 0, '보낼 것이 없으면 아무 일도 안 한다');
});

// --- 굶었을 때 ---------------------------------------------------------------

test('굶으면 말한다', () => {
  // 소리에 구멍이 난 것이고, 화면에 안 보이면 "왜 뚝뚝 끊기지" 가 된다.
  const { v, send, seen } = rig();
  v.say(Buffer.alloc(200), send);
  v.onStatus(RING, 50, ST_ARMED | ST_STARVED);
  assert.equal(evs(seen, 'voice_starved').length, 1);
  assert.equal(v.status().starved, true);
});

test('굶은 채로 끝나면 끝났다는 말에 그것이 실린다', () => {
  const { v, send, seen } = rig();
  v.say(Buffer.alloc(10), send);
  v.onStatus(RING, 10, ST_ENDED | ST_STARVED);
  v.pump(send);
  assert.equal(evs(seen, 'voice_done')[0].starved, true);
});

// --- 상태 프레임 뜯기 --------------------------------------------------------

test('상태 프레임을 뜯는다', () => {
  const p = Buffer.from([0x00, 0x10, 0x34, 0x12, 0x00, 0x00, ST_ARMED]);
  const st = VoiceStream.parseStatus(p);
  assert.equal(st.room, 0x1000);
  assert.equal(st.played, 0x1234, '리틀엔디안 32 비트');
  assert.equal(st.flags, ST_ARMED);
});

test('짧거나 없는 상태 프레임은 조용히 버린다', () => {
  // 어긋난 스트림에서 반쯤 온 프레임. 믿고 쓰면 자리를 잘못 알고 넘친다.
  assert.equal(VoiceStream.parseStatus(Buffer.from([1, 2, 3])), null);
  assert.equal(VoiceStream.parseStatus(null), null);
  assert.equal(VoiceStream.parseStatus(Buffer.alloc(0)), null);
});

// --- 링 크기가 펌웨어와 같아야 한다 ------------------------------------------

test('링 크기가 펌웨어의 값과 같다', () => {
  // **여기가 크면 넘치고 작으면 굶는다.** 펌웨어의 PD_VOICE_RING 을 고치면서
  // 이쪽을 잊는 것이 이 두 숫자가 갈라지는 유일한 길이라, 값을 글자 그대로
  // 적어 둔다.
  assert.equal(RING, 4096);
  assert.equal(FRAME, 512);
  assert.equal(LEAD, RING - FRAME);
});

// --- 전체를 한 번 흘려보낸다 --------------------------------------------------

test('한 마디가 한 바이트도 안 잃고 순서대로 나간다', () => {
  const { v, out, send } = rig();
  const word = Buffer.alloc(10_000);
  for (let i = 0; i < word.length; i++) word[i] = i & 0xFF;
  v.say(word, send);
  // MSX 가 512 씩 먹어 가며 상태를 돌려준다.
  let played = 0;
  for (let i = 0; i < 100 && v.busy; i++) {
    played = Math.min(word.length, played + 512);
    v.onStatus(RING - (v.at - played), played,
               ST_ARMED | (played >= word.length ? ST_ENDED : 0));
    v.pump(send);
  }
  const got = Buffer.concat(datas(out).map((f) => f.payload));
  assert.equal(got.length, word.length, `${got.length} / ${word.length}`);
  assert.ok(got.equals(word), '바이트가 하나라도 어긋나면 말이 깨진다');
  assert.equal(v.busy, false);
});
