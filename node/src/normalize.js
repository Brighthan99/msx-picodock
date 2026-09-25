// SPDX-License-Identifier: GPL-2.0-only
//
// normalize.js — 맥에서 본 것과 MSX 에서 본 것을 같게 만든다.
//
// src/host/disk_normalize.py 를 옮긴 것이다. macOS 가 FAT 볼륨에 남기는 것 셋이
// 양쪽에서 다르게 읽힌다:
//
//   * **소문자 힌트 비트** (NT 바이트, 오프셋 0x0C 의 비트 3/4). 원래 이름이
//     소문자였으면 macOS 가 세우고 `SOFARUN` 을 `sofarun` 으로 보여 준다.
//     MSX-DOS 는 그 비트를 모르므로 같은 디렉터리가 양쪽에서 달리 읽힌다.
//   * **LFN 기록** - 짧은 항목 앞에 붙는 긴 이름 항목들. Nextor 는 못 읽어서
//     MSX 에는 뭉개진 별명(`SPACEM~1.COM`)만 보인다. 게다가 루트 디렉터리
//     슬롯을 먹는데, 그게 512 개뿐이다.
//   * **AppleDouble 사이드카와 메타데이터 폴더** (`._NAME`, `.fseventsd`,
//     `.Trashes`, ...). 맥에서는 안 보이고 MSX 의 DIR 에는 버젓이 보인다.
//
// 힌트 비트를 지우고, LFN 을 떼고, 메타데이터를 지우면서 그 클러스터를 돌려준다.
// 8.3 을 넘는 이름은 뭉개진 채로 남는다 - 그건 FAT 의 한계다 - 그러나 맥에서
// 보이는 것이 MSX 에서 보이는 것과 같아진다.
//
// **마운트되지 않은 이미지에 대고 돈다.** 서버는 핸들을 놓은 동안에 부른다.

import fs from 'node:fs';
import { Fat, lfnText, shortText,
         SECTOR, ATTR_LFN, ATTR_DIR, ATTR_VOLUME, FREE } from './fat.js';

const NT_LOWERCASE = 0x18;      // bit3 = 이름이 소문자, bit4 = 확장자가 소문자

const MACOS_DIRS = new Set(['.fseventsd', '.Trashes', '.Spotlight-V100',
                            '.TemporaryItems', '.DocumentRevisions-V100', '.apDisk']);

// AppleDouble 파일은 이 매직으로 시작한다 (뒤에 버전 00 02 00 00).
const APPLEDOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);

/**
 * AppleDouble 사이드카와 macOS 메타데이터 폴더인가.
 *
 * 긴 이름이 확실한 신호다 - `._NAME` 과 `.fseventsd` 는 올바른 8.3 이름이
 * 아니라서 macOS 가 반드시 LFN 을 쓴다.
 *
 * LFN 이 이미 떨어져 나간 항목(옛 버전이 지나간 이미지)은 `_NAME~1.COM` 같은
 * 것으로만 남는데, 그건 `_NAME.COM` 이라는 진짜 파일과 구별이 안 된다. 이름으로
 * 짐작하면 진짜 데이터를 지우게 되므로, 그런 것은 **내용**으로 가린다 -
 * AppleDouble 은 매직 넘버가 고정이다.
 */
function isMacJunk(fat, longName, shortName, isDir, firstCluster) {
  if (longName.startsWith('._') || longName === '.DS_Store') return true;
  if (MACOS_DIRS.has(longName)) return true;

  if (!longName && !isDir && shortName.startsWith('_') && firstCluster) {
    const pos = (fat.dataStart + (firstCluster - 2) * fat.spc) * SECTOR;
    return fat.read(pos, 4).equals(APPLEDOUBLE_MAGIC);
  }
  return false;
}

/**
 * 이미지를 제자리에서 정규화한다.
 *
 * @returns {{nt:number, lfn:number, junk:number}} 손본 개수
 */
export function normalize(path) {
  const stats = { nt: 0, lfn: 0, junk: 0 };
  const fd = fs.openSync(path, 'r+');
  try {
    const fat = new Fat(fd);
    const todo = [0];
    const visited = new Set();

    while (todo.length) {
      const cluster = todo.pop();
      if (visited.has(cluster)) continue;
      visited.add(cluster);

      for (const sec of fat.dirSectors(cluster)) {
        const data = fat._sector(sec);
        let dirty = false;
        let pending = [];            // 마지막 짧은 항목 이후에 본 LFN 기록들

        for (let i = 0; i < SECTOR; i += 32) {
          const ent = data.subarray(i, i + 32);
          if (ent[0] === 0x00) break;
          if (ent[0] === FREE) continue;

          const attr = ent[11];
          if (attr === ATTR_LFN) { pending.push([i, Buffer.from(ent)]); continue; }
          if (attr & ATTR_VOLUME) { pending = []; continue; }

          const longName = pending.length ? lfnText(pending.map((p) => p[1])) : '';
          const shortName = shortText(ent);
          const isDir = (attr & ATTR_DIR) !== 0;
          const first = ent.readUInt16LE(26);
          const name8 = ent.subarray(0, 8).toString('latin1').trim();
          const dot = name8 === '.' || name8 === '..';

          if (!dot && isMacJunk(fat, longName, shortName, isDir, first)) {
            // 자리만 비우면 아무도 닿을 수 없는 클러스터가 남는다. 공간도
            // 같이 돌려준다.
            if (isDir) fat.freeTree(first);
            else if (first) fat.freeChain(first);
            data[i] = FREE;
            for (const [j] of pending) data[j] = FREE;
            stats.junk++;
            dirty = true;
            pending = [];
            continue;
          }

          for (const [j] of pending) { data[j] = FREE; stats.lfn++; dirty = true; }
          pending = [];

          if (ent[12] & NT_LOWERCASE) {
            data[i + 12] = ent[12] & ~NT_LOWERCASE;
            stats.nt++;
            dirty = true;
          }

          if (isDir && !dot) todo.push(first);
        }

        if (dirty) fat.write(sec * SECTOR, data);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return stats;
}

/** 손본 것이 있으면 사람이 읽을 한 줄, 없으면 null. */
export function describe(st) {
  const parts = [];
  if (st.nt) parts.push(`uppercased ${st.nt}`);
  if (st.lfn) parts.push(`removed ${st.lfn} long-name record(s)`);
  if (st.junk) parts.push(`deleted ${st.junk} macOS metadata item(s)`);
  return parts.length ? parts.join(', ') : null;
}
