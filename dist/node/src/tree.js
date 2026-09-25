// SPDX-License-Identifier: GPL-2.0-only
//
// tree.js — 이미지 안의 파일 트리를 읽는다 (읽기 전용).
//
// 화면에 "지금 이 디스크에 뭐가 들어 있나" 를 보여 주기 위한 것이다. MSX 에서
// `DIR` 를 치는 것과 같은 것을 보되, 맥에서 마운트하지 않고 본다 - 마운트는
// 서버가 섹터를 넘기고 있는 파일에 macOS 가 쓰기를 시작한다는 뜻이고, 그건
// `disk/paused` 가 존재하는 이유 그 자체다.
//
// **이름을 둘 다 들고 간다.** `name` 은 8.3 이고 MSX 가 보는 그것이다. LFN 이
// 남아 있으면 `long` 에 따로 담는다 - 같은 자리에 하나만 보여 주면, 맥에서 보던
// 이름과 MSX 에서 보이는 이름이 다를 때 화면이 거짓말을 한다.
//
// **읽는 도중에 MSX 가 쓰고 있을 수 있다.** 디렉터리 항목은 갱신됐는데 FAT 은
// 아직인 순간이 실제로 있다. 그래서 여기서 본 것은 "그 찰나의 모습" 이지
// 트랜잭션이 아니다 - 깨진 사슬을 만나면 던지지 않고 그 가지만 잘라 낸다.
// 보는 화면이 서버를 멈추게 하는 것이 훨씬 나쁘다.

import fs from 'node:fs';
import { Fat, lfnText, shortText, SECTOR, ATTR_LFN, ATTR_DIR, ATTR_VOLUME, FREE }
  from './fat.js';

//: 아무리 이상한 이미지라도 여기서 멈춘다. 손상된 FAT 은 디렉터리 사슬을
//: 제자리로 돌려 놓을 수 있고, 그러면 이 순회가 영영 안 끝난다. `chain()` 이
//: 이미 사슬 반복은 막지만, 디렉터리가 **서로를** 가리키는 것은 못 막는다.
const MAX_DEPTH = 16;
const MAX_ENTRIES = 20000;

function fatDate(ent) {
  const time = ent.readUInt16LE(22);
  const date = ent.readUInt16LE(24);
  if (!date) return null;
  const y = 1980 + ((date >> 9) & 0x7f);
  const mo = (date >> 5) & 0x0f;
  const d = date & 0x1f;
  const h = (time >> 11) & 0x1f;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  if (!mo || !d) return null;
  // 화면에 그대로 찍을 문자열로 둔다. 이건 MSX 가 적어 둔 **그 지역 시각**이고,
  // 시간대가 없다. Date 로 만들면 브라우저가 UTC 로 여겨 몇 시간씩 옮긴다.
  const p2 = (n) => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}`;
}

function readDir(fat, cluster, depth, budget) {
  const out = [];
  let pending = [];                       // 짧은 항목 앞에 쌓이는 LFN 조각들

  for (const sec of fat.dirSectors(cluster)) {
    if (budget.n >= MAX_ENTRIES) break;
    let data;
    try { data = fat.read(sec * SECTOR, SECTOR); }
    catch { break; }                      // 잘린 이미지. 본 데까지가 답이다.

    for (let i = 0; i < SECTOR; i += 32) {
      const ent = data.subarray(i, i + 32);
      if (ent[0] === 0x00) { pending = []; return out; }   // 여기가 끝이다
      if (ent[0] === FREE) { pending = []; continue; }
      if (ent[11] === ATTR_LFN) { pending.push(Buffer.from(ent)); continue; }
      if (ent[11] & ATTR_VOLUME) { pending = []; continue; }

      const short = shortText(ent);
      const long = pending.length ? lfnText(pending) : '';
      pending = [];
      if (short === '.' || short === '..') continue;

      const isDir = !!(ent[11] & ATTR_DIR);
      const first = ent.readUInt16LE(26);
      budget.n++;

      const node = {
        name: short,
        dir: isDir,
        at: fatDate(ent),
      };
      if (long && long !== short) node.long = long;

      if (isDir) {
        node.children = (depth < MAX_DEPTH && first)
          ? readDir(fat, first, depth + 1, budget)
          : [];
      } else {
        node.size = ent.readUInt32LE(28);
      }
      out.push(node);
    }
  }
  return out;
}

/**
 * 이미지의 트리와 용량을 읽는다.
 *
 * @param {string} path 이미지 파일
 * @returns {{volume:object, root:Array}}
 */
export function readTree(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const fat = new Fat(fd);
    const budget = { n: 0 };
    const root = readDir(fat, 0, 0, budget);

    const free = fat.freeCount();
    const clusterBytes = fat.spc * SECTOR;
    let files = 0, dirs = 0, bytes = 0;
    (function count(list) {
      for (const n of list) {
        if (n.dir) { dirs++; count(n.children || []); }
        else { files++; bytes += n.size || 0; }
      }
    })(root);

    return {
      volume: {
        path,
        clusterBytes,
        clusters: fat.clusters,
        freeClusters: free,
        freeBytes: free * clusterBytes,
        totalBytes: fat.clusters * clusterBytes,
        fatSectors: fat.fatsz,
        files, dirs, bytes,
        truncated: budget.n >= MAX_ENTRIES,
      },
      root,
    };
  } finally {
    fs.closeSync(fd);
  }
}
