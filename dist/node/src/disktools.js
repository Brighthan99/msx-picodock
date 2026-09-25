// SPDX-License-Identifier: GPL-2.0-only
//
// disktools.js — MSX 디스크 이미지에 파일을 넣고, 지우고, 이름을 바꾸고, 폴더를
// 만들고, 글 파일을 고친다. 마운트하지 않는다.
//
// src/host/ 의 disk_put.py / disk_rm.py / disk_mv.py / disk_mkdir.py /
// disk_text.py 를 옮겼다 (2026-09-25). 사용자가 파이썬을 깔지 않아도 되게 하려고.
// 찍는 문구와 종료 코드까지 그대로다 - 스크립트와 문서와 사람의 기억이 그 문구를
// 알고 있다. 이미지에 남는 바이트가 파이썬과 같은지는 test/disk_crosscheck.py 가
// 본다.
//
// 모두 서버를 먼저 비켜 세운다 (diskhold.js). 서버는 캐시 없이 파일에서 바로
// 읽어 넘기므로, 여기서 쓴 것이 쓰는 도중에도 MSX 에 보인다.

import fs from 'node:fs';
import path from 'node:path';
import {
  openImage, toShort, as83, shownName, splitPath, matchIn, entryOf, resolvePath,
  resolveDir, pyRstrip, pyStrip, pySorted, DiskError, FREE, ATTR_DIR, ATTR_LFN,
  ATTR_VOLUME,
} from './fat.js';
import { Hold, HoldError } from './diskhold.js';
import { decode, encode, DecodeError, EncodeError, LookupError } from './codecs.js';

const say = (s = '') => console.log(s);
const lpad = (s, n) => String(s).padEnd(n);
const rpad = (n, w) => String(n).padStart(w);

/** 이미지를 연 채로 fn 을 돌리고, 끝나면 디스크까지 밀어 넣고 닫는다. */
function withImage(image, mode, fn) {
  const fat = openImage(image, mode);
  try { return fn(fat); } finally {
    try { if (mode !== 'r') fat.sync(); } finally { fs.closeSync(fat.fd); }
  }
}

/** 서버를 세우고 fn. 못 세우면 "[-] 왜" 를 찍고 1. */
async function held(image, fn, onHoldFail = (e) => { say(`[-] ${e.message}`); return 1; }) {
  const hold = new Hold(image);
  try { await hold.enter(); } catch (e) {
    if (e instanceof HoldError) return onHoldFail(e);
    throw e;
  }
  const onSig = () => { hold.release(); process.exit(130); };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  try { return await fn(); } finally {
    hold.release();
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
}

/** 이미지가 멀쩡한데 일이 안 된 경우 (디스크가 참, 원본을 못 읽음 ...). */
const isIoError = (e) => e instanceof DiskError || (e && typeof e.code === 'string');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const mtime = (p) => fs.statSync(p).mtimeMs / 1000;
const listdir = (d) => pySorted(fs.readdirSync(d));

// =========================================================================== put

function putFile(fat, dirCluster, p, taken, renamed) {
  const data = fs.readFileSync(p);
  const name = path.basename(p);
  const name11 = toShort(name, taken);
  taken.add(name11);
  const shown = `${pyRstrip(name11.slice(0, 8))}.${pyRstrip(name11.slice(8))}`.replace(/\.+$/, '');
  if (shown.toUpperCase() !== name.toUpperCase()) renamed.push([name, shown]);
  fat.addFile(dirCluster, name11, data, mtime(p));
  return [shown, data.length];
}

function putTree(fat, dirCluster, p, taken, renamed, out) {
  const name = path.basename(p.replace(new RegExp(`\\${path.sep}+$`), ''));
  const name11 = toShort(name, taken);
  taken.add(name11);
  const sub = fat.mkdir(dirCluster, name11, mtime(p));
  const subTaken = fat.names(sub);
  let n = 0;
  for (const child of listdir(p)) {
    if (child.startsWith('.')) continue;            // .DS_Store 같은 것은 두고 간다
    const full = path.join(p, child);
    if (isDir(full)) n += putTree(fat, sub, full, subTaken, renamed, out);
    else { putFile(fat, sub, full, subTaken, renamed); n += 1; }
  }
  out.push([`${pyRstrip(name11.slice(0, 8))}/`, n]);
  return n;
}

function putAll(fat, paths, contents, dest) {
  paths = [...paths];
  for (const d of contents) {
    if (!isDir(d)) { say(`[-] not a folder: ${d}`); return 1; }
    for (const e of listdir(d)) if (!e.startsWith('.')) paths.push(path.join(d, e));
  }
  const taken = fat.names(dest);
  const renamed = [];
  const dirs = [];
  for (const p of paths) {
    if (!exists(p)) { say(`[-] no such file: ${p}`); return 1; }
    if (isDir(p)) putTree(fat, dest, p, taken, renamed, dirs);
    else {
      const [shown, size] = putFile(fat, dest, p, taken, renamed);
      say(`[+] ${lpad(shown, 13)} ${rpad(size, 7)}`);
    }
  }
  for (const [name, n] of dirs) say(`[+] ${lpad(name, 13)} ${rpad(n, 7)} file(s)`);

  if (renamed.length) {
    say();
    for (const [was, now] of renamed.slice(0, 5)) say(`[!] ${was} -> ${now}`);
    if (renamed.length > 5) say(`[!] ...and ${renamed.length - 5} more`);
    say('    FAT has no room for the long name. The number in ~1 depends on what');
    say('    else went on and when, so check before naming one in AUTOEXEC.BAT.');
  }
  return 0;
}

/**
 * `paths` 는 그 자체로, `contents` 폴더들은 **안에 든 것이** 들어간다. `into` 는
 * 디스크 안의 목적지 폴더 (이미 있어야 한다).
 */
export async function put(image, paths, contents = [], into = '') {
  return held(image, () => {
    let fat;
    try { fat = openImage(image); } catch (e) { say(`[-] ${e.message}`); return 1; }
    try {
      const dest = resolveDir(fat, into);
      if (dest === null) {
        say(`[-] no such folder on the disk: ${into}`);
        say('    Folders are 8.3 as the MSX sees them, and it has to exist already.');
        return 1;
      }
      return putAll(fat, paths, contents, dest);
    } catch (e) {
      if (!isIoError(e)) throw e;
      // 도중에 자리가 모자라면 이미 쓴 항목은 그대로, 실패한 파일은 없다 -
      // 이미지는 멀쩡하다. 트레이스백 대신 어느 것이 안 들어갔는지 말한다.
      say(`[-] ${e.message}`);
      say('    Nothing was corrupted; the files before this one are on the disk.');
      return 1;
    } finally {
      try { fat.sync(); } finally { fs.closeSync(fat.fd); }
    }
  });
}

export async function putMain(argv) {
  const args = argv.slice(1);
  const contents = [];
  let into = '';
  const rest = [];
  for (let i = 0; i < args.length;) {
    if ((args[i] === '-c' || args[i] === '--contents') && i + 1 < args.length) {
      contents.push(args[i + 1]); i += 2;
    } else if ((args[i] === '-i' || args[i] === '--into') && i + 1 < args.length) {
      into = args[i + 1]; i += 2;
    } else { rest.push(args[i]); i += 1; }
  }
  if (!rest.length || (rest.length < 2 && !contents.length)) {
    say(`usage: ${path.basename(argv[0])} <image> [-i DEST] [-c FOLDER] [file-or-dir...]`);
    say('       -c FOLDER puts what is *inside* FOLDER on the disk');
    say('       -i DEST   puts them in DEST on the disk (e.g. GAMES),');
    say('                 which has to exist already. Default: the root');
    return 2;
  }
  const [image, ...paths] = rest;
  if (!isFile(image)) { say(`[-] no such image: ${image}`); return 1; }
  return put(image, paths, contents, into);
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ============================================================================ rm

/** 한 디렉터리의 [name11, {isDir, size}] - FAT 이 들고 있는 순서대로. */
function listing(fat, cluster) {
  const out = new Map();
  for (const { ent } of fat.entries(cluster)) {
    if (ent[0] === FREE || ent[11] === ATTR_LFN || (ent[11] & ATTR_VOLUME)) continue;
    const n8 = pyStrip(ent.subarray(0, 8).toString('latin1'));
    if (n8 === '.' || n8 === '..') continue;
    out.set(ent.subarray(0, 11).toString('latin1'),
            { isDir: !!(ent[11] & ATTR_DIR), size: ent.readUInt32LE(28) });
  }
  return out;
}

export function show(image) {
  return withImage(image, 'r+', (fat) => {
    const l = listing(fat, 0);
    if (!l.size) { say('[*] the disk is empty'); return 0; }
    for (const [name11, { isDir: d, size }] of l)
      say(`  ${lpad(shownName(name11), 13)} ${d ? '<DIR>' : rpad(size, 7)}`);
    return 0;
  });
}

export async function remove(image, names, recursive = false) {
  const rc = await held(image, () => {
    const fat = openImage(image);
    try {
      // 하나라도 지우기 전에 이름을 전부 풀어 본다.
      const targets = [];
      const missing = [];
      for (const want of names) {
        const got = resolvePath(fat, want);
        if (got) targets.push([want, got]); else missing.push(want);
      }
      if (missing.length) {
        for (const m of missing) say(`[-] not on the disk: ${m}`);
        say('    Nothing was removed. Names are 8.3 as the MSX sees them - run with no names to list them.');
        return 1;
      }
      // **같은 항목을 두 번 부르면 두 번 지우지 않고 거절한다.** 이미 돌려준
      // 사슬을 한 번 더 돌려주면 빈 목록에 주인이 둘이 된다.
      const seen = new Map();
      for (const [want, { parent, name11 }] of targets) {
        const key = `${parent}\u0000${name11}`;
        if (seen.has(key)) {
          say(`[-] named twice: ${seen.get(key)} and ${want} are the same entry`);
          say('    Nothing was removed.');
          return 1;
        }
        seen.set(key, want);
      }
      if (!recursive) {
        const heavy = [];
        for (const [want, { parent, name11, isDir: d }] of targets) {
          if (!d) continue;
          const child = entryOf(fat, parent, name11).first;
          if (child && listing(fat, child).size) heavy.push(want);
        }
        if (heavy.length) {
          for (const h of heavy) say(`[-] not empty: ${h}`);
          say('    Nothing was removed. Empty it first, or pass -r to remove a folder and everything under it.');
          return 1;
        }
      }
      for (const [want, { parent, name11, isDir: d }] of targets) {
        const size = (entryOf(fat, parent, name11) || { size: 0 }).size;
        fat.remove(parent, name11);
        // 빈 폴더에 "and its contents" 를 찍으면 거짓말이다.
        const what = d && recursive ? '<DIR> and its contents' : d ? '<DIR>' : rpad(size, 7);
        say(`[-] ${lpad(want, 20)} ${what}`);
      }
      fat.sync();
      return 0;
    } finally { fs.closeSync(fat.fd); }
  });
  if (rc !== 0) return rc;
  say();
  say('    Now run PDSYNC on the MSX, or Nextor keeps showing what was there.');
  return 0;
}

export async function rmMain(argv) {
  argv = [...argv];
  let recursive = false;
  for (const flag of ['-r', '--recursive']) {
    let i;
    while ((i = argv.indexOf(flag, 1)) > 0) { argv.splice(i, 1); recursive = true; }
  }
  if (argv.length < 2) {
    say(`usage: ${path.basename(argv[0])} [-r] <image> [name...]   (no names lists the disk)`);
    return 2;
  }
  const image = argv[1];
  if (!isFile(image)) { say(`[-] no such image: ${image}`); return 1; }
  return argv.length === 2 ? show(image) : remove(image, argv.slice(2), recursive);
}

// ============================================================================ mv

const BAD_NAME = [
  '    8.3 only - up to 8 characters, optionally a dot and up to 3',
  "    more. Letters, digits and $%'-_@~`!(){}^#& ; no spaces.",
];

export async function rename(image, p, newName) {
  const new11 = as83(newName);
  if (new11 === null) {
    say(`[-] not a name this disk can hold: ${newName}`);
    BAD_NAME.forEach((l) => say(l));
    return 1;
  }
  let tail = true;
  const rc = await held(image, () => {
    const fat = openImage(image);
    try {
      const got = resolvePath(fat, p);
      if (!got) {
        say(`[-] not on the disk: ${p}`);
        say('    Names are 8.3 as the MSX sees them.');
        return 1;
      }
      const { parent, name11, isDir: d } = got;
      if (new11 === name11) {
        say(`[*] already called that: ${shownName(name11)}`);
        tail = false;
        return 0;
      }
      // **쓰고 있는 이름이면 덮지 않고 거절한다.** 한 이름에 항목이 둘이 되면 MSX
      // 는 먼저 찾은 것을 열고, 다른 하나는 클러스터를 쥔 채 닿을 수 없게 된다.
      const clash = matchIn(fat, parent, shownName(new11));
      if (clash) {
        say(`[-] already there: ${shownName(clash)}`);
        say('    Remove it first, or pick another name.');
        return 1;
      }
      if (!fat.rename(parent, name11, new11)) { say(`[-] could not rename ${p}`); return 1; }
      say(`[+] ${lpad(p, 20)} -> ${shownName(new11)}${d ? '  <DIR>' : ''}`);
      fat.sync();
      return 0;
    } finally { fs.closeSync(fat.fd); }
  });
  if (rc !== 0 || !tail) return rc;
  say();
  say('    Now run PDSYNC on the MSX, or Nextor keeps showing the old name.');
  return 0;
}

export async function mvMain(argv) {
  if (argv.length !== 4) {
    say(`usage: ${path.basename(argv[0])} <image> <path> <new-name>`);
    say(`       e.g. ${path.basename(argv[0])} picodock.img GAMES/OLD.ROM NEW.ROM`);
    return 2;
  }
  const [, image, p, newName] = argv;
  if (!isFile(image)) { say(`[-] no such image: ${image}`); return 1; }
  return rename(image, p, newName);
}

// ========================================================================= mkdir

export async function mkdir(image, p) {
  const parts = splitPath(p);
  if (!parts.length) { say('[-] which folder?'); return 1; }
  const parentPath = parts.slice(0, -1).join('/');
  const name = parts[parts.length - 1];
  const name11 = as83(name);
  if (name11 === null) {
    say(`[-] not a name this disk can hold: ${name}`);
    BAD_NAME.forEach((l) => say(l));
    return 1;
  }
  const rc = await held(image, () => {
    const fat = openImage(image);
    try {
      const parent = resolveDir(fat, parentPath);
      if (parent === null) {
        say(`[-] no such folder on the disk: ${parentPath || '/'}`);
        say('    The folder it goes in has to exist already.');
        return 1;
      }
      const clash = matchIn(fat, parent, shownName(name11));
      if (clash) { say(`[-] already there: ${shownName(clash)}`); return 1; }
      fat.mkdir(parent, name11);
      fat.sync();
      say(`[+] ${p}  <DIR>`);
      return 0;
    } finally { fs.closeSync(fat.fd); }
  });
  if (rc !== 0) return rc;
  say();
  say('    Now run PDSYNC on the MSX, or Nextor keeps showing the old list.');
  return 0;
}

export async function mkdirMain(argv) {
  if (argv.length !== 3) {
    say(`usage: ${path.basename(argv[0])} <image> <path>`);
    say(`       e.g. ${path.basename(argv[0])} picodock.img GAMES/KONAMI`);
    return 2;
  }
  if (!isFile(argv[1])) { say(`[-] no such image: ${argv[1]}`); return 1; }
  return mkdir(argv[1], argv[2]);
}

// ========================================================================== text

//: 이보다 큰 것은 textarea 에서 고칠 것이 아니다.
export const MAX_TEXT = 512 * 1024;
//: 문자 코드를 안 주면 이 순서로 시도한다. ASCII 가 먼저인 것은 평범한 파일을
//: "우연히 ASCII 인 shift_jis" 가 아니라 평범한 것으로 말하려고.
const SNIFF = ['ascii', 'shift_jis', 'cp949', 'latin-1'];

/** 글이 아닌가. 이유를 돌려주고, 글로 읽히면 null. */
export function looksBinary(data, name = '') {
  if (data[0] === 0xff && name.toUpperCase().endsWith('.BAS'))
    return 'tokenised BASIC (saved without ,A) - editing it here would '
      + 'destroy it. Re-save from MSX with SAVE "...",A for text';
  if (data.includes(0x00)) return 'there are NUL bytes in it, so this is not text';
  return null;
}

/** CRLF 파일인가. 있는 것을 지키고, 줄바꿈이 없을 때만 MSX 관습(CRLF)으로. */
export function usesCrlf(data) {
  if (data.includes('\r\n')) return true;
  if (data.includes(0x0a) || data.includes(0x0d)) return false;
  return true;
}

function readBytes(fat, p) {
  const got = resolvePath(fat, p);
  if (!got) return [null, `not on the disk: ${p}`];
  const { parent, name11, isDir: d } = got;
  if (d) return [null, `${shownName(name11)} is a folder`];
  const { size, first } = entryOf(fat, parent, name11);
  if (size > MAX_TEXT) return [null, `${size} bytes is too big to edit here (limit ${MAX_TEXT})`];
  const data = first && size ? fat.readClusters(first).subarray(0, size) : Buffer.alloc(0);
  return [{ parent, name11, data }, null];
}

/** [text, charset, exact] - exact 는 다시 인코드하면 똑같은가. */
function decodeSniff(data, charset) {
  const order = charset && charset !== 'auto' ? [charset] : SNIFF;
  for (const cs of order) {
    let text;
    try { text = decode(data, cs); } catch (e) {
      if (e instanceof DecodeError || e instanceof LookupError) continue;
      throw e;
    }
    let exact;
    try { exact = encode(text, cs).equals(data); } catch (e) {
      if (!(e instanceof EncodeError)) throw e;
      exact = false;
    }
    if (exact || charset) return [text, cs, exact];
  }
  // 아무것도 깨끗이 풀리지 않았다. latin-1 은 늘 풀리고 바이트를 그대로 되살린다.
  return [data.toString('latin1'), 'latin-1', true];
}

export function textRead(image, p, charset) {
  return withImage(image, 'r', (fat) => {
    const [got, why] = readBytes(fat, p);
    if (why) return { ok: false, why };
    const { name11, data } = got;
    const binary = looksBinary(data, shownName(name11));
    const eof1a = data.length > 0 && data[data.length - 1] === 0x1a;
    const [text, cs, exact] = decodeSniff(eof1a ? data.subarray(0, -1) : data, charset);
    return {
      ok: true, name: shownName(name11), path: p, bytes: data.length, charset: cs,
      // 바이너리면 왕복이 정확해도 고치게 두지 않는다.
      exact: exact && !binary, binary: binary || null,
      crlf: usesCrlf(data), eof1a, text,
    };
  });
}

export async function textWrite(image, p, charset, text) {
  text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return held(image, () => {
    const fat = openImage(image);
    try {
      const [got, why0] = readBytes(fat, p);
      if (why0) return { ok: false, why: why0 };
      const { parent, name11, data: old } = got;
      const why = looksBinary(old, shownName(name11));
      if (why) return { ok: false, why: `${shownName(name11)}: ${why}` };

      const crlf = usesCrlf(old);
      const eof1a = old.length > 0 && old[old.length - 1] === 0x1a;
      if (eof1a) text = text.replace(/\x1a+$/, '');
      const body = crlf ? text.replace(/\n/g, '\r\n') : text;
      const cs = charset || 'ascii';
      let data;
      try { data = encode(body, cs); } catch (e) {
        if (e instanceof EncodeError || e instanceof LookupError)
          return { ok: false, why: `cannot save as ${cs}: ${e.message}` };
        throw e;
      }
      if (eof1a) data = Buffer.concat([data, Buffer.from([0x1a])]);
      if (data.length > MAX_TEXT)
        return { ok: false, why: `${data.length} bytes is over the ${MAX_TEXT} limit` };
      fat.addFile(parent, name11, data);
      fat.sync();
      return { ok: true, name: shownName(name11), bytes: data.length, charset: cs };
    } finally { fs.closeSync(fat.fd); }
  }, (e) => ({ ok: false, why: e.message }));
}

export async function textNew(image, folder, name) {
  const name11 = as83(name);
  if (name11 === null)
    return { ok: false, why: `not a name this disk can hold: ${name} - 8.3 only, up to 8`
      + ' characters, optionally a dot and up to 3 more, no spaces' };
  return held(image, () => {
    const fat = openImage(image);
    try {
      const dest = resolveDir(fat, folder);
      if (dest === null) return { ok: false, why: `no such folder on the disk: ${folder || '/'}` };
      // **있는 것 위에 새로 만들지 않는다.** addFile 은 갈아 끼우므로 오타 하나가
      // 부딪힌 파일을 먹고 성공했다고 말한다.
      if (matchIn(fat, dest, shownName(name11)))
        return { ok: false, why: `already there: ${shownName(name11)}` };
      fat.addFile(dest, name11, Buffer.alloc(0));
      fat.sync();
      const where = (folder ? `${folder.replace(/\/+$/, '')}/` : '') + shownName(name11);
      return { ok: true, name: shownName(name11), path: where, bytes: 0 };
    } finally { fs.closeSync(fat.fd); }
  }, (e) => ({ ok: false, why: e.message }));
}

export async function textMain(argv, stdin = () => fs.readFileSync(0)) {
  const me = path.basename(argv[0]);
  if (argv.length < 4 || !['read', 'write', 'new'].includes(argv[1])) {
    console.error(`usage: ${me} read|write <image> <path> [--charset NAME]\n`
      + `       ${me} new <image> <folder> <name>`);
    return 2;
  }
  if (argv[1] === 'new' && argv.length < 5) {
    console.error(`usage: ${me} new <image> <folder> <name>   (folder "" = root)`);
    return 2;
  }
  const [, what, image, p] = argv;
  let charset = null;
  const rest = argv.slice(4);
  const i = rest.indexOf('--charset');
  if (i >= 0 && i + 1 < rest.length) charset = rest[i + 1];
  if (!isFile(image)) {
    say(JSON.stringify({ ok: false, why: `no such image: ${image}` }));
    return 1;
  }
  let out;
  if (what === 'new') out = await textNew(image, p, argv[4]);
  else if (what === 'read') out = textRead(image, p, charset);
  else out = await textWrite(image, p, charset, stdin().toString('utf8'));
  say(JSON.stringify(out));
  return out.ok ? 0 : 1;
}
