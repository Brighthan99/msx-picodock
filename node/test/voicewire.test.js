// PDVOICE 가 보낸 문장이 정말 카트리지까지 가는가 — serve() 를 통째로 태운다.
//
// 조각마다 시험은 따로 있다. 여기서 보는 것은 **이음매**다: 메일박스로 들어온
// 0x04 가 합성으로 가고, 나온 바이트가 0x70 프레임이 되어 선에 오르고,
// 카트리지가 0x72 로 자리를 말하면 나머지가 이어 나가는가.
//
// 이음매는 조각보다 자주 틀린다. 조각은 자기 시험이 지키지만 이음매는 아무도
// 안 보고 있어서, 배선 하나가 빠져도 모든 시험이 통과한다.

import { test, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { serve } from '../src/server.js';
import { AskService } from '../src/ask.js';
import { VoiceSession } from '../src/voicesession.js';
import { buildFrame, FrameParser } from '../src/frame.js';
import { MB_TO_HOST, MB_TO_MSX, VOICE_DATA, VOICE_CTRL, VOICE_STAT } from '../src/protocol.js';
import { CTRL_RESET, CTRL_CLOSE, ST_ARMED } from '../src/voicestream.js';

const OP_SPEAK = 0x04;
const OP_ERR = 0x8F;

/**
 * 한 방향씩 갈라 놓은 가짜 선.
 *
 * **PassThrough 를 쓰면 안 된다.** serve() 는 link 에 쓰고 link 에서 읽으므로,
 * 같은 스트림을 주면 자기가 내보낸 프레임을 들어온 프레임으로 다시 읽는다.
 * 그래서 나가는 쪽은 write 로 받아 모으고, 들어오는 쪽만 'data' 로 흘린다.
 */
// serve() 는 100 ms 티커를 걸고 'close' 에서만 푼다. 안 풀면 시험이 다 끝나도
// 프로세스가 안 죽는다 - 한 번 그렇게 되어 시험이 통째로 멈췄다.
const open = [];
after(() => { for (const l of open) l.emit('close'); });

function wire() {
  const link = new EventEmitter();
  open.push(link);
  const out = [];
  const parser = new FrameParser();
  link.write = (buf) => { for (const f of parser.feed(buf)) out.push(f); return true; };
  //: MSX -> 호스트. serve() 가 듣는 쪽.
  link.fromMsx = (buf) => link.emit('data', buf);
  //: 티커를 멈춘다. 안 하면 시험이 끝나도 프로세스가 안 죽는다.
  link.close = () => link.emit('close');
  return { link, out };
}

function rig(opts = {}) {
  const hub = new EventEmitter();
  const seen = [];
  hub.on('ask', (ev, d) => seen.push({ ev, ...d }));

  const said = [];
  const say = {
    busy: false, lastError: null,
    say(text, o) {
      said.push({ text, o });
      if (opts.fail) return Promise.reject(new Error(opts.fail));
      return Promise.resolve(Buffer.alloc(opts.bytes ?? 1200, 0x80));
    },
  };
  const voice = new VoiceSession(hub, { say, enabled: opts.enabled ?? true });
  const ask = new AskService(hub, {});
  const { link, out } = wire();
  // 디스크는 이 시험과 무관하다. 멈춰 있는 것으로 두어, 음성이 디스크의
  // 상태와 상관없이 도는지도 같이 확인한다.
  const disk = { blocks: 0, paused: true, readonly: true };
  serve(link, disk, hub, { ask, voice });
  return { link, out, ask, voice, said, seen, hub };
}

/** MSX -> 호스트: 소리내어 말해라. */
function speakReq(text) {
  const body = Buffer.from(text, 'latin1');
  return buildFrame(MB_TO_HOST,
    Buffer.concat([Buffer.from([OP_SPEAK, body.length & 0xFF, body.length >> 8]), body]));
}

function statFrame(room, played, flags) {
  const b = Buffer.alloc(7);
  b.writeUInt16LE(room, 0);
  b.writeUInt32LE(played, 2);
  b[6] = flags;
  return buildFrame(VOICE_STAT, b);
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('0x04 가 합성으로 가고 0x70 이 되어 나간다', async () => {
  const r = rig({ bytes: 1200 });
  r.link.fromMsx(speakReq('hello'));
  await settle();

  assert.equal(r.said.length, 1, '합성기를 안 불렀다');
  assert.equal(r.said[0].text, 'hello');

  const data = r.out.filter((f) => f.cmd === VOICE_DATA);
  assert.ok(data.length >= 1, '음성 프레임이 안 나갔다');
  const total = data.reduce((n, f) => n + f.payload.length, 0);
  assert.equal(total, 1200, `${total} 바이트만 나갔다`);
});

test('시작 전에 링을 씻는다', async () => {
  const r = rig();
  r.link.fromMsx(speakReq('hello'));
  await settle();
  const ctrl = r.out.filter((f) => f.cmd === VOICE_CTRL);
  // **RESET 이 먼저다.** 앞 문장의 꼬리가 링에 남아 있으면 새 문장의 앞에
  // 붙어서 나가고, 둘 다 못 알아듣게 된다.
  assert.equal(ctrl[0].payload[0], CTRL_RESET, '씻지 않고 부었다');
  const first = r.out.findIndex((f) => f.cmd === VOICE_CTRL);
  const firstData = r.out.findIndex((f) => f.cmd === VOICE_DATA);
  assert.ok(first < firstData, 'RESET 이 데이터보다 뒤에 갔다');
});

test('다 보내고 나면 닫는다', async () => {
  const r = rig({ bytes: 1200 });
  r.link.fromMsx(speakReq('hello'));
  await settle();
  const ctrl = r.out.filter((f) => f.cmd === VOICE_CTRL);
  // 닫는 것은 "더 올 것이 없다" 는 말이고, 이것이 없으면 카트리지는 링이
  // 빈 것을 굶은 것으로 보고 MSX 는 영영 끝을 못 본다.
  assert.ok(ctrl.some((f) => f.payload[0] === CTRL_CLOSE), '닫지 않았다');
});

test('자리가 없으면 멈췄다가, 들으면 이어 보낸다', async () => {
  // 링보다 긴 말. 한 번에 다 못 보내고, 카트리지가 자리를 말해야 나머지가 간다.
  const r = rig({ bytes: 12000 });
  r.link.fromMsx(speakReq('a long sentence'));
  await settle();

  const sentFirst = r.out.filter((f) => f.cmd === VOICE_DATA)
                         .reduce((n, f) => n + f.payload.length, 0);
  assert.ok(sentFirst > 0 && sentFirst < 12000,
            `한 번에 ${sentFirst} 를 보냈다 - 링은 4096 인데`);

  r.link.fromMsx(statFrame(4096, 4096, ST_ARMED));   // 다 먹었다
  await settle();
  const sentAfter = r.out.filter((f) => f.cmd === VOICE_DATA)
                         .reduce((n, f) => n + f.payload.length, 0);
  assert.ok(sentAfter > sentFirst, '자리가 났는데 아무것도 안 보냈다');
});

test('디스크가 멈춰 있어도 자리 소식은 처리한다', async () => {
  // **이것이 이 파일에서 가장 조용한 실패다.** disk.paused 분기가 위에
  // 있으면 상태 프레임이 거기서 걸리고, 말은 링 하나만큼만 나가다 멈춘다.
  // 디스크는 이 시험 내내 paused 다.
  const r = rig({ bytes: 12000 });
  r.link.fromMsx(speakReq('a long sentence'));
  await settle();
  const before = r.out.filter((f) => f.cmd === VOICE_DATA).length;
  r.link.fromMsx(statFrame(4096, 4096, ST_ARMED));
  await settle();
  assert.ok(r.out.filter((f) => f.cmd === VOICE_DATA).length > before,
            '멈춘 디스크가 음성까지 막았다');
});

test('속도 재기가 선을 타고 이어진다', async () => {
  // **얼마로 재는지는 여기서 못 본다** - 진짜 시계로 도는 시험이라 20 ms 안에
  // 두 프레임이 들어가고, 그것은 말이 안 되는 속도다. 정확한 수는
  // voicesession.test.js 가 가짜 시계로 본다. 여기서 볼 것은 상태 프레임이
  // serve() 를 지나 세션까지 닿느냐 하나다.
  const r = rig({ bytes: 40000 });
  r.link.fromMsx(speakReq('a very long one'));
  await settle();
  r.link.fromMsx(statFrame(4096, 1000, ST_ARMED));
  await settle();
  assert.deepEqual(r.voice.stream.status().played, 1000,
                   '상태 프레임이 세션까지 안 갔다');
  r.link.fromMsx(statFrame(4096, 1000 + 99999, ST_ARMED));
  await settle();
  assert.equal(r.voice.measured, null, '20 ms 에 10 만 개를 믿었다');
});

test('질문은 여전히 질문이다', async () => {
  const r = rig();
  const body = Buffer.from('what is 2+2', 'latin1');
  r.link.fromMsx(buildFrame(MB_TO_HOST,
    Buffer.concat([Buffer.from([0x01, body.length, 0]), body])));
  await settle();
  // 0x01 이 음성으로 새면 화면에 답이 안 뜨고 스피커에서 소리가 난다.
  assert.equal(r.said.length, 0, '질문을 소리내어 읽었다');
  assert.equal(r.ask.question, 'what is 2+2');
});

test('합성이 실패하면 MSX 에게 말해 준다', async () => {
  const r = rig({ fail: 'espeak-ng is not installed' });
  r.link.fromMsx(speakReq('hello'));
  await settle();
  r.ask.pump((p) => r.link.write(buildFrame(MB_TO_MSX, p)));
  await settle();

  const back = r.out.filter((f) => f.cmd === MB_TO_MSX);
  assert.ok(back.some((f) => f.payload[0] === OP_ERR),
            'MSX 는 오지 않을 소리를 기다리게 된다');
  assert.ok(r.seen.some((e) => e.ev === 'speak_failed'
                            && /espeak-ng/.test(e.why || '')),
            '왜 실패했는지 어디에도 안 남았다');
});

test('꺼져 있으면 거절이 가고 프레임은 안 나간다', async () => {
  const r = rig({ enabled: false });
  r.link.fromMsx(speakReq('hello'));
  await settle();
  r.ask.pump((p) => r.link.write(buildFrame(MB_TO_MSX, p)));
  await settle();
  assert.equal(r.out.filter((f) => f.cmd === VOICE_DATA).length, 0);
  assert.ok(r.out.filter((f) => f.cmd === MB_TO_MSX)
                 .some((f) => f.payload[0] === OP_ERR));
});

test('음성을 안 걸어 두면 ask 가 대신 거절한다', async () => {
  // --voice off 가 아니라 아예 세션이 없는 서버. 잠자코 있으면 MSX 는 2 초를
  // 멈춰 있다가 포기하고, 왜 아무 말도 안 났는지 아무 데도 안 남는다.
  const hub = new EventEmitter();
  const ask = new AskService(hub, {});
  const { link, out } = wire();
  serve(link, { blocks: 0, paused: true }, hub, { ask });
  link.fromMsx(speakReq('hello'));
  await settle();
  ask.pump((p) => link.write(buildFrame(MB_TO_MSX, p)));
  await settle();
  assert.ok(out.filter((f) => f.cmd === MB_TO_MSX)
               .some((f) => f.payload[0] === OP_ERR));
});

// --- 답을 소리로 ------------------------------------------------------------
// PDASK 가 물으면 답이 글자로 간다. 그 답을 소리로도(또는 소리로만) 보내는
// 것이 원래 요청이었다. 이음매가 또 하나 늘었으니 이음매를 본다.

function askReq(text) {
  const body = Buffer.from(text, 'latin1');
  return buildFrame(MB_TO_HOST,
    Buffer.concat([Buffer.from([0x01, body.length & 0xFF, body.length >> 8]), body]));
}

function askRig(opts = {}) {
  const hub = new EventEmitter();
  const seen = [];
  hub.on('ask', (ev, d) => seen.push({ ev, ...d }));
  const said = [];
  const say = {
    busy: false, lastError: null,
    say(text) { said.push(text); return Promise.resolve(Buffer.alloc(600, 0x80)); },
  };
  const voice = new VoiceSession(hub, { say });
  const ask = new AskService(hub, {
    answerer: async () => opts.answer ?? 'forty two',
    reply: opts.reply, ...(opts.mode ? { mode: opts.mode } : {}),
  });
  const { link, out } = wire();
  serve(link, { blocks: 0, paused: true }, hub, { ask, voice });
  return { link, out, ask, voice, said, seen };
}

/**
 * MSX 가 하는 일을 대신한다: 나오는 대로 받고, 청크마다 ACK 를 돌려준다.
 *
 * **ACK 를 안 보내면 글자 한 청크에서 멈춘다.** 그러면 그 뒤에 오는 것이
 * 영영 안 나가는데, 시험에서는 "안 보냈다" 로 보인다 - 실은 못 보낸 것이다.
 */
const drain = async (r) => {
  await settle();
  for (let i = 0; i < 40; i++) {
    r.ask.pump((p) => r.link.write(buildFrame(MB_TO_MSX, p)));
    r.link.fromMsx(buildFrame(MB_TO_HOST, Buffer.from([0x06])));   // OP_ACK
  }
  await settle();
};

test('기본은 글자만 — 소리는 안 난다', async () => {
  const r = askRig();
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  assert.equal(r.said.length, 0, '기본인데 말했다');
  assert.ok(r.out.some((f) => f.cmd === MB_TO_MSX), '글자가 안 갔다');
});

test('voice 면 소리로 가고, 대화는 끝난다', async () => {
  const r = askRig({ reply: 'voice' });
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  assert.deepEqual(r.said, ['forty two']);
  // **빈 답이라도 보내야 한다.** 아무것도 안 보내면 MSX 는 답을 기다린 채로
  // 남고 다음 질문을 못 한다.
  const back = r.out.filter((f) => f.cmd === MB_TO_MSX);
  assert.ok(back.length >= 1, 'MSX 가 답을 영영 기다린다');
  assert.equal(r.ask.state, 'idle', '대화가 안 끝났다');
  // 글자 청크는 없어야 한다 - voice 인데 글자까지 가면 both 다.
  assert.equal(back.some((f) => f.payload[0] === 0x81), false, '글자도 보냈다');
});

test('both 면 둘 다 간다', async () => {
  const r = askRig({ reply: 'both' });
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  assert.deepEqual(r.said, ['forty two']);
  assert.ok(r.out.filter((f) => f.cmd === MB_TO_MSX)
             .some((f) => f.payload[0] === 0x81), '글자가 안 갔다');
});

test('합성이 실패해도 글자는 간다', async () => {
  // 소리가 안 나는 것보다 답을 못 받는 것이 크다.
  const hub = new EventEmitter();
  const seen = [];
  hub.on('ask', (ev, d) => seen.push({ ev, ...d }));
  const say = { busy: false, lastError: null,
                say: () => Promise.reject(new Error('no engine here')) };
  const voice = new VoiceSession(hub, { say });
  const ask = new AskService(hub, { answerer: async () => 'forty two', reply: 'both' });
  const { link, out } = wire();
  serve(link, { blocks: 0, paused: true }, hub, { ask, voice });
  link.fromMsx(askReq('what is it'));
  await settle();
  for (let i = 0; i < 40; i++) ask.pump((p) => link.write(buildFrame(MB_TO_MSX, p)));
  await settle();
  assert.ok(out.filter((f) => f.cmd === MB_TO_MSX).some((f) => f.payload[0] === 0x81),
            '합성이 실패했다고 글자까지 막았다');
  assert.ok(seen.some((e) => e.ev === 'say_failed' && /no engine/.test(e.why || '')),
            '왜 소리가 안 났는지 어디에도 안 남았다');
});

test('reply 에 오타를 넣으면 조용히 text 가 되지 않는다', async () => {
  const r = askRig();
  assert.throws(() => r.ask.setVoice({ reply: 'sound' }), /unknown reply mode/);
  assert.equal(r.ask.replyMode, 'text', '거절해 놓고 바꿨다');
});

test('소리가 있으면 0x83 을 먼저 보낸다', async () => {
  // **짐작하지 않게 한다.** MSX 가 링의 READY 만 보고 판단하면, 지난 번에
  // 아무도 안 들은 스트림의 찌꺼기를 제 것으로 알고 튼다 - 실기에서 알아들을
  // 수 없는 소리가 1 초 나고 끝났다. 링에 든 것은 그것이 누구 것인지 말해
  // 주지 않는다.
  for (const mode of ['voice', 'both']) {
    const r = askRig({ reply: mode });
    r.link.fromMsx(askReq('what is it'));
    await drain(r);
    const ops = r.out.filter((f) => f.cmd === MB_TO_MSX).map((f) => f.payload[0]);
    assert.ok(ops.includes(0x83), `${mode}: 0x83 을 안 보냈다`);
    // END 보다 먼저여야 한다. END 를 본 MSX 는 그 자리에서 읽기를 끝낸다.
    assert.ok(ops.indexOf(0x83) < ops.indexOf(0x82), `${mode}: 0x83 이 END 뒤에 갔다`);
  }
});

test('글자만일 때는 0x83 이 없다', async () => {
  const r = askRig();
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  const ops = r.out.filter((f) => f.cmd === MB_TO_MSX).map((f) => f.payload[0]);
  assert.equal(ops.includes(0x83), false, '소리도 안 보내면서 틀라고 했다');
});

test('voice 일 때도 END 는 간다', async () => {
  const r = askRig({ reply: 'voice' });
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  const ops = r.out.filter((f) => f.cmd === MB_TO_MSX).map((f) => f.payload[0]);
  assert.ok(ops.includes(0x82), 'MSX 가 오지 않을 답을 기다린다');
  assert.equal(ops.includes(0x81), false, 'voice 인데 글자도 보냈다');
});

test('굶었다는 말은 한 마디에 한 번만', async () => {
  // 카트리지의 표시는 다음 시작까지 남아 있다. 들을 때마다 말하면 10 ms 마다
  // 한 줄씩 쌓이고, 실기에서 238 줄이 쌓여 정작 봐야 할 줄을 덮었다.
  const r = askRig({ reply: 'voice' });
  r.link.fromMsx(askReq('what is it'));
  await drain(r);
  for (let i = 0; i < 30; i++) {
    r.link.fromMsx(statFrame(4096, 4096, ST_ARMED | 0x02 | 0x04));
    await settle();
  }
  const n = r.seen.filter((e) => e.ev === 'voice_starved').length;
  assert.ok(n <= 1, `굶었다고 ${n} 번 말했다`);
});

// --- 전달 경로 --------------------------------------------------------------
// 셋은 같은 바이트를 다르게 건넨다. stream 은 재생 중에 흘려보내므로 MSX 가
// 샘플마다 버스를 읽고, 나머지 둘은 통째로 건넨 뒤 RAM 에서 튼다 - 재생 중에
// 버스를 안 읽는다. 그 차이가 셋을 둔 이유다.

test('echo 는 보낸 것을 그대로 답으로 돌려준다', async () => {
  // **echo 는 답하는 쪽의 하나다.** 검색 대신, MSX 가 보낸 문장을 그대로 답으로
  // 돌려준다. 처음에는 "답 앞에 질문을 한 번 읽어 주기" 로 잘못 만들었다.
  const r = askRig({ mode: 'echo', answer: 'this must not be used' });
  r.link.fromMsx(askReq('hello from the msx'));
  await drain(r);
  const text = r.out.filter((f) => f.cmd === MB_TO_MSX && f.payload[0] === 0x81)
                    .map((f) => f.payload.subarray(2).toString('latin1')).join('');
  assert.equal(text, 'hello from the msx', '보낸 것이 그대로 안 돌아왔다');
});

test('echo 에 소리를 붙이면 MSX 가 친 것을 MSX 가 말한다', async () => {
  const r = askRig({ mode: 'echo', reply: 'voice' });
  r.link.fromMsx(askReq('say this back'));
  await drain(r);
  assert.deepEqual(r.said, ['say this back'], '합성기에 간 것이 보낸 문장이 아니다');
});

test('echo 는 기본이 아니다', () => {
  const r = askRig();
  assert.equal(r.ask.mode, 'google');
});

test('모드는 화면에서 echo 로 바꿀 수 있고 기다리던 질문에도 답한다', async () => {
  // 수동으로 두고 질문을 받은 뒤 echo 로 바꾸면, 기다리던 질문이 곧바로
  // 돌아가야 한다 - google 로 바꿀 때와 같다.
  const r = askRig({ mode: 'manual' });
  r.link.fromMsx(askReq('waiting one'));
  await settle();
  assert.equal(r.ask.state, 'asking');
  assert.equal(r.ask.setMode('echo'), 'echo');
  await drain(r);
  const text = r.out.filter((f) => f.cmd === MB_TO_MSX && f.payload[0] === 0x81)
                    .map((f) => f.payload.subarray(2).toString('latin1')).join('');
  assert.equal(text, 'waiting one');
});
