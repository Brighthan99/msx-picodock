// SPDX-License-Identifier: GPL-2.0-only
//
// rp2drive.js — RP2040 부트로더의 대용량 저장 드라이브를 어느 컴퓨터에서든 찾는다.
//
// src/host/rp2_drive.py 를 옮겼다 (2026-09-25). 드라이브 이름은 어디서나
// RPI-RP2 이고, 나타나는 자리만 다르다:
//
//     macOS    /Volumes/RPI-RP2
//     Linux    /media/<user>/RPI-RP2, /run/media/<user>/RPI-RP2, /mnt/RPI-RP2
//     Windows  드라이브 문자. 부트로더가 늘 두는 INFO_UF2.TXT 로 알아본다
//
// **사라지는 것이 성공 신호다.** 부트로더는 UF2 블록을 세어 전부 받았을 때만
// 재부팅하므로, 드라이브가 없어지는 것이 쓰기가 끝났다는 말이다.

import fs from 'node:fs';
import path from 'node:path';

export const LABEL = 'RPI-RP2';

function candidates() {
  if (process.platform === 'darwin') return [`/Volumes/${LABEL}`];
  if (process.platform === 'win32') {
    const out = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      try { if (fs.existsSync(path.join(root, 'INFO_UF2.TXT'))) out.push(root); } catch { /* 답 없는 드라이브 */ }
    }
    return out;
  }
  const under = (base) => {
    try { return fs.readdirSync(base).map((u) => path.join(base, u, LABEL)); } catch { return []; }
  };
  return [...under('/media'), ...under('/run/media'), `/media/${LABEL}`, `/mnt/${LABEL}`];
}

/** 마운트된 드라이브, 없으면 null. */
export function find() {
  for (const p of candidates()) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* 다음 */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 드라이브가 나타나기(present) 또는 사라지기를 기다린다. 일어났으면 true. */
export async function waitFor(seconds, present = true) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if ((find() !== null) === present) return true;
    await sleep(500);
  }
  return (find() !== null) === present;
}
