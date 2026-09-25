#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// pd_bootsel.js — 버튼 없이 카트리지를 BOOTSEL 로 보낸다. src/host/pd_bootsel.py 의
// Node 판이고 찍는 말이 같다.
//
//   node bin/pd_bootsel.js [--port /dev/cu.usbmodemXXXX] [--wait 20]
//
// CDC 포트를 **1200 bps 로 열기만** 하면 펌웨어가 스스로 부트로더로 넘어간다
// (pd_usb.c 의 tud_cdc_line_coding_cb). Pico SDK 의 pico_stdio_usb 와 같은 방식 -
// DTR 은 건드리지 않는다. 펌웨어가 이 신호를 모르면 조용히 아무 일도 안 일어나고,
// 그때는 드라이브가 안 뜨는 것으로 갈린다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { find as drivePresent } from '../src/rp2drive.js';
import { VID, PID } from '../src/link.js';

const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadSerial() {
  try { return (await import('serialport')).SerialPort; } catch { return null; }
}

async function findPort(SerialPort, explicit) {
  if (explicit) return explicit;
  if (SerialPort) {
    try {
      const p = (await SerialPort.list()).find((x) => (x.vendorId || '').toLowerCase() === VID
                                              && (x.productId || '').toLowerCase() === PID);
      if (p) return p.path.replace('/dev/tty.', '/dev/cu.');
    } catch { /* 아래로 */ }
  }
  let hits = [];
  try { hits = fs.readdirSync('/dev').filter((n) => n.startsWith('cu.usbmodem')).sort(); } catch { /* 윈도우 */ }
  return hits.length ? `/dev/${hits[0]}` : null;
}

/** 이 포트를 열고 있는 다른 프로세스들. macOS 의 cu.* 는 둘이 같이 열리므로 열기가 성공해도 묻는다. */
function holders(port) {
  let pids = [];
  try { pids = execFileSync('lsof', ['-t', port], { encoding: 'utf8', timeout: 5000 }).split(/\s+/).filter(Boolean); }
  catch { return []; }
  return pids.filter((p) => p !== String(process.pid)).map((pid) => {
    let name = '?';
    try { name = execFileSync('ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* */ }
    return [pid, name];
  });
}

/** 1200 bps 로 연다. 장치가 그 자리에서 사라지므로 닫을 때 나는 오류는 정상이다. */
async function knock(SerialPort, port) {
  if (!SerialPort) { say('[-] the serialport package is needed: run npm install in the node folder'); return false; }
  const sp = new SerialPort({ path: port, baudRate: 1200, autoOpen: false });
  try { await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve()))); } catch (e) {
    say(`[-] could not open the port: ${e.message}`);
    if (/busy/i.test(e.message)) {
      say('    Something else holds it - stop the disk server first:');
      say(`      lsof ${port}`);
    }
    return false;
  }
  await new Promise((resolve) => sp.close(() => resolve()));   // 여기서 나는 오류는 정상이다
  return true;
}

async function main(argv) {
  let port = null, wait = 20;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = argv[++i];
    else if (argv[i] === '--wait') wait = Number(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') {
      say('usage: pd_bootsel [--port PORT] [--wait SECONDS]'); return 0;
    }
  }
  const already = drivePresent();
  if (already) { say(`[+] already in BOOTSEL: ${already}`); return 0; }
  const SerialPort = await loadSerial();
  port = await findPort(SerialPort, port);
  if (!port) { say('[-] no cartridge found. Check it is plugged in, or already in BOOTSEL.'); return 1; }
  const held = holders(port);
  if (held.length) {
    say(`[!] something else has ${port} open:`);
    for (const [pid, name] of held) say(`      pid ${pid}  ${name}`);
    say('    On macOS two programs can hold /dev/cu.* at once, so this');
    say('    open will succeed either way. The knock sometimes still');
    say('    works and sometimes does not; if it does not, this is the');
    say('    first thing to rule out. Stop it with:');
    say(`      kill ${held.map(([pid]) => pid).join(' ')}`);
  }
  say(`[*] opening ${port} at 1200 bps`);
  await knock(SerialPort, port);
  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    const d = drivePresent();
    if (d) { say(`[+] in BOOTSEL now: ${d}`); return 0; }
    await sleep(300);
  }
  say('[-] the drive did not appear.');
  if (held.length) {
    say(`    ${held.length} other program(s) had the port open - rule that`);
    say('    out first. See above.');
  } else say('    If the firmware predates this, hold BOOTSEL while plugging in.');
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
