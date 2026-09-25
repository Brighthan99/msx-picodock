// psg.test.js — 브라우저가 낼 소리를 브라우저 없이 확인한다.
//
// 워크렛은 AudioWorkletGlobalScope 에서 도는 파일이지만, 그 안의 DSP 는 그냥
// 산수다. 전역 몇 개를 흉내 내 주면 Node 에서 그대로 돌릴 수 있다.
//
// **무엇에 대 보는가가 중요하다.** 파이썬 렌더러와 비교만 하면 둘이 같이
// 틀렸을 때 통과한다. 그래서 여기서 대 보는 것은 주로 **물리**다 - 톤 주파수는
// CLK/(16xTP), 엔벨로프 주기는 CLK/(256xEP) 로 데이터시트에 적혀 있다. 우리가
// 고른 값이 아니라 칩이 정한 값이라, 양쪽이 사이좋게 틀릴 수가 없다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const RATE = 44100;

// ESM 은 한 번만 실행된다. 두 번째 import 는 registerProcessor 를 다시 부르지
// 않으므로, 처음에 잡아 둔 것을 돌려준다.
let cached = null;

/** 워크렛을 Node 에서 돌릴 수 있게 전역을 흉내 낸다. */
async function loadWorklet() {
  if (cached) return cached;
  const posted = [];
  globalThis.sampleRate = RATE;
  globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: (m) => posted.push(m), onmessage: null };
    }
  };
  let Klass = null;
  globalThis.registerProcessor = (_name, k) => { Klass = k; };
  await import('../web/psg-worklet.js');
  assert.ok(Klass, 'registerProcessor 가 안 불렸다');
  cached = { Klass, posted };
  return cached;
}

/** 레지스터 한 벌을 계속 먹이면서 seconds 초를 뽑는다. */
function render(Klass, regs, seconds, opts = {}) {
  const p = new Klass();
  const perFrame = RATE / 50;
  const n = Math.floor(RATE * seconds);
  const out = new Float32Array(n);
  const block = new Float32Array(128);
  const outputs = [[block]];

  let fed = 0;
  const feed = () => {
    const r = typeof regs === 'function' ? regs(fed) : regs;
    p.port.onmessage({ data: { cmd: 'frame', regs: Uint8Array.from(r),
                               flags: opts.flags || 0 } });
    fed++;
  };
  // 재생이 시작되려면 큐가 먼저 차야 한다 (START_FRAMES).
  for (let i = 0; i < 4; i++) feed();

  let done = 0, sinceFeed = 0;
  while (done < n) {
    block.fill(0);
    p.process([], outputs);
    const take = Math.min(128, n - done);
    out.set(block.subarray(0, take), done);
    done += take;
    sinceFeed += 128;
    while (sinceFeed >= perFrame) { sinceFeed -= perFrame; feed(); }
  }
  return opts.proc ? { out, p } : out;
}

/** 0 을 지나는 횟수로 기본 주파수를 잰다. 사각파라 주기당 두 번이다. */
function freqOf(buf, skip = RATE / 10) {
  let crossings = 0;
  let prev = buf[skip];
  for (let i = skip + 1; i < buf.length; i++) {
    const v = buf[i];
    if (v === 0) continue;
    if ((prev < 0) !== (v < 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / ((buf.length - skip) / RATE);
}

const rms = (b, skip = 0) => {
  let s = 0;
  for (let i = skip; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / (b.length - skip));
};

/** 채널 A 만 톤으로 켠 레지스터 한 벌. */
function toneA(period, vol = 15) {
  const r = new Array(14).fill(0);
  r[0] = period & 0xff;
  r[1] = (period >> 8) & 0x0f;
  r[7] = 0x3e;                 // bit0=0 -> 톤 A 켜짐, 나머지·노이즈 전부 꺼짐
  r[8] = vol;
  return r;
}

const CLK = 1789772.5;

test('톤 주파수가 CLK/(16xTP) 와 맞는다', async () => {
  const { Klass } = await loadWorklet();
  // 낮은 음부터 높은 음까지. 높은 쪽이 특히 중요하다 - 반주기가 샘플 몇 개
  // 밖에 안 돼서, 식이 2 배 틀려도 낮은 음에서는 잘 안 드러난다.
  for (const tp of [1000, 508, 254, 127, 64, 32]) {
    const want = CLK / (16 * tp);
    const got = freqOf(render(Klass, toneA(tp), 0.5));
    const err = Math.abs(got - want) / want;
    assert.ok(err < 0.02,
      `TP=${tp}: ${want.toFixed(1)} Hz 여야 하는데 ${got.toFixed(1)} Hz (${(err * 100).toFixed(1)}% 어긋남)`);
  }
});

test('볼륨이 로그 눈금을 따른다', async () => {
  const { Klass } = await loadWorklet();
  const at = (v) => rms(render(Klass, toneA(254, v), 0.3), RATE / 10);
  const v15 = at(15), v8 = at(8), v0 = at(0);
  assert.equal(v0, 0, '볼륨 0 은 무음이어야 한다');
  // 실측 AY 곡선에서 8 은 0.1691, 15 는 1.0 - 약 5.9 배 차이다.
  const ratio = v15 / v8;
  assert.ok(ratio > 4.5 && ratio < 7.5, `15/8 = ${ratio.toFixed(2)} 배 (5.9 언저리여야)`);
});

test('믹서가 채널을 실제로 끈다', async () => {
  const { Klass } = await loadWorklet();
  const on = rms(render(Klass, toneA(254), 0.3), RATE / 10);
  const off = toneA(254);
  off[7] = 0x3f;                        // 전부 꺼짐
  // 톤도 노이즈도 꺼진 채널은 DC 레벨을 낸다 (무음이 아니라 일정한 값).
  // 그래서 흔들림이 없는지를 본다.
  const q = render(Klass, off, 0.3).subarray(RATE / 10);
  let min = Infinity, max = -Infinity;
  for (const v of q) { if (v < min) min = v; if (v > max) max = v; }
  assert.ok(on > 0.05, '켜져 있으면 소리가 나야 한다');
  assert.ok(max - min < 1e-6, `꺼진 채널이 흔들린다 (진폭 ${(max - min).toExponential(1)})`);
});

test('노이즈는 톤과 달리 주기가 없다', async () => {
  const { Klass } = await loadWorklet();
  const r = new Array(14).fill(0);
  r[6] = 16;                            // 노이즈 주기
  r[7] = 0x37;                          // bit3=0 -> 노이즈 A 켜짐, 톤은 전부 꺼짐
  r[8] = 15;
  const buf = render(Klass, r, 0.5);
  assert.ok(rms(buf, RATE / 10) > 0.05, '노이즈가 나와야 한다');

  // 자기상관이 낮아야 한다. 톤이었다면 한 주기 뒤에 자기 자신과 똑같다.
  const a = buf.subarray(RATE / 10);
  let best = 0;
  for (const lag of [50, 100, 200, 400, 800]) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i + lag < a.length; i++) {
      dot += a[i] * a[i + lag]; na += a[i] * a[i]; nb += a[i + lag] * a[i + lag];
    }
    best = Math.max(best, Math.abs(dot / Math.sqrt(na * nb)));
  }
  assert.ok(best < 0.35, `주기가 보인다 (자기상관 ${best.toFixed(2)}) - 노이즈가 아니다`);
});

test('엔벨로프 주기가 CLK/(256xEP) 와 맞는다', async () => {
  const { Klass } = await loadWorklet();
  // EP 를 작게 잡아 창 안에 주기가 여러 번 들어오게 한다. 처음에는 EP=2000
  // 으로 재다가 1.2 초에 주기가 1.75 번뿐이어서, 정수로 세는 측정이 1 을
  // 냈다. 코드가 아니라 자가 틀렸던 것이다.
  const EP = 300;
  const r = new Array(14).fill(0);
  r[0] = 30; r[1] = 0;                  // 빠른 톤 - 엔벨로프를 실어 나르는 반송파
  r[7] = 0x3e;
  r[8] = 0x10;                          // 볼륨 대신 엔벨로프를 쓴다
  r[11] = EP & 0xff; r[12] = EP >> 8;
  r[13] = 0x0a;                         // 계속 · 반전 - 삼각파
  const buf = render(Klass, r, 2.0);

  // 포락선을 뽑는다.
  const win = 16;
  const env = [];
  for (let i = RATE / 5; i + win < buf.length; i += win) {
    let m = 0;
    for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(buf[i + k]));
    env.push(m);
  }
  // 절반 높이를 **올라가며** 지나는 횟수 = 주기 수. 골을 세는 것보다 튼튼하다 -
  // 골은 순간이라 창 하나에 안 잡힐 수 있고, 절반 높이는 오래 머문다.
  const half = Math.max(...env) / 2;
  let cycles = 0;
  for (let i = 1; i < env.length; i++)
    if (env[i - 1] < half && env[i] >= half) cycles++;

  const secs = (env.length * win) / RATE;
  const got = cycles / secs;
  // 0x0A 한 주기 = 64 스텝 (32 내려가고 32 올라온다).
  // 스텝은 CLK/(8xEP) 번/초 = 전체 주기로 CLK/(256xEP) 의 절반.
  const want = (CLK / (8 * EP)) / 64;
  assert.ok(Math.abs(got - want) / want < 0.1,
    `엔벨로프 ${want.toFixed(2)} Hz 여야 하는데 ${got.toFixed(2)} Hz (${cycles} 주기 / ${secs.toFixed(2)} s)`);
});

test('엔벨로프 모양이 실제로 다르다 (0x08 톱니 · 0x0A 삼각)', async () => {
  // 주기만 맞고 모양이 틀리면 소리는 완전히 달라진다. 0x08 은 되풀이해서
  // 내려가기만 하고(톱니), 0x0A 는 내려갔다 올라온다(삼각). 톱니는 매 주기
  // 끝에 뚝 끊기고 삼각은 이어진다.
  const { Klass } = await loadWorklet();
  const mk = (shape) => {
    const r = new Array(14).fill(0);
    r[0] = 30; r[7] = 0x3e; r[8] = 0x10;
    r[11] = 300 & 0xff; r[12] = 0;
    r[13] = shape;
    return r;
  };
  const envOf = (shape) => {
    const buf = render(Klass, mk(shape), 1.0);
    const win = 16, out = [];
    for (let i = RATE / 5; i + win < buf.length; i += win) {
      let m = 0;
      for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(buf[i + k]));
      out.push(m);
    }
    return out;
  };
  const jumps = (e) => {
    // 한 창에서 다음 창으로 크게 튀는 횟수. 톱니는 주기마다 한 번씩 튄다.
    const span = Math.max(...e);
    let n = 0;
    for (let i = 1; i < e.length; i++) if (e[i] - e[i - 1] > span * 0.5) n++;
    return n;
  };
  const saw = jumps(envOf(0x08));
  const tri = jumps(envOf(0x0a));
  assert.ok(saw > 5, `톱니가 주기마다 튀어야 한다 (튐 ${saw} 번)`);
  assert.ok(tri < saw / 3, `삼각은 이어져야 한다 (톱니 ${saw} · 삼각 ${tri})`);
});

test('프레임이 끊겨도 소리가 이어진다 (구멍이 아니라 유지)', async () => {
  // MSX 는 대개 같은 음을 계속 내고 있다. 프레임 하나가 안 왔다고 무음을
  // 넣으면 실제로 일어난 일보다 나쁘게 들린다.
  const { Klass } = await loadWorklet();
  const p = new Klass();
  const block = new Float32Array(128);
  const outputs = [[block]];
  const feed = () => p.port.onmessage({ data: { cmd: 'frame', regs: Uint8Array.from(toneA(254)) } });

  for (let i = 0; i < 4; i++) feed();
  for (let i = 0; i < 200; i++) p.process([], outputs);   // 큐를 다 쓴다

  // 이제 아무것도 안 먹이고 계속 뽑는다.
  const dry = new Float32Array(4410);
  for (let i = 0; i < dry.length; i += 128) {
    block.fill(0);
    p.process([], outputs);
    dry.set(block.subarray(0, Math.min(128, dry.length - i)), i);
  }
  assert.ok(rms(dry) > 0.05, '먹일 것이 없을 때 조용해지면 안 된다');
  assert.ok(Math.abs(freqOf(dry, 0) - CLK / (16 * 254)) / (CLK / (16 * 254)) < 0.05,
    '같은 음을 유지해야 한다');
});

test('오버샘플링이 모서리 지터를 실제로 줄인다', async () => {
  // tasks.md 가 적어 둔 문제다: 점 샘플링 사각파는 모서리가 샘플 경계로
  // 반올림돼 +-23 us 가 흔들리고, 높은 음일수록 거칠다. 줄었다고 말만 하지
  // 않고 잰다.
  //
  // 재는 법: 반주기가 샘플 12~13 개를 오가는 음(1776 Hz 근처)을 내고, 0 을
  // 지나는 간격의 표준편차를 본다. 흔들리지 않는다면 전부 같아야 한다.
  const { Klass } = await loadWorklet();
  const tp = Math.round(CLK / (16 * 1776));
  const buf = render(Klass, toneA(tp), 0.5).subarray(RATE / 10);

  const gaps = [];
  let last = -1, prev = buf[0];
  for (let i = 1; i < buf.length; i++) {
    if ((prev < 0) !== (buf[i] < 0)) {
      // 선형 보간으로 모서리가 샘플 사이 어디였는지 본다.
      const frac = Math.abs(prev) / (Math.abs(prev) + Math.abs(buf[i]));
      const at = i - 1 + frac;
      if (last >= 0) gaps.push(at - last);
      last = at;
    }
    prev = buf[i];
  }
  assert.ok(gaps.length > 500, '잴 만큼 모서리가 있어야 한다');
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  const jitterUs = sd / RATE * 1e6;
  // 점 샘플링이면 표준편차가 샘플 하나의 절반쯤(약 11 us)이다.
  assert.ok(jitterUs < 4,
    `모서리 지터 ${jitterUs.toFixed(1)} us - 점 샘플링(약 11 us)과 다를 바 없다`);
});

test('R13 을 같은 값으로 다시 써도 엔벨로프가 되살아난다', async () => {
  // **실기에서 걸린 자리다.** MSX 음악은 R13 에 같은 값(흔히 0x00)을 프레임마다
  // 다시 써서 엔벨로프를 재발동시킨다. 레지스터만 봐서는 "또 썼다" 와 "안 썼다"
  // 를 구별할 수 없어서, 카트리지가 쓰기를 세어 프레임의 flags bit0 으로
  // 알려 준다.
  //
  // 그 플래그를 안 쓰면 엔벨로프가 한 번 내려간 뒤 영영 0 에 머물고, 톤
  // 채널이 통째로 조용해진다 - 노이즈 효과음만 남는다. 이 시험이 없어서
  // 브라우저 신디사이저가 그 상태로 나갔다.
  const { Klass } = await loadWorklet();
  const r = new Array(14).fill(0);
  r[0] = 60; r[1] = 0;                  // 톤 A
  r[7] = 0x3e;                          // 톤 A 만 켜짐
  r[8] = 0x10;                          // 볼륨 대신 엔벨로프
  r[11] = 40; r[12] = 0;                // 짧은 엔벨로프
  r[13] = 0x00;                         // 한 번 내려가고 0 에 머무는 모양

  // 플래그 없이: 한 번 감쇠하고 조용해져야 한다 (고치기 전의 동작)
  const quiet = render(Klass, r, 1.0, { flags: 0 });
  const tail = rms(quiet.subarray(RATE / 2));

  // 플래그를 세워서 프레임마다 재발동: 계속 울려야 한다
  const alive = render(Klass, r, 1.0, { flags: 1 });
  const tailAlive = rms(alive.subarray(RATE / 2));

  assert.ok(tail < 0.01, `플래그가 없으면 조용해져야 한다 (실측 ${tail.toFixed(4)})`);
  assert.ok(tailAlive > 0.05,
    `플래그가 있으면 계속 울려야 한다 (실측 ${tailAlive.toFixed(4)})`);
});
