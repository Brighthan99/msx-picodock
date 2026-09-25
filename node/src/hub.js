// SPDX-License-Identifier: GPL-2.0-only
//
// hub.js — 서버가 할 말을 전부 모으는 곳. src/host/pd_hub.py 와 같은 규칙이다.
//
//   * **문장이 아니라 필드를 낸다.** emit('io','read',{lba:1234,count:8}) 은
//     텍스트로도, 표의 한 줄로도, 그래프로도 그릴 수 있다. 미리 만든 문자열은
//     영영 텍스트일 뿐이고, 그러면 브라우저는 더 나쁜 터미널이 된다.
//   * **채널마다 스크롤백을 둔다.** 늦게 붙은 화면도 지난 일을 받아야 하고,
//     섹터 트래픽이 정작 중요한 한 줄을 밀어내면 안 된다.

export const CH_LINK = 'link';
export const CH_DISK = 'disk';
export const CH_IO = 'io';
export const CH_PRINT = 'print';
export const CH_ASK = 'ask';

const SCROLLBACK = { link: 200, disk: 200, io: 2000, print: 500, ask: 200 };

export class Hub {
  constructor() {
    this.history = new Map(Object.keys(SCROLLBACK).map((c) => [c, []]));
    this.subs = new Set();
    this.seq = 0;
  }

  emit(channel, event, fields = {}) {
    const ev = { ...fields, seq: ++this.seq, t: Date.now() / 1000, ch: channel, ev: event };
    const ring = this.history.get(channel);
    if (ring) {
      ring.push(ev);
      if (ring.length > SCROLLBACK[channel]) ring.shift();
    }
    for (const fn of [...this.subs]) {
      // 화면 하나가 깨져도 서버가 죽으면 안 된다. MSX 가 섹터를 쓰는 중일 수
      // 있고, 여기서 예외가 새면 반쯤 쓰인 섹터가 남는다.
      try { fn(ev); } catch { /* 무시 */ }
    }
    return ev;
  }

  subscribe(fn, { backfill = false } = {}) {
    if (backfill) for (const ev of this.since(0)) { try { fn(ev); } catch {} }
    this.subs.add(fn);
    return fn;
  }

  unsubscribe(fn) { this.subs.delete(fn); }

  /** seq 이후의 이벤트를 시간순으로. 브라우저가 다시 붙을 때 쓴다. */
  since(seq) {
    const all = [];
    for (const ring of this.history.values()) for (const ev of ring) if (ev.seq > seq) all.push(ev);
    return all.sort((a, b) => a.seq - b.seq);
  }
}
