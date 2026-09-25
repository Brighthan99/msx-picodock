#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// pdserve.js — 디스크 이미지를 MSX 에 서빙한다 (Node 판).
//
//   node bin/pdserve.js <image>                 시리얼 자동 탐색 (VID 2E8A/PID 000A)
//   node bin/pdserve.js <image> --port /dev/... 포트 지정
//   node bin/pdserve.js <image> --readonly
//   node bin/pdserve.js <image> --measure       디스크와 PSG 를 같이 재면서 서빙
//   node bin/pdserve.js <image> --tcp 9000      하드웨어 없이 서버 로직만
//   node bin/pdserve.js <image> --answer "..."  CALL PDASK 에 늘 이렇게 답한다
//   node bin/pdserve.js <image> --print raw     프린터 바이트를 작업마다 저장
//   node bin/pdserve.js <image> --spool         모든 바이트를 capture 에 모은다
//   node bin/pdserve.js <image> --web           브라우저로 보는 화면 (8080)
//   node bin/pdserve.js <image> --web 9000      다른 포트로
//   node bin/pdserve.js <image> --kanji-rom X.rom   한자를 실기 글리프로
//   node bin/pdserve.js <image> --direct escpos58   찍는 대로 영수증 프린터로
//   node bin/pdserve.js <image> --printers my.json  프린터를 더 등록한다
//   node bin/pdserve.js --printers-list             고를 수 있는 프린터들
//
// --measure 가 이 파일의 존재 이유 중 하나다. pyserial 이 바이트를 흘리던 문제가
// 드러난 자리는 **디스크와 소리가 동시에 흐를 때**였다 - PSG 만 흘릴 때는
// 깨끗했다. 그러니 둘을 같이 흘리며 재야 한다. 포트는 하나뿐이라 두 프로그램으로
// 나눌 수 없고, 한 프로그램이 둘 다 해야 한다.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Disk } from '../src/disk.js';
import { Hub, CH_LINK, CH_IO, CH_PRINT, CH_ASK } from '../src/hub.js';
import { serve } from '../src/server.js';
import { runLink, findDevices } from '../src/link.js';
import { AskService } from '../src/ask.js';
import { VoiceSession } from '../src/voicesession.js';
import { VoiceSay } from '../src/voicesay.js';
import fs from 'node:fs';
import { Printer } from '../src/printer.js';
import { Printers, Direct, label } from '../src/printers.js';
import { Cart } from '../src/cart.js';
import { Lending } from '../src/hold.js';
import { startWeb } from '../src/web.js';
import { errText } from '../src/errtext.js';

// ---------------------------------------------------------------- 인자
//
// 파이썬 서버(src/host/pd_diskserver.py)의 옵션을 전부 받는다 - serve.sh 가
// 2026-09-25 부터 이 서버를 띄우고, 사람의 손과 문서가 그 옵션들을 안다.
// 짧은 이름(-p, -s, -v)과 --output 도 그래서 있다.
//
// **값을 받는 옵션을 알아야 이미지를 옳게 고른다.** 예전에는 "-- 로 시작하지
// 않는 첫 인자" 를 이미지로 봐서, `--port /dev/x img.img` 가 /dev/x 를 이미지로
// 열었다.
const ALIASES = { '-p': '--port', '-s': '--serial', '-v': '--verbose', '--output': '--out' };
const TAKES_VALUE = new Set(['--port', '--serial', '--print', '--charset', '--glyphs', '--print-timeout',
  '--out', '--ask', '--ask-width', '--ask-charset', '--ask-engine', '--ask-lang', '--ask-results',
  '--dump', '--sound-buffer-ms', '--tcp', '--answer', '--reply', '--voice', '--voice-deliver',
  '--voice-engine', '--voice-lang', '--voice-name', '--voice-curve', '--web-host', '--kanji-rom',
  '--direct', '--printers']);
//: 값이 있어도 되고 없어도 되는 것: 다음 인자가 이 모양일 때만 값으로 먹는다.
const MAYBE_VALUE = { '--web': /^\d+$/, '--voice-tone': /^(ramp|sine)$/ };

const raw = process.argv.slice(2).map((a) => ALIASES[a] || a);
const flags = new Map();
const positional = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a.startsWith('-') && a !== '-') {
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { flags.set(ALIASES[a.slice(0, eq)] || a.slice(0, eq), a.slice(eq + 1)); continue; }
    if (TAKES_VALUE.has(a)) { if (!flags.has(a)) flags.set(a, raw[i + 1] ?? null); i += 1; }
    else if (MAYBE_VALUE[a] && raw[i + 1] !== undefined && MAYBE_VALUE[a].test(raw[i + 1])) {
      if (!flags.has(a)) flags.set(a, raw[i + 1]); i += 1;
    } else if (!flags.has(a)) flags.set(a, null);
  } else positional.push(a);
}
const image = positional[0] || 'picodock.img';
//: 처음 준 것이 이긴다 - serve.sh 가 사용자 인자 뒤에 제 기본값을 덧붙인다.
const opt = (n, d = null) => (flags.has(n) && flags.get(n) !== null ? flags.get(n) : d);
const has = (n) => flags.has(n);

const hub = new Hub();

/** 저장소의 VERSION. 서버는 시작할 때마다 찍는다 - 버그 신고가 판을 말할 수 있게. */
function readVersion() {
  let d = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const f = path.join(d, 'VERSION');
    // node/ 에도 VERSION 이 있다 - 저장소의 것은 dist/ 옆에 있는 것이다.
    if (fs.existsSync(f) && (fs.existsSync(path.join(d, 'dist')) || fs.existsSync(path.join(d, 'resources')))) {
      const v = fs.readFileSync(f, 'ascii').trim().replace(/^[vV]/, '');
      if (v) return v;
    }
    const up = path.dirname(d);
    if (up === d) return '0.0.0-unknown';
    d = up;
  }
}
const VERSION = readVersion();
if (has('--version')) { console.log(`PicoDock v${VERSION}`); process.exit(0); }

// 꽂혀 있는 PicoDock 들. 둘 이상일 때 --serial 에 무엇을 쓸지 알려 준다.
if (has('--list')) {
  const { SerialPort } = await import('serialport').catch(() => {
    console.error('[-] the serialport package is missing - run npm install in the node folder');
    process.exit(1);
  });
  const found = await findDevices(SerialPort);
  if (!found.length) {
    console.log('no PicoDock found (VID 2E8A PID 000A).');
    // 꽂힌 것이 무엇인지 사람이 가릴 수 있을 만큼 - 다른 USB 직렬 포트들.
    const others = (await SerialPort.list()).filter((p) => p.vendorId)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    if (others.length) {
      console.log('\nOther USB serial ports seen:');
      for (const p of others)
        console.log(`  ${p.path.padEnd(28)} ${p.vendorId.toUpperCase()}:${(p.productId || '').toUpperCase()} `
          + `${p.manufacturer || ''}${p.serialNumber ? ` serial ${p.serialNumber}` : ''}`);
    }
    process.exit(1);
  }
  console.log(`${found.length} PicoDock${found.length === 1 ? '' : 's'}:`);
  // 고정 폭으로 자르면 안 된다 - 한 배치의 보드는 앞자리가 길게 같다. 하나만
  // 가리킬 때까지 늘린다 (pd_port.short_serials).
  for (const d of found) {
    let line = `  ${d.path.padEnd(28)} serial ${d.serial || '(none reported)'}`;
    if (d.serial) {
      const others = found.filter((o) => o.path !== d.path && o.serial).map((o) => o.serial.toLowerCase());
      let n = 4;
      while (n < d.serial.length && others.some((o) => o.startsWith(d.serial.slice(0, n).toLowerCase()))) n += 1;
      const short = d.serial.slice(0, n);
      if (short !== d.serial) line += `   (--serial ${short} is enough)`;
    }
    console.log(line);
  }
  if (found.length > 1 && new Set(found.map((d) => d.serial)).size === 1)
    console.log('\n[!] Every board reports the same serial, so --serial cannot'
      + '\n    tell them apart. That is firmware older than v0.38.0:'
      + '\n    reflash them, or select by --port for now.');
  else if (found.length > 1)
    console.log('\nPick one with --serial <prefix>; each needs its own image'
      + '\nand its own server process.');
  process.exit(0);
}

// **목록만 보려는데 디스크 이미지를 요구하지 않는다.** 어떤 id 를 --direct 에
// 써야 하는지 알아보는 일과, 서버를 띄우는 일은 다르다 - 이미지가 아직 없는
// 사람이 가장 먼저 묻는 것이 이것이다.
if (has('--printers-list')) {
  const list = new Printers();
  const f = opt('--printers');
  if (f) { try { list.load(f); } catch (e) { console.error(`[-] ${f}: ${e.message}`); } }
  console.log('printers (--direct takes one of these ids):');
  for (const d of list.list()) console.log(`  ${d.id.padEnd(10)} ${d.label}`);
  process.exit(0);
}

// 이미지를 못 열면 Node 의 스택 트레이스가 아니라 사람이 읽을 말로 끝낸다.
// 여기서 틀리는 것은 거의 언제나 경로이거나, 아직 이미지를 안 만든 것이다.
let disk;
try {
  disk = new Disk(image, { readonly: has('--readonly') });
} catch (e) {
  console.error(`[-] cannot open the disk image: ${image}`);
  console.error(`    ${errText(e)}`);
  if (e.code === 'ENOENT')
    console.error('    make one with ./dist/disk/make-disk.sh, or check the path.');
  process.exit(1);
}
console.log(`PicoDock v${VERSION}`);

// --dump: 카트리지에서 받은 바이트를 그대로 파일에. 소리가 이상할 때 디스크와
// PSG 가 섞인 진짜 스트림을 나중에 뜯어보려고.
let dumpFd = null;
if (opt('--dump')) {
  try { dumpFd = fs.openSync(opt('--dump'), 'a'); console.log(`[+] dumping received bytes to ${opt('--dump')}`); }
  catch (e) { console.error(`[-] --dump: ${errText(e)}`); process.exit(1); }
}
const received = (d) => { m.bytes += d.length; if (dumpFd !== null) fs.writeSync(dumpFd, d); };

// --sound: 파이썬 서버는 PSG 를 이 컴퓨터의 스피커로 틀었다 (sounddevice). Node 는
// 브라우저가 튼다 - 화면을 켜고 거기서 "PSG raw" 를 켜면 된다.
if (has('--sound')) {
  if (!has('--web')) flags.set('--web', null);
  console.log('[*] --sound: the PSG plays in the browser - open the web UI and turn on PSG raw');
}
// ---------------------------------------------------------------- 측정
const m = { frames: 0, ticks: 0, lastSeq: null, dropFirst: null, dropLast: 0,
            reads: 0, writes: 0, bytes: 0, t0: Date.now() };

function onPsg(payload) {
  if (web) web.psg(payload);        // 브라우저가 소리로 만든다
  if (payload.length < 17) return;
  const seq = payload[15];
  m.dropLast = payload[16];
  if (m.dropFirst === null) m.dropFirst = m.dropLast;
  if (m.lastSeq !== null) { m.ticks += (seq - m.lastSeq) & 0xff; m.frames += 1; }
  m.lastSeq = seq;
}

hub.subscribe((ev) => {
  if (ev.ch === CH_IO && ev.ev === 'read') m.reads += ev.count;
  if (ev.ch === CH_IO && ev.ev === 'write') m.writes += ev.count;
  // 섹터마다 찍으면 시끄럽다 - 파이썬 서버처럼 -v 일 때만.
  if (ev.ch === CH_IO && (has('--measure') || !has('--verbose'))) return;
  const t = new Date(ev.t * 1000).toTimeString().slice(0, 8);
  const rest = Object.fromEntries(
    Object.entries(ev).filter(([k]) => !['seq', 't', 'ch', 'ev'].includes(k)));
  console.log(`${t}  ${ev.ch}/${ev.ev}`, rest);
});

if (has('--measure')) {
  setInterval(() => {
    const lost = m.ticks - m.frames;
    const pct = m.ticks ? (100 * lost / m.ticks).toFixed(2) : '0.00';
    const el = ((Date.now() - m.t0) / 1000).toFixed(0);
    console.log(`  ${el}s: sectors R${m.reads} W${m.writes}`
      + `, PSG ${m.ticks} ticks ${m.frames} frames ${lost} lost (${pct}%)`
      + `, cartridge drops ${(m.dropLast - (m.dropFirst ?? 0)) & 0xff}`);
  }, 5000).unref?.();
}

// Ctrl-C 만 받으면 부족하다. `kill` 의 기본은 SIGTERM 이고, 터미널을 닫으면
// SIGHUP 이 온다. 어느 쪽으로 죽든 .srv 를 치워야 한다 - 남은 .srv 는 다음에
// 오는 disk_put 에게 **없는 서버가 있다**고 말하고, 그쪽은 30 초를 기다린다.
// SIGKILL 은 어차피 못 받지만, 그건 disk_hold 쪽이 PID 로 걸러 준다.
const shutdown = (code = 0) => {
  const lost = m.ticks - m.frames;
  console.log(`\n[=] total: sectors R${m.reads} W${m.writes}, ${m.bytes} bytes received`);
  console.log(`[=] PSG: ${m.ticks} ticks, ${m.frames} frames, ${lost} lost`
    + ` (${m.ticks ? (100 * lost / m.ticks).toFixed(2) : 0}%)`);
  if (dumpFd !== null) fs.closeSync(dumpFd);
  if (web) web.close();
  clearInterval(lendTimer);
  lending.cleanup();        // 남은 .srv 는 없는 서버가 있다고 말한다
  printer.flush();          // 날아가던 작업을 잃지 않는다
  printer.close();          // 열린 작업을 색인에 남긴다 - 꼬리로 두지 않는다
  disk.close();
  process.exit(typeof code === 'number' ? code : 0);
};

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);

// ---------------------------------------------------------------- PDASK
// 답하는 쪽은 아직 비워 둔다. 파이썬은 기본이 구글 검색인데, 그것은 프로토콜이
// 아니라 정책이라 아직 안 옮겼다 - 로컬 웹 UI 에서는 브라우저가 답할 자리다.
// 지금은 질문이 로그에 뜨고 답을 기다리는 수동 모드로 돈다.
//
//   --answer "..."  물으면 늘 그 문장으로 답한다. 결선 확인용.
const canned = opt('--answer');
//   --reply text|voice|both   답을 무엇으로 돌려줄까 (기본 text)
//   --echo                    검색 대신 보낸 것을 그대로 답한다 (기본 꺼짐)
//   --ask google|manual|echo|claude|gemini   누가 답하나 (기본 google = 웹 검색)
//   --ask-engine auto|google|ddg|wikipedia  --ask-lang en  --ask-results 5
//   --ask-width 40  --ask-charset ascii|cp949|raw          (파이썬 서버와 같다)
const askMode = has('--echo') ? 'echo' : opt('--ask', 'google');
const ASK_MODES = ['google', 'manual', 'echo', 'claude', 'gemini'];
if (!ASK_MODES.includes(askMode)) { console.error(`[-] --ask takes ${ASK_MODES.join(' | ')}`); process.exit(2); }
const ask = new AskService(hub, {
  ...(canned ? { answerer: async () => canned } : {}),
  reply: opt('--reply') || 'text',
  mode: askMode,
  search: {
    engine: opt('--ask-engine', 'auto'), lang: opt('--ask-lang', 'en'),
    count: Number(opt('--ask-results', '5')), width: Number(opt('--ask-width', '40')),
    charset: opt('--ask-charset', 'ascii'),
  },
});

// ---------------------------------------------------------------- PDVOICE
// 같은 메일박스로 오는 다른 부탁: "이것을 소리내어 말해라". 답을 돌려보내는
// 대신 호스트가 합성해서 카트리지의 링에 흘려 넣고, MSX 가 PSG 로 뿜는다.
//
//   --voice off       아예 꺼 둔다. PDVOICE 는 거절을 받는다.
//   --voice-engine    say | sapi | espeak-ng | piper | auto  (기본 auto; sapi 는 Windows)
//   --voice-lang      en | ko | ja ...                (기본 en)
//   --voice-name      엔진마다 다르다. piper 는 모델 파일.
//
// 합성기는 파이썬에 있다(src/host/pd_voice.py). 하나도 안 깔려 있으면 여기서는
// 조용하고, 실제로 말을 시킬 때 그 이유가 MSX 와 로그에 간다 - 서버가 뜨는
// 것을 막지는 않는다. 목소리 하나 없다고 디스크까지 못 쓸 이유는 없다.
//   --voice-tone [ramp|sine]
//                     진단: 합성기 대신 정해진 파형을 보낸다.
//                       ramp  PDVOICE /T 가 내는 것과 **같은 파형**. 들리고
//                             안 들리고가 스트리밍 경로의 잘못인지 가른다.
//                       sine  순음 하나. 맑게 들리면 볼륨 표가 실제 칩과
//                             맞는 것이고, 갈대처럼 쐐하면 휘어 있는 것이다.
//                             말로는 이것을 못 가린다 - 말은 원래 배음이
//                             많아서 왜곡이 섞여도 티가 안 난다.
//   --voice-deliver stream|disk|mailbox|auto
//                     어느 길로 MSX 에 건넬까 (기본 stream)
//                       stream   카트리지 링으로 흘려보낸다. 길지만 실시간이라
//                                재생 중에도 버스를 읽는다.
//                       mailbox  ask 채널로 통째로 건넨 뒤 RAM 에서 튼다.
//                                느리지만 **재생 중 버스를 안 읽는다.**
//                       disk     디스크 이미지에 파일로 써 둔다. 남는다.
const voice = new VoiceSession(hub, {
  enabled: opt('--voice') !== 'off',
  deliver: opt('--voice-deliver') || 'stream',
  say: new VoiceSay({ tone: has('--voice-tone') ? (opt('--voice-tone') || 'ramp') : null }),
});
voice.say.set({
  engine: opt('--voice-engine') || 'auto',
  lang: opt('--voice-lang') || 'en',
  voice: opt('--voice-name') || null,
  // **PDVOICE 가 쓰는 표와 같아야 한다.** /S1 /S2 /S3 중 맑게 들린 번호가
  // ay / ym / db15 순이다. 안 주면 pd_voice.py 의 기본을 따르고, MSX 쪽 기본
  // 표도 거기서 만들어지므로 둘은 어긋날 수가 없다.
  curve: opt('--voice-curve') || null,
});
// disk 로 건네는 길: 합성한 것을 이미지에 파일로 써 둔다.
//
// **서버가 이미지를 쥐고 있다.** 밖에서 disk_put 을 부르면 그 사이 MSX 가
// 쓰던 섹터와 부딪히므로, 여기서 쓰고 MSX 는 PDSYNC 없이도 보게 한다 -
// Nextor 의 캐시는 그 파일을 아직 모르니 새 파일은 그냥 보인다.

if (voice.enabled && voice.say.tone)
  console.log(`[!] voice: DIAGNOSTIC ${voice.say.tone.toUpperCase()} - not speech (--voice-tone)`);
else if (voice.enabled)
  console.log(`[+] voice: ${voice.say.opts.engine} / ${voice.say.opts.lang}`
              + (voice.say.opts.curve ? ` / curve ${voice.say.opts.curve}` : '')
              + (voice.say.opts.voice ? ` / ${voice.say.opts.voice}` : ''));

// ---------------------------------------------------------------- 프린터
//
//   --print raw    작업마다 .prn 파일 하나
//   --spool        모든 바이트를 하나의 capture 에 모으고 경계만 색인한다
//
// 기본은 둘 다 꺼짐이다. 켜지 않으면 프린터 바이트는 버려진다 - 펌웨어는
// 어차피 보내므로, 안 쓸 거면 여기서 버리는 것이 맞다.
// 한자 폰트 ROM 은 가진 사람만 댄다. 크기를 확인하는 이유는 같은 폴더의 게임
// ROM 을 폰트로 잘못 집는 일을 막기 위해서다 - 잘린 덤프를 조용히 이상하게
// 그리느니 거절한다.
let kanjiRom = null;
const romPath = opt('--kanji-rom');
if (romPath) {
  try {
    const b = fs.readFileSync(romPath);
    if (b.length !== 0x20000 && b.length !== 0x40000)
      throw new Error(`expected 128KB or 256KB, got ${b.length} bytes`);
    kanjiRom = new Uint8Array(b);
    console.log(`[+] kanji font ROM: ${romPath} (${b.length / 1024}KB)`);
  } catch (e) {
    console.error(`[-] could not use ${romPath}: ${e.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------- 고를 수 있는 프린터
//
// 목록은 늘어난다는 전제다. `--printers x.json` 이 그 길이고, 같은 id 를 쓰면
// 기본 정의를 덮어쓴다 - 영수증 프린터의 USB 주소를 자동으로 못 찾을 때 직접
// 대는 것이 그렇다.
const printers = new Printers();
const printersFile = opt('--printers');
if (printersFile) {
  try {
    const { added, bad } = printers.load(printersFile);
    console.log(`[+] printers: ${added.length} from ${printersFile}`);
    for (const b of bad) console.error(`[-] ${b}`);
  } catch (e) {
    console.error(`[-] could not read ${printersFile}: ${e.message}`);
    process.exit(1);
  }
}
// **직접 출력은 스풀을 켠다.** 렌더러는 스풀 색인에서 작업을 찾으므로, 색인이
// 없으면 내보낼 것을 못 고른다. 조용히 아무것도 안 나가는 것보다, 켜 주고 켰다고
// 말하는 편이 낫다.
const directTo = opt('--direct');
if (directTo && !printers.get(directTo)) {
  console.error(`[-] no printer '${directTo}' - try --printers-list`);
  process.exit(1);
}
const wantSpool = has('--spool') || !!directTo;
if (directTo && !has('--spool'))
  console.log('[+] --direct needs the spool; turning it on');

const direct = new Direct(hub, printers,
                          { target: directTo || null, auto: !!directTo,
                            outDir: opt('--out', 'output') });
if (directTo)
  console.log(`[+] printing straight through to ${label(printers.get(directTo))}`);

let printer;
try {
printer = new Printer(hub, {
  kanjiRom,
  mode: opt('--print', 'off'),
  charset: opt('--charset', 'cp437'),
  glyphs: opt('--glyphs', 'msx'),
  spool: wantSpool,
  timeout: Number(opt('--print-timeout', '2')),
  outDir: opt('--out', 'output'),
  // 작업이 닫히면 바로 종이로. 꺼져 있으면 Direct 가 알아서 아무 일도 안 한다.
  onJob: (stem, seq) => direct.send(stem, seq),
});
} catch (e) { console.error(`[-] ${e.message}`); process.exit(2); }

// ---------------------------------------------------------------- 웹 화면
//
// 링크 상태를 여기 적어 둔다. 시리얼 포트를 화면이 직접 보지 않는 이유는
// TCP 로 돌 때도 같은 화면이어야 해서다.
const link = { connected: false, port: null, serial: null };
const cart = new Cart();

// 이미지를 빌려 주고 돌려받는 일. 서버가 없을 때와 있을 때를 disk_put 이
// 구별할 수 있게 .srv 를 남긴다.
const lending = new Lending(hub, disk, image);
lending.announce();

// **링크와 상관없이 돈다.** 처음에는 serve() 의 티커에 얹었는데, serve() 는
// 카트리지가 붙어야 실행된다. 그런데 이미지에 파일을 넣는 때는 보통 MSX 가
// 꺼져 있을 때다 - 파이썬 disk_put 이 30 초를 기다리다 포기하는 것으로
// 드러났다. 빌려 주는 일은 서빙과 별개다.
const lendTimer = setInterval(() => lending.tick(), 200);
lendTimer.unref?.();

// `--web` 만 써도 된다. 포트를 외우게 하지 않는다 - 기억해야 할 것이 하나
// 늘 때마다 안 쓰게 될 확률도 같이 는다.
let web = null;
const webArg = opt('--web');
// --no-web 이 이긴다: serve.sh 는 --web 을 기본으로 덧붙이므로, 끄려면 이것이다.
const webPort = has('--web') && !has('--no-web')
  ? (webArg && !webArg.startsWith('--') ? webArg : '8080')
  : null;
if (webPort) {
  try {
    web = await startWeb(hub, { disk, cart, ask, printer, link, lending,
                                printers, direct, voice },
                   { port: Number(webPort), host: opt('--web-host', '127.0.0.1') });
  } catch (e) {
    // 다른 서버가 이미 떠 있는 것이 거의 언제나의 까닭이다. 반쯤 뜬 채로 두지 않고
    // 말하고 끝낸다 - 화면 없는 서버는 쓰는 사람에게 고장으로 보인다.
    console.error(e.code === 'EADDRINUSE'
      ? `[-] web UI: port ${webPort} is in use - is another server running? (--web ${Number(webPort) + 1} picks another)`
      : `[-] web UI: ${errText(e)}`);
    shutdown(1);
  }
  // 모니터: MSX 가 틀기 시작하면 같은 소리를 화면에도. voicesession 은 화면을
  // 모르므로 여기서 잇는다.
  voice.onMonitor = (pcm, rate) => web.voice(pcm, rate);
  voice.onMonitorStop = () => web.voiceStop();
  console.log(`[+] web UI: ${web.url}`);
}

//: 직접 출력은 제 힘으로 움직인다 - 사람이 명령을 보내서가 아니라 MSX 가
//: 작업을 끝내서 시작한다. 그래서 명령 뒤에 스냅샷을 뿌리는 길로는 화면에
//: 안 닿는다. 줄 길이와 실패 수가 화면에서 움직이려면 여기서 밀어야 한다.
const DIRECT_EVENTS = new Set(['direct_start', 'direct_done', 'direct_failed',
                               'direct_dropped', 'direct_on', 'direct_off',
                               'direct_target', 'direct_rotate']);

hub.subscribe((ev) => {
  if (ev.ch === CH_PRINT && DIRECT_EVENTS.has(ev.ev)) { if (web) web.refresh(); return; }
  if (ev.ch !== CH_LINK) return;
  if (ev.ev === 'connected') Object.assign(link, { connected: true, port: ev.port, serial: ev.serial });
  else if (ev.ev === 'lost') Object.assign(link, { connected: false, port: null, serial: null });
  else return;
  if (web) web.refresh();
});

// ---------------------------------------------------------------- 링크
hub.emit(CH_LINK, 'image', { path: image, blocks: disk.blocks,
                             readonly: !!disk.readonly });

const tcpPort = opt('--tcp');
if (tcpPort) {
  net.createServer((sock) => {
    hub.emit(CH_LINK, 'connected', { port: `tcp:${tcpPort}` });
    sock.on('data', received);
    cart.attach(sock);
    serve(sock, disk, hub, { onPsg, ask, printer, voice });
    sock.on('close', () => { cart.detach(); hub.emit(CH_LINK, 'lost', { error: 'closed' }); });
  }).listen(Number(tcpPort), '127.0.0.1',
            () => hub.emit(CH_LINK, 'waiting', { tcp: Number(tcpPort) }));
} else {
  const { SerialPort } = await import('serialport').catch(() => {
    console.error('[-] the serialport package is missing - run npm install in the node folder (or test with --tcp)');
    process.exit(1);
  });

  // **한 번 열고 끝내지 않는다.** 카트리지는 쓰는 동안 계속 왔다 갔다 한다 -
  // 다시 굽고, MSX 를 껐다 켜고, 케이블을 건드린다. 그때마다 서버를 다시
  // 띄우게 하면 그건 제품이 아니다. link.js 가 기다리는 일과 다시 여는 일을
  // 맡고, 여기는 열린 링크에 serve() 를 거는 것만 한다.
  await runLink(SerialPort, hub, { port: opt('--port'), serial: opt('--serial') }, (sp) => {
    sp.on('data', received);
    // 카트리지는 막 부팅해서 펌웨어 기본값이다. 지금 설정을 다시 밀어 넣는다.
    cart.attach(sp);
    serve(sp, disk, hub, { onPsg, ask, printer, voice });
  }, () => {
    cart.detach();
    // 끊김도 작업의 끝이다. 안 닫으면 재접속 뒤에 들어오는 바이트가 앞
    // 작업에 이어 붙어, 두 인쇄가 한 파일이 된다.
    printer.flush();
  });
}
