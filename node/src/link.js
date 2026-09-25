// SPDX-License-Identifier: GPL-2.0-only
//
// link.js — 카트리지가 나타날 때까지 기다리고, 사라지면 다시 기다린다.
//
// src/host/pd_diskserver.py 의 wait_for_port() 와 같은 규율이다. 카트리지는
// 정상적으로 쓰는 동안에도 계속 왔다 갔다 한다 - 다시 굽고, MSX 를 껐다 켜고,
// 케이블을 건드린다. 서버는 그 모두를 앉아서 견뎌야 한다.
//
// 여기서 지키는 것이 셋이다. 셋 다 실제로 당하고 나서 생긴 규칙이다.
//
// 1. **왜 못 열었는지 반드시 말한다.** 삼키면 화면에는 "카트리지를 기다린다"
//    만 남아, 장치가 없는 것과 권한이 없는 것이 구별되지 않는다. 우분투에서
//    실제로 그렇게 막혔다 - 포트는 거기 있고 dialout 그룹이 세션에 반영되지
//    않았을 뿐이었는데, 화면은 장치가 없다고 말하고 있었다.
//    오류를 삼키는 진단 도구는 도구가 아니라 눈가리개다.
//
// 2. **한 번 말을 튼 카트리지를 고수한다.** 시리얼 번호를 잠근다. 안 그러면
//    A 를 뽑고 B 를 꽂았을 때 B 가 A 의 디스크 이미지를 조용히 받는다.
//    선에서는 Sunrise IDE 가 다 똑같이 생겨서 서버가 알아챌 방법이 없다.
//
// 3. **둘 중에 고르지 않는다.** 후보가 여럿이면 세어서 말하고 기다린다.
//    --port 가 답이지 추측이 답이 아니다.

import { CH_LINK } from './hub.js';
import { errText } from './errtext.js';

export const VID = '2e8a';
export const PID = '000a';

const POLL_MS = 500;

// 기다리는 동안에도 그만둘 수 있어야 한다. 서버는 영영 도는 것이 맞지만,
// 시험과 웹 UI 의 '다시 시작' 은 도중에 멈출 수 있어야 한다 - 멈출 수 없는
// 고리는 시험할 수도 없다 (테스트 프로세스가 끝나지 않는다).
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); },
                            { once: true });
  });
}

/** 그만두라는 신호가 왔을 때 던지는 것. 오류가 아니라 정상 종료다. */
export class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; }
}

/**
 * VID/PID 가 맞는 포트들. want 가 있으면 그 시리얼만 - **앞부분만 맞아도 된다**
 * (파이썬 서버의 --serial 이 그랬다: 열두 자리를 다 치게 하지 않는다). 대소문자는
 * 가리지 않는다. 앞부분이 둘 이상에 맞으면 둘 다 돌려주고, 고르는 쪽이 "여럿" 이라
 * 말한다 - 짐작하지 않는다.
 */
export async function findDevices(SerialPort, want = null) {
  const all = await SerialPort.list();
  const w = want ? String(want).toUpperCase() : null;
  return all
    .filter((p) => (p.vendorId || '').toLowerCase() === VID
                && (p.productId || '').toLowerCase() === PID)
    .filter((p) => !w || (p.serialNumber || '').toUpperCase().startsWith(w))
    .map((p) => ({ path: calloutPath(p.path), serial: p.serialNumber || null }));
}

/**
 * macOS 에서는 `cu.` 쪽을 쓴다.
 *
 * 같은 장치가 `/dev/tty.usbmodem*` 과 `/dev/cu.usbmodem*` 둘로 보인다.
 * `tty.` 는 다이얼인 쪽이라 **DCD 가 설 때까지 open 이 막힐 수 있고**,
 * `cu.` 는 콜아웃 쪽이라 바로 열린다. pyserial 이 `cu.` 를 내놓는 것도
 * 같은 이유다 - serialport 는 `tty.` 를 내놓으므로 여기서 맞춰 준다.
 *
 * 리눅스에는 이 구분이 없어서 그대로 지나간다.
 */
function calloutPath(p) {
  if (process.platform !== 'darwin') return p;
  return p.startsWith('/dev/tty.') ? '/dev/cu.' + p.slice(9) : p;
}

/** 같은 시리얼을 단 보드가 둘 이상인가 (v0.38.0 이전 펌웨어). */
function ambiguous(found) {
  if (found.length < 2) return false;
  const serials = new Set(found.map((d) => d.serial));
  return serials.size === 1;
}

/**
 * 카트리지가 열릴 때까지 막고, 열린 SerialPort 를 돌려준다.
 *
 * state 는 호출 사이에 이어지는 것들을 담는다 (잠근 시리얼, 마지막 오류).
 * 함수 밖에 두는 이유는 재접속마다 새로 만들면 잠금이 풀리기 때문이다.
 */
export async function waitForPort(SerialPort, hub, opts = {}, state = {}) {
  let announced = false;
  const signal = opts.signal || null;

  for (;;) {
    if (signal?.aborted) throw new Aborted();
    let path = opts.port || null;
    let serial = null;

    if (!path) {
      const want = opts.serial || state.lockedSerial || null;
      let found = await findDevices(SerialPort, want);

      if (ambiguous(found)) {
        if (!announced) {
          hub.emit(CH_LINK, 'ambiguous', {
            devices: found.map((d) => d.path),
            reason: 'same serial on every board - firmware older than '
                  + 'v0.38.0. Reflash, or pick one with --port',
          });
          announced = true;
        }
        found = [];                       // 절대 추측하지 않는다
      } else if (found.length > 1) {
        if (!announced) {
          hub.emit(CH_LINK, 'several',
                   { devices: found.map((d) => `${d.path} (${d.serial})`) });
          announced = true;
        }
        found = [];
      }
      if (found.length === 1) ({ path, serial } = found[0]);
    }

    if (path) {
      try {
        const sp = await openPort(SerialPort, path, opts.baudRate || 115200);
        if (serial) state.lockedSerial = serial;
        state.lastError = null;
        hub.emit(CH_LINK, 'connected', { port: path, serial });
        return sp;
      } catch (e) {
        // 규칙 1. 같은 오류를 되풀이해 찍지는 않되, 사정이 바뀌면 다시 말한다.
        const why = errText(e);
        if (why !== state.lastError) {
          state.lastError = why;
          hub.emit(CH_LINK, 'open_failed', { port: path, error: why });
          announced = false;
        }
      }
    }

    if (!announced) {
      hub.emit(CH_LINK, 'waiting', { vid: VID, pid: PID });
      announced = true;
    }
    await sleep(opts.pollMs ?? POLL_MS, signal);
  }
}

/** new SerialPort 의 콜백/이벤트를 프라미스 하나로 묶는다. */
function openPort(SerialPort, path, baudRate) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sp = new SerialPort({ path, baudRate }, (err) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(sp);
    });
  });
}

/**
 * 링크가 끊길 때까지 기다린다. 끊긴 이유를 돌려준다.
 *
 * serialport 는 뽑힘을 'close' 로도 'error' 로도 알린다 - 플랫폼마다 다르고,
 * 어느 쪽이 먼저 오는지도 다르다. 둘 다 같은 끝으로 모은다.
 */
export function waitForLoss(sp) {
  return new Promise((resolve) => {
    let done = false;
    const end = (why) => { if (!done) { done = true; resolve(why); } };
    sp.on('close', (e) => end(e ? (e.message || 'closed') : 'closed'));
    sp.on('error', (e) => end(e.message || 'error'));
    sp.on('end', () => end('end'));
  });
}

/**
 * 영원히 도는 고리: 기다린다 -> onLink(sp) -> 끊기면 다시 기다린다.
 *
 * onLink 는 **막지 않아야 한다.** serve() 처럼 핸들러만 걸고 바로 돌아온다.
 * 끊김은 waitForLoss 가 잡는다.
 */
export async function runLink(SerialPort, hub, opts, onLink, onLost = null) {
  const state = {};
  const signal = opts.signal || null;
  for (;;) {
    let sp;
    try {
      sp = await waitForPort(SerialPort, hub, opts, state);
    } catch (e) {
      if (e instanceof Aborted) return;
      throw e;
    }
    onLink(sp);

    // 그만두라는 신호도 끊김과 같이 취급한다 - 어느 쪽이 먼저 와도 포트를 닫는다.
    const why = await Promise.race([
      waitForLoss(sp),
      new Promise((resolve) => signal?.addEventListener(
        'abort', () => resolve(null), { once: true })),
    ]);
    try { if (sp.isOpen) sp.close(); } catch { /* 이미 사라진 장치다 */ }
    if (why === null) return;              // 우리가 그만둔 것이다
    hub.emit(CH_LINK, 'lost', { error: why });
    if (onLost) onLost(why);
  }
}
