// SPDX-License-Identifier: GPL-2.0-only
//
// voicesession.js — 말 한 마디의 처음부터 끝까지.
//
//   PDVOICE 가 문장을 보낸다  ->  합성(voicesay)  ->  링으로 흘리기(voicestream)
//                                                 ->  MSX 가 PSG 로 뿜는다
//
// 세 조각을 잇는 것 말고 이 파일이 하는 일이 하나 더 있다: **MSX 가 실제로
// 몇 Hz 로 재생하는지 재는 것.**
//
// 왜 재야 하는가
// -------------
// 재생 속도는 Z80 의 루프 길이로 정해지는 것처럼 보이지만 아니다. VDP 가
// 주기적으로 버스를 가져가서, Z80 은 명목 클럭의 아홉 할쯤만 쓴다. 그 비율은
// 기계마다 다르고 화면 모드에 따라서도 다르다. 그래서 MSX 쪽에서 상수로 맞출
// 수가 없다 - 맞췄다 해도 다른 기계에서는 틀린다.
//
// 그런데 카트리지가 10 ms 마다 "몇 개 나갔다"(`played`)를 말해 준다. 그것을
// 두 번 보면 속도가 나온다. **호스트가 재서 다음 문장을 그 속도로 합성한다.**
// 첫 문장은 11025 Hz 로 어림잡고 나가므로 조금 느리거나 빠른 목소리가 되고,
// 두 번째부터는 맞는다.

import { CH_ASK } from './hub.js';
import { VoiceSay } from './voicesay.js';
import { VoiceStream, VOICE_STAT } from './voicestream.js';

//: 첫 문장을 합성할 때 쓰는 어림. pdvoice.s 의 기본 여백이 노리는 값이다.
export const ASSUMED_RATE = 11025;

//: 잰 값을 믿기 전에 필요한 것. 짧게 재면 USB 가 몰아 보낸 한 순간이 그대로
//: 속도가 되어, 다음 문장이 엉뚱한 속도로 합성된다.
export const MIN_SPAN_MS = 400;
export const MIN_SPAN_SAMPLES = 3000;

//: 잰 값이 이 범위 밖이면 버린다. 8 비트 PSG DAC 를 이보다 느리게 돌리면
//: 말이 아니고, 이보다 빠르면 Z80 이 낼 수 있는 속도가 아니다 - 그런 수가
//: 나왔다면 잰 것이 틀린 것이지 기계가 그런 것이 아니다.
//: 아무도 안 들으면 얼마 만에 그만두나.
//:
//: **이것이 없으면 세션이 영영 막힌다.** MSX 쪽에 재생기가 없는 도구로
//: 물으면(PDASK 가 한동안 그랬다) 호스트는 링 하나를 채우고 자리가 나기를
//: 기다린다. 자리는 영영 안 나고, 그 뒤 모든 말이 "아직 앞의 말을 하는 중"
//: 으로 거절된다. 실기에서 sent 4096 / played 0 으로 굳은 채 발견됐다.
//:
//: 10 초인 이유: 링은 0.37 초어치다. 사람이 명령을 치고 재생이 시작되기까지
//: 걸리는 시간은 넉넉히 잡아도 그 안이고, 10 초 동안 한 바이트도 안 나갔으면
//: 듣는 사람이 없는 것이다.
export const STALL_MS = 10000;

export const RATE_MIN = 4000;
export const RATE_MAX = 30000;

/**
 * PSG 바이트를 16 비트 PCM 으로 푼다. `levels` 는 코드마다의 -1..1 레벨이다.
 *
 * 레벨표는 가운데가 0 이 아니다 - 칩의 사다리가 대칭이 아니어서 무음(128)이
 * 조금 비껴 앉는다. 그대로 두면 스피커가 한쪽으로 밀린 채 말하고, 앞뒤에서
 * 딸깍 한다. 그래서 바이트 128 의 레벨을 0 으로 옮긴다.
 */
export function toPcm(bytes, levels) {
  const zero = levels[128];
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const v = Math.max(-1, Math.min(1, levels[bytes[i]] - zero));
    out[i] = Math.round(v * 32767);
  }
  return out;
}

export class VoiceSession {
  constructor(hub, opts = {}) {
    this.hub = hub;
    this.say = opts.say || new VoiceSay();
    this.stream = opts.stream || new VoiceStream(hub);
    this.now = opts.now || (() => Date.now());

    //: 꺼져 있으면 PDVOICE 가 말을 걸어도 거절한다. 서버 설정에서 켠다.
    this.enabled = opts.enabled ?? true;

    //: 다음 문장을 합성할 속도. 재고 나면 바뀐다.
    this.rate = opts.rate || ASSUMED_RATE;
    this.measured = null;      // 잰 적이 있으면 그 값
    this._first = null;        // [시각, played] - 처음 소리가 난 순간
    this._last = null;
    this._moved = 0;           // played 가 마지막으로 오른 시각
    this._seen = 0;            // 그때의 played

    //: 브라우저 모니터. 서버가 건다: (pcm Int16Array, rate) / ()
    this.onMonitor = opts.onMonitor || null;
    this.onMonitorStop = opts.onMonitorStop || null;
    this._pending = null;      // 아직 MSX 가 안 틀기 시작한 발화
    this._monitoring = false;  // 모니터를 이미 내보냈나
  }

  get speaking() { return this.stream.busy; }

  /**
   * 말해라. `send(buffer)` 로 카트리지에 내보낸다.
   *
   * 실패는 던진다. 부르는 쪽이 MSX 에게 거절을 보내야 하는데, 조용히 실패하면
   * MSX 는 링이 차기를 영영 기다린다.
   */
  async speak(text, send, opts = {}) {
    if (!this.enabled) throw new Error('voice is switched off on the host');
    if (this.stream.busy) {
      // **답은 끼어든다, echo 는 안 끼어든다.**
      //
      // echo 가 아직 질문을 읽는 중인데 답이 왔다면, 듣고 싶은 쪽은 답이다.
      // 거절하면 물어본 사람이 답을 못 듣는데, 그건 질문을 끝까지 못 듣는
      // 것보다 크게 잃는 일이다. 반대로 말이 나가는 중에 echo 가 끼어들면
      // 그냥 방해다.
      //
      // 줄을 세우지 않는 이유는 따로다: 세워 두면 사람이 그만둔 뒤에 갑자기
      // 말이 나온다(voicesay.js).
      if (!opts.interrupt) throw new Error('still saying the last one');
      this.stop(send);
    }

    this.hub.emit(CH_ASK, 'voice_ask', { text: String(text), rate: this.rate });
    const data = await this.say.say(text, { rate: this.rate });

    // 모니터 거리를 미리 챙겨 둔다. **보내는 것은 MSX 가 실제로 틀기 시작할
    // 때다** - 합성이 끝난 지금 보내면 브라우저가 MSX 보다 먼저 말하고, MSX 가
    // 아예 안 틀면 브라우저만 말한다. 레벨표는 지금 물어야 그때 기다리지 않는다.
    this._pending = null;
    this._monitoring = false;
    if (this.onMonitor) {
      const levels = await this.say.levels?.().catch(() => null);
      if (levels) this._pending = { data, rate: this.rate, levels };
    }

    this._first = this._last = null;
    this._moved = this.now();
    this._seen = 0;
    this.stream.say(data, send);
    return data.length;
  }

  /** 그만. 카트리지의 링도 비운다. */
  stop(send) {
    this._pending = null;
    if (this._monitoring && this.onMonitorStop) this.onMonitorStop();
    this._monitoring = false;
    this.stream.stop(send);
    this._first = this._last = null;
    this._moved = 0;
  }

  /** 카트리지의 상태 프레임. 흐름 제어와 속도 측정이 둘 다 여기서 온다. */
  onStatus(payload, send) {
    const st = VoiceStream.parseStatus(payload);
    if (!st) return null;
    this.stream.onStatus(st.room, st.played, st.flags);
    if (st.played > this._seen) { this._seen = st.played; this._moved = this.now(); }

    // MSX 가 첫 샘플을 가져갔다 - 이제 브라우저도 말한다. 10 ms 마다 오는
    // 상태라 둘은 그 안쪽으로 맞는다.
    if (this._pending && st.played > 0) {
      const { data, rate, levels } = this._pending;
      this._pending = null;
      this._monitoring = true;
      try { this.onMonitor(toPcm(data, levels), rate); } catch { /* 화면 일이다 */ }
    }
    this._measure(st.played);
    this.stream.pump(send);
    return st;
  }

  /** 보낼 것이 남았으면 보낸다. 타이머에서 자주 불러도 된다. */
  pump(send) {
    // **듣는 사람이 없으면 그만둔다.** 여기서 놓아주지 않으면 한 번 막힌
    // 세션이 서버가 다시 뜰 때까지 모든 말을 거절한다.
    if (this.stream.busy && this._moved
        && this.now() - this._moved > STALL_MS) {
      const played = this.stream.status().played;
      // 상태 프레임을 한 번도 못 들었으면 링이 거기 없는 것이다 - 옛 펌웨어이거나
      // 카트리지가 스트리밍을 모른다. 그 말을 해 주지 않으면 "소리가 안 난다" 만
      // 남는다.
      const why = this.stream.heard ? 'nobody was listening'
        : 'the cartridge never reported a ring - this firmware is too old for '
          + 'speech; reflash it';
      this.stop(send);
      this.hub.emit(CH_ASK, 'voice_abandoned', { played, afterMs: STALL_MS, why });
      return 0;
    }
    return this.stream.pump(send);
  }

  /**
   * 재생 속도를 잰다.
   *
   * **소리가 나기 시작한 뒤부터 센다.** MSX 가 `CALL` 을 친 사람을 기다리는
   * 동안에도 상태는 오는데, 그때 played 는 0 에 머물러 있다. 0 에서 재기
   * 시작하면 기다린 시간이 통째로 "느린 재생" 으로 들어간다.
   */
  _measure(played) {
    if (played <= 0) return;
    const t = this.now();
    if (!this._first) { this._first = [t, played]; this._last = [t, played]; return; }

    // **말이 끝난 뒤의 시간은 세지 않는다.**
    //
    // 상태 프레임은 재생이 끝난 뒤에도 몇 번 더 온다. 그때 played 는 멈춰
    // 있고 시계만 가므로, 그것까지 넣으면 "같은 개수를 더 긴 시간에" 가 되어
    // 속도가 낮게 나온다. 실기에서 10429 로 잰 것이 다음 발화에서 10045 로
    // 굳었다 - 3.7% 낮다.
    //
    // 그리고 낮게 재면 다음 문장을 그만큼 낮은 속도로 합성하고, MSX 는 원래
    // 속도로 재생하므로 **목소리가 그만큼 높아진다.** 듣는 사람에게는
    // "너무 하이톤" 으로 나타난다.
    if (played <= this._last[1]) return;
    this._last = [t, played];

    const ms = t - this._first[0];
    const n = played - this._first[1];
    if (ms < MIN_SPAN_MS || n < MIN_SPAN_SAMPLES) return;

    const rate = Math.round(n * 1000 / ms);
    if (rate < RATE_MIN || rate > RATE_MAX) return;

    const was = this.measured;
    this.measured = rate;
    this.rate = rate;
    // 처음 잰 값과, 10% 넘게 달라진 값만 말한다. 매 프레임 말하면 로그가
    // 이것만으로 찬다.
    if (was === null || Math.abs(rate - was) > was * 0.1) {
      this.hub.emit(CH_ASK, 'voice_rate', { hz: rate, assumed: ASSUMED_RATE });
    }
  }

  /** 화면이 그릴 "지금 어떤가". */
  status() {
    return {
      enabled: this.enabled,
      rate: this.rate,
      measured: this.measured,
      busy: this.say.busy,
      lastError: this.say.lastError,
      ...this.stream.status(),
    };
  }
}

export { VOICE_STAT };
