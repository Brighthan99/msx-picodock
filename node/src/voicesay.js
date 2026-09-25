// SPDX-License-Identifier: GPL-2.0-only
//
// voicesay.js — 문장 하나를 PSG 가 낼 수 있는 바이트로 바꾼다.
//
// 합성과 양자화는 voice.js 가 한다 (src/host/pd_voice.py 를 2026-09-25 에 옮긴
// 것). 여기는 그것을 한 번에 하나씩 부르고, 목소리 목록과 레벨표를 기억하는
// 일만 한다. 예전에는 파이썬을 자식 프로세스로 불러 stdout 으로 바이트를 받았다.
//
// 오래 걸린다
// ----------
// 한 문장에 `say` 가 0.5-2 초를 쓴다. 그동안 MSX 는 기다리고 있고, 디스크도
// 같은 파이프를 쓴다 - 그래서 **한 번에 하나만** 돌린다. 두 번째 부탁이 오면
// 첫 번째를 기다리지 않고 바로 거절한다. 줄을 세워 두면 사람이 ESC 를 눌러
// 포기한 문장이 나중에 갑자기 말해진다.

import * as V from './voice.js';

//: 말 한 마디에 줄 시간. `say` 는 보통 1 초 안쪽이고, piper 는 모델을 처음
//: 읽을 때 더 걸린다. 30 초를 넘겼으면 돌아오지 않는 것이다.
export const TIMEOUT_MS = 30000;

//: 받을 수 있는 최대. 11025 Hz 에서 1 MB 는 95 초다. 그보다 긴 말은 MSX 가
//: 인터럽트를 끈 채로 기다린다는 뜻이라, 받아 봐야 좋을 것이 없다.
export const MAX_BYTES = 1 << 20;

/**
 * 이 기계에서 실제로 합성하는 쪽. 시험은 이것 대신 가짜를 끼운다 - 진짜 `say`
 * 는 맥에만 있고, 있어도 시험이 소리를 내면 안 된다.
 */
export const LOCAL = {
  async synth(text, o) {
    const [samples, rate] = await V.synthesise(text, { engine: o.engine, lang: o.lang, voice: o.voice });
    const [data] = V.toPsg(samples, rate, { rateOut: o.rate, normalise: o.normalise,
                                            curve: o.curve || V.DEFAULT_CURVE });
    return data;
  },
  async voices(o) {
    return (await V.voicesFor(o.engine, o.lang)).map(([name, note]) => ({ name, note }));
  },
  async levels(o) { return V.levels(o.curve || V.DEFAULT_CURVE); },
};

/**
 * 진단용 파형: 0 에서 255 까지의 톱니를 되풀이한다.
 *
 * **PDVOICE /T 가 내는 것과 같은 파형이다.** /T 는 그 톱니를 레지스터에서
 * 세어 만들고 여기 것은 창으로 흘려보낸다 - 그 한 가지만 다르다. /T 는
 * 들리는데 이것이 안 들리면 스트리밍 루프가 파형을 망가뜨리는 것이고, 둘 다
 * 들리면 길은 멀쩡하고 말이 안 들리는 이유는 따로 있다.
 *
 * 전폭이라 실제 음성보다 10 dB 남짓 크다. 그것도 요점의 일부다: 음성이
 * 그냥 작아서 안 들리는 것인지가 이걸로 갈린다.
 */
export function ramp(rate = 11025, seconds = 1) {
  const n = Math.round(rate * seconds);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xFF;
  return out;
}

/**
 * 진단용 순음. **표가 맞는지를 귀로 가른다.**
 *
 * 호스트는 칩의 볼륨 눈금을 표로 들고 있다(pd_voice.py 의 VOL). 그 표가 실제
 * 칩과 다르면 코드에서 레벨로 가는 길이 휘고, 휜 길로 지나간 사인파는
 * 배음이 생겨 **갈대 소리처럼 쐐한** 음이 된다. 맞으면 맑은 음 하나다.
 *
 * 말로는 이것을 가릴 수 없다. 말은 원래 배음투성이라, 왜곡이 더해져도
 * "원래 그런가" 가 된다. 순음은 그 변명이 없다.
 *
 * 440 Hz 를 고른 이유는 귀가 가장 예민한 대역이고, 10473 Hz 로 나눠도
 * 주기가 24 샘플이라 양자화 자체로 거칠어지지 않기 때문이다.
 */
export function sine(rate = 11025, seconds = 1.5, hz = 440) {
  const n = Math.round(rate * seconds);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = Math.sin(2 * Math.PI * hz * i / rate);
    // 전폭에서 조금 물러선다. 표의 맨 위는 눈금이 성겨서, 거기까지 밀면
    // 곡선이 맞는지 보려는 시험이 그 성김을 보게 된다.
    out[i] = Math.max(0, Math.min(255, Math.round(128 + v * 120)));
  }
  return out;
}

export const DEFAULTS = {
  engine: 'auto',       // say / espeak-ng / piper / auto
  lang: 'en',
  voice: null,          // 엔진마다 다르다. piper 는 모델 파일 경로다.
  normalise: true,
  rate: 11025,
  //: 칩의 볼륨 사다리. **여기에 기본값을 두지 않는다** - null 이면 voice.js 의
  //: DEFAULT_CURVE 가 쓰인다. MSX 쪽 기본 표(psgvol_table.inc 의 PSGVOL_DEFAULT)
  //: 는 pd_voice.py 의 DEFAULT_CURVE 에서 만들어지고, 둘이 같은지는
  //: test/voice_crosscheck.py 가 본다. 여기 또 적으면 한 군데만 바뀌는 날이
  //: 오고, 어긋난 표는 뻗지 않고 그냥 쐐한 소리를 낸다.
  curve: null,
};

/** 시한 안에 끝나지 않으면 던진다. */
function within(ms, p, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
  })]).finally(() => clearTimeout(timer));
}

export class VoiceSay {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS };
    this.backend = opts.backend || LOCAL;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.busy = false;
    this.lastError = null;
    //: 엔진·언어별 목소리 목록. 한 번 물으면 기억한다.
    this._voices = new Map();
    this._asking = new Map();
    //: 곡선별 레벨표. 모니터가 바이트를 소리로 풀 때 쓴다.
    this._levels = new Map();
    //: 합성기 대신 진단용 파형을 보낸다. 'ramp' 는 PDVOICE /T 와 같은 톱니,
    //: 'sine' 은 순음 - 켜면 무슨 말을 하든 그것이 난다.
    this.tone = opts.tone || null;
  }

  /**
   * 이 엔진과 언어가 아는 목소리들.
   *
   * **한 번 묻고 기억한다.** `say -v ?` 는 프로세스를 띄우고 수백 밀리초를
   * 쓰는데, 화면은 상태를 갱신할 때마다 이것을 알고 싶어 한다.
   *
   * 못 물으면 빈 목록이다 - 오류가 아니다. piper 의 목소리는 디스크에 있는
   * 모델 파일이라 받은 사람만 어디 있는지 안다.
   */
  voices(opts = {}) {
    const o = { ...this.opts, ...opts };
    const key = `${o.engine}/${o.lang}`;
    if (this._voices.has(key)) return Promise.resolve(this._voices.get(key));
    if (this._asking.has(key)) return this._asking.get(key);
    const p = within(this.timeoutMs, Promise.resolve().then(() => this.backend.voices(o)), 'listing voices')
      .then((got) => (Array.isArray(got) ? got.filter((v) => v && String(v.name || '').trim()) : []),
            () => [])
      .then((out) => { this._voices.set(key, out); this._asking.delete(key); return out; });
    this._asking.set(key, p);
    return p;
  }

  /**
   * 이미 알고 있는 목록만. 모르면 물어보기 시작하고 빈 목록을 돌려준다.
   * **화면 상태는 기다리지 않는다.**
   */
  voicesCached(opts = {}) {
    const o = { ...this.opts, ...opts };
    const key = `${o.engine}/${o.lang}`;
    if (this._voices.has(key)) return this._voices.get(key);
    this.voices(o).catch(() => {});
    return [];
  }

  /**
   * 코드 256 개가 각각 어떤 레벨(-1..1)로 나는가. 곡선마다 한 번 묻는다.
   * 브라우저 모니터가 들려주는 소리는 MSX 가 받은 바이트를 decode_psg 로 푼
   * 것과 같아야 한다 - 그래서 사다리를 여기 또 적지 않고 voice.js 에 묻는다.
   * 못 물으면 null. 모니터는 그때 조용히 빠진다.
   */
  levels(opts = {}) {
    const o = { ...this.opts, ...opts };
    const key = String(o.curve || '');
    if (this._levels.has(key)) return Promise.resolve(this._levels.get(key));
    return Promise.resolve().then(() => this.backend.levels(o)).then((v) => {
      if (!v || v.length !== 256 || !Array.from(v).every(Number.isFinite)) return null;
      const got = Float32Array.from(v);
      this._levels.set(key, got);
      return got;
    }, () => null);
  }

  /** 서버가 UI 에서 바꿔 주는 것들. 모르는 열쇠는 무시한다. */
  set(o = {}) {
    for (const k of Object.keys(DEFAULTS)) {
      if (o[k] !== undefined) this.opts[k] = o[k];
    }
    return this.opts;
  }

  /**
   * 말 한 마디 -> PSG 바이트.
   *
   * 던지는 것들은 모두 사람이 읽을 수 있어야 한다. "합성기가 없다" 와
   * "그 목소리가 없다" 는 다른 일이고, 화면에 같은 말이 뜨면 고칠 수 없다.
   */
  async say(text, opts = {}) {
    const words = String(text ?? '').trim();
    if (!words) throw new Error('there is nothing to say');
    if (this.busy) throw new Error('still making the last sentence');

    if (this.tone) {
      const rate = (opts.rate ?? this.opts.rate) || DEFAULTS.rate;
      return this.tone === 'sine' ? sine(rate) : ramp(rate);
    }

    this.busy = true;
    this.lastError = null;
    try {
      const data = await within(this.timeoutMs,
        Promise.resolve().then(() => this.backend.synth(words, { ...this.opts, ...opts })), 'speech');
      // **빈 것은 성공이 아니다.** 목소리 이름이 그 언어에 없으면 say 가 0.02 초
      // 짜리 무음을 내놓은 적이 있다 - 아무 말도 안 나오는데 아무 데도 틀렸다는
      // 말이 없었다.
      if (!data || !data.length) throw new Error('the synthesiser produced nothing');
      if (data.length > MAX_BYTES)
        throw new Error(`that is ${Math.round(data.length / 11025)}s of speech - too long to play`);
      return Buffer.isBuffer(data) ? data : Buffer.from(data);
    } catch (e) {
      this.lastError = String(e && e.message || e);
      throw new Error(this.lastError);
    } finally {
      this.busy = false;
    }
  }
}
