#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// rp2_drive.js — RPI-RP2 드라이브가 어디 있는지. src/host/rp2_drive.py 의 Node 판.
//
//   node bin/rp2_drive.js            어디 있는지 찍거나, 없다고 말한다
//   node bin/rp2_drive.js --wait 30  나타나기를 30 초까지 기다린다
//   node bin/rp2_drive.js --gone 90  사라지기를 90 초까지 기다린다
import { find, waitFor, LABEL } from '../src/rp2drive.js';

const args = process.argv.slice(2);
if (args[0] === '--wait' || args[0] === '--gone') {
  const want = args[0] === '--wait';
  const ok = await waitFor(args[1] ? Number(args[1]) : 30, want);
  if (ok && want) console.log(find());
  process.exitCode = ok ? 0 : 1;
} else {
  const where = find();
  if (where) console.log(where);
  else {
    console.error(`[-] ${LABEL} is not mounted - the cartridge is not in BOOTSEL.`);
    console.error('    Hold BOOTSEL while plugging it in, with a normal data cable '
      + '(a VBUS-blocking one carries no power, so BOOTSEL cannot work).');
  }
  process.exitCode = where ? 0 : 1;
}
