// SPDX-License-Identifier: GPL-2.0-only
//
// hold.js — 이미지를 빌려 주고 돌려받는다.
//
// MSX 에게 디스크를 서빙하는 동안 그 이미지를 이 컴퓨터에 마운트하면, 한
// 파일시스템에 쓰는 쪽이 둘이 된다. 거의 확실한 손상이고, 더 나쁜 것은
// **조용히** 손상된다는 점이다. 그래서 빌려 가는 동안에는 서버가 손을 뗀다.
//
// 빌려 가는 길이 둘이고 둘 다 막아야 한다.
//
//   Finder 마운트 (손으로 하는 길)
//     알아채는 수밖에 없다. macOS 는 `hdiutil info`, 리눅스는 `losetup -j` 로
//     본다. 서브프로세스라 비싸서 2 초마다만 본다. 알아챈 뒤에 멈추므로 그
//     사이에 창이 있지만, 마운트 직후에 바로 쓰는 일은 드물다.
//
//   disk_put.sh (`.hold` 파일)
//     이쪽은 **경합이 없다.** 요청하는 쪽이 `.hold` 를 놓고 기다리고, 서버는
//     핸들을 놓은 뒤에 `.held` 를 쓴다. 요청한 쪽은 `.held` 가 보이기 전에는
//     이미지를 건드리지 않는다.
//
// 파일 셋:
//   <image>.srv    도는 서버의 PID (disk_put 이 서버가 있는지 알아보려고)
//   <image>.hold   빌려 달라는 요청. 요청한 쪽의 PID 가 들어 있다.
//   <image>.held   놓았다는 확인
//
// **.hold 에 PID 가 들어 있는 이유.** 요청한 프로세스가 SIGKILL 로 죽으면
// 파일이 남는다. 그것을 곧이곧대로 따르면 서버는 영영 멈춰 있고, 사용자는
// 디스크가 죽었다고 생각한다. PID 가 살아 있는지 보고, 죽었으면 요청이 아니라
// 쓰레기로 친다.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { CH_DISK } from './hub.js';
import { normalize, describe } from './normalize.js';

const ap = (image) => path.resolve(image);
export const srvPath = (image) => ap(image) + '.srv';
export const holdPath = (image) => ap(image) + '.hold';
export const heldPath = (image) => ap(image) + '.held';

/** 이미지가 얼마나 자주 마운트됐는지 보는가. 서브프로세스라 자주 못 본다. */
const MOUNT_POLL_MS = 2000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // 있긴 한데 우리 것이 아니다
}

/** 살아 있는 요청이 기다리고 있는가. 쓰레기 .hold 는 치운다. */
export function holdActive(image) {
  let text;
  try { text = fs.readFileSync(holdPath(image), 'utf8').trim(); }
  catch { return false; }                    // 파일이 없다
  if (!text) return true;                    // 막 만들어졌다. PID 는 아직.
  const pid = Number(text);
  if (!Number.isInteger(pid)) return true;   // 뜻 모를 내용이면 안전한 쪽으로
  if (pidAlive(pid)) return true;
  try { fs.rmSync(holdPath(image)); } catch { /* 누가 먼저 치웠다 */ }
  return false;
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout));
});

/** 이 이미지가 지금 이 컴퓨터에 붙어 있는가. 알 수 없으면 false. */
export async function isMounted(image) {
  const target = ap(image);
  try {
    if (process.platform === 'darwin')
      return (await run('hdiutil', ['info'])).includes(target);
    return (await run('losetup', ['-j', target])).trim().length > 0;
  } catch {
    return false;        // 알 수 없으면 막지 않는다. 막는 쪽이 더 나쁘다.
  }
}

/** 어디에 붙어 있는지 - 메시지에 이름을 대 주려고. macOS 만. */
export async function mountPoints(image) {
  if (process.platform !== 'darwin') return [];
  const target = ap(image);
  const info = await run('hdiutil', ['info']);
  const out = [];
  for (const block of info.split('================================================')) {
    if (!block.includes(target)) continue;
    for (const line of block.split('\n')) {
      if (!line.includes('\t/')) continue;
      if (line.includes('image-path') || line.includes('icon-path')) continue;
      const at = line.split('\t').pop().trim();
      if (at.startsWith('/')) out.push(at);
    }
  }
  return out;
}

/**
 * 빌려 주고 돌려받는 일을 맡는다.
 *
 * `tick()` 을 주기적으로 부른다. `.hold` 검사는 파일 하나 읽는 것뿐이라 매번
 * 하고, 마운트 검사는 서브프로세스라 2 초마다만 한다.
 */
export class Lending {
  constructor(hub, disk, image, opts = {}) {
    this.hub = hub;
    this.disk = disk;
    this.image = image;
    this.mountPollMs = opts.mountPollMs ?? MOUNT_POLL_MS;
    this.onResume = opts.onResume || null;   // 돌려받은 직후에 할 일 (정규화 등)
    this.mounted = false;
    this._wasMounted = false;     // 마운트 때문에 멈췄던 것인가
    this._lastMountCheck = 0;
    this._checking = false;
    this._byUser = false;                    // 화면에서 누른 일시정지
  }

  /** 서버가 여기 있다고 알린다. disk_put 이 이 파일을 보고 판단한다. */
  announce() {
    try { fs.writeFileSync(srvPath(this.image), String(process.pid)); }
    catch { /* 못 써도 서빙에는 지장이 없다 */ }
  }

  /**
   * 치우고 나간다.
   *
   * Ctrl-C 는 스스로 치우지만 SIGKILL 은 아니다. 남은 .srv 는 disk_put 에게
   * 없는 서버가 있다고 말하게 되므로, 나갈 때 반드시 지운다.
   */
  cleanup() {
    for (const p of [srvPath(this.image), heldPath(this.image)]) {
      try { fs.rmSync(p); } catch { /* 없으면 그만 */ }
    }
  }

  /** 화면에서 누른 일시정지. 파일 규약과 따로 논다. */
  setByUser(on) {
    this._byUser = !!on;
    this._apply();
  }

  tick() {
    if (Date.now() - this._lastMountCheck > this.mountPollMs && !this._checking) {
      this._lastMountCheck = Date.now();
      this._checking = true;
      isMounted(this.image)
        .then((m) => { this.mounted = m; })
        .catch(() => { /* 알 수 없으면 그대로 둔다 */ })
        .finally(() => { this._checking = false; this._apply(); });
    }
    this._apply();
  }

  _apply() {
    const requested = holdActive(this.image);
    const want = requested || this.mounted || this._byUser;
    const disk = this.disk;

    if (want && !disk.paused) {
      disk.pause();
      const reason = requested ? 'disk_put' : this.mounted ? 'mounted' : 'user';
      this._wasMounted = reason === 'mounted';
      this.hub.emit(CH_DISK, 'paused', { path: this.image, reason });
      if (reason === 'mounted') {
        mountPoints(this.image).then((at) => {
          if (at.length) this.hub.emit(CH_DISK, 'mount_at', { at });
        }).catch(() => {});
      }
    } else if (!want && disk.paused) {
      // **돌려주기 전에 정리한다.** macOS 는 마운트했다 빼면 `._` 사이드카와
      // LFN 과 소문자 힌트 비트를 남기고, MSX 에서는 그것이 쓰레기 파일과
      // 뭉개진 이름으로 보인다. 고치는 일은 핸들이 놓여 있는 지금만 안전하다 -
      // 다시 열고 나서 디렉터리를 고쳐 쓰면 MSX 가 그 사이를 읽을 수 있다.
      //
      // 마운트 때만 한다. disk_put 은 FAT 에 직접 쓰므로 남길 것이 없고,
      // 화면에서 누른 일시정지는 이미지를 건드리지 않는다.
      if (this._wasMounted) {
        try {
          const st = normalize(this.image);
          const said = describe(st);
          if (said) this.hub.emit(CH_DISK, 'tidied', { text: said, ...st });
        } catch (e) {
          // 정리에 실패해도 디스크는 돌려준다. 못 고친 것보다 못 돌려주는
          // 것이 훨씬 나쁘다 - MSX 쪽에서는 디스크가 죽은 것으로 보인다.
          this.hub.emit(CH_DISK, 'tidy_failed', { error: e.message });
        }
      }
      if (this.onResume) {
        try { this.onResume(); } catch { /* 정리에 실패해도 돌려주기는 한다 */ }
      }
      disk.resume();
      this.hub.emit(CH_DISK, 'resumed', { path: this.image, blocks: disk.blocks });

      this._wasMounted = false;
    }

    // **.held 는 사건이 아니라 상태다.** 멈추는 *순간*에만 쓰면, 화면에서 이미
    // 멈춰 둔 이미지에 .hold 가 들어왔을 때 전이가 없어 영영 안 써진다.
    // 요청한 쪽은 30 초를 기다리다 포기하고, 아무도 무엇이 잘못됐는지 모른다.
    //
    // 순서는 여전히 지킨다: 핸들을 놓은 **뒤에** 쓴다. 반대로 하면 요청한 쪽이
    // 아직 우리가 쥔 이미지를 건드리기 시작한다.
    const hp = heldPath(this.image);
    const heldNow = fs.existsSync(hp);
    if (requested && disk.paused && !heldNow) {
      try { fs.writeFileSync(hp, ''); } catch { /* 못 써도 다음 tick 에 다시 */ }
    } else if ((!requested || !disk.paused) && heldNow) {
      try { fs.rmSync(hp); } catch { /* 누가 먼저 치웠다 */ }
    }
  }
}
