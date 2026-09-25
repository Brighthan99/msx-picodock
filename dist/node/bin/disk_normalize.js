#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_normalize.js — 맥에서 본 것과 MSX 에서 본 것을 같게 만든다. 명령줄.
//
//   node bin/disk_normalize.js picodock.img
//
// src/host/disk_normalize.py 의 main 을 옮겼다 (2026-09-25). 일은 src/normalize.js 가
// 한다 - 서버가 hold 에서 돌아올 때 부르는 바로 그것이다. 무엇을 왜 고치는지는
// 거기에 적혀 있다.

import { normalize, describe } from '../src/normalize.js';

const argv = process.argv.slice(2);
if (argv.length !== 1) {
  console.log('usage: disk_normalize <image>\n\n'
    + 'Uppercase 8.3 names macOS marked lowercase, drop long-name records Nextor\n'
    + 'cannot read, and delete the metadata macOS leaves on a FAT volume.');
  process.exit(1);
}
let st;
try {
  st = normalize(argv[0]);
} catch (e) {
  console.log(`[-] ${e.message}`);
  process.exit(1);
}
const said = describe(st);
if (said) console.log(`[*] ${said}`);
