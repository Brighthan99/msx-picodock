// SPDX-License-Identifier: GPL-2.0-only
//
// cart.js — 카트리지 자신에게 내리는 지시 (PD_CMD_CTRL).
//
// src/host/pd_diskserver.py 의 Cart 를 옮긴 것이다. 디스크·프린터·메일박스와
// 달리 이것은 MSX 로 중계되지 않는다 - 카트리지가 직접 읽고 제 동작을 바꾼다.
//
// **왜 원하는 값을 따로 들고 있는가.** 카트리지가 재부팅하면 펌웨어 기본값으로
// 돌아간다(PSG 스트림 켜짐, MIDI-PAC 켜짐). 서버의 기본값은 그 반대다. 그래서
// 링크가 붙을 때마다 지금 설정을 다시 밀어 넣지 않으면, 카트리지를 다시 꽂은
// 것만으로 화면에 꺼져 있다고 쓰인 기능이 실제로는 돌아간다 - 화면과 기계가
// 어긋나는 것이 기능 하나가 안 되는 것보다 나쁘다.

import { buildFrame } from './frame.js';
import { CTRL, CTRL_PSG_STREAM, CTRL_MIDIPAC, CTRL_MIDI_PROG } from './protocol.js';

export { CTRL_PSG_STREAM, CTRL_MIDIPAC, CTRL_MIDI_PROG };

export class Cart {
  constructor() {
    this.link = null;
    this.want = new Map();      // what -> bool
  }

  attach(link) {
    this.link = link;
    this.push();                // 재연결. 카트리지는 기본값으로 돌아가 있다.
  }

  detach() { this.link = null; }

  /**
   * `value` 는 불린이거나 0..255 의 값이다.
   *
   * 프레임은 [what][value] 한 모양뿐이고, what 이 그 둘째 바이트를 어떻게
   * 읽을지 정한다 - 스위치에게는 0/1 이고 악기에게는 번호다. 프레임을 두
   * 가지로 늘리는 것보다 이게 낫다: 카트리지의 모르는-what-은-무시 규칙이
   * 그대로 유지되므로 구형 펌웨어에 새 호스트가 붙어도 조용히 지나간다.
   */
  set(what, value) {
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : (value & 0xff);
    this.want.set(what, v);
    this._send(what, v);
  }

  get(what, dflt = false) {
    if (!this.want.has(what)) return dflt;
    const v = this.want.get(what);
    return typeof dflt === 'boolean' ? !!v : v;
  }

  push() {
    for (const [what, v] of this.want) this._send(what, v);
  }

  _send(what, value) {
    if (!this.link) return;     // 끊겨 있다. 다음 attach 에서 다시 보낸다.
    try { this.link.write(buildFrame(CTRL, Buffer.from([what, value & 0xff]))); }
    catch { /* 방금 끊겼다 */ }
  }
}
