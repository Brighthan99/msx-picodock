// SPDX-License-Identifier: GPL-2.0-only
//
// websearch.js — `CALL PDASK` 를 웹 검색으로 답한다.
//
// 검색은 search.js, 답의 모양은 askshape.js 가 한다. 둘 다 src/host/pd_ask.py
// 를 옮긴 것이다 (2026-09-25) - 예전에는 여기서 파이썬을 자식 프로세스로 불렀다.
// 이제 같은 프로세스에서 돈다. 검색은 네트워크를 기다리는 동안 이벤트 루프를
// 막지 않으므로 (fetch 는 비동기다) 그동안에도 섹터는 오간다.

import { search, SearchError, ENGINES } from './search.js';
import { shape } from './askshape.js';

export { ENGINES };

//: 검색 한 번에 이 이상 기다리지 않는다. 요청마다 15 초 시한이 있지만 auto 는
//: 엔진 셋을 차례로 시도하므로 합이 더 길어질 수 있다. MSX 는 답을 기다리며 멈춰
//: 있으니 영영 기다리게 두지 않는다.
export const SEARCH_TIMEOUT_MS = 40000;

/**
 * 한 질문에 한 답. 돌려주는 글은 **선에 나갈 바이트 그대로**다 (latin1 문자열,
 * 줄 끝은 CR LF). notes 는 앞의 엔진이 왜 안 됐는가.
 *
 * @returns {Promise<{text: string, source: string, notes: string[], cut: boolean}>}
 */
export async function webAnswer(query, { timeout = SEARCH_TIMEOUT_MS, engine = 'auto', limit,
                                         lang = 'en', count = 5, width = 40,
                                         charset = 'ascii', get } = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `the search took longer than ${Math.round(timeout / 1000)}s`)), timeout);
  });
  try {
    const got = await Promise.race([
      search(query, { engine, lang, count, ...(get ? { get } : {}) }), deadline]);
    const [data, cut] = shape(got.text, { limit, width, charset });
    if (!data.length) throw new Error('nothing came back');
    return { text: data.toString('latin1'), source: got.used, notes: got.notes, cut };
  } catch (e) {
    // 못 찾은 것과 시한을 넘긴 것은 다른 이야기다. 둘 다 MSX 에는 "답이 없다" 로
    // 가지만, 화면에는 어느 쪽인지 남아야 한다.
    if (e instanceof SearchError) throw new Error(e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
