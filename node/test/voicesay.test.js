// 문장 하나를 PSG 바이트로. 합성은 voice.js 가 하고, 여기는 그것을 한 번에
// 하나씩 부르고 기억하는 쪽이다.
//
// 진짜 `say` 는 부르지 않는다 - 맥에만 있고, 있어도 시험이 소리를 내면 안 된다.
// 대신 백엔드를 갈아 끼우고 **무엇을 부탁했는지**를 본다. 옵션이 틀리면 소리는
// 나는데 엉뚱한 목소리로 나므로, 옵션이야말로 확인할 값어치가 있다. 합성과
// 양자화 자체가 파이썬과 같은지는 test/voice_crosscheck.py 가 본다.

import { test } from 'node:test';
import assert from 'node:assert';
import { VoiceSay, ramp, DEFAULTS, LOCAL, MAX_BYTES } from '../src/voicesay.js';

/** 부탁받은 것을 적어 두는 가짜. **계산하지 않고 기록만 한다.** */
function fake({ reply = Buffer.from([1, 2, 3]), fail = null, voices = [], levels = null } = {}) {
  const calls = [];
  const asked = { voices: [], levels: [] };
  return {
    calls, asked,
    // 진짜처럼 비동기로 돌려준다. 동기로 돌려주면 busy 가 풀리는 순서가
    // 달라져서, 겹치기 시험이 실제와 다른 것을 보게 된다.
    synth: (text, o) => new Promise((resolve, reject) => {
      calls.push({ text, o });
      setImmediate(() => (fail ? reject(fail) : resolve(reply)));
    }),
    voices: async (o) => { asked.voices.push(o); if (voices instanceof Error) throw voices; return voices; },
    levels: async (o) => { asked.levels.push(o); return levels; },
  };
}

test('말을 합성기에 넘기고 바이트를 받는다', async () => {
  const f = fake();
  const got = await new VoiceSay({ backend: f }).say('hello');
  assert.deepEqual([...got], [1, 2, 3]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].text, 'hello');
});

test('기본 합성기는 이 기계의 voice.js 다 (파이썬이 아니다)', () => {
  assert.equal(new VoiceSay().backend, LOCAL);
  assert.equal(typeof LOCAL.synth, 'function');
});

test('말은 말로 넘어간다 - 대시로 시작해도 옵션이 되지 않는다', async () => {
  const f = fake();
  await new VoiceSay({ backend: f }).say('--engine piper');
  assert.equal(f.calls[0].text, '--engine piper');
  assert.equal(f.calls[0].o.engine, 'auto', '말이 엔진을 바꿨다');
});

test('엔진과 언어와 목소리가 넘어간다', async () => {
  const f = fake();
  await new VoiceSay({ backend: f }).say('hi', { engine: 'espeak-ng', lang: 'ko', voice: 'ko+m3' });
  assert.equal(f.calls[0].o.engine, 'espeak-ng');
  assert.equal(f.calls[0].o.lang, 'ko');
  assert.equal(f.calls[0].o.voice, 'ko+m3');
});

test('목소리를 안 고르면 비워서 넘긴다', async () => {
  // 빈 문자열을 이름으로 쓰면 `say -v ''` 가 되고, 그것은 이름이 빈 목소리를
  // 찾으라는 뜻이다. voice.js 는 거짓 값을 "고르지 않음" 으로 읽는다.
  const f = fake();
  await new VoiceSay({ backend: f }).say('hi');
  assert.ok(!f.calls[0].o.voice);
});

test('정규화는 기본이 켜짐이고, 끄면 꺼진 채로 간다', async () => {
  assert.equal(DEFAULTS.normalise, true);
  const f = fake();
  const v = new VoiceSay({ backend: f });
  await v.say('a');
  await v.say('b', { normalise: false });
  assert.equal(f.calls[0].o.normalise, true);
  assert.equal(f.calls[1].o.normalise, false);
});

test('빈 말은 합성기를 부르지도 않는다', async () => {
  const f = fake();
  await assert.rejects(() => new VoiceSay({ backend: f }).say('   '));
  assert.equal(f.calls.length, 0, '빈 말로 합성기를 불렀다');
});

test('아무것도 안 나오면 성공이 아니다', async () => {
  // 목소리 이름이 그 언어에 없으면 say 가 0.02 초짜리 무음을 내놓은 적이
  // 있다. 그때 아무 데도 틀렸다는 말이 없었던 것이 문제였다.
  const f = fake({ reply: Buffer.alloc(0) });
  await assert.rejects(() => new VoiceSay({ backend: f }).say('hello'), /produced nothing/);
});

test('합성기가 실패한 이유를 그대로 전한다', async () => {
  const f = fake({ fail: new Error("espeak-ng: 'espeak-ng' is not installed") });
  const v = new VoiceSay({ backend: f });
  await assert.rejects(() => v.say('hello'), /not installed/);
  assert.match(v.lastError, /not installed/);
});

test('한 번에 하나만 - 두 번째는 기다리지 않고 거절한다', async () => {
  const f = fake();
  const v = new VoiceSay({ backend: f });
  const first = v.say('hello');
  await assert.rejects(() => v.say('there'), /last sentence/);
  await first;
  assert.equal(f.calls.length, 1, '두 번째가 합성기를 불렀다');
  // 끝나고 나면 다시 받는다. 안 그러면 한 번 말한 뒤로 영영 못 말한다.
  await v.say('again');
  assert.equal(f.calls.length, 2);
});

test('실패해도 다음 말은 받는다', async () => {
  const v = new VoiceSay({ backend: fake({ fail: new Error('boom') }) });
  await assert.rejects(() => v.say('hello'));
  assert.equal(v.busy, false, 'busy 가 걸린 채로 남았다');
});

test('설정은 남고, 한 번만 다르게도 된다', async () => {
  const f = fake();
  const v = new VoiceSay({ backend: f });
  v.set({ lang: 'ko', engine: 'espeak-ng' });
  await v.say('안녕');
  assert.equal(f.calls[0].o.lang, 'ko');
  await v.say('hello', { lang: 'en' });        // 이번만
  assert.equal(f.calls[1].o.lang, 'en');
  assert.equal(v.opts.lang, 'ko', '한 번짜리가 설정을 덮었다');
});

test('모르는 열쇠는 설정에 들어가지 않는다', () => {
  const v = new VoiceSay({ backend: fake() });
  v.set({ lang: 'ja', nonsense: 1 });
  assert.equal(v.opts.lang, 'ja');
  assert.equal('nonsense' in v.opts, false);
});

test('시한과 크기에 상한이 있다', async () => {
  // 상한이 없으면 돌아오지 않는 합성기 하나가 서버를 영영 잡는다.
  const never = { synth: () => new Promise(() => {}), voices: async () => [], levels: async () => null };
  const v = new VoiceSay({ backend: never, timeoutMs: 30 });
  await assert.rejects(() => v.say('hi'), /longer than/);
  assert.equal(v.busy, false);
  const big = fake({ reply: Buffer.alloc(MAX_BYTES + 1) });
  await assert.rejects(() => new VoiceSay({ backend: big }).say('hi'), /too long/);
});

test('진단 톱니는 합성기를 부르지 않는다', async () => {
  const f = fake();
  const got = await new VoiceSay({ backend: f, tone: true }).say('hello');
  assert.equal(f.calls.length, 0, '톱니인데 합성기를 불렀다');
  // **PDVOICE /T 가 내는 것과 같은 파형이어야 의미가 있다.**
  assert.equal(got[0], 0);
  assert.equal(got[255], 255);
  assert.equal(got[256], 0, '256 에서 다시 0 부터 세야 한다');
  assert.equal(got.length, 11025, '1 초');
});

test('톱니는 재생 속도를 따라간다', async () => {
  const got = await new VoiceSay({ backend: fake(), tone: true }).say('hello', { rate: 9000 });
  assert.equal(got.length, 9000);
});

test('ramp 는 전폭이다', () => {
  const r = ramp(1000, 1);
  assert.equal(Math.min(...r), 0);
  assert.equal(Math.max(...r), 255);
});

test('순음 모드는 순음을 보낸다', async () => {
  const f = fake();
  const got = await new VoiceSay({ backend: f, tone: 'sine' }).say('hello');
  assert.equal(f.calls.length, 0, '순음인데 합성기를 불렀다');
  assert.equal(got[0], 128, '무음에서 시작하지 않는다');
  assert.ok(Math.max(...got) > 200 && Math.min(...got) < 56, '진폭이 없다');
  // **전폭까지 밀지 않는다.** 표의 맨 위는 눈금이 성기다.
  assert.ok(Math.max(...got) < 255 && Math.min(...got) > 0, '끝까지 밀었다');
});

test('순음은 톱니가 아니다', async () => {
  const r = await new VoiceSay({ backend: fake(), tone: 'ramp' }).say('x');
  const s = await new VoiceSay({ backend: fake(), tone: 'sine' }).say('x');
  const rampSteps = new Set([...r.subarray(0, 100)].map((v, i, a) => (i ? v - a[i - 1] : 1)));
  assert.deepEqual([...rampSteps], [1], '톱니가 톱니가 아니다');
  const sineSteps = new Set([...s.subarray(0, 100)].map((v, i, a) => (i ? v - a[i - 1] : 0)));
  assert.ok(sineSteps.size > 3, '순음이 직선이다');
});

test('진단 파형을 안 켜면 합성기로 간다', async () => {
  const f = fake();
  await new VoiceSay({ backend: f }).say('hello');
  assert.equal(f.calls.length, 1);
});

test('곡선이 합성기로 넘어가고, 기본은 여기 적지 않는다', async () => {
  // **MSX 가 쓰는 표와 같아야 한다.** 호스트가 ym 으로 부호화하고 MSX 가 ay
  // 표로 되돌리면 길이 두 번 휜다.
  const f = fake();
  await new VoiceSay({ backend: f }).say('hi', { curve: 'ym' });
  assert.equal(f.calls[0].o.curve, 'ym');
  // null 이면 voice.js 의 DEFAULT_CURVE 가 쓰인다. 여기 이름을 적어 두면
  // 언젠가 한 군데만 바뀐다.
  assert.equal(DEFAULTS.curve, null, 'Node 에 기본 곡선을 또 적었다');
});

test('목소리 목록을 한 번만 묻는다', async () => {
  const f = fake({ voices: [{ name: 'Reed', note: 'ko_KR' }, { name: 'Grandpa', note: 'ko_KR' }] });
  const v = new VoiceSay({ backend: f });
  const a = await v.voices({ engine: 'say', lang: 'ko' });
  const b = await v.voices({ engine: 'say', lang: 'ko' });
  assert.equal(f.asked.voices.length, 1, `${f.asked.voices.length} 번 물었다`);
  assert.deepEqual(a.map((x) => x.name), ['Reed', 'Grandpa']);
  assert.equal(a, b, '같은 목록을 돌려줘야 한다');
});

test('언어가 다르면 따로 묻는다', async () => {
  const f = fake({ voices: [{ name: 'Reed', note: 'en_GB' }] });
  const v = new VoiceSay({ backend: f });
  await v.voices({ engine: 'say', lang: 'ko' });
  await v.voices({ engine: 'say', lang: 'en' });
  assert.equal(f.asked.voices.length, 2, '언어별로 안 나눴다');
});

test('voicesCached 는 기다리지 않는다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const backend = { ...fake(), voices: async () => { await gate; return [{ name: 'Reed', note: '' }]; } };
  const v = new VoiceSay({ backend });
  assert.deepEqual(v.voicesCached({ engine: 'say', lang: 'en' }), []);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(v.voicesCached({ engine: 'say', lang: 'en' }).map((x) => x.name), ['Reed']);
});

test('물어보다 실패해도 빈 목록이지 오류가 아니다', async () => {
  // piper 의 목소리는 디스크의 모델 파일이라 목록이 없다. 그것은 고장이 아니다.
  const v = new VoiceSay({ backend: fake({ voices: new Error('boom') }) });
  assert.deepEqual(await v.voices({ engine: 'piper', lang: 'en' }), []);
});

test('레벨표는 곡선마다 한 번 묻는다', async () => {
  const f = fake({ levels: Array.from({ length: 256 }, (_, i) => i / 127.5 - 1) });
  const v = new VoiceSay({ backend: f });
  const a = await v.levels();
  const b = await v.levels();
  assert.equal(f.asked.levels.length, 1, '두 번 물었다');
  assert.equal(a.length, 256);
  assert.equal(a, b);
  await v.levels({ curve: 'ym' });
  assert.equal(f.asked.levels.length, 2, '곡선이 다른데 같은 표를 썼다');
  assert.equal(f.asked.levels[1].curve, 'ym');
});

test('레벨표가 망가져 오면 null 이다', async () => {
  assert.equal(await new VoiceSay({ backend: fake({ levels: [1, 2, 3] }) }).levels(), null,
               '256 개가 아닌데 받았다');
});

test('진짜 레벨표는 256 개이고 -1 에서 1 까지다', async () => {
  const lv = await LOCAL.levels({ curve: null });
  assert.equal(lv.length, 256);
  assert.equal(lv[0], -1);
  assert.equal(lv[255], 1);
});
