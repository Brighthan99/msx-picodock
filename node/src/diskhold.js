// SPDX-License-Identifier: GPL-2.0-only
//
// diskhold.js — 서빙 중인 이미지를 서버에게서 잠시 빌리고, 돌려준다.
//
// 도구 쪽 절반이다 (서버 쪽 절반은 hold.js). src/host/disk_hold.py 를 옮겼다.
// 서버는 블록을 캐시 없이 파일에서 바로 읽어 넘기므로, 여기서 쓴 것이 그 순간
// MSX 에 보인다 - FAT 을 고치는 도중까지. 그래서 먼저 비켜 달라고 한다.
//
// 대화는 이미지 옆의 파일 셋으로 한다. 멈춘 채 남은 잠금이 눈에 보이고 지울 수
// 있게 하려고 일부러 그렇다:
//
//   <image>.srv    서버의 PID. 서빙하는 동안 있다
//   <image>.hold   우리 PID. 비켜 달라는 부탁
//   <image>.held   서버의 답: 핸들을 닫았다, 써도 된다
//
// .hold 를 지우면 돌려준 것이다. 어떻게 끝나든 지운다 - 영영 멈춘 서버가 실패한
// 복사보다 나쁘다.

import fs from 'node:fs';
import path from 'node:path';

export function sidecars(image) {
  const base = path.resolve(image);
  return { srv: `${base}.srv`, hold: `${base}.hold`, held: `${base}.held` };
}

/** 살아 있는 프로세스인가. EPERM 도 "아니다" 로 본다 - 파이썬의 os.kill 이 그렇다. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 서버가 있으면 멈춰 세우고, 없으면 아무 일도 안 한다 - 서버가 없는 것이 보통이다
 * (MSX 를 켜기도 전에 이미지를 만드는 사람).
 */
export class Hold {
  constructor(image, { timeout = 30, report = (s) => console.log(s) } = {}) {
    Object.assign(this, sidecars(image));
    this.timeout = timeout;
    this.report = report;
    this.holding = false;
  }

  async enter() {
    let pid;
    try {
      pid = Number.parseInt(fs.readFileSync(this.srv, 'utf8').trim(), 10);
    } catch { return this; }                 // 아무도 서빙하지 않는다
    if (!Number.isInteger(pid)) return this;
    if (!alive(pid)) {
      // 죽은 서버가 남긴 .srv. 지우지 않는다 - 이 프로그램이 놓은 것이 아니고,
      // 잘못 짚으면 멀쩡히 살아 있는 서버 밑에서 쓰게 된다.
      this.report(`[!] stale ${path.basename(this.srv)} (no process ${pid}) - proceeding`);
      return this;
    }

    this.report('[*] a server is serving this image - asking it to pause');
    try { fs.rmSync(this.held); } catch { /* 없으면 그만 */ }
    fs.writeFileSync(this.hold, String(process.pid));
    this.holding = true;

    const deadline = Date.now() + this.timeout * 1000;
    while (!fs.existsSync(this.held)) {
      if (Date.now() > deadline) {
        this.release();
        throw new HoldError(
          `the server did not confirm the pause within ${this.timeout}s; stopping `
          + 'rather than writing underneath it.\n'
          + '    If nothing is actually serving it, remove the stale lock:\n'
          + `      rm -f ${this.srv}`);
      }
      await sleep(100);
    }
    this.report('[*] server paused - safe to proceed');
    return this;
  }

  release() {
    if (!this.holding) return;
    try { fs.rmSync(this.hold); } catch { /* 이미 없다 */ }
    this.holding = false;
  }
}

export class HoldError extends Error {}

/** fn 을 도는 동안 서버를 비켜 세운다. 서버를 못 세우면 fn 을 부르지 않는다. */
export async function withHold(image, fn, opts) {
  const hold = new Hold(image, opts);
  await hold.enter();
  // 어떻게 끝나든 돌려준다. Ctrl-C 로 끊겨도 - 서버가 영영 멈춰 있는 것보다
  // 실패한 복사가 낫다.
  const onSig = () => { hold.release(); process.exit(130); };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  try { return await fn(); } finally {
    hold.release();
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
}
