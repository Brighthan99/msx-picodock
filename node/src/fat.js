// SPDX-License-Identifier: GPL-2.0-only
//
// fat.js — FAT16 이미지의 기하와 디렉터리 읽기.
//
// `normalize.js` 안에 있던 것을 꺼냈다. 꺼낸 이유가 편의가 아니다: **FAT 파서가
// 둘이면 둘이 어긋나고, 어긋나는 순간이 곧 데이터가 깨지는 순간이다.** 2026-09-21
// 에 실제로 그 모양으로 당했다 (tasks.md §I - 파이썬 도구와 macOS 가 같은
// 이미지를 FAT16 과 FAT12 로 다르게 읽었다). 트리 뷰어가 제 나름의 BPB 해석을
// 들고 있으면 같은 함정이 하나 더 생긴다.
//
// 쓰기도 여기 있다 (2026-09-25). 예전에는 FAT 을 고치는 것은 파이썬
// (`src/host/fat16.py`)의 일이었고 이 파일은 읽기만 했다 - 쓰기 구현이 둘이면
// 둘이 어긋나기 때문이다. 이제 쓰는 쪽이 여기 **하나**고, 파이썬은 시험에서
// 정답표로만 남는다: `test/fat_crosscheck.py` 가 같은 일을 양쪽에 시켜 **이미지가
// 바이트 단위로 같은지** 본다. 그래서 아래 쓰기 함수들은 fat16.py 를 줄 단위로
// 따른다 - 할당 순서, 디렉터리 끝 판정, 빈 칸 고르기까지.

import fs from 'node:fs';

export const SECTOR = 512;
export const ATTR_LFN = 0x0f;
export const ATTR_DIR = 0x10;
export const ATTR_VOLUME = 0x08;
export const FREE = 0xe5;

// 이보다 클러스터가 적으면 FAT 규격은 그 볼륨을 **FAT12** 로 친다. BPB 에
// "FAT16" 이라고 적혀 있어도 소용없다 - 타입을 정하는 것은 클러스터 수다.
// 여기 코드는 16 비트 항목만 읽고 쓰므로, FAT12 볼륨에 대면 엉뚱한 니블을
// 읽고 덮어쓴다. 조용히 망가뜨리느니 거절한다.
export const FAT12_MAX_CLUSTERS = 4084;

export class Fat {
  constructor(fd) {
    this.fd = fd;
    const mbr = this._sector(0);
    this.part = (mbr[510] === 0x55 && mbr[511] === 0xaa)
      ? mbr.readUInt32LE(0x1be + 8) : 0;

    const b = this._sector(this.part);
    this.bps = b.readUInt16LE(11);
    this.spc = b[13];
    this.reserved = b.readUInt16LE(14);
    this.nfats = b[16];
    this.rootEntries = b.readUInt16LE(17);
    this.fatsz = b.readUInt16LE(22);
    this.total = b.readUInt16LE(19) || b.readUInt32LE(32);
    if (!(this.bps === SECTOR && this.spc && this.fatsz))
      throw new Error('not a FAT16 image this tool understands');

    this.fatStart = this.part + this.reserved;
    this.rootStart = this.fatStart + this.nfats * this.fatsz;
    this.rootSectors = Math.ceil((this.rootEntries * 32) / SECTOR);
    this.dataStart = this.rootStart + this.rootSectors;

    this.clusters = Math.floor((this.total - (this.dataStart - this.part)) / this.spc);
    if (this.clusters <= FAT12_MAX_CLUSTERS)
      throw new Error(`this is a FAT12 volume (${this.clusters} clusters; `
        + `FAT16 needs more than ${FAT12_MAX_CLUSTERS}), `
        + 'and this tool only speaks FAT16');
  }

  _sector(n) { return this.read(n * SECTOR, SECTOR); }

  read(pos, len) {
    const b = Buffer.alloc(len);
    fs.readSync(this.fd, b, 0, len, pos);
    return b;
  }

  write(pos, buf) { fs.writeSync(this.fd, buf, 0, buf.length, pos); }

  // --- FAT -------------------------------------------------------------
  //
  // **FAT 은 통째로 한 번 읽어 들고 있는다.** 항목마다 읽으면 항목마다 syscall
  // 이고, 빈 클러스터를 세는 일은 그것을 클러스터 수만큼 한다 - 128MB 디스크에서
  // 8,188 번이다. 실제로 트리 한 번 읽는 데 18ms 가 걸렸고, 그동안 **서버의
  // 이벤트 루프가 막힌다**. 시리얼 왕복이 30ms 인 자리에서 18ms 는 MSX 가
  // 기다리는 시간이다. FAT 한 벌은 여기서 가장 커도 128KB 라 그냥 다 읽는다.
  _fat() {
    if (!this._fatBuf)
      this._fatBuf = this.read(this.fatStart * SECTOR, this.fatsz * SECTOR);
    return this._fatBuf;
  }

  get(cluster) {
    const off = cluster * 2;
    const buf = this._fat();
    // 범위 밖은 0 으로 본다. 손상된 사슬이 끝 너머를 가리킬 수 있는데, 거기서
    // 던지면 화면 하나 보려다 서버가 죽는다.
    return off + 2 <= buf.length ? buf.readUInt16LE(off) : 0;
  }

  /** FAT 사본을 **전부** 고친다. 서로 다르게 두면 복구 도구를 부르는 셈이다. */
  set(cluster, value) {
    const v = Buffer.alloc(2);
    v.writeUInt16LE(value, 0);
    for (let n = 0; n < this.nfats; n++)
      this.write((this.fatStart + n * this.fatsz) * SECTOR + cluster * 2, v);
    // 들고 있는 사본도 같이 고친다. 안 그러면 방금 쓴 값을 다음 get 이 옛것으로
    // 읽는다 - normalize 는 지우면서 곧바로 되읽으므로 그 자리에서 어긋난다.
    if (this._fatBuf && cluster * 2 + 2 <= this._fatBuf.length)
      this._fatBuf.writeUInt16LE(value, cluster * 2);
  }

  chain(cluster) {
    const out = [];
    const seen = new Set();
    let c = cluster;
    while (c >= 2 && c < 0xfff8 && !seen.has(c)) {
      seen.add(c);
      out.push(c);
      c = this.get(c);
    }
    return out;
  }

  freeChain(cluster) { for (const c of this.chain(cluster)) this.set(c, 0); }

  /** 빈 클러스터 수. DIR 의 "bytes free" 가 세는 것과 같은 것을 센다. */
  freeCount() {
    let n = 0;
    for (let c = 2; c < this.clusters + 2; c++) if (this.get(c) === 0) n++;
    return n;
  }

  // --- 디렉터리 ---------------------------------------------------------
  dirSectors(cluster) {
    if (cluster === 0) {
      const out = [];
      for (let i = 0; i < this.rootSectors; i++) out.push(this.rootStart + i);
      return out;
    }
    const out = [];
    for (const c of this.chain(cluster))
      for (let i = 0; i < this.spc; i++) out.push(this.dataStart + (c - 2) * this.spc + i);
    return out;
  }

  /**
   * 디렉터리와 그 아래 전부를 돌려준다.
   *
   * 끝 표시(0x00)를 만나면 **디렉터리 전체를** 거기서 끝낸다 - fat16.py 의
   * entries() 가 그렇다. 예전에는 섹터마다 따로 끊고 다음 섹터를 계속 읽었는데,
   * 보통 이미지에서는 같아도 끝 표시 뒤에 무언가 남은 이미지에서는 파이썬과
   * 다른 클러스터를 풀었다.
   */
  freeTree(cluster) {
    for (const { ent } of this.entries(cluster)) {
      if (ent[0] === FREE || ent[11] === ATTR_LFN || (ent[11] & ATTR_VOLUME)) continue;
      const name8 = pyStrip(ent.subarray(0, 8).toString('latin1'));
      if (name8 === '.' || name8 === '..') continue;
      const child = ent.readUInt16LE(26);
      if (ent[11] & ATTR_DIR) this.freeTree(child);
      else if (child) this.freeChain(child);
    }
    this.freeChain(cluster);
  }

  // --- 쓰기 (fat16.py 를 따른다) -------------------------------------------

  /** 빈 클러스터 `count` 개를 앞에서부터 찾아 사슬로 잇고 쓰는 중으로 표시한다. */
  alloc(count) {
    const got = [];
    for (let c = 2; got.length < count && c < this.clusters + 2; c++)
      if (this.get(c) === 0) got.push(c);
    if (got.length < count)
      throw new DiskError(`disk full: needed ${count} clusters, ${got.length} free`);
    for (let i = 0; i + 1 < got.length; i++) this.set(got[i], got[i + 1]);
    this.set(got[got.length - 1], EOC);
    return got;
  }

  clusterOffset(cluster) { return (this.dataStart + (cluster - 2) * this.spc) * SECTOR; }

  /** 클러스터마다 한 조각씩. 모자란 끝은 0 으로 채운다. */
  writeClusters(clusters, data) {
    const size = this.spc * SECTOR;
    clusters.forEach((c, i) => {
      const chunk = Buffer.alloc(size);
      data.copy(chunk, 0, i * size, Math.min(data.length, (i + 1) * size));
      this.write(this.clusterOffset(c), chunk);
    });
  }

  readClusters(cluster, size = null) {
    const step = this.spc * SECTOR;
    const parts = [];
    let have = 0;
    for (const c of this.chain(cluster)) {
      parts.push(this.read(this.clusterOffset(c), step));
      have += step;
      if (size !== null && have >= size) break;
    }
    const out = Buffer.concat(parts);
    return size !== null ? out.subarray(0, size) : out;
  }

  /**
   * 쓰이고 있는 칸마다 {sec, off, ent}. 처음 나온 0x00 에서 디렉터리를 끝낸다.
   * 섹터 목록은 먼저 다 뽑는다 - 파이썬도 그렇다 (dir_sectors 가 리스트다).
   */
  *entries(cluster) {
    for (const sec of this.dirSectors(cluster)) {
      const data = this._sector(sec);
      for (let i = 0; i < SECTOR; i += 32) {
        const ent = data.subarray(i, i + 32);
        if (ent[0] === END_OF_DIR) return;
        yield { sec, off: i, ent };
      }
    }
  }

  /** 쓰이고 있는 11 바이트 이름들 (latin1 문자열). toShort 가 피해 간다. */
  names(cluster) {
    const out = new Set();
    for (const { ent } of this.entries(cluster)) {
      if (ent[0] === FREE || ent[11] === ATTR_LFN) continue;
      out.add(ent.subarray(0, 11).toString('latin1'));
    }
    return out;
  }

  /** `name11` 의 {sec, off, ent}, 없으면 null. */
  find(cluster, name11) {
    const want = Buffer.from(name11, 'latin1');
    for (const e of this.entries(cluster)) {
      if (e.ent[11] === ATTR_LFN || e.ent[0] === FREE) continue;
      if (e.ent.subarray(0, 11).equals(want)) return e;
    }
    return null;
  }

  /** 써 넣을 칸. 하위 디렉터리면 모자랄 때 클러스터 하나를 늘린다. */
  _freeSlot(cluster) {
    for (const sec of this.dirSectors(cluster)) {
      const data = this._sector(sec);
      for (let i = 0; i < SECTOR; i += 32)
        if (data[i] === END_OF_DIR || data[i] === FREE) return { sec, off: i };
    }
    if (cluster === 0)
      throw new DiskError(`the root directory is full (${this.rootEntries} entries)`);
    const fresh = this.alloc(1)[0];
    this.write(this.clusterOffset(fresh), Buffer.alloc(this.spc * SECTOR));
    const chain = this.chain(cluster);
    this.set(chain[chain.length - 1], fresh);
    this.set(fresh, EOC);
    return { sec: this.dataStart + (fresh - 2) * this.spc, off: 0 };
  }

  putEntry(cluster, name11, attr, first, size, epoch = null) {
    const loc = this.find(cluster, name11) || this._freeSlot(cluster);
    this.write(loc.sec * SECTOR + loc.off, packEntry(name11, attr, first, size, epoch));
    return loc;
  }

  /** `data` 를 `name11` 로 쓴다. 있던 것은 갈아 끼운다 (사슬을 먼저 돌려준다). */
  addFile(cluster, name11, data, epoch = null) {
    const old = this.find(cluster, name11);
    if (old) {
      const prev = old.ent.readUInt16LE(26);
      if (prev) this.freeChain(prev);
    }
    let first = 0;
    if (data.length) {
      const per = this.spc * SECTOR;
      const chain = this.alloc(Math.ceil(data.length / per));
      this.writeClusters(chain, data);
      first = chain[0];
    }
    this.putEntry(cluster, name11, ATTR_ARCHIVE, first, data.length, epoch);
  }

  /** 하위 디렉터리를 만들거나 (있으면) 찾아서, 첫 클러스터를 돌려준다. */
  mkdir(cluster, name11, epoch = null) {
    const found = this.find(cluster, name11);
    if (found && (found.ent[11] & ATTR_DIR)) return found.ent.readUInt16LE(26);
    if (found) throw new DiskError(`${pyStrip(name11)} exists and is not a directory`);

    const fresh = this.alloc(1)[0];
    this.write(this.clusterOffset(fresh), Buffer.alloc(this.spc * SECTOR));
    // ".." 는 부모를 가리키고, 루트는 클러스터 번호가 없어도 0 으로 적는다 -
    // 규격이 그렇게 말한다.
    this.write(this.clusterOffset(fresh), Buffer.concat([
      packEntry('.          ', ATTR_DIR, fresh, 0, epoch),
      packEntry('..         ', ATTR_DIR, cluster, 0, epoch)]));
    this.putEntry(cluster, name11, ATTR_DIR, fresh, 0, epoch);
    return fresh;
  }

  /** 파일이나 디렉터리 나무를 지운다. 무언가 있었으면 true. */
  remove(cluster, name11) {
    const found = this.find(cluster, name11);
    if (!found) return false;
    const first = found.ent.readUInt16LE(26);
    if (found.ent[11] & ATTR_DIR) this.freeTree(first);
    else if (first) this.freeChain(first);
    this.write(found.sec * SECTOR + found.off, Buffer.from([FREE]));
    return true;
  }

  /**
   * 있는 항목에 새 11 바이트 이름을 준다. **아무것도 옮기지 않는다.** 앞에 붙은
   * LFN 기록은 옛 긴 이름을 들고 있으므로 지운다 - 두면 macOS 는 옛 이름을,
   * MSX 는 새 이름을 보여 준다.
   */
  rename(cluster, name11, new11) {
    const want = Buffer.from(name11, 'latin1');
    let lfn = [];
    for (const { sec, off, ent } of this.entries(cluster)) {
      if (ent[0] === FREE) { lfn = []; continue; }
      if (ent[11] === ATTR_LFN) { lfn.push([sec, off]); continue; }
      if (ent.subarray(0, 11).equals(want)) {
        this.write(sec * SECTOR + off, Buffer.from(new11, 'latin1'));
        for (const [s_, o_] of lfn) this.write(s_ * SECTOR + o_, Buffer.from([FREE]));
        return true;
      }
      lfn = [];
    }
    return false;
  }

  /** 쓴 것을 디스크까지 밀어 넣는다. */
  sync() { fs.fsyncSync(this.fd); }
}

/** 디스크가 차거나 루트가 차는 것처럼, 이미지는 멀쩡하고 일이 안 된 경우. */
export class DiskError extends Error {}

export const EOC = 0xffff;
export const END_OF_DIR = 0x00;
export const ATTR_ARCHIVE = 0x20;

//: FAT 이 짧은 이름에 허락하는 글자. 나머지는 "_" 가 된다.
export const SHORT_OK = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%'-_@~`!(){}^#&");

// **파이썬의 공백이다.** strip()/rstrip() 이 지우는 것과 같은 집합이어야 이름이
// 같게 나온다. JS 의 \s 와는 다르다: 파이썬은 \x1c-\x1f 와 \x85 를 공백으로
// 보고, \ufeff 는 공백으로 보지 않는다. latin1 로 읽은 이름에서 0x85 와 0xA0
// 은 실제로 나올 수 있는 바이트다.
const PY_WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_HEAD = new RegExp(`^[${PY_WS}]+`, 'u');
const WS_TAIL = new RegExp(`[${PY_WS}]+$`, 'u');
export const pyRstrip = (s) => String(s).replace(WS_TAIL, '');
export const pyStrip = (s) => String(s).replace(WS_HEAD, '').replace(WS_TAIL, '');

/** 파이썬 sorted() 의 순서: 코드 포인트로 견준다 (JS 기본은 UTF-16 단위다). */
export function pySorted(list) {
  const key = (s) => Array.from(s, (ch) => ch.codePointAt(0));
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}

/** FAT16 이 적는 (날짜, 시각). 1980 년 이전은 적을 수 없다. 지역 시각이다. */
export function fatTime(epoch = null) {
  const t = new Date(epoch === null ? Date.now() : epoch * 1000);
  const year = Math.max(t.getFullYear(), 1980);
  const date = ((year - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
  const tm = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1);
  return [date, tm];
}

/** 디렉터리 항목 32 바이트 (struct "<11sBBBHHHHHHHI"). */
function packEntry(name11, attr, first, size, epoch) {
  const [date, tm] = fatTime(epoch);
  const e = Buffer.alloc(32);
  Buffer.from(name11, 'latin1').copy(e, 0, 0, 11);
  e[11] = attr;
  e.writeUInt16LE(tm, 14);      // 만든 시각
  e.writeUInt16LE(date, 16);    // 만든 날짜
  e.writeUInt16LE(date, 18);    // 마지막 접근 날짜
  e.writeUInt16LE(0, 20);       // 클러스터 윗 16 비트 (FAT32 만)
  e.writeUInt16LE(tm, 22);      // 고친 시각
  e.writeUInt16LE(date, 24);    // 고친 날짜
  e.writeUInt16LE(first, 26);
  e.writeUInt32LE(size >>> 0, 28);
  return e;
}

/** 이미지를 고치려고 연다. 다 쓰면 closeSync(fat.fd). */
export function openImage(path, mode = 'r+') {
  const fd = fs.openSync(path, mode);
  try { return new Fat(fd); } catch (e) { fs.closeSync(fd); throw e; }
}

// --- 이름 --------------------------------------------------------------------

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - Array.from(s).length));
const mapShort = (s) => Array.from(s.toUpperCase(), (c) => (SHORT_OK.has(c) ? c : '_')).join('');

/**
 * `name` 을 8.3 한 쌍으로. 맞지 않으면 FAT 의 답 `NAME~1` 을 주고, `taken`
 * (11 바이트 이름들) 과 부딪히지 않게 번호를 올린다. 맞는 이름은 이미 있어도
 * 그대로 쓴다 - 같은 파일을 다시 넣는 것은 갈아 끼우는 것이다.
 */
export function toShort(name, taken = new Set()) {
  const at = name.lastIndexOf('.');
  let base = at >= 0 ? name.slice(0, at) : '';
  let ext = at >= 0 ? name.slice(at + 1) : name;
  if (!base) { base = ext; ext = ''; }
  base = mapShort(base);
  ext = Array.from(mapShort(ext)).slice(0, 3).join('');
  base = base || '_';
  const packed = (b) => pad(b, 8) + pad(ext, 3);
  if (Array.from(base).length <= 8) return packed(base);
  for (let n = 1; n < 1000000; n++) {
    const suffix = `~${n}`;
    const stem = Array.from(base).slice(0, 8 - suffix.length).join('') + suffix;
    if (!taken.has(packed(stem))) return packed(stem);
  }
  throw new Error(`no free short name for ${name}`);
}

/**
 * `name` 을 저장될 11 바이트로, 8.3 에 맞지 않으면 null. **줄이지 않고 거절한다**
 * - 이름을 지금 고르는 중이라면, 친 것과 다른 것을 저장하는 것이 사고다.
 */
export function as83(name) {
  name = pyStrip(String(name));
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
    return null;
  const at = name.lastIndexOf('.');
  let base, ext;
  if (at < 0) { base = name; ext = ''; }
  else {
    base = name.slice(0, at); ext = name.slice(at + 1);
    if (!ext) return null;             // 끝의 점. DOS 는 떼고 저장한다 - 친 것과 다르다
  }
  base = base.toUpperCase(); ext = ext.toUpperCase();
  const bl = Array.from(base).length, el = Array.from(ext).length;
  if (bl < 1 || bl > 8 || el > 3) return null;
  if (Array.from(base + ext).some((c) => !SHORT_OK.has(c))) return null;
  return pad(base, 8) + pad(ext, 3);
}

/** 저장된 11 바이트를 `NAME.EXT` 로 - MSX 가 보여 주는 모양. */
export function shownName(name11) {
  const base = pyRstrip(name11.slice(0, 8)), ext = pyRstrip(name11.slice(8));
  return ext ? `${base}.${ext}` : base;
}

/** `a/b\\c` -> ['a', 'b', 'c']. 빈 조각과 `.` 은 버린다. */
export function splitPath(p) {
  return String(p).replace(/\\/g, '/').split('/').map(pyStrip).filter((x) => x && x !== '.');
}

/** 한 디렉터리에서 `want` 의 저장된 이름. 대소문자 무시, `NAME.EXT` 도 날것도 받는다. */
export function matchIn(fat, cluster, want) {
  want = pyStrip(want).toUpperCase();
  for (const { ent } of fat.entries(cluster)) {
    if (ent[0] === FREE || ent[11] === ATTR_LFN || (ent[11] & ATTR_VOLUME)) continue;
    const n8 = pyStrip(ent.subarray(0, 8).toString('latin1'));
    if (n8 === '.' || n8 === '..') continue;
    const name11 = ent.subarray(0, 11).toString('latin1');
    if (shownName(name11).toUpperCase() === want || pyRstrip(name11).toUpperCase() === want)
      return name11;
  }
  return null;
}

/** 있는 것으로 아는 이름의 {isDir, size, first}. */
export function entryOf(fat, cluster, name11) {
  const got = fat.find(cluster, name11);
  if (!got) return null;
  return { isDir: !!(got.ent[11] & ATTR_DIR), size: got.ent.readUInt32LE(28),
           first: got.ent.readUInt16LE(26) };
}

/** `A/B/C` -> {parent, name11, isDir}, 없으면 null (호출한 쪽이 빠진 것을 모아 말한다). */
export function resolvePath(fat, p) {
  const parts = splitPath(p);
  if (!parts.length) return null;
  let cluster = 0;
  for (const part of parts.slice(0, -1)) {
    const name11 = matchIn(fat, cluster, part);
    if (!name11) return null;
    const got = entryOf(fat, cluster, name11);
    if (!got || !got.isDir) return null;
    cluster = got.first;
  }
  const name11 = matchIn(fat, cluster, parts[parts.length - 1]);
  if (!name11) return null;
  const got = entryOf(fat, cluster, name11);
  return got ? { parent: cluster, name11, isDir: got.isDir } : null;
}

/** `p` 에 있는 디렉터리의 클러스터. 빈 경로는 루트(0). 없거나 파일이면 null. */
export function resolveDir(fat, p) {
  const parts = splitPath(p);
  if (!parts.length) return 0;
  const got = resolvePath(fat, parts.join('/'));
  if (!got || !got.isDir) return null;
  return entryOf(fat, got.parent, got.name11).first;
}

/** 긴 이름을 LFN 기록에서 되짚는다 (거꾸로 들어 있다). */
export function lfnText(entries) {
  let out = '';
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k];
    const chunk = Buffer.concat([e.subarray(1, 11), e.subarray(14, 26), e.subarray(28, 32)]);
    out += chunk.toString('utf16le');
  }
  return out.split(' ')[0];
}

/** 8.3 이름을 `NAME.EXT` 로. MSX 가 보는 바로 그 이름이다. */
export function shortText(ent) {
  const base = ent.subarray(0, 8).toString('latin1').replace(/\s+$/, '');
  const ext = ent.subarray(8, 11).toString('latin1').replace(/\s+$/, '');
  return ext ? `${base}.${ext}` : base;
}
