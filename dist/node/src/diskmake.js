// SPDX-License-Identifier: GPL-2.0-only
//
// diskmake.js — Nextor 가 받아 주는 FAT16 이미지를 처음부터 만들고, 옆의
// system/ 과 user-files/ 로 채우거나 따라잡게 한다.
//
// src/host/ 의 make_disk.py, build_disk.py, stage_user_files.py 를 옮겼다
// (2026-09-25). 이미지에 남는 바이트가 파이썬과 같은지는 test/disk_crosscheck.py
// 가 본다.
//
// **왜 hdiutil / mkfs.vfat 이 아닌가.** 둘 다 멀쩡한 FAT16 을 만들지만 Nextor 가
// 마운트를 거절한다. Nextor 의 FDISK 가 만든 것과 필드마다 견주었다:
//
//     필드             hdiutil            Nextor FDISK
//     MBR 타입         0x06 (FAT16 CHS)   0x0E (FAT16 LBA)
//     MBR CHS          h254 s63 c1023     전부 0
//     부트 플래그      0x00               0x80
//     미디어           0xF8               0xF0
//     트랙당 섹터      32                 0
//     헤드             16                 0
//     숨은 섹터        1                  0
//
// 여기서 쓰면 그 필드가 전부 우리 것이다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from './disktools.js';
import { pySorted } from './fat.js';

const say = (s = '') => console.log(s);

const SECTOR = 512;
const FAT16_MAX_CLUSTERS = 65524;         // 넘으면 FAT32
//: 이보다 클러스터가 적으면 규격은 FAT12 로 친다 - BPB 의 글자가 아니라 클러스터
//: 수가 타입을 정한다. 여기 도구들은 16 비트 항목만 읽고 쓴다.
const FAT12_MAX_CLUSTERS = 4084;
const ROOT_ENTRIES = 512;
const RESERVED = 1;
const NUM_FATS = 2;
const MEDIA = 0xf0;                       // FDISK 가 쓰는 값 (PC 는 보통 0xF8)
const PART_START = 1;                     // FDISK 는 MBR 바로 다음에 파티션을 둔다
const PART_TYPE = 0x0e;                   // FAT16 LBA - Nextor 가 쓰는 타입

//: 순서가 선호다. 16KB 가 목표고 나머지는 두 방향의 비상구다.
const CLUSTER_PREFERENCE = [32, 64, 16, 8, 4];   // 16KB, 32KB, 8KB, 4KB, 2KB
//: FAT12 절벽에서 이만큼은 떨어져야 받는다. 가장 큰 클러스터를 고르면 가장 적은
//: 클러스터 수를 노리게 되고, 그것은 절벽으로 걸어가는 것이다.
const FAT12_MARGIN = 256;

/**
 * FAT16 안에 넉넉히 머무는 가장 큰 클러스터. FAT 은 시리얼로 섹터 하나씩 읽히고
 * DIR 은 "bytes free" 한 줄을 위해 FAT 을 다 훑는다 - 2KB 클러스터의 128MB 는
 * FAT 이 128KB 라 그 한 줄에 256 왕복이다. 16KB 면 32 왕복이다.
 */
export function pickClusterSectors(partSectors) {
  const rootSectors = Math.ceil((ROOT_ENTRIES * 32) / SECTOR);
  for (const spc of CLUSTER_PREFERENCE) {
    // FAT 크기는 클러스터 수에, 클러스터 수는 FAT 크기에 달렸다. 몇 번이면 모인다.
    let fatSectors = 1;
    let converged = false;
    for (let k = 0; k < 8; k++) {
      const data = partSectors - RESERVED - NUM_FATS * fatSectors - rootSectors;
      if (data <= 0) { converged = true; break; }
      const clusters = Math.floor(data / spc);
      const need = Math.ceil(((clusters + 2) * 2) / SECTOR);
      if (need === fatSectors) { converged = true; break; }
      fatSectors = need;
    }
    if (!converged) continue;
    const data = partSectors - RESERVED - NUM_FATS * fatSectors - rootSectors;
    const clusters = data > 0 ? Math.floor(data / spc) : 0;
    if (FAT12_MAX_CLUSTERS + FAT12_MARGIN < clusters && clusters <= FAT16_MAX_CLUSTERS)
      return { spc, fatSectors, clusters };
  }
  return null;
}

function buildMbr(partStart, partSectors) {
  const mbr = Buffer.alloc(SECTOR);
  const e = 0x1be;
  mbr[e] = 0x80;                          // active
  mbr[e + 4] = PART_TYPE;                 // CHS 는 FDISK 처럼 0 으로 둔다
  mbr.writeUInt32LE(partStart, e + 8);
  mbr.writeUInt32LE(partSectors, e + 12);
  mbr[510] = 0x55; mbr[511] = 0xaa;
  return mbr;
}

function buildBoot(volname, spc, fatSectors, totalSectors) {
  const b = Buffer.alloc(SECTOR);
  b.set([0xeb, 0xfe, 0x90], 0);           // jmp $ - 부팅 코드가 아니다
  b.write('MSXPDSER', 3, 'latin1');        // 8 바이트 꼭 맞게 (파이썬은 9 바이트를 넣어 한 칸 밀렸었다)
  b.writeUInt16LE(SECTOR, 11);
  b[13] = spc;
  b.writeUInt16LE(RESERVED, 14);
  b[16] = NUM_FATS;
  b.writeUInt16LE(ROOT_ENTRIES, 17);
  b.writeUInt16LE(0, 19);                 // total16 은 안 쓴다 - 값은 total32 에
  b[21] = MEDIA;
  b.writeUInt16LE(fatSectors, 22);
  // 트랙당 섹터, 헤드, 숨은 섹터 - FDISK 는 0 을 쓴다
  b.writeUInt32LE(totalSectors, 32);
  b[36] = 0x00;                           // 드라이브 번호
  b[38] = 0x29;                           // 확장 부트 서명
  // 볼륨 이름: 앞 11 글자를 대문자로, 공백으로 채우고, ASCII 가 아니면 '?'
  const vol = Array.from(Array.from(volname).slice(0, 11).join('').toUpperCase().padEnd(11),
    (c) => (c.codePointAt(0) < 0x80 ? c : '?')).join('');
  Buffer.from(vol, 'latin1').copy(b, 43, 0, 11);
  b.write('FAT16   ', 54, 'latin1');
  b[510] = 0x55; b[511] = 0xaa;
  return b;
}

function buildFat(fatSectors) {
  const fat = Buffer.alloc(fatSectors * SECTOR);
  fat[0] = MEDIA; fat[1] = 0xff;          // 첫 항목은 미디어 바이트를 따라 적는다
  fat[2] = 0xff; fat[3] = 0xff;           // 둘째 항목: 사슬 끝
  return fat;
}

export function parseSize(text) {
  const t = String(text).trim().toLowerCase();
  if (t.endsWith('g')) return Math.trunc(Number(t.slice(0, -1)) * 1024);
  if (t.endsWith('m')) return strictInt(t.slice(0, -1));
  return strictInt(t);
}

function strictInt(s) {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error(`invalid literal for int(): '${s}'`);
  return Number.parseInt(s, 10);
}

const USAGE = `make_disk - build a FAT16 disk image that Nextor accepts.

    make_disk <image> [128m] [VOLNAME]

Sizes from 9m to 2047m (or 1g). The layout mirrors Nextor's own FDISK: one
partition of type 0x0E, active, CHS zeroed, media 0xF0.`;

/** make_disk.py 의 main. argv 는 [이름, image, size?, volname?]. */
export function makeDisk(argv) {
  if (argv.length < 2) { say(USAGE); return 1; }
  const file = argv[1];
  let mb;
  try { mb = argv.length > 2 ? parseSize(argv[2]) : 128; } catch (e) {
    say(`[-] ${e.message}`); return 1;
  }
  const volname = argv.length > 3 ? argv[3] : 'MSXDISK';

  // 아래 9MB 는 용량이 아니라 **타입**이다 (2KB 클러스터 8MB 는 4079 클러스터 =
  // FAT12). 위 2047 도 타입이다 (2048MB 는 32KB 클러스터로도 FAT32 영역).
  if (!(mb >= 9 && mb <= 2047)) {
    say('[-] size must be between 9MB and 2047MB.');
    say('    Below 9MB a 2KB-cluster volume has fewer than 4085 clusters,');
    say('    which the FAT spec calls FAT12 - and these tools only');
    say('    speak FAT16.');
    return 1;
  }
  const totalSectors = Math.floor((mb * 1024 * 1024) / SECTOR);
  // FDISK 는 양 끝에 섹터 하나씩을 비워 둔다. 따라 한다.
  const partSectors = totalSectors - PART_START - 1;
  const bpbSectors = partSectors - 1;
  const pick = pickClusterSectors(bpbSectors);
  if (!pick) { say(`[-] no FAT16 geometry fits ${mb}MB`); return 1; }
  const { spc, fatSectors, clusters } = pick;
  const rootSectors = Math.ceil((ROOT_ENTRIES * 32) / SECTOR);

  const fd = fs.openSync(file, 'w');
  try {
    let pos = 0;
    const put_ = (buf) => { fs.writeSync(fd, buf, 0, buf.length, pos); pos += buf.length; };
    put_(buildMbr(PART_START, partSectors));
    put_(buildBoot(volname, spc, fatSectors, bpbSectors));
    for (let i = 0; i < NUM_FATS; i++) put_(buildFat(fatSectors));
    put_(Buffer.alloc(rootSectors * SECTOR));
    fs.ftruncateSync(fd, totalSectors * SECTOR);   // 나머지는 쓰지 않고 늘린다
  } finally { fs.closeSync(fd); }

  const hex = PART_TYPE.toString(16).toUpperCase().padStart(2, '0');
  say(`[+] ${file}  ${mb}MB`);
  say(`    partition   LBA ${PART_START}, ${partSectors} sectors, type 0x${hex} (FAT16 LBA), active`);
  say(`    cluster     ${spc} sectors (${(spc * SECTOR) / 1024}KB)`);
  say(`    clusters    ${clusters}  (FAT16 limit ${FAT16_MAX_CLUSTERS})`);
  say(`    FAT         ${NUM_FATS} x ${fatSectors} sectors, root ${ROOT_ENTRIES} entries`);
  say(`    volume      ${volname.toUpperCase()}`);
  return 0;
}

// ===================================================================== staging

/** 8.3 에 맞는가 (stage_user_files 의 판정 - 첫 점에서 가른다). */
export function fits83(name) {
  const at = name.indexOf('.');
  const base = at >= 0 ? name.slice(0, at) : name;
  const ext = at >= 0 ? name.slice(at + 1) : '';
  const bl = Array.from(base).length;
  return !ext.includes('.') && !name.includes(' ') && bl >= 1 && bl <= 8
    && Array.from(ext).length <= 3;
}

/**
 * user-files/ 를 디스크에 넣을 모양으로 `dst` 에 옮긴다. system/ 의 이름은 이미
 * 쓰인 것으로 본다. 넣은 파일 수를 돌려준다.
 *
 * 이름은 대문자로 (macOS 는 소문자 표시를 따로 적는데 MSX 는 못 본다). system/
 * 과 부딪히면 건너뛰고 말한다. 8.3 을 넘는 이름은 바꾸지 않고 알린다 - FAT 이
 * 지어 주는 이름(SOFAR~14)은 무엇이 먼저 들어갔느냐로 달라진다. README 와 점
 * 파일은 두고 간다. 내용만 옮긴다 - 확장 속성은 1983 년 디스크의 것이 아니다.
 */
export function stageUserFiles(src, system, dst) {
  const taken = isDir(system)
    ? new Set(fs.readdirSync(system).map((n) => n.toUpperCase())) : new Set();
  const longNames = [];
  let staged = 0;

  const walk = (dir, rel) => {
    const names = fs.readdirSync(dir);
    const dirsAll = [];
    const files = [];
    for (const n of names) (isDir(path.join(dir, n)) ? dirsAll : files).push(n);
    let dirs = pySorted(dirsAll.filter((d) => !d.startsWith('.')));
    const out = path.join(dst, ...rel.split(path.sep).filter(Boolean).map((p) => p.toUpperCase()));
    fs.mkdirSync(out, { recursive: true });

    for (const d of [...dirs]) {
      if (!rel && taken.has(d.toUpperCase())) {
        say(`[!] user-files/${d}/ skipped - system/ has that name`);
        dirs = dirs.filter((x) => x !== d);
      } else if (!fits83(d)) longNames.push(`${rel}${d}/`);
    }
    for (const f of pySorted(files)) {
      if (f.startsWith('.') || f.toLowerCase() === 'readme.md') continue;
      if (!rel && taken.has(f.toUpperCase())) {
        say(`[!] user-files/${f} skipped - system/ has that name`);
        continue;
      }
      if (!fits83(f)) longNames.push(rel + f);
      fs.writeFileSync(path.join(out, f.toUpperCase()), fs.readFileSync(path.join(dir, f)));
      staged += 1;
    }
    // os.walk 처럼: 링크로 된 폴더는 목록에는 들지만 안으로 들어가지 않는다.
    for (const d of dirs) {
      const full = path.join(dir, d);
      if (!fs.lstatSync(full).isSymbolicLink()) walk(full, `${rel}${d}${path.sep}`);
    }
  };
  walk(src, '');

  // 인터넷이 붙인 이름의 ROM 폴더는 이런 것이 수십 개라 세어서 말한다.
  if (longNames.length) {
    for (const n of longNames.slice(0, 5))
      say(`[!] ${n} does not fit 8.3 - the MSX will see a name FAT invents`);
    if (longNames.length > 5) say(`[!] ...and ${longNames.length - 5} more`);
    say('    They are still copied. Shorten the ones you mean to type - anything named in AUTOEXEC.BAT above all.');
  }
  return staged;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// ===================================================================== build

const folders = (root) => [path.join(root, 'system'), path.join(root, 'user-files')];

function check(root) {
  const [system] = folders(root);
  if (!isDir(system)) { say(`[-] no system/ folder in ${root}`); return null; }
  const real = pySorted(fs.readdirSync(system))
    .filter((e) => !e.startsWith('.') && e.toLowerCase() !== 'readme.md');
  if (!real.length) {
    say('[-] system/ is empty - the image would boot to nothing.');
    say('    ./src/msx-tools/build.sh fills it (or ./src/stage_dist.sh');
    say('    for the two Nextor files, if you have no sdcc).');
    return null;
  }
  return real;
}

function stageUser(root) {
  const [system, user] = folders(root);
  if (!isDir(user)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picodock-stage-'));
  const n = stageUserFiles(user, system, tmp);
  if (!n) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
  return tmp;
}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && r.length < p.length ? r : p;
}

/** 없는 디스크를 만든다. 있으면 거절한다 - 다시 만들면 MSX 가 쓴 것이 사라진다. */
export async function build(root, size = '128m', image = null, volume = 'MSXDISK', withUser = true) {
  const [system] = folders(root);
  const real = check(root);
  if (real === null) return 1;
  image = image || path.join(root, 'picodock.img');
  if (fs.existsSync(image)) {
    say(`[!] ${rel(image)} exists already.`);
    say('    Making it again would discard whatever is on it. Move it');
    say('    aside, or use sync-disk to update it in place.');
    return 1;
  }
  const rc = makeDisk(['make_disk', image, size, volume]);
  if (rc) return rc;
  say();
  const tmp = withUser ? stageUser(root) : null;
  try {
    const contents = [system, ...(tmp ? [tmp] : [])];
    say(`[*] system/ (${real.length} files)${tmp ? ', user-files/' : withUser ? '' : ', user-files/ skipped'}`);
    return await put(image, [], contents);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** user-files/ 를 있는 디스크에 따라잡게 한다. 덮어쓰기만 하고 지우지 않는다. */
export async function sync(root, image = null) {
  if (check(root) === null) return 1;
  image = image || path.join(root, 'picodock.img');
  let file = false;
  try { file = fs.statSync(image).isFile(); } catch { /* 없다 */ }
  if (!file) {
    say(`[-] no disk image at ${rel(image)}`);
    say('    make one first:  make-disk');
    return 1;
  }
  const tmp = stageUser(root);
  if (!tmp) {
    say('[*] nothing to copy - user-files/ holds no files the disk can take.');
    return 0;
  }
  try { return await put(image, [], [tmp]); } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function buildMain(argv) {
  if (argv.length < 3 || !['make', 'bare', 'sync'].includes(argv[1])) {
    say('    build_disk make <dist/disk> [size] [image] [volume]\n'
      + '    build_disk bare <dist/disk> [size] [image] [volume]\n'
      + '    build_disk sync <dist/disk> [image]');
    return 2;
  }
  const [, what, root, ...rest] = argv;
  if (what === 'make' || what === 'bare')
    return build(root, rest[0] ?? '128m', rest[1] ?? null, rest[2] ?? 'MSXDISK', what === 'make');
  return sync(root, rest[0] ?? null);
}

export async function stageMain(argv) {
  if (argv.length !== 4) {
    say('    python3 stage_user_files.py <user-files> <system> <staging-dir>'
      .replace('python3 stage_user_files.py', 'stage_user_files'));
    return 2;
  }
  const [, src, system, dst] = argv;
  if (!isDir(src)) { say(`[-] no such folder: ${src}`); return 1; }
  say(`staged ${stageUserFiles(src, system, dst)}`);
  return 0;
}
