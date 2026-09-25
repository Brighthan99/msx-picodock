// SPDX-License-Identifier: GPL-2.0-only
//
// ask.js — `CALL PDASK("...")`. MSX 가 호스트에게 묻고, 호스트가 답한다.
//
// src/host/pd_ask.py 의 **선 위 절반**만 옮긴 것이다. 파이썬 쪽 708 줄에는
// 구글 검색과 40 칼럼 줄바꿈과 문자셋 변환이 같이 들어 있는데, 그것은 정책이지
// 프로토콜이 아니다. 여기서는 답하는 쪽을 함수 하나로 받는다 (`answerer`) -
// 로컬 웹 UI 에서는 브라우저가 답할 테니, 그 자리를 비워 두는 편이 맞다.
//
// 상태: idle -> asking(답을 기다림) -> sending(청크/ACK) -> idle
//
// 파이썬은 검색을 스레드로 돌리고 inbox + lock 으로 결과를 받아 왔다. 시리얼
// 루프가 15 초짜리 웹 요청에 막히면 섹터 읽기가 멈추고, 멈춘 디스크는 MSX 가
// 포기해 버리기 때문이다. Node 는 원래 그렇게 돌므로 answerer 를 async 로
// 받으면 끝난다. 다만 **serial 번호는 그대로 가져왔다** - 늦게 돌아온 답이
// 그 사이 바뀐 새 질문에 답해 버리는 것을 막는 장치라, 언어와 무관하다.

import { CH_ASK } from './hub.js';
import { Claude } from './claude.js';
import { Gemini } from './gemini.js';
import { describeMsx } from './askshape.js';

// MSX -> 호스트
export const OP_REQ    = 0x01;   // LO HI 뒤에 그만큼의 질의 바이트
export const OP_INFO   = 0x02;   // LEN 뒤에 기계에 대한 바이트
export const OP_CANCEL = 0x03;   // 됐다 (Ctrl+STOP)
export const OP_SPEAK  = 0x04;   // LO HI 뒤에 그만큼의 바이트 - 소리내어 말해라
export const OP_ACK    = 0x06;   // 청크 다 썼다, 다음 것

// 호스트 -> MSX
export const OP_CHUNK  = 0x81;   // LEN 뒤에 그만큼의 답 바이트
export const OP_END    = 0x82;   // 여기까지다
//: "소리도 보냈다, 링을 틀어라". **짐작 대신 말해 준다.** MSX 가 링의 READY
//: 만 보고 판단했더니 지난번에 버려진 찌꺼기를 틀어 1 초짜리 잡음이 났다.
//: 버퍼에 든 것은 그것이 누구 것인지 말해 주지 않는다.
export const OP_SAY    = 0x83;
export const OP_ERR    = 0x8f;   // CODE, 답은 없다

export const ERR_OFF    = 1;     // 예약. 지금 어느 모드도 안 쓰지만 ROM 이
                                 // 해독하므로 번호는 잡아 둔다.
export const ERR_FAILED = 2;     // 답하는 쪽이 실패했다

//: 답을 어떻게 돌려줄 것인가. `voices.js` 의 REPLY_MODES 와 같은 이름이다.
export const REPLY_TEXT = 'text';
export const REPLY_VOICE = 'voice';
export const REPLY_BOTH = 'both';
export const ERR_BUSY   = 3;     // 앞 질문의 답이 아직 나가는 중이다

//: API 키가 있어야 답하는 쪽들. 모드 이름이자 AskService 의 필드 이름이다.
export const KEYED = ['claude', 'gemini'];

// 한 청크의 바이트. 메일박스 프레임 한도 256B 아래이고 RX 링 1KB 에는 한참
// 못 미치므로, ACK 가 늦어도 청크 하나가 링을 넘길 수 없다.
export const CHUNK = 128;

// 답을 자르는 자리. 설정이 아니다 - 검색 결과는 몇 쪽씩 나오고 40 칼럼 화면은
// 그 중 몇 줄을 보여줄 뿐이며, 그 너머의 128 바이트마다 MSX 가 ACK 해야 하는
// 왕복이 한 번씩 더 붙는다.
//
// 500 이었다가 250 으로 줄였다 (2026-09-24, 실기에서 "너무 길다"). 40 칼럼으로
// 접으면 예닐곱 줄, 소리로 내면 20 초 남짓이다. 500 은 그 두 배라 소리로 들으면
// 50 초였고, 그동안 MSX 는 인터럽트를 끈 채 붙잡혀 있다.
//
// **파이썬도 같은 값으로 자른다** (pd_ask.py LIMIT, 그리고 webAnswer 가 넘기는
// PD_ASK_LIMIT). 한쪽만 줄이면 파이썬이 단어 경계에서 "..." 로 예쁘게 자른
// 500 자를 여기서 250 바이트째에 단어 한가운데서 다시 자르게 된다.
export const LIMIT = 250;

// 이보다 긴 질문은 질문이 아니라 어긋남이다 - 버리고 다시 맞춘다.
export const MAX_QUERY = 1024;

// MSX 가 청크를 받았다고 말하기를 기다리는 시간. 넉넉하게 - 3.58MHz Z80 이
// 40 칼럼 화면에 찍고 있을 수도 있다.
export const ACK_TIMEOUT_MS = 20000;

/**
 * MSX -> 호스트 방향을 바이트 단위로 읽는다.
 *
 * 아는 opcode 가 아닌 바이트는 그 자리에서 버린다. 요청 도중에 끊긴 스트림이
 * 다음 요청에서 저절로 다시 맞는 것이 그 덕이다.
 */
export class RequestParser {
  constructor() { this.reset(); }

  reset() {
    this.state = 'op';
    this.want = 0;
    this.buf = [];
    //: 길이와 본문을 읽는 상태는 ASK 와 SPEAK 이 함께 쓴다. 무엇으로
    //: 시작했는지는 여기 남는다 - 안 그러면 PDVOICE 가 보낸 문장이
    //: 질문으로 들어가 화면에 답이 뜬다.
    this.op = OP_REQ;
  }

  _kind() { return this.op === OP_SPEAK ? 'speak' : 'ask'; }

  /** @returns {Array<{kind:string, value?:*}>} */
  feed(data) {
    const out = [];
    for (const b of data) {
      switch (this.state) {
        case 'op':
          if (b === OP_REQ) { this.op = OP_REQ; this.state = 'len_lo'; }
          else if (b === OP_SPEAK) { this.op = OP_SPEAK; this.state = 'len_lo'; }
          else if (b === OP_INFO) this.state = 'info_len';
          else if (b === OP_CANCEL) out.push({ kind: 'cancel' });
          else if (b === OP_ACK) out.push({ kind: 'ack' });
          // 그 밖에는 잡음이다. 건너뛴다.
          break;

        case 'info_len':
          this.want = b;
          this.buf = [];
          this.state = b ? 'info' : 'op';
          if (!b) out.push({ kind: 'info', value: Buffer.alloc(0) });
          break;

        case 'info':
          this.buf.push(b);
          if (this.buf.length >= this.want) {
            out.push({ kind: 'info', value: Buffer.from(this.buf) });
            this.state = 'op';
          }
          break;

        case 'len_lo':
          this.want = b;
          this.state = 'len_hi';
          break;

        case 'len_hi':
          this.want |= b << 8;
          this.buf = [];
          if (this.want === 0) { out.push({ kind: this._kind(), value: '' }); this.state = 'op'; }
          else if (this.want > MAX_QUERY) { out.push({ kind: 'garbled', value: this.want }); this.state = 'op'; }
          else this.state = 'body';
          break;

        case 'body':
          this.buf.push(b);
          if (this.buf.length >= this.want) {
            out.push({ kind: this._kind(), value: Buffer.from(this.buf).toString('latin1') });
            this.state = 'op';
          }
          break;
      }
    }
    return out;
  }
}

export const buildChunk = (p) => Buffer.concat([Buffer.from([OP_CHUNK, p.length]), Buffer.from(p)]);
export const buildEnd   = () => Buffer.from([OP_END]);
export const buildSay   = () => Buffer.from([OP_SAY]);
export const buildError = (code) => Buffer.from([OP_ERR, code]);

/**
 * 한 번에 한 질문.
 *
 * `answerer(question)` 는 문자열이나 `{text, source}` 를 돌려주는 async 함수다.
 * 던지면 MSX 에게 ERR_FAILED 가 간다. 아무도 주지 않으면 모든 질문은 답을
 * 기다리는 채로 남는다 - 사람이 UI 에서 `reply()` 를 부르는 수동 모드다.
 */
export class AskService {
  constructor(hub, opts = {}) {
    this.hub = hub;
    this.answerer = opts.answerer || null;
    // **기본은 검색이다.** 수동이 기본이던 때는 MSX 에서 CALL PDASK 를 치면
    // 아무 일도 안 일어난 것처럼 보였다 - 답은 맥 화면에서 누가 타이핑해 주기를
    // 기다리고 있었고, MSX 앞에 앉은 사람은 그것을 알 길이 없었다. 혼자 쓰는
    // 기계에서 "누가 답해 주기를 기다린다" 는 기본값이 될 수 없다.
    this.mode = opts.mode || 'google';
    this.limit = opts.limit ?? LIMIT;
    this.chunk = opts.chunk ?? CHUNK;
    //: 키가 있어야 답하는 쪽들. 묻는 쪽이자 **키를 쥐는 쪽**이다. 모드와
    //: 상관없이 늘 있어야 모드를 고르기 전에 키부터 넣을 수 있다.
    this.claude = opts.claude || new Claude({ limit: this.limit });
    this.gemini = opts.gemini || new Gemini({ limit: this.limit });

    //: 검색과 답의 모양. 파이썬 서버의 --ask-engine / --ask-lang / --ask-results /
    //: --ask-width / --ask-charset 이 여기로 온다. Claude·Gemini 의 답도 같은 폭과
    //: 문자 코드로 접는다 - 누가 답했느냐로 화면 모양이 달라지면 안 된다.
    this.search = { engine: 'auto', lang: 'en', count: 5, width: 40, charset: 'ascii',
                    ...(opts.search || {}) };
    for (const k of KEYED)
      this[k].shapeOpts = { width: this.search.width, charset: this.search.charset };

    //: 답을 글자로 보낼지, 소리로 보낼지, 둘 다인지.
    //: **`reply` 가 아니라 `replyMode` 다.** `reply()` 는 이 클래스의 메서드고,
    //: 같은 이름의 속성을 두면 인스턴스에서 메서드가 가려진다 - 아래 _deliver
    //: 의 주석에 적힌 `ask.answer is not a function` 과 똑같은 함정이다.
    this.replyMode = opts.reply || REPLY_TEXT;
    //: 서버가 건다. 없으면 소리 쪽은 통째로 아무 일도 안 한다.
    this.onSay = opts.onSay || null;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;

    this.parser = new RequestParser();
    this.state = 'idle';
    this.question = null;
    this.answer = null;
    this.askedAt = 0;
    this.msx = null;

    this._queue = [];
    this._awaitAck = false;
    this._deadline = 0;
    this._serial = 0;          // 질문 번호. 늦은 답이 새 질문에 답하지 못하게.
  }

  get waiting() { return this.state === 'asking'; }

  /**
   * 검색으로 답하는 기본 답변자.
   *
   * 모듈을 **부를 때** 불러온다: 시험은 `answerer` 를 주고 돌므로 여기까지
   * 오지 않고, 네트워크도 파이썬도 건드리지 않는다.
   */
  _web = async (query) => {
    const { webAnswer } = await import('./websearch.js');
    const got = await webAnswer(query, { limit: this.limit, ...this.search });
    // 앞의 엔진이 왜 안 됐는지. 뒤의 것이 답했을 때 그 까닭이 보여야 한다.
    for (const n of got.notes || []) this.hub.emit(CH_ASK, 'note', { text: n });
    return got;
  };

  status() {
    return { state: this.state, question: this.question, limit: this.limit,
             mode: this.mode, reply: this.replyMode,
             // 키는 싣지 않는다. 있다/없다와 모델 이름뿐이다.
             claude: this.claude.status(), gemini: this.gemini.status() };
  }

  /**
   * 누가 답할지 바꾼다. `google` 이면 검색이, `manual` 이면 사람이,
   * `claude` 나 `gemini` 면 그쪽이 답한다.
   *
   * **기다리고 있던 질문에도 적용된다.** 수동으로 두고 질문을 받은 뒤 마음이
   * 바뀌는 것이 보통의 순서다 - 그때 질문을 버리고 다시 치게 하는 것은 한 번
   * 더 시키는 일이다.
   */
  setMode(mode) {
    const m = ['manual', 'echo', ...KEYED].includes(mode) ? mode : 'google';
    if (m === this.mode) return this.mode;
    this.mode = m;
    this.hub.emit(CH_ASK, 'mode', { mode: m });
    if (m !== 'manual' && this.state === 'asking') this._dispatch();
    return m;
  }

  /** 지금 모드에서 실제로 답할 함수. 없으면 사람이 답한다는 뜻이다. */
  _answerFn() {
    if (this.mode === 'manual') return null;
    // echo: **보낸 것을 그대로 답으로 돌려준다.** 검색도 사람도 없다. 소리로
    // 답하게 해 두면 MSX 가 친 문장을 MSX 가 말하는 것이 된다 - PDASK 하나로
    // PDVOICE 가 하는 일을 하는 셈이다.
    if (this.mode === 'echo') return async (query) => ({ text: query, source: 'echo' });
    // 키가 없으면 던지고, 그것이 MSX 에게 ERR_FAILED 로 간다. 화면 로그에는
    // "키를 넣어라" 가 남는다.
    if (KEYED.includes(this.mode)) return this[this.mode].answer;
    return this.answerer || this._web;
  }

  /** 키를 쥐는 쪽 하나. 모르는 이름이면 던진다 - 조용히 Claude 로 가면 안 된다. */
  _keyed(who) {
    if (!KEYED.includes(who)) throw new Error(`unknown answerer ${who}`);
    return this[who];
  }

  /**
   * `who`(claude|gemini) 의 키를 받는다. **키는 이벤트에도 돌려주는 값에도
   * 싣지 않는다** - 로그에 남는 것은 "들어왔다/놓았다" 와 모델 이름뿐이다.
   * 틀린 키면 던진다.
   */
  async setApiKey(who, key) {
    const s = await this._keyed(who).setKey(key);
    this.hub.emit(CH_ASK, 'api_key', { who, set: true, model: s.model });
    return s;
  }

  forgetApiKey(who) {
    const k = this._keyed(who);
    if (k.forget()) this.hub.emit(CH_ASK, 'api_key', { who, set: false });
    return k.status();
  }

  // -- MSX 로부터 -------------------------------------------------------
  /** 카트리지의 메일박스 바이트 (프레임 0x30). */
  feed(payload) {
    for (const item of this.parser.feed(payload)) {
      if (item.kind === 'ask') this._begin(item.value);
      else if (item.kind === 'speak') this._speak(item.value);
      else if (item.kind === 'cancel') {
        if (this.state !== 'idle') this.hub.emit(CH_ASK, 'cancelled', { by: 'msx' });
        this._idle();
      }
      else if (item.kind === 'ack') this._awaitAck = false;
      else if (item.kind === 'info') {
        this.msx = item.value;
        // 이름은 여기서 붙인다 - PDINFO 가 이름을 싣고 다니면 말을 고칠 때마다
        // 디스크를 다시 만들어야 한다.
        this.hub.emit(CH_ASK, 'msx', { raw: item.value.toString('hex'),
                                       fields: describeMsx(item.value) });
      }
      else if (item.kind === 'garbled') {
        this.hub.emit(CH_ASK, 'garbled', { want: item.value });
      }
    }
  }

  /**
   * PDVOICE 가 보낸 문장. 질문이 아니라 **소리내어 말할 것**이다.
   *
   * 여기서 답을 만들지 않는다 - 대화 상태(this.state)도 건드리지 않는다.
   * 말하는 동안에도 CALL PDASK 는 물어볼 수 있어야 하고, 둘이 같은 상태를
   * 쓰면 한쪽이 다른 쪽을 취소시킨다.
   */
  _speak(raw) {
    const words = String(raw).trim();
    this.hub.emit(CH_ASK, 'speak', { text: words });
    if (!this.onSpeak) {
      // 서버가 음성을 안 걸어 두었다. MSX 는 링이 차기를 기다리고 있으므로
      // 잠자코 있으면 2 초 뒤 시한이 끝날 때까지 멈춰 있는다.
      this.sendError(ERR_FAILED);
      return;
    }
    Promise.resolve()
      .then(() => this.onSpeak(words))
      .catch((e) => {
        this.hub.emit(CH_ASK, 'speak_failed', { text: words, why: String(e && e.message || e) });
        this.sendError(ERR_FAILED);
      });
  }

  _begin(raw) {
    const query = String(raw).trim();
    this._serial += 1;
    this.question = query;
    this.answer = null;
    this.askedAt = Date.now();
    this._queue = [];
    this._awaitAck = false;
    this.state = 'asking';
    this.hub.emit(CH_ASK, 'question', { text: query });

    if (!query) { this.fail('empty question'); return; }

    if (this._answerFn()) this._dispatch();
  }

  _dispatch() {
    const serial = this._serial;
    const query = this.question;
    this.hub.emit(CH_ASK, 'answering', { text: query });

    Promise.resolve()
      .then(() => this._answerFn()(query))
      .then((res) => {
        const text = typeof res === 'string' ? res : (res?.text ?? '');
        this._deliver(serial, text, typeof res === 'object' ? res?.source : undefined);
      })
      .catch((e) => this.fail(e?.message || String(e), ERR_FAILED, serial));
  }

  // -- 사람이나 답하는 쪽으로부터 ---------------------------------------
  /**
   * 기다리고 있는 질문에 답한다. serial 을 주면 그 질문의 답일 때만 받는다.
   *
   * 이름이 `answer` 가 아닌 이유: `this.answer` 는 **보낸 답의 내용**을 담는
   * 필드다. 자바스크립트에서 인스턴스 필드는 프로토타입 메서드를 가리므로,
   * 둘에 같은 이름을 쓰면 생성자가 도는 순간 메서드가 사라진다. 실제로 그렇게
   * 짰다가 시험에서 `ask.answer is not a function` 으로 드러났다.
   */
  _deliver(serial, text, source = 'manual') {
    if (serial !== null && serial !== this._serial) return;   // 지나간 질문이다
    if (this.state !== 'asking') return;

    // **줄 끝은 CR LF 로 보낸다.** MSX 는 받은 바이트를 CHPUT 에 그대로 넘기고,
    // CHPUT 의 LF 는 커서를 한 줄 내릴 뿐 첫 칸으로 돌려놓지 않는다. LF 만
    // 보냈더니 둘째 줄이 첫 줄이 끝난 칸에서 시작해 계단처럼 밀려 찍혔다
    // (실기, 2026-09-24). 검색 답도 Claude·Gemini 답도 pd_ask.py 가 사람 보라고
    // 찍은 LF 판으로 여기 온다. 파이썬 서버는 encode() 가 CR LF 로 바꿔 보낸다.
    //
    // 한도는 그대로 맞는다: shape() 는 CR LF 로 센 바이트를 한도 안에 넣는다.
    let data = Buffer.from(String(text).replace(/\r\n|\r|\n/g, '\r\n'), 'latin1');
    const cut = data.length > this.limit;
    if (cut) data = data.subarray(0, this.limit);

    this.answer = data.toString('latin1');
    this.hub.emit(CH_ASK, 'answer', {
      text: this.answer, source, bytes: data.length, truncated: cut,
      took: Math.round((Date.now() - this.askedAt) / 100) / 10,
    });

    // 소리로도 보낸다면 여기서 건다. **글자보다 먼저** 걸어 두는 이유는
    // 합성이 1 초쯤 걸리기 때문이다 - 글자가 다 나간 뒤에 시작하면 사람이
    // 다 읽고 나서 소리가 난다.
    if (this.replyMode === REPLY_VOICE || this.replyMode === REPLY_BOTH)
      this._say(this.answer, 'answer');

    this._queue = [];
    if (this.replyMode !== REPLY_VOICE) {
      for (let i = 0; i < data.length; i += this.chunk)
        this._queue.push(buildChunk(data.subarray(i, i + this.chunk)));
    }
    // **소리가 있다고 말해 준다.** 없으면 MSX 는 링을 보고 짐작해야 하는데,
    // 링에는 지난 번 것이 남아 있을 수 있다.
    if (this.replyMode !== REPLY_TEXT) this._queue.push(buildSay());
    // 글자가 없어도 END 는 보낸다. 안 보내면 MSX 는 오지 않을 답을 기다린
    // 채로 남고 다음 질문을 못 한다.
    this._queue.push(buildEnd());
    this.state = 'sending';
  }

  /**
   * 소리로 내보낸다. 서버가 `onSay` 를 걸어 두었을 때만 일어난다.
   *
   * **실패해도 대화를 깨지 않는다.** 합성기가 없거나 앞의 말이 아직 나가는
   * 중일 수 있는데, 그렇다고 답을 못 받으면 사람이 잃는 것이 더 크다. 글자는
   * 이미 가고 있거나 곧 간다.
   */
  _say(text, what) {
    if (!this.onSay || !String(text || '').trim()) return;
    Promise.resolve()
      .then(() => this.onSay(String(text), what))
      .catch((e) => this.hub.emit(CH_ASK, 'say_failed',
                                  { what, why: String(e && e.message || e) }));
  }

  /**
   * 화면에서 바꾸는 것들. 모르는 열쇠는 무시하고, 아는 것만 받는다.
   *
   * reply 를 검사하는 이유: 오타 하나가 조용히 'text' 처럼 굴게 두면,
   * 소리를 켰는데 안 난다는 신고가 들어오고 원인은 화면 어디에도 없다.
   */
  setVoice(o = {}) {
    if (o.reply !== undefined) {
      if (![REPLY_TEXT, REPLY_VOICE, REPLY_BOTH].includes(o.reply))
        throw new Error(`unknown reply mode ${o.reply}`);
      this.replyMode = o.reply;
    }
    return { reply: this.replyMode };
  }

  /** 밖에서 부르는 이름. 지금 기다리는 질문에 답한다. */
  reply(text, source = 'manual') { this._deliver(null, text, source); }

  /**
   * "안 되겠다" 만 MSX 에게. 질문의 답과 달리 대화 상태를 만들지 않는다.
   *
   * 대화가 한창이면 끼어들지 않는다 - 질문의 답을 잘라먹는 쪽이 말 한 마디
   * 못 하는 쪽보다 나쁘고, PDVOICE 는 기다리다 스스로 포기한다.
   */
  sendError(code = ERR_FAILED) {
    if (this.state !== 'idle') return false;
    this._queue = [buildError(code)];
    this.state = 'sending';
    return true;
  }

  fail(why, code = ERR_FAILED, serial = null) {
    if (serial !== null && serial !== this._serial) return;
    if (this.state !== 'asking') return;
    this.hub.emit(CH_ASK, 'error', { text: why });
    this._queue = [buildError(code)];
    this.state = 'sending';
  }

  // -- 선 --------------------------------------------------------------
  /**
   * 시리얼 루프를 돌 때마다 부른다. `send(payload)` 가 메일박스 페이로드를
   * 선에 올린다. **절대 막지 않는다.**
   */
  pump(send) {
    if (this.state !== 'sending') return;

    if (this._awaitAck) {
      if (Date.now() > this._deadline) {
        this.hub.emit(CH_ASK, 'timeout', { afterMs: this.ackTimeoutMs });
        this._idle();
      }
      return;
    }
    if (!this._queue.length) { this._idle(); return; }

    const payload = this._queue.shift();
    send(payload);

    if (payload[0] === OP_CHUNK) {
      this._awaitAck = true;
      this._deadline = Date.now() + this.ackTimeoutMs;
      return;
    }
    if (payload[0] === OP_END) {
      this.hub.emit(CH_ASK, 'delivered', { chars: (this.answer || '').length });
      this._idle();
      return;
    }
    // **END 와 ERR 만 대화를 끝낸다.** 예전에는 청크가 아닌 것이면 무엇이든
    // 여기서 끝냈는데, 0x83(소리도 보냈다)이 생기자 그것을 보낸 자리에서
    // 끝나고 END 가 영영 안 나갔다 - MSX 는 오지 않을 답을 기다린다.
    if (payload[0] === OP_ERR) { this._idle(); return; }
  }

  /**
   * 카트리지가 오거나 갔다. 반쯤 보내던 것은 같이 갔고, 다음 질문은 새로 켠
   * MSX 에서 올 것이다.
   */
  linkReset() {
    this.parser.reset();
    if (this.state === 'sending')
      this.hub.emit(CH_ASK, 'note', { text: 'the link dropped mid-answer - abandoned it' });
    this._idle();
  }

  _idle() {
    this.state = 'idle';
    this.question = null;
    this._queue = [];
    this._awaitAck = false;
  }
}
