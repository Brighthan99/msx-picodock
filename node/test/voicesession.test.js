// 말 한 마디의 처음부터 끝까지, 그리고 **속도 재기**.
//
// 속도가 이 파일의 중심이다. MSX 가 몇 Hz 로 재생하는지는 Z80 의 루프 길이가
// 아니라 VDP 가 버스를 얼마나 가져가느냐로 정해지고, 그 비율은 기계마다
// 다르다. 그래서 호스트가 재야 하고, 잘못 재면 다음 문장이 엉뚱한 속도로
// 합성되어 목소리가 높거나 낮아진다.

import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  VoiceSession, ASSUMED_RATE, MIN_SPAN_MS, MIN_SPAN_SAMPLES, RATE_MAX, STALL_MS,
} from '../src/voicesession.js';
import { VoiceStream, ST_ARMED, ST_ENDED } from '../src/voicestream.js';

/** 합성기 대신. **계산하지 않고 무엇을 부탁받았는지 적는다.** */
function fakeSay(bytes = 4096) {
  const calls = [];
  return {
    calls,
    busy: false,
    lastError: null,
    say(text, opts) { calls.push({ text, opts }); return Promise.resolve(Buffer.alloc(bytes, 0x80)); },
  };
}

/** 카트리지가 보내는 상태 프레임의 payload 일곱 바이트. */
function stat(room, played, flags) {
  const b = Buffer.alloc(7);
  b.writeUInt16LE(room, 0);
  b.writeUInt32LE(played, 2);
  b[6] = flags;
  return b;
}

function session(opts = {}) {
  const hub = new EventEmitter();
  const seen = [];
  hub.on('ask', (ev, d) => seen.push({ ev, ...d }));
  const say = opts.say || fakeSay(opts.bytes);
  let t = 1000;
  const clock = { at: () => t, to: (ms) => { t = ms; } };
  const v = new VoiceSession(hub, { say, now: clock.at, ...opts });
  const sent = [];
  const send = (buf) => sent.push(buf);
  return { v, say, sent, send, seen, clock };
}

test('말하면 합성하고 흘려보낸다', async () => {
  const { v, say, sent } = session();
  const n = await v.speak('hello', (b) => sent.push(b));
  assert.equal(n, 4096);
  assert.equal(say.calls.length, 1);
  assert.equal(say.calls[0].text, 'hello');
  assert.ok(sent.length > 0, '아무것도 안 나갔다');
});

test('첫 문장은 11025 Hz 로 어림잡는다', async () => {
  const { v, say, sent } = session();
  await v.speak('hello', (b) => sent.push(b));
  assert.equal(say.calls[0].opts.rate, ASSUMED_RATE);
});

test('꺼져 있으면 거절한다', async () => {
  const { v, send } = session({ enabled: false });
  await assert.rejects(() => v.speak('hello', send), /switched off/);
});

test('말하는 중에 또 시키면 거절한다', async () => {
  const { v, send } = session();
  await v.speak('one', send);
  // 두 마디가 같은 링에 섞이면 둘 다 못 알아듣는다.
  await assert.rejects(() => v.speak('two', send), /last one/);
});

test('그만하면 다시 말할 수 있다', async () => {
  const { v, send } = session();
  await v.speak('one', send);
  v.stop(send);
  await v.speak('two', send);   // 던지지 않으면 통과
});

// --- 속도 재기 -------------------------------------------------------------

test('충분히 길게 보고 나서야 속도를 믿는다', async () => {
  const { v, send, clock } = session({ bytes: 60000 });
  await v.speak('a long one', send);

  clock.to(2000);
  v.onStatus(stat(4096, 1000, ST_ARMED), send);      // 소리가 나기 시작했다
  clock.to(2000 + MIN_SPAN_MS - 50);                 // 아직 짧다
  v.onStatus(stat(4096, 1000 + MIN_SPAN_SAMPLES + 500, ST_ARMED), send);
  assert.equal(v.measured, null, '너무 일찍 믿었다');
  assert.equal(v.rate, ASSUMED_RATE);
});

test('오래 보면 잰다', async () => {
  const { v, send, clock, seen } = session({ bytes: 60000 });
  await v.speak('a long one', send);

  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  clock.to(3000);                                    // 1 초 뒤
  v.onStatus(stat(4096, 100 + 9900, ST_ARMED), send); // 9900 개 나갔다
  assert.equal(v.measured, 9900);
  assert.equal(v.rate, 9900);
  assert.ok(seen.some((e) => e.ev === 'voice_rate' && e.hz === 9900), '말 안 했다');
});

test('잰 속도로 다음 문장을 합성한다', async () => {
  const { v, say, send, clock } = session({ bytes: 60000 });
  await v.speak('first', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  clock.to(3000);
  v.onStatus(stat(4096, 10000, ST_ARMED), send);

  v.stop(send);
  await v.speak('second', send);
  // **여기가 요점이다.** 이 값이 11025 로 남아 있으면 기계가 아홉 할 속도로
  // 도는 만큼 목소리가 낮아지고, 아무도 왜인지 모른다.
  assert.equal(say.calls[1].opts.rate, 9900);
  assert.notEqual(say.calls[1].opts.rate, ASSUMED_RATE);
});

test('기다리는 동안은 세지 않는다', async () => {
  // MSX 가 아직 CTRL=1 을 안 썼으면 played 는 0 에 머문다. 그 시간을 재기에
  // 넣으면, 사람이 화면을 5 초 보다가 시작한 것이 "아주 느린 재생" 이 된다.
  const { v, send, clock } = session({ bytes: 60000 });
  await v.speak('hello', send);

  clock.to(2000);
  v.onStatus(stat(4096, 0, 0), send);
  clock.to(7000);                                    // 5 초 동안 가만히
  v.onStatus(stat(4096, 0, 0), send);
  clock.to(7000);
  v.onStatus(stat(4096, 1, ST_ARMED), send);         // 이제 시작
  clock.to(8000);
  v.onStatus(stat(4096, 11026, ST_ARMED), send);
  assert.equal(v.measured, 11025, '기다린 시간이 속도에 섞였다');
});

test('말이 안 되는 속도는 버린다', async () => {
  const { v, send, clock } = session({ bytes: 200000 });
  await v.speak('hello', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  clock.to(3000);
  // 1 초에 10 만 개는 Z80 이 낼 수 있는 속도가 아니다. 그런 수가 나왔으면
  // 기계가 그런 것이 아니라 잰 것이 틀린 것이다.
  v.onStatus(stat(4096, 100100, ST_ARMED), send);
  assert.equal(v.measured, null, `${RATE_MAX} 보다 빠른 값을 믿었다`);
  assert.equal(v.rate, ASSUMED_RATE);
});

test('새 문장마다 다시 잰다', async () => {
  const { v, send, clock } = session({ bytes: 60000 });
  await v.speak('first', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  v.stop(send);
  await v.speak('second', send);
  // 앞 문장의 played 를 기준으로 삼으면, 두 문장 사이의 침묵이 재기에 들어간다.
  clock.to(3000);
  v.onStatus(stat(4096, 50, ST_ARMED), send);
  clock.to(4000);
  v.onStatus(stat(4096, 10050, ST_ARMED), send);
  assert.equal(v.measured, 10000);
});

test('그만두지 않고 끝난 뒤 다시 말해도 다시 잰다', async () => {
  // 앞의 시험은 stop() 과 speak() 가 **둘 다** 자국을 지우므로 한쪽만 망가져도
  // 통과한다. 여기서는 stop 을 부르지 않는다: 말이 끝나면 스트림이 스스로
  // 비고, 그 뒤의 speak 만이 자국을 지울 수 있다.
  const { v, send, clock } = session({ bytes: 512 });
  await v.speak('first', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  v.onStatus(stat(4096, 512, ST_ARMED | ST_ENDED), send);   // 끝났다
  assert.equal(v.speaking, false);

  await v.speak('second', send);                            // stop 없이
  clock.to(3000);
  v.onStatus(stat(4096, 50, ST_ARMED), send);
  clock.to(4000);
  v.onStatus(stat(4096, 10050, ST_ARMED), send);
  assert.equal(v.measured, 10000, '앞 문장의 자국이 남아 속도가 섞였다');
});

test('그만둔 뒤 MSX 가 혼자 다시 틀어도 속도를 망치지 않는다', async () => {
  // stop() 은 호스트 쪽 일이고, MSX 는 그것을 모른 채 PDVOICE 를 다시 돌릴
  // 수 있다. 그러면 played 가 0 부터 다시 오르는데, 앞 문장의 자국이 남아
  // 있으면 "그때부터 지금까지 이만큼" 이 되어 속도가 실제의 몇 분의 일로
  // 잡힌다. 그 값으로 다음 문장을 합성하면 아주 낮은 목소리가 된다.
  const { v, send, clock } = session({ bytes: 60000 });
  await v.speak('first', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  v.stop(send);

  // 18 초 뒤에도 played 는 이어서 오른다 - CTRL=1 은 표시만 지우고 센 것은
  // 그대로 두기 때문이다(pd_voice_win.c). 그래서 묵은 자국은 "18 초에 10 만
  // 개" 가 되어 5555 Hz 라는 그럴듯한 값을 내놓는다. 범위 검사로는 못 거른다.
  clock.to(20000);
  v.onStatus(stat(4096, 100100, ST_ARMED), send);
  clock.to(21000);
  v.onStatus(stat(4096, 111125, ST_ARMED), send);   // 진짜로는 11025 Hz
  assert.equal(v.measured, 11025,
               `묵은 자국으로 ${v.measured} 가 나왔다 - 목소리가 반쯤 낮아진다`);
});

test('말이 끝난 뒤의 시간은 속도에 안 들어간다', async () => {
  // 재생이 끝나도 상태 프레임은 몇 번 더 온다. played 는 멈춰 있고 시계만
  // 가므로, 그것까지 세면 "같은 개수를 더 긴 시간에" 가 되어 속도가 낮게
  // 나온다. 실기에서 10429 가 10045 로 굳었다.
  //
  // 그리고 낮게 재면 다음 문장을 낮은 속도로 합성하고, MSX 는 제 속도로
  // 재생하므로 목소리가 그만큼 높아진다.
  const { v, send, clock } = session({ bytes: 60000 });
  await v.speak('hello', send);
  clock.to(2000);
  v.onStatus(stat(4096, 100, ST_ARMED), send);
  clock.to(3000);
  v.onStatus(stat(4096, 10100, ST_ARMED), send);   // 1 초에 만 개
  assert.equal(v.measured, 10000);

  // 끝났다. 이 뒤로는 played 가 안 오른다.
  clock.to(3500);
  v.onStatus(stat(4096, 10100, ST_ARMED), send);
  clock.to(4000);
  v.onStatus(stat(4096, 10100, ST_ARMED), send);
  assert.equal(v.measured, 10000, `꼬리를 세서 ${v.measured} 가 됐다`);
});

test('망가진 상태 프레임은 조용히 버린다', async () => {
  const { v, send } = session();
  await v.speak('hello', send);
  assert.equal(v.onStatus(Buffer.alloc(3), send), null);
  assert.equal(v.onStatus(null, send), null);
});

test('상태를 들으면 흐름 제어가 움직인다', async () => {
  const { v, send, sent } = session({ bytes: 60000 });
  await v.speak('a long one', send);
  const before = sent.length;
  // 링이 다 비었다고 들으면 더 보낼 수 있어야 한다. 안 움직이면 한 링 분량만
  // 말하고 나머지는 영영 안 나간다.
  v.onStatus(stat(4096, 4096, ST_ARMED), send);
  assert.ok(sent.length > before, '자리가 났는데 아무것도 안 보냈다');
});

test('status() 가 합성과 재생을 둘 다 보여준다', async () => {
  const { v, send } = session();
  const idle = v.status();
  assert.equal(idle.enabled, true);
  assert.equal(idle.speaking, false);
  assert.equal(idle.measured, null);
  await v.speak('hello', send);
  assert.equal(v.status().speaking, true);
  assert.equal(v.status().bytes, 4096);
});

test('합성이 실패하면 던지고, 흘려보내지 않는다', async () => {
  const say = { busy: false, lastError: null, calls: [],
                say: () => Promise.reject(new Error('espeak-ng not here')) };
  const { v, sent, send } = session({ say });
  await assert.rejects(() => v.speak('hello', send), /espeak-ng/);
  assert.equal(sent.length, 0, '실패했는데 뭔가 나갔다');
  assert.equal(v.speaking, false);
});

test('끝났다는 말을 들으면 자리를 비운다', async () => {
  const { v, send, seen } = session({ bytes: 512 });
  await v.speak('short', send);
  v.onStatus(stat(4096, 512, ST_ARMED | ST_ENDED), send);
  assert.equal(v.speaking, false, '끝났는데 아직 말하는 중이다');
  assert.ok(seen.some((e) => e.ev === 'voice_done'));
});

test('parseStatus 는 voicestream 의 것을 그대로 쓴다', () => {
  // 뜯는 코드가 두 벌이면 갈라진다. 같은 함수인지 여기서 건다.
  const got = VoiceStream.parseStatus(stat(1234, 567890, ST_ARMED));
  assert.equal(got.room, 1234);
  assert.equal(got.played, 567890);
  assert.equal(got.flags, ST_ARMED);
});

test('아무도 안 들으면 그만둔다', async () => {
  // 실기에서 이렇게 굳었다: PDASK 에는 재생기가 없는데 답을 소리로 보내라고
  // 했더니, 호스트가 링 하나를 채우고 자리가 나기를 영영 기다렸다.
  // sent 4096 / played 0. 그 뒤 모든 말이 "앞의 말을 하는 중" 으로 거절됐다.
  const { v, send, clock, seen } = session({ bytes: 600000 });
  await v.speak('a very long answer', send);
  assert.equal(v.speaking, true);

  clock.to(1000 + STALL_MS - 1);
  v.pump(send);
  assert.equal(v.speaking, true, '너무 일찍 그만뒀다');

  clock.to(1000 + STALL_MS + 1);
  v.pump(send);
  assert.equal(v.speaking, false, '영영 붙들고 있다');
  assert.ok(seen.some((e) => e.ev === 'voice_abandoned'), '왜 그만뒀는지 안 남았다');

  // 그리고 다시 말할 수 있어야 한다. 그게 이 시험의 요점이다.
  await v.speak('the next one', send);
});

test('듣고 있으면 그만두지 않는다', async () => {
  const { v, send, clock } = session({ bytes: 600000 });
  await v.speak('a very long answer', send);
  // 느리게라도 나가고 있으면 기다린다. 링은 0.37 초어치라 이 정도면 정상이다.
  for (let t = 2000; t < 40000; t += 3000) {
    clock.to(t);
    v.onStatus(stat(4096, t, ST_ARMED), send);
    v.pump(send);
  }
  assert.equal(v.speaking, true, '듣고 있는데 끊었다');
});

// --- 모니터 ----------------------------------------------------------------
// 브라우저가 같은 소리를 듣게 한다. **보내는 때가 요점이다**: MSX 가 첫 샘플을
// 가져간 순간이어야 둘이 맞고, MSX 가 아예 안 틀면 브라우저도 조용해야 한다.
import { toPcm } from '../src/voicesession.js';

function monRig(opts = {}) {
  const r = session({ bytes: opts.bytes ?? 2000 });
  r.say.levels = async () => {
    const lv = new Float32Array(256);
    for (let i = 0; i < 256; i++) lv[i] = i / 127.5 - 1;   // 곧은 사다리
    return lv;
  };
  r.mon = [];
  r.stops = 0;
  r.v.onMonitor = (pcm, rate) => r.mon.push({ pcm, rate });
  r.v.onMonitorStop = () => { r.stops++; };
  return r;
}

test('모니터는 MSX 가 틀기 시작할 때 나간다, 합성이 끝났을 때가 아니라', async () => {
  const { v, send, mon } = monRig();
  await v.speak('hello', send);
  assert.equal(mon.length, 0, 'MSX 보다 먼저 말했다');
  v.onStatus(stat(4096, 0, ST_ARMED), send);
  assert.equal(mon.length, 0, 'played 0 인데 나갔다');
  v.onStatus(stat(4096, 12, ST_ARMED), send);
  assert.equal(mon.length, 1, 'MSX 가 틀기 시작했는데 안 나갔다');
  v.onStatus(stat(4096, 900, ST_ARMED), send);
  assert.equal(mon.length, 1, '한 마디에 두 번 나갔다');
});

test('모니터는 보낸 바이트를 그대로, 합성한 속도로 싣는다', async () => {
  const { v, send, mon } = monRig({ bytes: 1234 });
  await v.speak('hello', send);
  v.onStatus(stat(4096, 1, ST_ARMED), send);
  assert.equal(mon[0].pcm.length, 1234, '길이가 다르다');
  assert.equal(mon[0].rate, ASSUMED_RATE, '합성한 속도가 아니다');
});

test('MSX 가 안 틀면 모니터도 안 나간다', async () => {
  const { v, send, mon } = monRig();
  await v.speak('hello', send);
  v.stop(send);
  v.onStatus(stat(4096, 50, ST_ARMED), send);   // 그만둔 뒤 온 늦은 상태
  assert.equal(mon.length, 0, '아무도 안 들은 말을 화면이 말했다');
});

test('도중에 그치면 화면에도 그치라고 한다', async () => {
  const r = monRig();
  await r.v.speak('hello', r.send);
  r.v.stop(r.send);
  assert.equal(r.stops, 0, '시작도 안 한 모니터를 그치게 했다');
  await r.v.speak('again', r.send);
  r.v.onStatus(stat(4096, 5, ST_ARMED), r.send);
  r.v.stop(r.send);
  assert.equal(r.stops, 1, '그쳤는데 화면은 계속 말한다');
});

test('레벨표를 못 구하면 모니터만 빠지고 말은 한다', async () => {
  const r = monRig();
  r.say.levels = async () => null;
  await r.v.speak('hello', r.send);
  r.v.onStatus(stat(4096, 5, ST_ARMED), r.send);
  assert.equal(r.mon.length, 0);
  assert.equal(r.v.speaking, true, '모니터 때문에 말이 막혔다');
});

test('toPcm: 무음(128)이 0 이 된다', () => {
  // 칩의 사다리는 대칭이 아니라 무음이 조금 비껴 앉는다. 그대로 두면 스피커가
  // 한쪽으로 밀린 채 말하고 앞뒤에서 딸깍 한다.
  const lv = new Float32Array(256).map((_, i) => (i / 255) * 1.6 - 0.9);
  const pcm = toPcm(new Uint8Array([128, 128, 0, 255]), lv);
  assert.equal(pcm[0], 0);
  assert.ok(pcm[2] < 0 && pcm[3] > 0);
  assert.ok(Math.abs(pcm[3]) <= 32767, '넘쳤다');
});
