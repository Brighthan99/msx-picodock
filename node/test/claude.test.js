// claude.test.js — CALL PDASK 를 Claude 가 답한다. 그리고 **키는 새지 않는다.**
//
// 네트워크는 안 쓴다. SDK 자리에 가짜를 끼운다 - 시험이 돌 때마다 돈이 나가면
// 안 되고, 키 없는 기계에서도 돌아야 한다. 가짜는 받은 옵션을 적어 두므로
// "키가 SDK 에는 가고 그 밖에는 안 간다" 를 볼 수 있다.
//
// 모양 잡기(pd_ask.py --shape)만은 진짜 파이썬으로 본다. 그것이 검색 답과
// **같은 자리에서** 자른다는 것이 요점이기 때문이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Claude, MODEL, API, systemPrompt, shapeText } from '../src/claude.js';
import { AskService, OP_REQ, OP_CHUNK, OP_ERR, LIMIT } from '../src/ask.js';
import { Hub, CH_ASK } from '../src/hub.js';

const KEY = 'sk-ant-api03-THIS-IS-THE-SECRET-0123456789';
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'host');

/** @anthropic-ai/sdk 의 흉내. 오류 클래스는 진짜와 같은 상속 관계로. */
function fakeSdk({ onRetrieve, onCreate } = {}) {
  class APIError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {
    constructor(message = 'Connection error.') { super(undefined, message); }
  }
  class APIConnectionTimeoutError extends APIConnectionError {}

  const made = [];
  const asked = [];
  class Anthropic {
    constructor(opts) {
      made.push(opts);
      this.models = { retrieve: async (id) => (onRetrieve ? onRetrieve(id) : { id }) };
      this.beta = { messages: { create: async (p) => { asked.push(p); return onCreate(p); } } };
    }
  }
  Object.assign(Anthropic, { APIError, AuthenticationError, PermissionDeniedError,
                             NotFoundError, RateLimitError, APIConnectionError,
                             APIConnectionTimeoutError });
  return { default: Anthropic, made, asked };
}

const said = (text, extra = {}) => async () =>
  ({ model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });

const same = async (t) => t;

// --------------------------------------------------------------- 키

test('키는 SDK 에만 가고, 이 객체를 어떻게 찍어도 나오지 않는다', async () => {
  const sdk = fakeSdk({ onCreate: said('An MSX is a computer.') });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  assert.equal(c.hasKey, false);

  const s = await c.setKey(`  ${KEY}\n`);          // 붙여 넣다 딸려 온 공백
  assert.deepEqual(s, { key: true, model: MODEL });

  const opts = sdk.made[0];
  assert.equal(opts.apiKey, KEY);
  // 환경변수가 끼어들 틈을 막았는가.
  assert.equal(opts.authToken, null, 'ANTHROPIC_AUTH_TOKEN 이 같이 가면 안 된다');
  assert.equal(opts.baseURL, API, 'ANTHROPIC_BASE_URL 로 새면 안 된다');
  assert.equal(opts.logLevel, 'off');

  for (const shown of [JSON.stringify(c), inspect(c),
                       inspect(c, { customInspect: false, depth: 0 }),
                       JSON.stringify(c.status()), String(Object.keys(c))])
    assert.ok(!shown.includes(KEY), `키가 보인다: ${shown}`);
});

test('거절당한 키는 쥐지 않는다', async () => {
  const sdk = fakeSdk({ onRetrieve: () => { throw sdkErr(sdk, 'AuthenticationError', 401); } });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await assert.rejects(c.setKey(KEY), /refused \(401\)/);
  assert.equal(c.hasKey, false);
  await assert.rejects(c.answer('hi'), /no API key/);
});

/** 가짜 SDK 의 오류 하나. 메시지에 **일부러 키를 넣는다** - 지워지는지 보려고. */
function sdkErr(sdk, name, status) {
  const E = sdk.default[name];
  return new E(status, `${status} something about ${KEY}`);
}

test('오류 문구에 키가 섞여 와도 지우고 내보낸다', async () => {
  const sdk = fakeSdk({ onRetrieve: () => { throw sdkErr(sdk, 'APIError', 400); } });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  const e = await c.setKey(KEY).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.ok(!e.message.includes(KEY), e.message);
  assert.match(e.message, /\*\*\*/);
});

test('공백이 든 것이나 빈 것은 키로 받지 않는다 - SDK 까지 가지도 않는다', async () => {
  const sdk = fakeSdk();
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await assert.rejects(c.setKey(''), /no key/);
  await assert.rejects(c.setKey('sk-ant-one two'), /does not look like/);
  assert.equal(sdk.made.length, 0);
});

test('놓으면 더는 묻지 못한다', async () => {
  const sdk = fakeSdk({ onCreate: said('yes') });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await c.setKey(KEY);
  assert.equal(c.forget(), true);
  assert.equal(c.forget(), false, '두 번째는 놓을 것이 없다');
  assert.equal(c.hasKey, false);
  await assert.rejects(c.answer('hi'), /no API key/);
});

// --------------------------------------------------------------- 묻기

test('무엇을 어떻게 묻는가', async () => {
  const sdk = fakeSdk({ onCreate: said('It is a 1983 home computer standard.') });
  const shaped = [];
  const c = new Claude({ limit: 250, sdk, shape: async (t) => { shaped.push(t); return `[${t}]`; } });
  await c.setKey(KEY);

  const out = await c.answer('what is msx');
  assert.deepEqual(out, { text: '[It is a 1983 home computer standard.]', source: MODEL });
  assert.deepEqual(shaped, ['It is a 1983 home computer standard.'], '답은 모양을 거쳐 나간다');

  const p = sdk.asked[0];
  assert.equal(p.model, 'claude-opus-5');
  assert.deepEqual(p.messages, [{ role: 'user', content: 'what is msx' }]);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.output_config.effort, 'low');
  // 없어진 것들을 다시 넣지 않았는가. 넣으면 400 이다.
  assert.equal(p.thinking?.budget_tokens, undefined);
  assert.equal(p.temperature, undefined);
  assert.match(p.system, /40-column/);
  assert.match(p.system, /at most 200 characters/, '선 위 한도 250 보다 적게 부른다');
});

test('거절은 실패가 아니라 답이다', async () => {
  const sdk = fakeSdk({ onCreate: said('', { stop_reason: 'refusal', content: [] }) });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await c.setKey(KEY);
  const out = await c.answer('something');
  assert.match(out.text, /would not answer/);
});

test('답하다 실패해도 키는 문구에 안 나온다', async () => {
  const sdk = fakeSdk({ onCreate: () => { throw sdkErr(sdk, 'APIError', 500); } });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await c.setKey(KEY);
  const e = await c.answer('hi').catch((x) => x);
  assert.match(e.message, /Claude API error/);
  assert.ok(!e.message.includes(KEY), e.message);
});

test('여러 text 블록은 이어 붙이고, 생각 블록은 버린다', async () => {
  const sdk = fakeSdk({ onCreate: async () => ({
    model: MODEL, stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' },
              { type: 'text', text: 'Z80 at ' }, { type: 'text', text: '3.58 MHz.' }] }) });
  const c = new Claude({ limit: LIMIT, sdk, shape: same });
  await c.setKey(KEY);
  assert.equal((await c.answer('cpu?')).text, 'Z80 at 3.58 MHz.');
});

test('시스템 프롬프트: 한도가 없으면 숫자를 부르지 않는다', () => {
  assert.match(systemPrompt(0), /a few sentences/);
  assert.doesNotMatch(systemPrompt(0), /NaN|undefined/);
});

// --------------------------------------------------------------- 모양

test('모양은 검색 답과 같은 자리(askshape.js)에서 잡는다', async () => {
  const long = '“Hello” — ' + 'word '.repeat(100);
  const out = await shapeText(long, 250);
  // 선에 나갈 바이트 그대로다: 줄 끝은 CR LF, 그렇게 세어 한도 안.
  assert.ok(Buffer.byteLength(out, 'latin1') <= 250, out);
  for (const line of out.split('\r\n')) assert.ok(line.length <= 40, `40 칼럼을 넘는다: ${line}`);
  assert.match(out, /^[\x20-\x7e\r\n]*$/, 'ASCII 만');
  assert.ok(out.startsWith('"Hello" - '), '둥근 따옴표와 긴 줄표를 MSX 글자로');
  assert.ok(out.endsWith('...'), '잘렸다고 표시한다');
});

// 정답표(src/host/pd_ask.py)는 개발 트리에만 있다. 공개 트리에서는 건너뛴다.
const NO_REFERENCE = !fs.existsSync(path.join(HOST, 'pd_ask.py'))
  && 'Python reference (src/host/pd_ask.py) not in this tree';

test('모양 잡은 답이 선에 오를 때 pd_ask.py 의 shape() 와 같은 바이트다', { skip: NO_REFERENCE }, async () => {
  // 파이썬 서버가 MSX 에 보내던 바이트가 정답이다: 40 칼럼, CR LF, 한도 안.
  // Node 는 pd_ask.py 가 사람 보라고 찍은 LF 판을 받으므로, 선에 올리기 전에
  // CR LF 를 되돌려야 한다 - 안 그러면 MSX 화면에서 줄이 계단처럼 밀린다.
  const long = 'MSX is a standard for 8-bit home computers introduced by '
    + 'Microsoft and ASCII in 1983. ' + 'It was popular in Japan and Europe. '.repeat(10);
  const want = spawnSync('python3', ['-c',
    'import sys, pd_ask; sys.stdout.buffer.write(pd_ask.shape(sys.stdin.read(), limit=250)[0])'],
    { cwd: HOST, input: long }).stdout;
  assert.ok(want.includes(Buffer.from('\r\n')), '파이썬은 CR LF 로 보낸다');

  const hub = new Hub();
  const ask = new AskService(hub, { answerer: async () => shapeText(long, 250) });
  ask.feed(req('q'));
  // 파이썬이 뜨는 데 100ms 남짓 걸린다. settle() 의 몇 틱으로는 모자란다.
  for (let i = 0; i < 100 && ask.state === 'asking'; i++)
    await new Promise((r) => setTimeout(r, 20));
  const sent = [];
  ask.pump((p) => sent.push(Buffer.from(p)));
  for (;;) {
    ask.feed(Buffer.from([0x06]));             // ACK - 다음 청크를
    const n = sent.length;
    ask.pump((p) => sent.push(Buffer.from(p)));
    if (sent.length === n || sent.at(-1)[0] !== OP_CHUNK) break;
  }
  const wire = Buffer.concat(sent.filter((p) => p[0] === OP_CHUNK).map((p) => p.subarray(2)));
  assert.deepEqual(wire, want);
  assert.ok(wire.length <= 250);
});

// --------------------------------------------------------------- PDASK 와

function req(text) {
  const b = Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([OP_REQ, b.length & 0xff, b.length >> 8]), b]);
}

async function settle(ask) {
  for (let i = 0; i < 50 && ask.state === 'asking'; i++)
    await new Promise((r) => setImmediate(r));
}

test('claude 모드: MSX 의 질문에 Claude 가 답하고, 로그 어디에도 키가 없다', async () => {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => seen.push(ev));
  const sdk = fakeSdk({ onCreate: async (p) => ({
    model: MODEL, stop_reason: 'end_turn',
    content: [{ type: 'text', text: `You asked: ${p.messages[0].content}` }] }) });
  const ask = new AskService(hub, { claude: new Claude({ limit: LIMIT, sdk, shape: same }) });

  assert.equal(ask.setMode('claude'), 'claude');
  await ask.setApiKey('claude', KEY);
  assert.deepEqual(ask.status().claude, { key: true, model: MODEL });

  ask.feed(req('what is msx'));
  await settle(ask);
  const sent = [];
  ask.pump((p) => sent.push(Buffer.from(p)));
  assert.equal(sent[0][0], OP_CHUNK);
  assert.equal(sent[0].subarray(2).toString('latin1'), 'You asked: what is msx');

  const answered = seen.find((e) => e.ch === CH_ASK && e.ev === 'answer');
  assert.equal(answered.source, MODEL);
  assert.ok(seen.some((e) => e.ev === 'api_key' && e.who === 'claude' && e.set === true));

  const everything = JSON.stringify([seen, hub.since(0), ask.status()]);
  assert.ok(!everything.includes(KEY), '이벤트나 상태에 키가 실렸다');

  ask.forgetApiKey('claude');
  assert.equal(ask.status().claude.key, false);
  assert.ok(seen.some((e) => e.ev === 'api_key' && e.who === 'claude' && e.set === false));
});

test('claude 모드인데 키가 없으면 MSX 는 실패를 받고, 화면에는 왜인지 남는다', async () => {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_ASK) seen.push(ev); });
  const ask = new AskService(hub, { mode: 'claude',
                                    claude: new Claude({ limit: LIMIT, sdk: fakeSdk(), shape: same }) });
  ask.feed(req('hello'));
  await settle(ask);
  const sent = [];
  ask.pump((p) => sent.push(Buffer.from(p)));
  assert.equal(sent[0][0], OP_ERR);
  assert.match(seen.find((e) => e.ev === 'error').text, /no API key/);
});

test('틀린 키는 이벤트를 남기지 않는다 - 들어온 적이 없으니까', async () => {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => seen.push(ev));
  const sdk = fakeSdk({ onRetrieve: () => { throw sdkErr(sdk, 'AuthenticationError', 401); } });
  const ask = new AskService(hub, { claude: new Claude({ limit: LIMIT, sdk, shape: same }) });
  await assert.rejects(ask.setApiKey('claude', KEY), /refused/);
  assert.equal(seen.filter((e) => e.ev === 'api_key').length, 0);
  assert.ok(!JSON.stringify(hub.since(0)).includes(KEY));
});
