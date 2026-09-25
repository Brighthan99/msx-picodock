#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// linkcheck.js — 소리를 내지 않고 링크만 잰다. src/host/pd_linkcheck.py 의 Node 판.
//
// **왜 이것이 먼저인가**: 파이썬에서 pyserial 로 읽으면 연속 스트림의 5~6 % 를
// 잃었고, 같은 카트리지를 같은 순간에 os.read 로 읽으면 0.00 % 였다(v0.81.0,
// macOS 실측). 그래서 파이썬 쪽은 raw tty 로 갔다. **Node 의 serialport 가 같은
// 문제를 갖는지는 아무도 모른다.** 나쁘게 나오면 이식 전체가 흔들리므로, 다른
// 것을 옮기기 전에 이것부터 잰다.
//
// 세는 법은 파이썬과 같다. PSG 프레임에는 seq 가 실려 있고, 그것은 카트리지가
// 20 ms 틱마다 **보냈든 걸렀든** 올린다. 그러니 seq 의 차이가 "카트리지가 돈
// 틱", 받은 프레임 수가 "우리에게 닿은 것" 이고, 그 차이가 잃은 것이다.
//
//   node bin/linkcheck.js [--port /dev/cu.usbmodemXXXX] [--seconds 20]

import { SerialPort } from 'serialport';
import { FrameParser } from '../src/frame.js';
import { PSG_FRAME } from '../src/protocol.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(opt('--seconds', 20));

let path = opt('--port', null);
if (!path) {
  const list = await SerialPort.list();
  const hit = list.find((p) => (p.vendorId || '').toLowerCase() === '2e8a'
                            && (p.productId || '').toLowerCase() === '000a');
  if (!hit) { console.error('[-] 카트리지를 못 찾았다 (VID 2E8A / PID 000A)'); process.exit(1); }
  path = hit.path;
}

const sp = new SerialPort({ path, baudRate: 115200, autoOpen: false });
await new Promise((res, rej) => sp.open((e) => (e ? rej(e) : res())));
console.log(`[*] ${path} · ${seconds} 초 동안 읽기만 한다`);

const parser = new FrameParser();
let nbytes = 0, reads = 0, frames = 0, ticks = 0, lastSeq = null;
// drops 는 카트리지 안의 누적 카운터(한 바이트라 256 에서 돈다)다.
// 프레임마다 더하면 아무 뜻이 없다 - 처음과 끝의 차이를 본다.
let dropFirst = null, dropLast = 0;
const t0 = process.hrtime.bigint();

sp.on('data', (d) => {
  nbytes += d.length; reads += 1;
  for (const f of parser.feed(d)) {
    if (f.cmd !== PSG_FRAME || f.payload.length < 17) continue;
    const seq = f.payload[15];
    dropLast = f.payload[16];
    if (dropFirst === null) dropFirst = dropLast;
    if (lastSeq !== null) ticks += (seq - lastSeq) & 0xff;   // seq 는 한 바이트, 256 에서 돈다
    else ticks += 0;
    if (lastSeq !== null) frames += 1;
    lastSeq = seq;
  }
});

await new Promise((r) => setTimeout(r, seconds * 1000));
sp.close(() => {});
const el = Number(process.hrtime.bigint() - t0) / 1e9;

if (frames < 2) {
  console.error(`[!] 프레임이 ${frames} 개뿐이라 잴 것이 없다.`);
  console.error('    카트리지가 PSG 프레임을 보내는 상태인지 확인할 것 '
              + '(디스크 서버가 꺼 두었을 수 있다).');
  process.exit(1);
}
const lost = ticks - frames;
console.log(`[*] ${el.toFixed(1)} 초 · ${nbytes} 바이트 · data 이벤트 ${reads} 번`);
console.log(`[*] 카트리지 ${ticks} 틱 · 받은 프레임 ${frames} · 잃은 것 ${lost}`
          + ` (${ticks ? (100 * lost / ticks).toFixed(2) : 0} %)`);
console.log('[*] 카트리지가 스스로 거른 것(drops): '
          + `${(dropLast - dropFirst) & 0xff} (${dropFirst} -> ${dropLast})`);
