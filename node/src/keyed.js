// SPDX-License-Identifier: GPL-2.0-only
//
// keyed.js — API 키가 있어야 답하는 쪽들(Claude, Gemini)이 함께 쓰는 뼈대.
//
// **키는 이 프로세스의 메모리에만 있다.** 파일에도, 로그에도, 스냅샷에도,
// 브라우저의 localStorage 에도 가지 않는다. 서버를 끄면 사라지고, 다시 켜면
// 다시 넣어야 한다 - 그것이 요구였다 ("절대로 저장하지 않도록").
//
// 그래서 키를 담는 곳은 이 클래스의 private 필드 하나다. 이 객체를 JSON 으로
// 찍든 console.log 로 찍든 나오는 것은 "키가 있다/없다" 뿐이다 - toJSON 과
// inspect.custom 이 그렇게 말한다. SDK 클라이언트도 키를 공개 속성으로 들고
// 있으므로 같은 private 필드 뒤에 둔다.
//
// **한 벌만 둔다.** 키를 다루는 코드를 회사마다 따로 두면, 한쪽에서 막은 구멍이
// 다른 쪽에는 열려 있게 된다. 여기서 갈라지는 것은 SDK 를 부르는 세 자리뿐이다:
// 클라이언트를 만들고(_connect), 키를 한 번 써 보고(_check), 묻는다(_ask).
//
// 답의 모양(40 칼럼, ASCII, 250 바이트)은 다시 짜지 않는다. 검색 답과 같은
// shape() 를 쓴다 (askshape.js - pd_ask.py 를 옮긴 것).

import { inspect } from 'node:util';
import { shape } from './askshape.js';

//: 한 번 묻는 데 이 이상 기다리지 않는다 (재시도 한 번까지 합쳐 1 분). 넘기면
//: MSX 에게 실패를 보낸다 - 가만 두면 MSX 앞의 사람은 ESC 말고는 알 길이 없다.
export const ANSWER_TIMEOUT_MS = 30000;

/**
 * 답하는 쪽에게 주는 한 단락. Claude 와 Gemini 가 같은 것을 받는다 - 같은
 * 질문에 두 답을 견주어 볼 수 있어야 한다.
 *
 * 글자 수를 한도보다 적게 부르는 이유: 한도는 선 위의 바이트다. 40 칼럼으로
 * 접으면 줄마다 CR LF 가 붙어서, 한도만큼 쓴 답은 끝에서 잘린다.
 */
export function systemPrompt(limit) {
  const size = limit > 0 ? `at most ${Math.floor(limit * 0.8)} characters`
                         : 'a few sentences';
  return 'You are answering a question typed on an MSX, an 8-bit home computer '
    + 'from the 1980s. Your reply is printed on its 40-column text screen and '
    + `may also be read aloud, so answer in plain English sentences, ${size}. `
    + 'The screen shows ASCII only - no markdown, lists, emoji or accented '
    + 'letters. Answer directly; if you do not know, say so briefly.';
}

/** 오류 문구에 키가 섞여 들어왔으면 지운다. 들어올 일은 없어야 하지만. */
export function scrub(text, key) {
  const s = String(text ?? '');
  return key ? s.split(key).join('***') : s;
}

/**
 * 검색 답과 같은 자리에서 자른다. 돌려주는 것은 **선에 나갈 바이트 그대로**다
 * (latin1 문자열, 줄 끝은 CR LF) - pd_ask.py 가 MSX 에 보내던 것과 같다.
 */
export function shapeText(text, limit, { width = 40, charset = 'ascii' } = {}) {
  const [data] = shape(text, { limit, width, charset });
  if (!data.length) throw new Error('the answer came out empty');
  return data.toString('latin1');
}

/**
 * 키를 쥐고 묻는 쪽. 하위 클래스가 채우는 것:
 *
 *   static PACKAGE        SDK 의 npm 이름 (없으면 설치하라고 말한다)
 *   label                 화면과 오류 문구에 쓰는 이름
 *   _connect(key, sdk)    SDK 클라이언트를 만든다
 *   _check(client)        키를 한 번 써 본다 - 돈이 안 드는 호출로
 *   _ask(client, query)   묻는다. {text, source, refused?} 를 돌려준다
 *   _why(e)               SDK 의 오류를 한 줄로
 */
export class KeyedAnswerer {
  #key = '';
  #client = null;

  /**
   * @param {object} o
   * @param {number} o.limit     답의 한도 (선 위의 바이트). ask.js 가 준다.
   * @param {string} o.model     묻는 모델
   * @param {object} [o.sdk]     시험이 가짜를 준다. 없으면 진짜 SDK 를 불러온다.
   * @param {Function} [o.shape] 시험이 준다. 없으면 shapeText (검색 답과 같은 모양).
   */
  constructor({ limit, model, sdk = null, shape = null,
                timeout = ANSWER_TIMEOUT_MS } = {}) {
    this.limit = limit;
    this.model = model;
    this.timeout = timeout;
    this._sdk = sdk;
    //: 줄 폭과 문자 코드. AskService 가 검색 답과 같은 값을 넣어 준다.
    this.shapeOpts = {};
    this._shape = shape || ((text) => shapeText(text, this.limit, this.shapeOpts));
  }

  get hasKey() { return this.#client !== null; }

  /** 밖에 보여 주는 전부. 키는 있다/없다로만. */
  status() { return { key: this.hasKey, model: this.model }; }
  toJSON() { return this.status(); }
  [inspect.custom]() {
    return `${this.constructor.name} { model: ${this.model}, key: ${this.hasKey ? 'set' : 'none'} }`;
  }

  /**
   * 키를 받는다. **받기 전에 한 번 써 본다** - 모델 정보를 묻는 것은 돈이 들지
   * 않고, 틀린 키를 MSX 에서 질문할 때에야 알게 되는 것보다 여기서 아는 편이
   * 낫다. 안 되면 쥐지 않는다.
   */
  async setKey(raw) {
    const key = String(raw ?? '').trim();
    if (!key) throw new Error('no key was given');
    // 붙여 넣다 딸려 온 것. 공백이 든 키는 없고, 이렇게 긴 키도 없다.
    if (/\s/.test(key) || key.length > 400)
      throw new Error('that does not look like an API key');
    const client = this._connect(key, await this.#load());
    try {
      await this._check(client);
    } catch (e) {
      throw new Error(scrub(this._why(e), key));
    }
    this.#key = key;
    this.#client = client;
    return this.status();
  }

  /** 쥐고 있던 키를 놓는다. 놓은 것이 있었는지를 돌려준다. */
  forget() {
    const had = this.hasKey;
    this.#key = '';
    this.#client = null;
    return had;
  }

  /** 질문 하나에 답 하나. ask.js 의 answerer 모양이다. */
  answer = async (query) => {
    const client = this.#client;
    const key = this.#key;
    if (!client) throw new Error(`${this.label} has no API key - enter one in the Ask pane`);
    let out;
    try {
      out = await this._ask(client, query);
    } catch (e) {
      throw new Error(scrub(this._why(e), key));
    }
    // 거절도 답이다. 실패로 보내면 MSX 에는 "code 02" 만 뜨고 왜인지 모른다.
    if (out.refused) return { text: `${this.label} would not answer that.`, source: out.source };
    const text = String(out.text || '').trim();
    if (!text) throw new Error(`${this.label} sent back no text`);
    return { text: await this._shape(text), source: out.source };
  };

  async #load() {
    if (this._sdk) return this._sdk;
    const pkg = this.constructor.PACKAGE;
    try {
      this._sdk = await import(pkg);
    } catch {
      throw new Error(`the ${this.label} SDK (${pkg}) is not installed - run npm install in node/`);
    }
    return this._sdk;
  }
}
