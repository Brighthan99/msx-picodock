// SPDX-License-Identifier: GPL-2.0-only
//
// gemini.js — `CALL PDASK` 를 Gemini 에게 묻는다.
//
// 키를 쥐고 버리는 일, 답의 모양을 잡는 일은 keyed.js 가 한다 (Claude 와 같은
// 코드다). 여기 있는 것은 Google Gen AI SDK 를 부르는 세 자리뿐이다.

import { KeyedAnswerer, systemPrompt } from './keyed.js';

//: 묻는 모델. stable 중 가장 새 Flash 다 (2026-09 문서 기준).
export const MODEL = 'gemini-3.8-flash';

//: 키가 가는 곳은 여기뿐이다. SDK 는 환경에 GOOGLE_GEMINI_BASE_URL 이 있으면
//: 그리로 보낸다.
export const API = 'https://generativelanguage.googleapis.com/';

//: 답이 비어 있을 때, 이것이 끝난 이유면 모자란 것이 아니라 막힌 것이다.
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII',
                         'RECITATION', 'IMAGE_SAFETY']);

export class Gemini extends KeyedAnswerer {
  static PACKAGE = '@google/genai';
  label = 'Gemini';

  constructor(opts = {}) { super({ model: MODEL, ...opts }); }

  _connect(key, sdk) {
    const { GoogleGenAI } = sdk;
    return new GoogleGenAI({
      apiKey: key,
      // 환경에 GOOGLE_GENAI_USE_VERTEXAI 가 켜져 있으면 SDK 는 Vertex AI 로
      // 간다. 이 키가 갈 곳이 아니다.
      vertexai: false,
      httpOptions: {
        baseUrl: API,          // 환경의 GOOGLE_GEMINI_BASE_URL 로 새지 않게
        timeout: this.timeout,
        // 기본은 다섯 번, 사이사이 60 초까지 쉰다. 무료 한도(429)에 걸리면 그
        // 동안 MSX 가 몇 분을 서 있게 된다.
        retryOptions: { attempts: 2, maxDelay: 5 },
      },
    });
  }

  _check(client) { return client.models.get({ model: this.model }); }

  async _ask(client, query) {
    const res = await client.models.generateContent({
      model: this.model,
      contents: query,
      config: {
        systemInstruction: systemPrompt(this.limit),
        // 짧은 질문에 짧은 답이다. 이 모델은 MINIMAL 을 받지 않는다.
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    });
    const source = res.modelVersion || this.model;
    const cand = res.candidates?.[0];
    // 생각(thought) 조각은 답이 아니다.
    const text = (cand?.content?.parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text).join('');
    if (!text.trim() && (res.promptFeedback?.blockReason || BLOCKED.has(cand?.finishReason)))
      return { refused: true, source };
    return { text, source };
  }

  /** SDK 의 오류를 사람이 읽을 한 줄로. */
  _why(e) {
    const msg = String(e?.message || e);
    const ApiError = this._sdk?.ApiError;
    if (ApiError && e instanceof ApiError) {
      // 틀린 키에 401 이 아니라 400 이 온다. 이유는 본문에 적혀 온다.
      if (e.status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg))
        return 'the key was refused - check it in Google AI Studio';
      if (e.status === 401 || e.status === 403)
        return `this key is not allowed to do that (${e.status})`;
      if (e.status === 404) return `${this.model} is not available to this key (404)`;
      if (e.status === 429) return 'over the quota (429) - try again shortly';
      return `Gemini API error: ${msg.slice(0, 200)}`;
    }
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
      return `Gemini took longer than ${Math.round(this.timeout / 1000)}s`;
    if (e instanceof TypeError && /fetch failed/i.test(msg))
      return 'could not reach generativelanguage.googleapis.com';
    return msg;
  }
}
