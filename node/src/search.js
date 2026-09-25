// SPDX-License-Identifier: GPL-2.0-only
//
// search.js — `CALL PDASK` 를 웹 검색으로 답한다.
//
// src/host/pd_ask.py 의 검색을 옮겼다 (2026-09-25). 엔진 셋과 그 순서, 결과를
// 읽는 정규식, 실패를 알아보는 문구가 전부 **실기에서 다듬은 것**이라 그대로다:
//
//   google     google.com 을 HTML 로 읽는다. 요즘은 JavaScript 벽을 세운다
//   ddg        DuckDuckGo 의 JavaScript 없는 창구. 결과를 주는 것은 이쪽이다
//   wikipedia  프로그램이 부르라고 내놓은 API. 긁는 쪽이 막혀도 답한다 - 바닥
//
// `auto` 는 셋을 차례로 해 보고, 앞의 것이 왜 안 됐는지 notes 에 남긴다. 키도
// 계정도 없다 - 카트리지를 막 꽂은 사람은 가입 양식이 아니라 답을 받아야 한다.
//
// 결과를 읽는 쪽이 파이썬과 같은지는 test/askshape_crosscheck.py 가 같은 HTML 을
// 양쪽에 먹여 본다. 그래서 가져오는 함수(`get`)를 바꿔 끼울 수 있다.

import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from './textdata.js';
import { pyStrip } from './fat.js';

export class SearchError extends Error {}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
//: 위키백과는 누구인지 밝히라고 하고, 브라우저 흉내를 원하지 않는다. 정직한 UA 가
//: 속도 제한을 안 받는 조건이고, 긁는 쪽이 막혀도 이쪽이 도는 까닭이다.
const WIKI_UA = 'PicoDock/1.0 (MSX disk server) node-fetch';

export const ENGINES = ['auto', 'google', 'ddg', 'wikipedia'];
export const REQUEST_TIMEOUT_S = 15;

/** urllib.parse.quote_plus: 글자·숫자·`_.-~` 만 두고, 공백은 `+`. */
export function quotePlus(s) {
  return Array.from(Buffer.from(String(s), 'utf8'), (b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
    if (b === 0x20) return '+';
    return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/** 한 번 가져온다. HTTP 오류와 연결 실패를 SearchError 하나로 말한다. */
export async function httpGet(url, { timeout = REQUEST_TIMEOUT_S, ua = CHROME_UA, lang = 'en' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': lang === 'en' ? `${lang}-US,${lang};q=0.9` : `${lang},${lang};q=0.9,en;q=0.8`,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    throw new SearchError(`${e.name}: ${e.message}`);
  }
  if (!res.ok) throw new SearchError(`HTTP ${res.status} from ${new URL(url).host}`);
  // decode("utf-8", "replace") - BOM 도 글자로 남긴다.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
}

// ------------------------------------------------------------ html.unescape

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function invalidCodepoint(n) {
  for (const [a, b] of INVALID_CODEPOINTS) if (n >= a && n <= b) return true;
  return false;
}

/**
 * 파이썬의 html.unescape: HTML5 의 이름 2231 개와 숫자 참조 규칙까지.
 * CPython Lib/html/__init__.py 를 옮겼다 (PSF-2.0 - NOTICE.md, LICENSES/Python-PSF-2.0.txt).
 */
export function unescapeHtml(s) {
  if (!s.includes('&')) return s;
  return s.replace(CHARREF, (_, ref) => {
    if (ref[0] === '#') {
      const body = ref.replace(/;+$/, '');
      const num = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(body.slice(2), 16)
                                                   : Number.parseInt(body.slice(1), 10);
      if (Object.hasOwn(INVALID_CHARREFS, String(num))) return INVALID_CHARREFS[String(num)];
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
      if (invalidCodepoint(num)) return '';
      return String.fromCodePoint(num);
    }
    if (Object.hasOwn(HTML5, ref)) return HTML5[ref];
    // 표준이 말하는 대로 가장 길게 맞는 이름을 찾는다 (끝의 ; 없는 옛 이름들).
    const c = Array.from(ref);
    for (let x = c.length - 1; x > 1; x--) {
      const head = c.slice(0, x).join('');
      if (Object.hasOwn(HTML5, head)) return HTML5[head] + c.slice(x).join('');
    }
    return `&${ref}`;
  });
}

//: 파이썬 re 의 \s (str 패턴) 와 같은 공백.
const PY_WS_RUN = /[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/** 태그 수프 -> 읽을 수 있는 한 줄. */
export function htmlText(fragment) {
  const bare = String(fragment).replace(/<[^>]+>/g, '');
  return pyStrip(unescapeHtml(bare).replace(PY_WS_RUN, ' '));
}

// ------------------------------------------------------------------ engines

const findAll = (re, s) => Array.from(s.matchAll(re), (m) => m[1]);

/**
 * google.com/search 를 HTML 로. 요즘은 JavaScript 벽이나 "브라우저를 바꿔라"
 * 로 답한다 (2026-08-02 측정: 어느 쪽이든 결과 0). 결과가 든 가벼운 HTML 이
 * 올 때 읽는 파서가 아래이고, 벽은 알아보고 말한다 - 조용히 빈손으로 오지 않는다.
 */
export async function googleScrape(query, lang, count, timeout, get = httpGet) {
  const url = `https://www.google.com/search?q=${quotePlus(query)}&num=${Math.max(count, 5)}&hl=${lang}`;
  const page = await get(url, { timeout, lang });
  const titles = findAll(/<(?:h3|div|span)[^>]*class="[^"]*(?:BNeawe vvjwJb|DKV0Md|LC20lb)[^"]*"[^>]*>(.*?)<\/(?:h3|div|span)>/gs, page);
  const snippets = findAll(/<(?:div|span)[^>]*class="[^"]*(?:BNeawe s3v9rd|VwiC3b|lyLwlc)[^"]*"[^>]*>(.*?)<\/(?:div|span)>/gs, page);
  const out = [];
  for (let i = 0; i < titles.length; i++) {
    const title = htmlText(titles[i]);
    if (!title) continue;
    out.push([title, i < snippets.length ? htmlText(snippets[i]) : '']);
    if (out.length >= count) break;
  }
  if (out.length) return out;
  if (page.includes('enablejs') || page.includes('/httpservice/retry'))
    throw new SearchError('google served its JavaScript wall (no results in the HTML)');
  if (page.includes("isn't supported any more") || page.includes('not supported any more'))
    throw new SearchError('google refused the request as an unsupported browser');
  if (page.includes('unusual traffic') || page.includes('/sorry/'))
    throw new SearchError('google is showing a captcha for this address');
  throw new SearchError('google returned a page with no results in it');
}

/** DuckDuckGo 의 JavaScript 없는 창구 - 평범한 GET 에 결과를 주는 곳. */
export async function ddg(query, lang, count, timeout, get = httpGet) {
  const url = `https://html.duckduckgo.com/html/?q=${quotePlus(query)}`;
  const page = await get(url, { timeout, lang });
  const titles = findAll(/class="result__a"[^>]*>(.*?)<\/a>/gs, page);
  const snippets = findAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs, page);
  const out = [];
  titles.slice(0, count).forEach((t, i) => {
    const title = htmlText(t);
    if (title) out.push([title, i < snippets.length ? htmlText(snippets[i]) : '']);
  });
  if (!out.length) {
    if (page.includes('anomaly') || page.toLowerCase().includes('captcha'))
      throw new SearchError('duckduckgo is asking for a captcha');
    throw new SearchError('no results');
  }
  return out;
}

/**
 * 위키백과의 검색 API. **페이지가 아니라 API 다.** 막히지 않는 대신 백과사전만
 * 안다 - 날씨도 값도 뉴스도 없다. 그래서 auto 의 맨 끝이다.
 */
export async function wikipedia(query, lang, count, timeout, get = httpGet) {
  const url = `https://${lang || 'en'}.wikipedia.org/w/api.php?action=query&list=search`
    + `&srsearch=${quotePlus(query)}&format=json&srlimit=${Math.max(1, count)}`;
  const page = await get(url, { timeout, ua: WIKI_UA, lang });
  let hits;
  try {
    const doc = JSON.parse(page);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError('AttributeError');
    const q = doc.query ?? {};
    if (q === null || typeof q !== 'object' || Array.isArray(q)) throw new TypeError('AttributeError');
    hits = q.search ?? [];
  } catch (e) {
    throw new SearchError(`wikipedia did not answer (${e instanceof SyntaxError ? 'JSONDecodeError' : 'AttributeError'})`);
  }
  const out = [];
  for (const h of hits.slice(0, count)) {
    const title = htmlText(h.title ?? '');
    // snippet 은 맞은 낱말을 <span class="searchmatch"> 로 두른다. 태그를 벗기고
    // 엔티티를 풀면 된다.
    const snippet = htmlText(h.snippet ?? '');
    if (title) out.push([title, snippet]);
  }
  if (!out.length) throw new SearchError('nothing on wikipedia for that');
  return out;
}

/** 검색 결과 -> MSX 가 찍을 글. 번호, 제목, 그 아래 요약 - 중간에 잘려도 버틴다. */
export function formatResults(results) {
  const out = [];
  results.forEach(([title, snippet], i) => {
    out.push(`${i + 1}. ${title}`);
    if (snippet) out.push(`   ${snippet}`);
  });
  return out.join('\n');
}

const FNS = { google: googleScrape, ddg, wikipedia };

/**
 * 검색 한 번. {text, used, notes}. `auto` 는 google, ddg, wikipedia 순이고, 앞의
 * 것이 실패한 까닭은 notes 에 남는다 - 뒤의 것이 답했을 때 왜인지 보이게.
 */
export async function search(query, { engine = 'auto', lang = 'en', count = 5,
                                      timeout = REQUEST_TIMEOUT_S, get = httpGet } = {}) {
  if (engine !== 'auto') {
    const fn = FNS[engine];
    if (!fn) throw new SearchError(`unknown engine ${engine}`);
    return { text: formatResults(await fn(query, lang, count, timeout, get)), used: engine, notes: [] };
  }
  const notes = [];
  for (const name of ['google', 'ddg', 'wikipedia']) {
    try {
      return { text: formatResults(await FNS[name](query, lang, count, timeout, get)), used: name, notes };
    } catch (e) {
      if (!(e instanceof SearchError)) throw e;
      notes.push(`${name}: ${e.message}`);
    }
  }
  throw new SearchError(notes.join('; '));
}
