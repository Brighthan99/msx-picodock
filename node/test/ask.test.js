// ask.test.js — CALL PDASK 의 선 위 절반.
//
// 여기서 보는 것은 상태 기계다. 파서가 파이썬과 **같은 바이트를 같게 읽는가**
// 는 test/ask_crosscheck.py 가 따로 본다 - 그쪽이 "우리 코드가 우리 코드에
// 동의하는가" 를 막는 장치다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AskService, RequestParser, buildChunk, buildEnd, buildError,
  OP_REQ, OP_INFO, OP_CANCEL, OP_ACK, OP_CHUNK, OP_END, OP_ERR,
  ERR_FAILED, CHUNK, MAX_QUERY,
} from '../src/ask.js';
import { Hub, CH_ASK } from '../src/hub.js';

/** MSX 가 보내는 질문 바이트. */
function req(text) {
  const b = Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([OP_REQ, b.length & 0xff, b.length >> 8]), b]);
}

function svc(opts = {}) {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_ASK) seen.push(ev); });
  const sent = [];
  const ask = new AskService(hub, opts);
  return { ask, hub, seen, sent, send: (p) => sent.push(Buffer.from(p)) };
}

// --------------------------------------------------------------- 파서

test('파서: 질문·취소·ACK·정보를 뽑는다', () => {
  const p = new RequestParser();
  const out = p.feed(Buffer.concat([
    req('msx'),
    Buffer.from([OP_CANCEL, OP_ACK, OP_INFO, 2, 0xaa, 0xbb]),
  ]));
  assert.deepEqual(out.map((o) => o.kind), ['ask', 'cancel', 'ack', 'info']);
  assert.equal(out[0].value, 'msx');
  assert.deepEqual([...out[3].value], [0xaa, 0xbb]);
});

test('파서: 쪼개져 들어와도 같다', () => {
  const whole = req('hello world');
  const a = new RequestParser().feed(whole);
  const b = new RequestParser();
  const got = [];
  for (const byte of whole) got.push(...b.feed(Buffer.from([byte])));
  assert.deepEqual(got, a);
  assert.equal(got[0].value, 'hello world');
});

test('파서: 잡음을 지나 다음 요청에서 다시 맞는다', () => {
  const p = new RequestParser();
  // 아는 opcode 가 아닌 바이트는 그 자리에서 버려진다.
  const noise = Buffer.from([0x00, 0x7f, 0xf0, 0x55]);
  const out = p.feed(Buffer.concat([noise, req('after noise')]));
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 'after noise');
});

test('파서: 터무니없이 긴 질문은 질문이 아니라 어긋남이다', () => {
  const p = new RequestParser();
  const n = MAX_QUERY + 1;
  const out = p.feed(Buffer.from([OP_REQ, n & 0xff, n >> 8]));
  assert.deepEqual(out, [{ kind: 'garbled', value: n }]);
  // 그리고 그 뒤 질문은 정상으로 읽혀야 한다 - 버렸으니 몸통을 안 기다린다.
  assert.equal(p.feed(req('ok'))[0].value, 'ok');
});

// --------------------------------------------------------------- 상태 기계

test('답이 청크로 쪼개져 나가고, 하나마다 ACK 를 기다린다', () => {
  const { ask, sent, send } = svc();
  ask.feed(req('q'));
  assert.equal(ask.state, 'asking', 'answerer 가 없으면 사람을 기다린다');

  const text = 'x'.repeat(CHUNK + 30);       // 청크 둘 + END
  ask.reply(text);
  assert.equal(ask.state, 'sending');

  ask.pump(send);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], OP_CHUNK);
  assert.equal(sent[0][1], CHUNK);

  ask.pump(send);
  assert.equal(sent.length, 1, 'ACK 전에는 다음 청크가 나가면 안 된다');

  ask.feed(Buffer.from([OP_ACK]));
  ask.pump(send);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1], 30);

  ask.feed(Buffer.from([OP_ACK]));
  ask.pump(send);
  assert.deepEqual([...sent[2]], [OP_END]);
  ask.pump(send);
  assert.equal(ask.state, 'idle');
  assert.equal(sent.length, 3);
});

test('ACK 가 안 오면 포기한다', async () => {
  // 시한을 0 으로 두면 안 된다. 같은 밀리초 안에서 Date.now() 가 안 움직여
  // `now > deadline` 이 거짓이라, 시간이 흐른 것을 시험하지 못한다.
  const { ask, seen, sent, send } = svc({ ackTimeoutMs: 5 });
  ask.feed(req('q'));
  ask.reply('short');
  ask.pump(send);                            // 청크 하나 나감
  assert.equal(sent.length, 1);

  ask.pump(send);
  assert.equal(ask.state, 'sending', '아직 시한 안이다');

  await new Promise((r) => setTimeout(r, 20));
  ask.pump(send);
  assert.equal(ask.state, 'idle');
  assert.equal(sent.length, 1, '포기했으면 더 보내지 않는다');
  assert.ok(seen.some((e) => e.ev === 'timeout'), '포기했다고 말해야 한다');
});

test('LIMIT 에서 자르고, 잘랐다고 말한다', () => {
  const { ask, seen } = svc({ limit: 10 });
  ask.feed(req('q'));
  ask.reply('0123456789ABCDEF');
  const ev = seen.find((e) => e.ev === 'answer');
  assert.equal(ev.bytes, 10);
  assert.equal(ev.truncated, true);
  assert.equal(ask.answer, '0123456789');
});

test('늦게 돌아온 답은 새 질문에 답하지 못한다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ask, sent, send } = svc({ answerer: async (q) => {
    if (q === 'first') { await gate; return 'LATE'; }
    return 'SECOND';
  } });

  ask.feed(req('first'));
  await Promise.resolve();
  ask.feed(req('second'));                   // 첫 답이 아직 안 왔는데 새 질문
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ask.answer, 'SECOND');

  release();                                 // 이제야 첫 답이 돌아온다
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ask.answer, 'SECOND', '지나간 질문의 답이 덮어쓰면 안 된다');

  ask.pump(send);
  assert.equal(Buffer.from(sent[0].subarray(2)).toString(), 'SECOND');
});

test('줄 끝은 CR LF 로 나간다 - CHPUT 의 LF 는 첫 칸으로 돌아가지 않는다', async () => {
  // 실기에서 걸렸다: LF 만 보냈더니 둘째 줄이 첫 줄이 끝난 칸에서 시작해
  // 계단처럼 밀려 찍혔다. 이미 CR LF 이거나 CR 만인 것은 두 번 바꾸지 않는다.
  const { ask, sent, send } = svc({ answerer: async () => 'one\ntwo\r\nthree\rfour' });
  ask.feed(req('q'));
  await new Promise((r) => setTimeout(r, 10));
  ask.pump(send);
  assert.equal(sent[0].subarray(2).toString('latin1'), 'one\r\ntwo\r\nthree\r\nfour');
});

test('answerer 가 던지면 MSX 에게 오류가 간다', async () => {
  const { ask, sent, send, seen } = svc({ answerer: async () => { throw new Error('nope'); } });
  ask.feed(req('q'));
  await new Promise((r) => setTimeout(r, 10));
  ask.pump(send);
  assert.deepEqual([...sent[0]], [OP_ERR, ERR_FAILED]);
  assert.ok(seen.some((e) => e.ev === 'error' && /nope/.test(e.text)));
  assert.equal(ask.state, 'idle');
});

test('빈 질문은 오류로 끝난다', () => {
  const { ask, sent, send } = svc();
  ask.feed(Buffer.from([OP_REQ, 0, 0]));
  ask.pump(send);
  assert.deepEqual([...sent[0]], [OP_ERR, ERR_FAILED]);
});

test('MSX 가 취소하면 나가던 것을 멈춘다', () => {
  const { ask, seen, sent, send } = svc();
  ask.feed(req('q'));
  ask.reply('x'.repeat(300));
  ask.pump(send);
  assert.equal(sent.length, 1);
  ask.feed(Buffer.from([OP_CANCEL]));
  assert.equal(ask.state, 'idle');
  ask.pump(send);
  assert.equal(sent.length, 1, '취소 뒤에는 더 나가면 안 된다');
  assert.ok(seen.some((e) => e.ev === 'cancelled'));
});

test('링크가 끊기면 반쯤 보낸 답을 버린다', () => {
  const { ask, seen, send } = svc();
  ask.feed(req('q'));
  ask.reply('x'.repeat(300));
  ask.pump(send);
  ask.linkReset();
  assert.equal(ask.state, 'idle');
  assert.ok(seen.some((e) => e.ev === 'note' && /mid-answer/.test(e.text)));
});

test('기본은 검색이 답한다', () => {
  // 수동이 기본이던 때는 MSX 에서 CALL PDASK 를 치면 아무 일도 안 일어난
  // 것처럼 보였다 - 답은 맥 화면에서 누가 타이핑해 주기를 기다리고 있었고,
  // MSX 앞에 앉은 사람은 그것을 알 길이 없었다.
  const a = new AskService({ emit() {} });
  assert.equal(a.mode, 'google');
  assert.equal(a.status().mode, 'google');
});

test('모드를 바꾸면 기다리던 질문도 같이 간다', async () => {
  // 수동으로 두고 질문을 받은 뒤 마음이 바뀌는 것이 보통의 순서다. 그때
  // 질문을 버리고 MSX 에서 다시 치게 하는 것은 한 번 더 시키는 일이다.
  const seen = [];
  const hub = { emit: (ch, ev, d) => seen.push({ ev, ...d }) };
  let asked = null;
  const a = new AskService(hub, {
    mode: 'manual',
    answerer: async (q) => { asked = q; return 'from the web'; },
  });
  const sent = [];
  a.feed(req('how tall is mount fuji'));
  assert.equal(a.state, 'asking', '수동이면 기다린다');
  assert.equal(asked, null, '아무도 안 물었다');

  assert.equal(a.setMode('google'), 'google');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked, 'how tall is mount fuji', '바꾸자마자 물어봐야 한다');
  assert.ok(seen.some((e) => e.ev === 'mode' && e.mode === 'google'),
            '바뀌었다고 말해야 한다');
});

test('수동으로 돌리면 혼자 답하지 않는다', () => {
  let asked = 0;
  const a = new AskService({ emit() {} }, { answerer: async () => { asked++; return 'x'; } });
  a.setMode('manual');
  a.feed(req('anything'));
  assert.equal(a.state, 'asking');
  assert.equal(asked, 0, '사람이 답할 때까지 아무것도 안 간다');
});

test('모르는 모드 이름은 검색으로 본다', () => {
  // 오타 하나로 조용히 수동이 되면, MSX 는 영영 답을 못 받고 그 이유는
  // 아무 데도 안 남는다.
  const a = new AskService({ emit() {} });
  assert.equal(a.setMode('gogle'), 'google');
  assert.equal(a.setMode(''), 'google');
  assert.equal(a.setMode('manual'), 'manual');
});

test('답은 250 에서 자르고, 검색 답도 같은 자리에서 자른다', async () => {
  // 500 이었다가 실기에서 "너무 길다" 로 절반이 됐다. 숫자를 여기 적는 이유:
  // LIMIT 을 LIMIT 과 비교하면 무엇으로 바꾸든 통과한다.
  const { LIMIT, AskService } = await import('../src/ask.js');
  assert.equal(LIMIT, 250);
  const { EventEmitter } = await import('node:events');
  assert.equal(new AskService(new EventEmitter()).limit, 250);

  // **검색 답도 같은 자리에서 자른다** - 선에 나가는 바이트로 세어서, 단어
  // 경계에서, "..." 를 붙여. 한도를 안 넘기면 모양 잡는 쪽이 제 기본값으로 자르고
  // 그걸 _deliver 가 다른 길이로 단어 한가운데에서 또 자른다.
  const { webAnswer } = await import('../src/websearch.js');
  const page = JSON.stringify({ query: { search: Array.from({ length: 5 },
    (_, i) => ({ title: `Title ${i}`, snippet: 'word '.repeat(40) })) } });
  const got = await webAnswer('q', { engine: 'wikipedia', limit: 250, get: async () => page });
  assert.ok(Buffer.byteLength(got.text, 'latin1') <= 250, `${Buffer.byteLength(got.text, 'latin1')} bytes`);
  assert.ok(got.cut && got.text.endsWith('...'), '잘렸다고 표시한다');
  const fs = await import('node:fs');
  const ask = fs.readFileSync(new URL('../src/ask.js', import.meta.url), 'utf8');
  assert.ok(/webAnswer\(query, \{ limit: this\.limit/.test(ask), 'ask 가 한도를 안 넘긴다');
});
