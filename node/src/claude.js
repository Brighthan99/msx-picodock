// SPDX-License-Identifier: GPL-2.0-only
//
// claude.js — `CALL PDASK` 를 Claude 에게 묻는다.
//
// 키를 쥐고 버리는 일, 답의 모양을 잡는 일은 keyed.js 가 한다 (Gemini 와 같은
// 코드다). 여기 있는 것은 Anthropic SDK 를 부르는 세 자리뿐이다.

import { KeyedAnswerer, systemPrompt, shapeText, ANSWER_TIMEOUT_MS } from './keyed.js';

export { systemPrompt, shapeText, ANSWER_TIMEOUT_MS };

//: 묻는 모델.
export const MODEL = 'claude-opus-5';

//: 키가 가는 곳은 여기뿐이다. SDK 는 환경에 ANTHROPIC_BASE_URL 이 있으면
//: 그리로 보내는데, 누가 셸에 걸어 둔 프록시로 이 키가 새면 안 된다.
export const API = 'https://api.anthropic.com';

export class Claude extends KeyedAnswerer {
  static PACKAGE = '@anthropic-ai/sdk';
  label = 'Claude';

  constructor(opts = {}) { super({ model: MODEL, ...opts }); }

  _connect(key, sdk) {
    const { default: Anthropic } = sdk;
    return new Anthropic({
      apiKey: key,
      authToken: null,       // 환경의 ANTHROPIC_AUTH_TOKEN 이 같이 실려 가지 않게
      baseURL: API,          // 환경의 ANTHROPIC_BASE_URL 로 새지 않게
      timeout: this.timeout,
      maxRetries: 1,
      logLevel: 'off',       // ANTHROPIC_LOG=debug 가 요청을 찍지 않게
    });
  }

  _check(client) { return client.models.retrieve(this.model); }

  async _ask(client, query) {
    const res = await client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      // 짧은 질문에 짧은 답이다. 오래 생각할 거리가 아니고, 그동안 MSX 는
      // 답을 기다리며 서 있다.
      output_config: { effort: 'low' },
      // 안전 분류기가 거절하면 서버가 거절 종류에 맞는 다른 모델로 다시 묻는다.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(this.limit),
      messages: [{ role: 'user', content: query }],
    });
    const source = res.model || this.model;
    if (res.stop_reason === 'refusal') return { refused: true, source };
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, source };
  }

  /** SDK 의 오류를 사람이 읽을 한 줄로. 가장 좁은 것부터 본다. */
  _why(e) {
    const A = this._sdk?.default;
    if (!A) return String(e?.message || e);
    if (e instanceof A.AuthenticationError)
      return 'the key was refused (401) - check it in the Console';
    if (e instanceof A.PermissionDeniedError)
      return 'this key is not allowed to do that (403)';
    if (e instanceof A.NotFoundError)
      return `${this.model} is not available to this key (404)`;
    if (e instanceof A.RateLimitError)
      return 'rate limited (429) - try again shortly';
    if (e instanceof A.APIConnectionTimeoutError)
      return `Claude took longer than ${Math.round(this.timeout / 1000)}s`;
    if (e instanceof A.APIConnectionError)
      return 'could not reach api.anthropic.com';
    if (e instanceof A.APIError)
      return `Claude API error: ${String(e.message).slice(0, 200)}`;
    return String(e?.message || e);
  }
}
