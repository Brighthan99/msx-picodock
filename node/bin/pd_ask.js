#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// pd_ask.js — 검색이 되는지만 본다. MSX 도 서버도 없이.
//
//   node bin/pd_ask.js "what is an msx"
//   PD_ASK_ENGINE=ddg node bin/pd_ask.js "z80 opcodes"
//
// src/host/pd_ask.py 를 그냥 돌렸을 때 하던 일이다 (2026-09-25 에 옮겼다). search()
// 를 부르고, CALL PDASK 가 받을 모양 그대로 잘라 접은 것을 찍는다. 검색 엔진까지만
// 시험한다 - 프레이밍, 청크, ack 까지 보려면 ask_msx.js 다.

import { webAnswer } from '../src/websearch.js';
import { LIMIT } from '../src/ask.js';

const q = process.argv.slice(2).join(' ') || 'msx computer';
try {
  const got = await webAnswer(q, {
    engine: process.env.PD_ASK_ENGINE || 'auto',
    limit: Number(process.env.PD_ASK_LIMIT || LIMIT),
  });
  for (const n of got.notes) console.log(`[*] ${n}`);
  console.log(`[+] ${got.source}: ${got.text.length} bytes${got.cut ? ' (cut)' : ''}\n`);
  console.log(got.text.replace(/\r\n/g, '\n'));
} catch (e) {
  console.error(`[-] ${e.message}`);
  process.exitCode = 1;
}
