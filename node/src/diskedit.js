// SPDX-License-Identifier: GPL-2.0-only
//
// diskedit.js — 화면에서 이미지에 파일을 넣고 뺀다.
//
// **FAT 에 직접 쓰지 않는다.** `bin/disk_put.js` 와 `disk_rm.js` 를 **따로 띄운다**.
// 그 도구들은 이미 세 가지를 안다: 8.3 이름 짓기와 충돌 처리, 다 되거나 아무것도
// 안 되게 하기, 그리고 **서버를 비켜 세우는 `.srv`/`.hold`/`.held` 규약**.
// 마지막 것이 특히 중요하다 - 서버는 블록을 파일에서 바로 읽어 넘기므로, 여기서
// 쓴 것이 그 순간 MSX 에 보인다. FAT 을 고치는 도중이 거기 포함된다.
//
// 예전에는 파이썬 도구(src/host/*.py)를 불렀다. 2026-09-25 에 Node 로 옮기면서도
// **따로 띄우는 것은 그대로 두었다.** 같은 프로세스에서 64MB 를 쓰면 그동안 이
// 서버의 이벤트 루프가 서고, PSG 프레임과 인쇄와 PDASK 가 같이 선다. 따로 띄우면
// 서버는 도구가 쓰는 동안에도 돌고, 둘 사이의 약속은 지금까지 시험해 온 hold
// 규약 그대로다 (`test/hold_interop.py`).
//
// **올린 파일은 먼저 임시 폴더에 모은다.** 파일마다 도구를 부르면 파일마다
// 서버를 멈췄다 켜게 된다. 다 모은 뒤 한 번 부른다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(HERE, '..', 'bin');

/** 도구 하나를 이 서버와 같은 node 로 띄울 인자. */
const tool = (script) => [process.execPath, [path.join(BIN_DIR, script)]];

//: 한 파일과 한 번의 올리기 전체에 두는 한계. 디스크가 2GB 까지 가므로 꽉 채울
//: 수도 있지만, 브라우저가 실수로 폴더째 떨어뜨렸을 때 디스크가 차기 전에
//: 멈추는 편이 낫다. 넘으면 무엇이 넘었는지 말한다.
export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_BATCH = 256 * 1024 * 1024;
export const MAX_FILES = 500;

/**
 * 브라우저가 준 이름을 **파일 이름 하나**로 만든다.
 *
 * 경로 구분자와 `..` 를 지운다. 여기서 막는 것이 임시 폴더 밖으로 쓰는 일이고,
 * 이 서버가 127.0.0.1 에만 붙어 있어도 막아야 하는 종류의 일이다 - 이 페이지를
 * 여는 것은 사람만이 아니다 (브라우저의 다른 탭이 fetch 를 할 수 있다).
 */
export function safeName(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const clean = base.replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '').trim();
  return clean.slice(0, 120) || 'UNNAMED';
}

/** 올리기 한 묶음을 담는 임시 폴더. id 는 여기서 만든다 - 브라우저가 고르게 두면 그게 곧 경로다. */
export class Staging {
  constructor() { this.dirs = new Map(); }

  open() {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdput-'));
    this.dirs.set(id, { dir, bytes: 0, files: 0 });
    return id;
  }

  /** @returns {{ok:true,name:string}|{ok:false,why:string}} */
  add(id, name, body) {
    const st = this.dirs.get(id);
    if (!st) return { ok: false, why: 'no such upload - start one first' };
    if (body.length > MAX_FILE)
      return { ok: false, why: `${safeName(name)} is larger than ${MAX_FILE >> 20}MB` };
    if (st.bytes + body.length > MAX_BATCH)
      return { ok: false, why: `more than ${MAX_BATCH >> 20}MB in one go` };
    if (st.files >= MAX_FILES)
      return { ok: false, why: `more than ${MAX_FILES} files in one go` };
    const nm = safeName(name);
    fs.writeFileSync(path.join(st.dir, nm), body);
    st.bytes += body.length;
    st.files += 1;
    return { ok: true, name: nm };
  }

  list(id) {
    const st = this.dirs.get(id);
    if (!st) return null;
    return fs.readdirSync(st.dir).map((n) => path.join(st.dir, n));
  }

  drop(id) {
    const st = this.dirs.get(id);
    if (!st) return;
    this.dirs.delete(id);
    try { fs.rmSync(st.dir, { recursive: true, force: true }); } catch { /* 이미 없다 */ }
  }

  /** 서버가 내려갈 때 남은 것을 치운다. */
  cleanup() { for (const id of [...this.dirs.keys()]) this.drop(id); }
}

function run(script, args) {
  return new Promise((resolve) => {
    const [cmd, pre] = tool(script);
    execFile(cmd, [...pre, ...args],
      { maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        // 도구는 실패를 0 이 아닌 코드로 말하고, **왜인지는 stdout 에 적는다.**
        // 그 줄이 사용자가 볼 유일한 설명이므로 통째로 넘긴다.
        resolve({ ok: !err, text: out, code: err ? (err.code ?? 1) : 0 });
      });
  });
}

/**
 * 모아 둔 파일들을 이미지에 넣는다.
 *
 * `into` 는 이미지 안의 폴더 (`GAMES`, `''` 는 루트). 이미 있어야 한다 -
 * 만들어 주지 않는 이유는, 오타로 만들어진 폴더가 화면에 조용히 나타나는 것이
 * "그런 폴더 없다" 는 말보다 알아채기 어렵기 때문이다.
 */
export async function putStaged(image, staging, id, into = '') {
  const files = staging.list(id);
  if (!files) return { ok: false, why: 'no such upload' };
  if (!files.length) return { ok: false, why: 'nothing was uploaded' };
  try {
    const args = [image];
    if (into) args.push('--into', into);
    return asResult(await run('disk_put.js', [...args, ...files]));
  } finally {
    staging.drop(id);
  }
}

/** 이미지에서 지운다. `paths` 는 `GAMES/ONE.ROM` 처럼 이미지 안의 경로. */
export async function rmPaths(image, paths) {
  if (!paths.length) return { ok: false, why: 'nothing to remove' };
  return asResult(await run('disk_rm.js', [image, ...paths]));
}

/**
 * 이미지 안의 항목 이름을 바꾼다.
 *
 * `path` 는 이미지 안의 경로, `name` 은 **이름 하나**다 (경로가 아니다).
 * 옮기는 것이 아니라 이름만 바꾸는 것이므로 도구가 슬래시를 거절한다.
 */
export async function mvPath(image, path_, name) {
  if (!path_ || !name) return { ok: false, why: 'need a path and a new name' };
  return asResult(await run('disk_mv.js', [image, path_, name]));
}

/** 도구를 부르되 stdin 으로 글을 넣고, JSON 한 줄을 받는다. */
function runJson(script, args, stdin = null) {
  return new Promise((resolve) => {
    const [cmd, pre] = tool(script);
    const ch = spawn(cmd, [...pre, ...args],
                     { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    ch.stdout.on('data', (b) => { out += b; });
    ch.stderr.on('data', (b) => { err += b; });
    ch.on('error', (e) => resolve({ ok: false, why: e.message }));
    ch.on('close', () => {
      // 도구는 JSON 한 줄로 답한다. 못 읽으면 그 자체가 할 말이다 - 빈
      // 객체를 돌려주면 화면은 "빈 파일" 로 읽는다.
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { resolve({ ok: false, why: (err || out).trim() || 'the tool said nothing' }); }
    });
    if (stdin !== null) ch.stdin.end(stdin, 'utf8');
    else ch.stdin.end();
  });
}

/** 이미지 안의 글 파일을 읽는다. 디코드는 도구가 하고, 왕복이 정확한지도 거기서 본다. */
export async function readText(image, path_, charset) {
  if (!path_) return { ok: false, why: 'which file?' };
  const args = [ 'read', image, path_ ];
  if (charset) args.push('--charset', charset);
  return runJson('disk_text.js', args);
}

/** 고친 글을 도로 쓴다. 줄바꿈과 EOF 바이트는 도구가 원래 모양대로 맞춘다. */
export async function writeText(image, path_, charset, text) {
  if (!path_) return { ok: false, why: 'which file?' };
  const args = [ 'write', image, path_ ];
  if (charset) args.push('--charset', charset);
  return runJson('disk_text.js', args, String(text ?? ''));
}

/** 빈 글 파일을 만든다. `folder` 는 이미지 안의 폴더 (`''` 는 루트). */
export async function newText(image, folder, name) {
  if (!name) return { ok: false, why: 'need a name' };
  return runJson('disk_text.js', ['new', image, folder || '', name]);
}

/** 폴더를 만든다. `path` 는 이미지 안의 경로이고, 부모는 이미 있어야 한다. */
export async function mkdirPath(image, path_) {
  if (!path_) return { ok: false, why: 'which folder?' };
  return asResult(await run('disk_mkdir.js', [image, path_]));
}

function asResult(r) {
  return r.ok ? { ok: true, text: r.text }
              : { ok: false, why: r.text || `the tool exited with ${r.code}` };
}
