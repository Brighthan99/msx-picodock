// gemini.test.js — CALL PDASK 를 Gemini 가 답한다. 그리고 **키는 새지 않는다.**
//
// claude.test.js 와 같은 방식이다: SDK 자리에 가짜를 끼워 네트워크도 돈도 안
// 쓴다. 키를 쥐는 코드는 둘이 같은 것(keyed.js)이라, 여기서는 Gemini 에게만
// 다른 것 - 어디로 어떻게 묻는가, 막힌 답을 어떻게 알아보는가 - 을 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { Gemini, MODEL, API } from '../src/gemini.js';
import { AskService, OP_REQ, OP_CHUNK, LIMIT } from '../src/ask.js';
import { Hub, CH_ASK } from '../src/hub.js';

const KEY = 'AIzaSy-THIS-IS-THE-GEMINI-SECRET-0123456';

/** @google/genai 의 흉내. */
function fakeSdk({ onGet, onGenerate } = {}) {
  class ApiError extends Error {
    constructor(o) { super(o.message); this.name = 'ApiError'; this.status = o.status; }
  }
  const made = [];
  const asked = [];
  class GoogleGenAI {
    constructor(opts) {
      made.push(opts);
      this.models = {
        get: async (p) => (onGet ? onGet(p) : { name: p.model }),
        generateContent: async (p) => { asked.push(p); return onGenerate(p); },
      };
    }
  }
  return { GoogleGenAI, ApiError, made, asked };
}

const said = (text, extra = {}) => async () => ({
  modelVersion: MODEL,
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  ...extra,
});

const same = async (t) => t;

test('Gemini: 키는 SDK 에만, 환경변수가 목적지를 바꾸지 못하게', async () => {
  const sdk = fakeSdk();
  const g = new Gemini({ limit: LIMIT, sdk, shape: same });
  assert.deepEqual(await g.setKey(`${KEY}\n`), { key: true, model: MODEL });

  const opts = sdk.made[0];
  assert.equal(opts.apiKey, KEY);
  assert.equal(opts.vertexai, false, 'GOOGLE_GENAI_USE_VERTEXAI 가 켜져 있어도 Vertex 로 가면 안 된다');
  assert.equal(opts.httpOptions.baseUrl, API, 'GOOGLE_GEMINI_BASE_URL 로 새면 안 된다');
  assert.ok(opts.httpOptions.retryOptions.attempts <= 2, '429 에 몇 분씩 재시도하면 MSX 가 서 있다');

  for (const shown of [JSON.stringify(g), inspect(g),
                       inspect(g, { customInspect: false, depth: 0 })])
    assert.ok(!shown.includes(KEY), `키가 보인다: ${shown}`);
});

test('Gemini: 틀린 키는 400 으로 온다 - 그래도 "거절" 로 읽는다', async () => {
  const sdk = fakeSdk({ onGet: () => { throw new sdk.ApiError({ status: 400,
    message: `{"error":{"code":400,"message":"API key not valid. key=${KEY}",`
           + '"details":[{"reason":"API_KEY_INVALID"}]}}' }); } });
  const g = new Gemini({ limit: LIMIT, sdk, shape: same });
  const e = await g.setKey(KEY).catch((x) => x);
  assert.match(e.message, /refused/);
  assert.ok(!e.message.includes(KEY));
  assert.equal(g.hasKey, false);
});

test('Gemini: 다른 400 은 거절이 아니라 오류다 - 그리고 키는 지운다', async () => {
  const sdk = fakeSdk({ onGet: () => { throw new sdk.ApiError({ status: 400,
    message: `bad request near ${KEY}` }); } });
  const g = new Gemini({ limit: LIMIT, sdk, shape: same });
  const e = await g.setKey(KEY).catch((x) => x);
  assert.match(e.message, /Gemini API error/);
  assert.ok(!e.message.includes(KEY), e.message);
});

test('Gemini: 무엇을 어떻게 묻는가', async () => {
  const sdk = fakeSdk({ onGenerate: said('It is a Z80 home computer standard.') });
  const g = new Gemini({ limit: 250, sdk, shape: async (t) => `[${t}]` });
  await g.setKey(KEY);
  const out = await g.answer('what is msx');
  assert.deepEqual(out, { text: '[It is a Z80 home computer standard.]', source: MODEL });

  const p = sdk.asked[0];
  assert.equal(p.model, 'gemini-3.8-flash');
  assert.equal(p.contents, 'what is msx');
  assert.match(p.config.systemInstruction, /40-column/);
  assert.match(p.config.systemInstruction, /at most 200 characters/);
  // 이 모델은 MINIMAL 을 받지 않는다 (문서: "minimal is not supported").
  assert.equal(p.config.thinkingConfig.thinkingLevel, 'LOW');
});

test('Gemini: 생각 조각은 답이 아니다', async () => {
  const sdk = fakeSdk({ onGenerate: async () => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: 'let me think', thought: true }, { text: 'Z80 at ' }, { text: '3.58 MHz.' }] } }] }) });
  const g = new Gemini({ limit: LIMIT, sdk, shape: same });
  await g.setKey(KEY);
  assert.equal((await g.answer('cpu?')).text, 'Z80 at 3.58 MHz.');
});

test('Gemini: 막힌 답은 실패가 아니라 "답하지 않겠다" 다', async () => {
  for (const res of [
    { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
    { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] },
  ]) {
    const sdk = fakeSdk({ onGenerate: async () => res });
    const g = new Gemini({ limit: LIMIT, sdk, shape: same });
    await g.setKey(KEY);
    assert.match((await g.answer('x')).text, /Gemini would not answer/);
  }
});

test('Gemini: 그냥 빈 답은 오류다 - 막힌 것과 구별한다', async () => {
  const sdk = fakeSdk({ onGenerate: said('') });
  const g = new Gemini({ limit: LIMIT, sdk, shape: same });
  await g.setKey(KEY);
  await assert.rejects(g.answer('x'), /sent back no text/);
});

test('gemini 모드: MSX 의 질문에 Gemini 가 답하고, 로그 어디에도 키가 없다', async () => {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => seen.push(ev));
  const sdk = fakeSdk({ onGenerate: async (p) => said(`You asked: ${p.contents}`)() });
  const ask = new AskService(hub, { gemini: new Gemini({ limit: LIMIT, sdk, shape: same }) });

  assert.equal(ask.setMode('gemini'), 'gemini');
  await ask.setApiKey('gemini', KEY);
  assert.deepEqual(ask.status().gemini, { key: true, model: MODEL });
  assert.equal(ask.status().claude.key, false, '다른 쪽의 키는 그대로다');

  const q = Buffer.from('what is msx', 'latin1');
  ask.feed(Buffer.concat([Buffer.from([OP_REQ, q.length, 0]), q]));
  for (let i = 0; i < 50 && ask.state === 'asking'; i++)
    await new Promise((r) => setImmediate(r));
  const sent = [];
  ask.pump((p) => sent.push(Buffer.from(p)));
  assert.equal(sent[0][0], OP_CHUNK);
  assert.equal(sent[0].subarray(2).toString('latin1'), 'You asked: what is msx');
  assert.equal(seen.find((e) => e.ch === CH_ASK && e.ev === 'answer').source, MODEL);

  assert.ok(seen.some((e) => e.ev === 'api_key' && e.who === 'gemini' && e.set));
  assert.ok(!JSON.stringify([seen, hub.since(0), ask.status()]).includes(KEY));
});

test('모르는 이름의 키는 받지 않는다', async () => {
  const ask = new AskService(new Hub());
  await assert.rejects(ask.setApiKey('openai', KEY), /unknown answerer/);
  assert.throws(() => ask.forgetApiKey('openai'), /unknown answerer/);
});
