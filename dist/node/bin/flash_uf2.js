#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// flash_uf2.js — UF2 를 RP2040 부트로더의 드라이브로 써 넣는다.
// src/host/flash_uf2.py 의 Node 판이고 찍는 말이 같다.
//
//   node bin/flash_uf2.js <uf2>
//
// **왜 picotool 이 아닌가.** 이 맥의 picotool 2.3.0 은 장치 없이 `info` 에서
// 죽고, 7.7 MB 이미지를 `load` 하다 중간에 멈춰 **반만 쓴 플래시**를 남긴 적이
// 있다 - MSX 를 부팅에서 세우는 카트리지와 똑같아 보인다. 드라이브로 복사하면
// RP2040 의 ROM 부트로더를 거치고, 그 무엇에도 기대지 않는다.
//
// **끝났는지는 드라이브가 사라지는 것으로 안다.** 복사 자체는 늘 실패한 것처럼
// 보인다 - 장치가 쓰는 도중에 재부팅하므로. 그래서 복사의 결과는 버린다.
import fs from 'node:fs';
import path from 'node:path';
import { find, waitFor, LABEL } from '../src/rp2drive.js';

const TIMEOUT = 90;
const say = (s = '') => console.log(s);

async function flash(uf2) {
  if (!fs.existsSync(uf2) || !fs.statSync(uf2).isFile()) { say(`[-] no such file: ${uf2}`); return 1; }
  const drive = find();
  if (!drive) {
    say(`[-] ${LABEL} is not mounted - the cartridge is not in BOOTSEL.`);
    say('    Hold BOOTSEL while plugging it in, with a normal data cable');
    say('    (a VBUS-blocking one carries no power, so BOOTSEL cannot work).');
    return 1;
  }
  say(`[*] writing ${uf2} (${Math.floor(fs.statSync(uf2).size / 1024)}KB) to ${drive}`);
  try { fs.copyFileSync(uf2, path.join(drive, path.basename(uf2))); } catch { /* 예상된 것 - 머리말 */ }
  say('[*] waiting for the cartridge to reboot (that is what confirms the write)');
  if (!(await waitFor(TIMEOUT, false))) {
    say(`[-] ${drive} is still mounted after ${TIMEOUT}s.`);
    say('    The bootloader never got a complete image, so the flash is');
    say('    now PARTIAL - the cartridge will hang the MSX until this');
    say('    succeeds. Try again; a different USB port or a direct');
    say('    connection (no hub) is usually what fixes it.');
    return 1;
  }
  say('[+] rebooted - the bootloader accepted the whole image.');
  return 0;
}

const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0] === '-h' || argv[0] === '--help') {
  say('usage: flash_uf2 <uf2>');
  say('  e.g. flash_uf2 dist/cartridge/picodock.org.uf2');
  say();
  say('Put the cartridge in BOOTSEL first: hold the button while');
  say('plugging it in.');
  process.exitCode = argv.length === 1 ? 0 : 1;
} else process.exitCode = await flash(argv[0]);
