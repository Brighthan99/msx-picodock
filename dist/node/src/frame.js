// SPDX-License-Identifier: GPL-2.0-only
//
// frame.js — 0x5A 프레이밍. src/host/pd_diskserver.py 의 build_frame/FrameParser
// 와 **바이트 단위로 같아야 한다.** test/crosscheck.py 가 그것을 검사한다.

import { SOF, MAX_PAYLOAD } from './protocol.js';

export function buildFrame(cmd, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([
    Buffer.from([cmd, payload.length & 0xff, (payload.length >> 8) & 0xff]),
    payload,
  ]);
  let chk = 0;
  for (const b of body) chk ^= b;
  return Buffer.concat([Buffer.from([SOF]), body, Buffer.from([chk])]);
}

// 바이트 단위 조립기. **SOF 에서 다시 맞춘다** - 잘리거나 잡음이 낀 스트림이
// 멈추는 대신 다음 프레임에서 회복한다. 링크가 끊겼다 붙는 일이 잦은 이
// 프로젝트에서는 이 성질이 없으면 한 번 어긋난 뒤 영영 못 돌아온다.
export class FrameParser {
  constructor() { this.reset(); }

  reset() {
    this.state = 'sof';
    this.cmd = 0;
    this.length = 0;
    this.payload = [];
    this.chk = 0;
  }

  /** 들어온 바이트를 먹이고, 완성된 프레임을 [{cmd, payload}] 로 돌려준다. */
  feed(data) {
    const out = [];
    for (const b of data) {
      switch (this.state) {
        case 'sof':
          if (b === SOF) this.state = 'cmd';
          break;
        case 'cmd':
          this.cmd = b; this.chk = b; this.state = 'len_lo';
          break;
        case 'len_lo':
          this.length = b; this.chk ^= b; this.state = 'len_hi';
          break;
        case 'len_hi':
          this.length |= b << 8; this.chk ^= b; this.payload = [];
          if (this.length > MAX_PAYLOAD) this.reset();   // 말이 안 되는 길이
          else this.state = this.length ? 'payload' : 'chk';
          break;
        case 'payload':
          this.payload.push(b); this.chk ^= b;
          if (this.payload.length >= this.length) this.state = 'chk';
          break;
        case 'chk':
          if (b === this.chk) out.push({ cmd: this.cmd, payload: Buffer.from(this.payload) });
          this.reset();
          break;
      }
    }
    return out;
  }
}
