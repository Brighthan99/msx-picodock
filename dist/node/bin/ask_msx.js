#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// ask_msx.js — 카트리지 노릇을 한다: MSX 없이 진짜 서버에 질문하고, CALL PDASK 가
// 화면에 찍었을 바이트를 본다.
//
//   node bin/ask_msx.js "what is an msx"
//   node bin/ask_msx.js --engine ddg -v "z80 opcodes"      # 청크와 ack 를 하나씩
//   node bin/ask_msx.js --ask manual "give me a haiku"     # 답은 웹 화면에서 친다
//
// src/host/tests/ask_msx.py 를 옮겼다 (2026-09-25). 그쪽은 pty 위에 파이썬 서버를
// 띄웠고, 여기는 pdserve.js --tcp 를 띄워 그 소켓에 붙는다. 사용자가 돌리는 바로 그
// 서버다. 프레이밍, opcode, 청크, ack 주고받기, 한도에서 자르기가 모두 길 위에 있으니
// 여기서 맞는 답은 기계에서도 맞다 - 시험하지 않은 것은 케이블뿐이다.
//
// **ack 가 이 고리의 요점이다.** 서버는 카트리지가 앞 청크를 받았다고 할 때까지 다음
// 청크를 쥐고 있다. 찍느라 바쁜 MSX 는 받을 수도 없기 때문이다. ack 없이 둘째 청크가
// 오면 서버가 기다리지 않는다는 뜻이고, 그것은 진짜 버그다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildFrame, FrameParser } from '../src/frame.js';
import { MB_TO_HOST, MB_TO_MSX } from '../src/protocol.js';
import { OP_REQ, OP_ACK, OP_CHUNK, OP_END, OP_ERR, LIMIT } from '../src/ask.js';

const BIN = path.dirname(fileURLToPath(import.meta.url));
const MODES = ['google', 'manual', 'echo', 'claude', 'gemini'];

function usage(err) {
  console.log('usage: ask_msx [question ...] [--ask google|manual|echo|claude|gemini] [--engine E]\n'
    + '               [--patience SECONDS] [-v]\n\n'
    + 'Ask a real server a question, playing the MSX side.');
  if (err) console.log(`ask_msx: error: ${err}`);
  return err ? 2 : 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject)
      .listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function connect(port, patienceMs) {
  const until = Date.now() + patienceMs;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => resolve(s)).once('error', reject);
      });
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function main(argv) {
  const a = { words: [], ask: 'google', engine: null, patience: 20, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    try {
      if (k === '-h' || k === '--help') return usage();
      if (k === '--ask') a.ask = val();
      else if (k === '--engine') a.engine = val();
      else if (k === '--patience') a.patience = Number(val());
      else if (k === '-v' || k === '--verbose') a.verbose = true;
      else if (k.startsWith('-')) return usage(`unrecognized arguments: ${k}`);
      else a.words.push(k);
    } catch (e) { return usage(e.message); }
  }
  if (!MODES.includes(a.ask)) return usage(`--ask: choose from ${MODES.join(', ')}`);
  const question = a.words.join(' ') || 'what is an msx';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ask-msx-'));
  const image = path.join(tmp, 'scratch.img');
  const made = spawnSync(process.execPath, [path.join(BIN, 'make_disk.js'), image, '16m'], { encoding: 'utf8' });
  if (made.status !== 0) { console.log(`[-] could not make a scratch disk:\n${made.stdout}${made.stderr}`); return 1; }

  // 답을 사람이 치거나 (manual) 키를 넣어야 하는 (claude, gemini) 쪽은 웹 화면이 필요하다.
  const needWeb = a.ask !== 'google' && a.ask !== 'echo';
  const tcp = await freePort();
  const web = needWeb ? await freePort() : null;
  const opts = ['--tcp', String(tcp), '--print', 'off', '--ask', a.ask,
    ...(a.engine ? ['--ask-engine', a.engine] : []), ...(web ? ['--web', String(web)] : [])];

  console.log(`[*] server: pdserve ${opts.join(' ')}`);
  console.log(`[*] asking: ${question}`);
  if (a.ask === 'manual') console.log(`[*] --ask manual: type the answer at http://127.0.0.1:${web}/ (Ask pane).`);
  else if (needWeb) console.log(`[*] --ask ${a.ask}: enter the API key at http://127.0.0.1:${web}/ (Ask pane).`);
  console.log();

  let screen = '';
  const server = spawn(process.execPath, [path.join(BIN, 'pdserve.js'), image, ...opts],
                       { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { screen += d; });
  server.stderr.on('data', (d) => { screen += d; });
  const gone = new Promise((resolve) => server.once('exit', resolve));

  let sock;
  let text = Buffer.alloc(0), chunks = 0, how = 'silence';
  try {
    sock = await connect(tcp, 10000);
    await new Promise((r) => setTimeout(r, 500));      // 서버가 링크를 받아들이게
    const q = Buffer.from(question.replace(/[^\x00-\x7f]/g, '?'), 'latin1');
    sock.write(buildFrame(MB_TO_HOST, Buffer.concat([Buffer.from([OP_REQ, q.length & 0xff, q.length >> 8]), q])));

    how = await new Promise((resolve) => {
      const parser = new FrameParser();
      let quiet;
      const patience = () => { clearTimeout(quiet); quiet = setTimeout(() => resolve('silence'), a.patience * 1000); };
      patience();
      gone.then(() => resolve('the server went away'));
      sock.on('close', () => resolve('the server went away'));
      sock.on('data', (d) => {
        for (const { cmd, payload } of parser.feed(d)) {
          if (cmd !== MB_TO_MSX || !payload.length) continue;
          patience();
          const op = payload[0];
          if (op === OP_CHUNK) {
            text = Buffer.concat([text, payload.subarray(2)]);
            chunks += 1;
            if (a.verbose) console.log(`    <- chunk ${chunks}, ${payload.length - 2} bytes`);
            sock.write(buildFrame(MB_TO_HOST, Buffer.from([OP_ACK])));
          } else if (op === OP_END) {
            if (a.verbose) console.log('    <- end');
            clearTimeout(quiet); resolve('end');
          } else if (op === OP_ERR) {
            clearTimeout(quiet);
            resolve(`error 0x${(payload[1] ?? 0).toString(16).toUpperCase().padStart(2, '0')}`);
          } else if (a.verbose) {
            console.log(`    <- opcode 0x${op.toString(16).toUpperCase().padStart(2, '0')}`);
          }
        }
      });
    });
  } catch (e) {
    how = `could not reach the server: ${e.message}`;
  } finally {
    sock?.destroy();
    server.kill('SIGTERM');
    await gone;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const said = () => console.log(`    What the server said:\n    ${screen.slice(-600).replace(/\n/g, '\n    ')}`);
  console.log();
  if (how === 'silence') {
    console.log(`[-] nothing came back within ${a.patience}s.`);
    said();
    return 1;
  }
  if (how !== 'end') {
    console.log(`[-] the server refused: ${how}`);
    if (how.startsWith('error')) console.log('    That is what the MSX would print as a failure.');
    said();
    return 1;
  }
  console.log(`[+] ${text.length} bytes in ${chunks} chunk${chunks === 1 ? '' : 's'} - this is what the MSX prints:`);
  console.log();
  console.log(text.toString('latin1').replace(/\r\n/g, '\n'));
  console.log();
  if (text.length >= LIMIT) console.log('[*] at the limit - the answer was cut, which is normal.');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
