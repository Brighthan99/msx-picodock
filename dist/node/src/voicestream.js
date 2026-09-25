// SPDX-License-Identifier: GPL-2.0-only
//
// voicestream.js — 합성한 소리를 카트리지의 링으로 흘려보낸다.
//
// 한 마디는 10 KB 쯤이고 링은 4 KB 다. 그래서 한 번에 못 준다 - 나눠 주되,
// **MSX 가 먹는 만큼만** 줘야 한다. 그 판단이 이 파일의 전부다.
//
// 왜 시계로 안 맞추는가
// --------------------
// 재생 속도를 아니까(11025 B/s) 그 속도로 밀어 넣으면 될 것 같다. 안 된다.
// MSX 가 아직 시작을 안 눌렀으면 링은 안 비는데 **시계는 그것을 모른다.**
// 사람이 `CALL PDASK` 를 치고 화면을 보다가 몇 초 뒤에 재생을 시작할 수도
// 있고, 그 사이 호스트가 시계대로 밀면 말의 앞이 통째로 넘쳐 사라진다.
//
// 그래서 카트리지가 자리를 말해 준다(`PD_CMD_VOICE_STAT`). 호스트는 **들은
// 자리만큼만** 보내고, 듣기 전에는 링 크기까지만 보낸다.
//
// 디스크와 같은 파이프를 쓴다
// -------------------------
// 512 바이트씩 보낸다. 4KB 를 한 번에 밀면 그동안 섹터 읽기가 멈추고, 멈춘
// 디스크는 MSX 가 포기한다. 섹터 하나와 비슷한 덩어리면 서로를 굶기지 않는다.

import { CH_ASK } from './hub.js';
import { buildFrame } from './frame.js';
import { VOICE_DATA, VOICE_CTRL, VOICE_STAT } from './protocol.js';

export { VOICE_DATA, VOICE_CTRL, VOICE_STAT };

//: 카트리지의 링 크기. `pd_voice_win.h` 의 `PD_VOICE_RING` 과 같아야 한다.
//: 여기가 크면 넘치고, 작으면 굶는다.
export const RING = 4096;

//: 한 프레임에 싣는 바이트. 디스크 섹터와 비슷한 덩어리.
export const FRAME = 512;

//: 자리를 듣기 전에 넣어 두는 양. 링을 꽉 채우지 않는 이유는, 카트리지가
//: 말해 준 자리가 오는 동안 MSX 가 조금 더 먹었을 수 있기 때문이다 - 그
//: 시차만큼 비워 둔다.
export const LEAD = RING - FRAME;

export const CTRL_RESET = 0x00;
export const CTRL_CLOSE = 0x01;

export const ST_ARMED   = 0x01;
export const ST_STARVED = 0x02;
export const ST_ENDED   = 0x04;

/**
 * 프레임 하나.
 *
 * **여기서 다시 만들지 않는다** - `frame.js` 의 buildFrame 이 이미 그 일을
 * 하고 있고, 디스크와 프린터가 그것을 쓴다. 조립기를 두 벌 두면 한쪽에만
 * 고침이 들어가고, 그 갈라짐은 ESC/P 렌더러에서 이미 한 번 겪었다.
 */
export function frame(cmd, payload = []) {
  return buildFrame(cmd, Buffer.from(payload));
}

/**
 * 한 번에 한 마디.
 *
 * `send(buf)` 로 내보내고, 카트리지가 보낸 상태를 `status()` 로 받는다.
 * `pump()` 는 자주 불러도 되고, 보낼 것이 없으면 아무 일도 안 한다.
 */
export class VoiceStream {
  constructor(hub, opts = {}) {
    this.hub = hub;
    this.ring = opts.ring ?? RING;
    this.frameSize = opts.frame ?? FRAME;
    this.data = null;        // 보낼 것 전부
    this.at = 0;             // 어디까지 보냈나
    //: 마지막 상태를 들은 뒤로 보낸 양. 카트리지가 말해 준 `room` 은 그 말을
    //: 할 때의 자리라, 그 뒤에 보낸 것은 거기 안 들어 있다.
    this.sentSinceStatus = 0;
    this.room = this.ring;
    this.flags = 0;
    this.played = 0;
    this.closed = false;
    this.heard = false;      // 상태를 한 번이라도 들었나
    this.toldStarved = false;
  }

  get busy() { return this.data !== null; }
  get left() { return this.data ? this.data.length - this.at : 0; }

  /** 새 마디. 앞의 것은 버린다 - 두 마디가 섞이면 둘 다 못 알아듣는다. */
  say(bytes, send) {
    this.data = Buffer.from(bytes);
    this.at = 0;
    this.sentSinceStatus = 0;
    this.room = this.ring;
    this.flags = 0;
    this.played = 0;
    this.closed = false;
    this.heard = false;
    this.toldStarved = false;
    if (send) send(frame(VOICE_CTRL, [CTRL_RESET]));
    this.hub.emit(CH_ASK, 'voice_start', { bytes: this.data.length });
    this.pump(send);
    return this.data.length;
  }

  /** 그만. 카트리지의 링도 비운다. */
  stop(send) {
    if (!this.data) return;
    const sent = this.at;
    this.data = null;
    this.at = 0;
    if (send) send(frame(VOICE_CTRL, [CTRL_RESET]));
    this.hub.emit(CH_ASK, 'voice_stop', { sent });
  }

  /**
   * 카트리지가 말해 준 것.
   *
   * `room` 은 **그 말을 할 때의** 자리다. 그래서 들은 뒤에 보낸 양을 따로
   * 세고(`sentSinceStatus`), 다음 상태가 올 때 0 으로 되돌린다. 호스트가 센
   * "보낸 양" 과 링에 실제로 남은 양은 MSX 가 먹은 만큼 다르고, 그 차이는
   * 카트리지만 안다 - 그것이 `played` 다.
   */
  onStatus(room, played, flags) {
    this.heard = true;
    this.room = Math.max(0, Math.min(this.ring, room));
    this.played = played;
    this.flags = flags;
    this.sentSinceStatus = 0;
    if ((flags & ST_STARVED) && !this.toldStarved) {
      // 한 번 굶으면 소리에 구멍이 난다. 화면에 보여야 한다 - 안 보이면
      // "왜 뚝뚝 끊기지" 가 된다.
      //
      // **한 마디에 한 번만.** 카트리지의 표시는 다음 시작까지 남아 있으므로
      // 들을 때마다 말하면 10 ms 마다 한 줄씩 쌓인다 - 실기에서 238 줄이
      // 쌓여 정작 봐야 할 줄을 덮었다.
      this.toldStarved = true;
      this.hub.emit(CH_ASK, 'voice_starved', { played });
    }
  }

  /** 상태 프레임을 뜯는다. 길이가 안 맞으면 조용히 버린다. */
  static parseStatus(payload) {
    if (!payload || payload.length < 7) return null;
    return {
      room: payload[0] | (payload[1] << 8),
      played: payload[2] | (payload[3] << 8) | (payload[4] << 16) | (payload[5] << 24),
      flags: payload[6],
    };
  }

  /**
   * 보낼 수 있는 만큼 보낸다.
   *
   * 자리를 들은 적이 없으면 `LEAD` 까지만 - 링을 꽉 채우면, 상태가 오는 동안
   * MSX 가 먹은 만큼을 넣을 자리가 없어진다.
   */
  pump(send) {
    if (!this.data || !send) return 0;

    // **상한이 둘이고, 좁은 쪽을 따른다.** 하나만 믿으면 그 하나가 틀렸을 때
    // 링이 넘치고, 넘친 만큼은 말에서 사라진다.
    //
    //   byRoom  카트리지가 말해 준 자리에서, 그 말을 들은 뒤 보낸 것을 뺀 것.
    //           아직 들은 적이 없으면 LEAD 까지만.
    //   byRing  카트리지가 아직 들고 있을 양(보낸 것 - 먹은 것)으로 계산한 것.
    //           `room` 하나가 깨져 와도 이쪽이 막는다.
    const outstanding = Math.max(0, this.at - this.played);
    const byRing = this.ring - outstanding;
    const byRoom = (this.heard ? this.room : LEAD) - this.sentSinceStatus;
    let can = Math.min(byRing, byRoom, this.left);
    let sent = 0;
    while (can >= 1) {
      const n = Math.min(this.frameSize, can);
      send(frame(VOICE_DATA, this.data.subarray(this.at, this.at + n)));
      this.at += n;
      this.sentSinceStatus += n;
      sent += n;
      can -= n;
    }
    if (this.left === 0 && !this.closed) {
      // **다 보냈다고 끝난 것이 아니다.** 링에 남은 것이 아직 나간다.
      // 닫는 것은 "더 올 것이 없다" 는 말이고, 끝은 MSX 가 그것을 다 먹었을
      // 때다 - 그건 상태의 ENDED 가 말해 준다.
      send(frame(VOICE_CTRL, [CTRL_CLOSE]));
      this.closed = true;
      this.hub.emit(CH_ASK, 'voice_sent', { bytes: this.data.length });
    }
    if (this.closed && (this.flags & ST_ENDED)) {
      this.hub.emit(CH_ASK, 'voice_done',
                    { bytes: this.data.length, starved: !!(this.flags & ST_STARVED) });
      this.data = null;
      this.at = 0;
    }
    return sent;
  }

  /** 화면이 그릴 "지금 어떤가". */
  status() {
    return {
      speaking: this.busy,
      bytes: this.data ? this.data.length : 0,
      sent: this.at,
      played: this.played,
      room: this.room,
      armed: !!(this.flags & ST_ARMED),
      starved: !!(this.flags & ST_STARVED),
      closed: this.closed,
    };
  }
}
