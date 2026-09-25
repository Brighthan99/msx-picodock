// web.test.js — 브라우저에게 보이는 면.
//
// 여기서 확인하는 것은 셋이다.
//
//   * 늦게 연 화면도 **지난 일을 받는가.** 이벤트만 흘려 보내면 나중에 연
//     브라우저는 빈 화면으로 시작한다.
//   * 명령이 **실제로 무언가를 바꾸는가**, 그리고 안 되는 명령은 왜 안 되는지
//     말하는가. 눌렀는데 아무 일도 안 일어나는 화면이 제일 고약하다.
//   * 화면이 여럿일 때 **같은 것을 보는가.** 한 창에서 끄고 다른 창에서 켜져
//     있으면 어느 쪽이 참인지 알 수 없다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { startWeb, isLoopback } from '../src/web.js';
import { Claude } from '../src/claude.js';
import { Gemini } from '../src/gemini.js';
import { Disk } from '../src/disk.js';
import { Lending } from '../src/hold.js';
import { Hub, CH_DISK, CH_IO } from '../src/hub.js';
import { Cart, CTRL_PSG_STREAM, CTRL_MIDIPAC } from '../src/cart.js';
import { AskService } from '../src/ask.js';
import { FrameParser } from '../src/frame.js';
import * as P from '../src/protocol.js';
import { Printers, Direct } from '../src/printers.js';
import { Printer } from '../src/printer.js';
import { findBundledFont } from '../src/printrender.js';

// 'host' 모양은 번들 글꼴(resources/fonts/)로 다시 조판한다. 그 폴더는 저장소에
// 없다 - 사용자가 넣는 곳이다. 새로 받은 트리에서는 'msx' 모양만 본다.
const DOC_STYLES = findBundledFont('jp') || findBundledFont('kr') ? ['msx', 'host'] : ['msx'];

//: 저장소 루트 - 진짜 이미지를 만드는 도구들이 거기 있다.
const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 카트리지 대신 쓸, 써진 것을 모아 두는 링크. */
function fakeLink() {
  const wrote = [];
  return { wrote, write: (b) => { wrote.push(Buffer.from(b)); return true; } };
}

async function rig(t, opts = {}) {
  const hub = new Hub();
  const cart = new Cart();
  const ask = new AskService(hub);

  // **진짜 Disk 를 쓴다.** 흉내로 두면 pause() 가 핸들을 놓는지 같은 것을
  // 시험이 못 본다 - 실제로 그 자리에서 놓치고 있었다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdweb-'));
  const img = path.join(dir, 'test.img');
  fs.writeFileSync(img, Buffer.alloc(512 * 1024));
  const disk = new Disk(img);
  const lending = new Lending(hub, disk, img);
  t.after(() => { disk.close(); lending.cleanup();
                  fs.rmSync(dir, { recursive: true, force: true }); });

  // **진짜 Printer 를 쓴다.** 흉내로 두면 화면이 스풀을 켜는지 같은 것을
  // 시험이 못 본다 - Disk 를 진짜로 두는 것과 같은 이유다.
  const printer = opts.noPrinter ? null : (opts.printer
    || new Printer(hub, { outDir: dir, spool: !!opts.spool, timeout: 0.02,
                          mode: opts.printMode || 'off' }));
  t.after(() => { try { printer && printer.close(); } catch { /* 흉내였다 */ } });
  // 프린터 목록과 직접 출력. 가짜 실행기를 끼우므로 **종이는 안 나간다.**
  const printers = new Printers();
  const printed = [];
  const direct = new Direct(hub, printers, {
    // 한 번의 인쇄가 작업 여럿을 합쳐 나를 수 있다. `3+5` 는 합쳐 한 장,
    // `3`, `5` 두 줄은 따로 두 장 - 시험이 그 둘을 구별해야 한다.
    run: (job, def) => {
      printed.push(`${def.id}:${(job.seqs || [job.seq]).join('+')}`);
      return Promise.resolve();
    },
  });
  const web = await startWeb(hub, { disk, cart, ask, printer, lending,
                                    printers, direct,
                                    link: opts.link || {} },
                       { port: 0, host: '127.0.0.1' });
  t.after(() => web.close());
  return { hub, cart, ask, disk, printer, lending, web, img, printers, direct,
           printed,
           url: () => `ws://127.0.0.1:${web.port}/ws` };
}

/** 브라우저 노릇. 받은 메시지를 종류별로 모은다. */
async function browser(url) {
  const ws = new WebSocket(url);
  const msgs = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--)
      if (waiters[i].test(m)) waiters.splice(i, 1)[0].hit(m);
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => j(new Error('열지 못했다')), { once: true });
  });
  return {
    ws, msgs,
    states: () => msgs.filter((m) => m.type === 'state'),
    events: () => msgs.filter((m) => m.type === 'ev'),
    send: (o) => ws.send(JSON.stringify(o)),
    /** 조건에 맞는 메시지가 올 때까지 기다린다. 이미 왔으면 그것을. */
    until(test, what = 'a message') {
      const had = msgs.find(test);
      if (had) return Promise.resolve(had);
      return new Promise((hit, fail) => {
        waiters.push({ test, hit });
        setTimeout(() => fail(new Error(`시간 초과: ${what}`)), 2000);
      });
    },
    close: () => ws.close(),
  };
}

test('붙자마자 지금 상태를 받는다', async (t) => {
  const r = await rig(t, { link: { connected: true, port: '/dev/PD1', serial: 'ABC' } });
  const b = await browser(r.url());
  const s = await b.until((m) => m.type === 'state', 'state');
  assert.equal(s.link.connected, true);
  assert.equal(s.link.port, '/dev/PD1');
  assert.equal(s.disk.blocks, 1024);
  assert.deepEqual(s.toggles, { psg: false, midipac: false, pause: false });
  b.close();
});

test('늦게 열어도 지난 일을 받는다', async (t) => {
  // 이게 요점이다. 붙기 전에 일어난 일이 화면에 없으면, 왜 이렇게 됐는지
  // 알 수 없는 상태로 시작한다.
  const r = await rig(t);
  r.hub.emit(CH_DISK, 'info', { blocks: 1024, sector: 512 });
  r.hub.emit(CH_IO, 'read', { lba: 7, count: 1 });
  r.hub.emit(CH_IO, 'write', { lba: 9, count: 2 });

  const b = await browser(r.url());
  await b.until((m) => m.type === 'ev' && m.ev === 'write', '지난 write');
  // link 채널은 서버가 스스로 내는 것(화면이 붙었다 같은)이라 여기서 보는
  // 대상이 아니다. 여기서 보는 것은 디스크 쪽 지난 일이 오는가다.
  const evs = b.events().filter((e) => e.ch !== 'link');
  assert.deepEqual(evs.map((e) => e.ev), ['info', 'read', 'write']);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3], '순서가 seq 대로여야 한다');
  b.close();
});

test('그 뒤의 일은 실시간으로 온다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  r.hub.emit(CH_IO, 'read', { lba: 42, count: 1 });
  const ev = await b.until((m) => m.type === 'ev' && m.lba === 42, '새 read');
  assert.equal(ev.ch, 'io');
  b.close();
});

test('스위치가 카트리지에 실제 프레임을 보낸다', async (t) => {
  const r = await rig(t);
  const link = fakeLink();
  r.cart.attach(link);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'set', what: 'midipac', on: true, id: 1 });
  const reply = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(reply.ok, true);

  // 화면이 "켜졌다" 고 쓰는 것만으로는 부족하다. 선에 뭐가 나갔는지 본다.
  const frames = [...new FrameParser().feed(Buffer.concat(link.wrote))];
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmd, P.CTRL);
  assert.deepEqual([...frames[0].payload], [CTRL_MIDIPAC, 1]);

  const s = await b.until((m) => m.type === 'state' && m.toggles.midipac === true, '갱신된 상태');
  assert.equal(s.toggles.midipac, true);
  b.close();
});

test('끊겨 있을 때 끈 설정은 다시 붙을 때 밀어 넣는다', async (t) => {
  // 카트리지는 재부팅하면 펌웨어 기본값(켜짐)으로 돌아간다. 화면에 꺼져
  // 있다고 쓰였는데 실제로는 돌아가는 것이 제일 나쁘다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'set', what: 'psg', on: true, id: 1 });
  await b.until((m) => m.type === 'reply' && m.id === 1);      // 링크는 아직 없다

  const link = fakeLink();
  r.cart.attach(link);                                          // 이제 붙었다
  const frames = [...new FrameParser().feed(Buffer.concat(link.wrote))];
  assert.equal(frames.length, 1, 'attach 때 다시 보냈어야 한다');
  assert.deepEqual([...frames[0].payload], [CTRL_PSG_STREAM, 1]);
  b.close();
});

test('일시정지가 핸들까지 놓는다', async (t) => {
  // 플래그만 세우면 화면에는 "멈췄다" 고 쓰면서 파일은 그대로 쥐고 있다.
  // 그 상태로 이미지를 마운트하면 쓰는 쪽이 둘이 되고, 조용히 손상된다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'set', what: 'pause', on: true, id: 9 });
  await b.until((m) => m.type === 'reply' && m.id === 9);
  assert.equal(r.disk.paused, true);
  assert.equal(r.disk.fd, null, '핸들을 놓았어야 한다');

  b.send({ cmd: 'set', what: 'pause', on: false, id: 10 });
  await b.until((m) => m.type === 'reply' && m.id === 10);
  assert.equal(r.disk.paused, false);
  assert.ok(r.disk.fd !== null, '돌려받으면 다시 열어야 한다');
  assert.equal(r.disk.blocks, 1024, '다시 연 뒤에도 크기를 안다');
  b.close();
});

test('안 되는 명령은 왜 안 되는지 말한다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'answer', text: 'nobody asked', id: 1 });
  const noAsk = await b.until((m) => m.type === 'reply' && m.id === 1);
  assert.equal(noAsk.ok, false);
  assert.match(noAsk.why, /nothing is waiting/);

  b.send({ cmd: 'set', what: 'teleport', on: true, id: 2 });
  const noSuch = await b.until((m) => m.type === 'reply' && m.id === 2);
  assert.equal(noSuch.ok, false);
  assert.match(noSuch.why, /unknown toggle/);

  b.send({ cmd: 'fly', id: 3 });
  const noCmd = await b.until((m) => m.type === 'reply' && m.id === 3);
  assert.match(noCmd.why, /unknown command/);
  b.close();
});

test('JSON 이 아닌 것을 보내도 서버가 안 죽는다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.ws.send('{{{not json');
  const reply = await b.until((m) => m.type === 'reply' && m.why === 'not JSON');
  assert.equal(reply.ok, false);
  // 그리고 여전히 멀쩡하다.
  b.send({ cmd: 'set', what: 'pause', on: true, id: 7 });
  const ok = await b.until((m) => m.type === 'reply' && m.id === 7);
  assert.equal(ok.ok, true);
  b.close();
});

test('MSX 의 질문에 화면에서 답하면 청크가 나간다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  // MSX 가 물었다.
  r.ask.feed(Buffer.concat([Buffer.from([0x01, 3, 0]), Buffer.from('msx')]));
  const asking = await b.until((m) => m.type === 'ev' && m.ev === 'question', '질문');
  assert.equal(asking.text, 'msx');

  b.send({ cmd: 'answer', text: 'from the browser', id: 1 });
  const reply = await b.until((m) => m.type === 'reply' && m.id === 1);
  assert.equal(reply.ok, true);

  const sent = [];
  r.ask.pump((p) => sent.push(Buffer.from(p)));
  assert.equal(sent[0][0], 0x81, 'OP_CHUNK 여야 한다');
  assert.equal(sent[0].subarray(2).toString(), 'from the browser');
  b.close();
});

test('창이 둘이면 둘 다 같은 것을 본다', async (t) => {
  const r = await rig(t);
  const a = await browser(r.url());
  const c = await browser(r.url());
  await Promise.all([a.until((m) => m.type === 'state'), c.until((m) => m.type === 'state')]);

  a.send({ cmd: 'set', what: 'pause', on: true, id: 1 });
  // 누른 창이 아니라 **다른 창**이 갱신을 받아야 한다.
  const s = await c.until((m) => m.type === 'state' && m.toggles.pause === true,
                          '다른 창의 갱신');
  assert.equal(s.disk.paused, true);
  a.close(); c.close();
});

test('질문이 오면 상태도 같이 바뀐다 (이벤트만으로는 부족하다)', async (t) => {
  // 통합 시험에서 실제로 걸린 자리다. 로그에는 질문이 보이는데 답변 입력칸이
  // 안 열렸다 - 스냅샷이 접속할 때와 명령 뒤에만 갔기 때문이다.
  const r = await rig(t);
  const b = await browser(r.url());
  const first = await b.until((m) => m.type === 'state');
  assert.equal(first.ask.state, 'idle');

  r.ask.feed(Buffer.concat([Buffer.from([0x01, 2, 0]), Buffer.from('hi')]));

  const s = await b.until((m) => m.type === 'state' && m.ask.state === 'asking',
                          '질문 뒤의 갱신된 상태');
  assert.equal(s.ask.question, 'hi');
  b.close();
});

test('프린터 작업이 열리고 닫히는 것도 상태에 보인다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  r.printer.bufLen = 10;
  r.hub.emit('print', 'job_start', { mode: 'off' });
  const s = await b.until((m) => m.type === 'state' && m.printer.open === true,
                          '작업이 열렸다는 상태');
  assert.equal(s.printer.open, true);
  b.close();
});

test('명령이 던져도 서버가 안 죽는다', async (t) => {
  // **이 서버는 살아 있는 MSX 에게 디스크를 서빙한다.** 브라우저가 보낸 한 줄
  // 때문에 프로세스가 죽으면 날아가던 섹터 쓰기가 영영 안 닿고 FAT 이 반쯤
  // 갱신된 채 남는다. 실제로 그렇게 죽었다 - `note` 명령이 스코프에 없는
  // 변수를 건드려 ReferenceError 를 던졌고, 아무도 안 잡았다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  // 명령 처리 중에 확실히 터지게 만든다.
  const boom = new Error('boom');
  Object.defineProperty(r.disk, 'paused', { get() { throw boom; }, set() { throw boom; } });

  b.send({ cmd: 'set', what: 'pause', on: true, id: 1 });
  const reply = await b.until((m) => m.type === 'reply' && m.id === 1, '터진 명령의 답');
  assert.equal(reply.ok, false);
  assert.match(reply.why, /server error/);

  // 그리고 서버는 여전히 살아 있어야 한다.
  delete r.disk.paused;
  r.disk.paused = false;
  b.send({ cmd: 'jobs', id: 2 });
  const after = await b.until((m) => m.type === 'reply' && m.id === 2, '그 뒤의 명령');
  assert.ok(after, '터진 뒤에도 명령을 받아야 한다');
  b.close();
});

test('화면이 서버 로그에 한 줄 남길 수 있다', async (t) => {
  // 브라우저 콘솔을 볼 수 없는 자리에서 "화면 쪽에서 무슨 일이 있었나" 를
  // 아는 유일한 길이다. 이 명령 자체가 서버를 죽인 적이 있다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'note', text: 'audio started', id: 1 });
  const reply = await b.until((m) => m.type === 'reply' && m.id === 1);
  assert.equal(reply.ok, true);
  const ev = await b.until((m) => m.type === 'ev' && m.ev === 'viewer_note', '로그 줄');
  assert.equal(ev.text, 'audio started');
  b.close();
});

test('files 는 이미지의 트리를 돌려준다', async (t) => {
  // 진짜 이미지를 만들어 넣는다. rig 의 기본 이미지는 0 으로 채운 것이라
  // FAT16 이 아니고, 그건 아래에서 따로 본다.
  const r = await rig(t);
  const img = path.join(os.tmpdir(), `pdtree-web-${process.pid}.img`);
  t.after(() => { try { fs.unlinkSync(img); } catch {} });
  const mk = spawnSync(process.execPath,
    [path.join(HERE_ROOT, 'node', 'bin', 'make_disk.js'), img, '9m', 'WEBTREE'],
    { encoding: 'utf8' });
  if (mk.status !== 0) { t.skip('make_disk 를 못 돌렸다'); return; }
  spawnSync(path.join(HERE_ROOT, 'src', 'host', 'disk_put.sh'),
            [img, path.join(HERE_ROOT, 'VERSION')], { encoding: 'utf8' });

  r.disk.path = img;
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files', id: 7 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 7, '트리');
  assert.equal(rep.ok, true, rep.why);
  assert.ok(Array.isArray(rep.root), 'root 는 배열이어야 한다');
  assert.ok(rep.root.some((n) => n.name === 'VERSION'), 'VERSION 이 보여야 한다');
  assert.equal(rep.volume.clusterBytes, 2048, '9MB 는 2KB 클러스터다');
  assert.ok(rep.volume.freeClusters > 0, '빈 클러스터가 있어야 한다');
  b.close();
});

test('files 는 FAT16 이 아닌 이미지를 조용히 넘기지 않는다', async (t) => {
  // 0 으로 채운 파일에 대고 그럴듯한 빈 트리를 보여 주면, 디스크가 비었다는
  // 뜻인지 못 읽었다는 뜻인지 화면만 보고는 알 수 없다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files', id: 8 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 8, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /FAT/);
  b.close();
});

test('일시정지 중에는 트리를 읽지 않는다', async (t) => {
  // 일시정지는 "호스트가 이미지를 쥐고 있다" 는 뜻이다. 그 와중에 읽으면
  // 디스크가 고쳐지는 도중의 모습을 보게 된다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  r.disk.paused = true;
  b.send({ cmd: 'files', id: 9 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 9, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /paused/);
  r.disk.paused = false;
  b.close();
});

// ---------------------------------------------------------------------------
// 이미지 고치기. 여기부터는 **사용자의 디스크를 망가뜨릴 수 있는 코드**라,
// 되는 것보다 안 되는 것을 더 많이 본다.
// ---------------------------------------------------------------------------

/** 진짜 FAT16 이미지를 만들어 rig 에 물린다. */
function realImage(t, r, files = []) {
  const img = path.join(os.tmpdir(), `pdedit-${process.pid}-${Math.random().toString(36).slice(2)}.img`);
  t.after(() => { try { fs.unlinkSync(img); } catch {} });
  const mk = spawnSync(process.execPath,
    [path.join(HERE_ROOT, 'node', 'bin', 'make_disk.js'), img, '9m', 'EDIT'],
    { encoding: 'utf8' });
  if (mk.status !== 0) return null;
  if (files.length)
    spawnSync(path.join(HERE_ROOT, 'src', 'host', 'disk_put.sh'), [img, ...files],
              { encoding: 'utf8' });
  r.disk.path = img;
  return img;
}

async function upload(web, id, name, body) {
  const res = await fetch(`http://127.0.0.1:${web.port}/files/stage`
    + `?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
    { method: 'POST', body });
  return { status: res.status, json: await res.json() };
}

test('올린 파일이 이미지에 들어간다', async (t) => {
  const r = await rig(t);
  if (!realImage(t, r)) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  const open = await (await fetch(`http://127.0.0.1:${r.web.port}/files/open`,
                                  { method: 'POST' })).json();
  assert.ok(open.id, '올리기 묶음이 열려야 한다');
  const up = await upload(r.web, open.id, 'HELLO.TXT', Buffer.from('hi from the web'));
  assert.equal(up.json.ok, true, up.json.why);

  b.send({ cmd: 'files_put', id2: open.id, into: '', id: 20 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 20, '넣기');
  assert.equal(rep.ok, true, rep.why);

  b.send({ cmd: 'files', id: 21 });
  const tree = await b.until((m) => m.type === 'reply' && m.id === 21, '트리');
  const got = tree.root.find((n) => n.name === 'HELLO.TXT');
  assert.ok(got, '올린 파일이 트리에 보여야 한다');
  assert.equal(got.size, 15);
  b.close();
});

test('지우기는 고른 것만 지우고, 하나라도 없으면 아무것도 안 지운다', async (t) => {
  const r = await rig(t);
  const a = path.join(os.tmpdir(), `pdA-${process.pid}.TXT`);
  const c = path.join(os.tmpdir(), `pdC-${process.pid}.TXT`);
  fs.writeFileSync(a, 'aaa'); fs.writeFileSync(c, 'ccc');
  t.after(() => { for (const f of [a, c]) { try { fs.unlinkSync(f); } catch {} } });
  if (!realImage(t, r, [a, c])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  // 없는 이름이 섞이면 전부 거절 - 다섯 중 하나가 오타일 때 나머지 넷이
  // 지워지고 이유가 위로 밀려 올라가면 안 된다.
  const nameA = path.basename(a).toUpperCase().slice(0, 8);
  b.send({ cmd: 'files_rm', paths: [`${nameA}~1.TXT`, 'NOPE.TXT'], id: 30 });
  const bad = await b.until((m) => m.type === 'reply' && m.id === 30, '거절');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /not on the disk/);

  b.send({ cmd: 'files', id: 31 });
  const still = await b.until((m) => m.type === 'reply' && m.id === 31, '트리');
  assert.equal(still.root.length, 2, '아무것도 안 지워졌어야 한다');
  b.close();
});

test('읽기 전용 이미지는 고치지 않는다', async (t) => {
  const r = await rig(t);
  r.disk.readonly = true;
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files_rm', paths: ['A.TXT'], id: 40 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 40, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /read-only/);
  b.close();
});

test('빈 선택으로는 지우지 않는다', async (t) => {
  // 화면의 버그가 빈 목록을 보내면 도구는 "이름 없이 부르면 목록을 찍는" 쪽으로
  // 갈 수 있다. 그건 성공으로 보이고, 사용자는 지워진 줄 안다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files_rm', paths: [], id: 50 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 50, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /nothing was selected/);
  b.close();
});

test('올리는 이름은 임시 폴더를 벗어나지 못한다', async (t) => {
  const r = await rig(t);
  const open = await (await fetch(`http://127.0.0.1:${r.web.port}/files/open`,
                                  { method: 'POST' })).json();
  const up = await upload(r.web, open.id, '../../escaped.txt', Buffer.from('x'));
  assert.equal(up.json.ok, true);
  assert.equal(up.json.name, 'escaped.txt', '경로 조각이 떨어져야 한다');
  assert.ok(!up.json.name.includes('/'), '구분자가 남으면 안 된다');
});

test('없는 올리기 묶음에는 넣지 않는다', async (t) => {
  const r = await rig(t);
  const up = await upload(r.web, 'made-up-id', 'X.TXT', Buffer.from('x'));
  assert.equal(up.json.ok, false);
  assert.match(up.json.why, /no such upload/);
});

// ---------------------------------------------------------------------------
// 인쇄 작업 내려받기. `--spool` 로 돌면 모든 바이트가 한 덩어리 .prn 에 들어가고
// 작업은 색인으로만 나뉘므로, **작업 하나에 해당하는 파일이 디스크에 없다.**
// 이 길이 없으면 작업 하나를 꺼내는 방법은 CLI 뿐이다.
// ---------------------------------------------------------------------------

async function rigWithSpool(t) {
  const { Printer } = await import('../src/printer.js');
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdprn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const printer = new Printer(r.hub, { mode: 'off', outDir: dir, spool: true, timeout: 0.05 });
  t.after(() => { try { printer.close(); } catch {} });
  r.web.deps ??= {};
  Object.assign(r.printer, printer);                 // rig 이 넘긴 그릇을 채운다
  Object.setPrototypeOf(r.printer, Printer.prototype);
  return r;
}

test('인쇄 작업을 파일로 내려받는다', async (t) => {
  const r = await rigWithSpool(t);
  r.printer.feed(Buffer.from('HELLO FROM THE MSX\r\n', 'latin1'));
  r.printer.flush();
  await new Promise((res) => setTimeout(res, 60));
  r.printer.tick?.();
  const list = r.printer.jobs();
  assert.ok(list.length, '작업이 색인에 있어야 한다');
  const seq = list[0].seq;

  const raw = await fetch(`http://127.0.0.1:${r.web.port}/print/job?seq=${seq}&as=prn`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-disposition') || '', /\.prn"/);
  assert.equal(Buffer.from(await raw.arrayBuffer()).length, 20);

  const txt = await fetch(`http://127.0.0.1:${r.web.port}/print/job?seq=${seq}&as=txt`);
  assert.equal(txt.status, 200);
  assert.match(await txt.text(), /HELLO FROM THE MSX/);
});

test('없는 작업과 잘못된 요청은 조용히 빈 파일을 주지 않는다', async (t) => {
  // 빈 파일을 200 으로 주면 "인쇄한 것이 비었다" 로 읽힌다. 그게 제일 나쁘다.
  const r = await rigWithSpool(t);
  const gone = await fetch(`http://127.0.0.1:${r.web.port}/print/job?seq=999&as=prn`);
  assert.equal(gone.status, 404);
  const nope = await fetch(`http://127.0.0.1:${r.web.port}/print/job?as=prn`);
  assert.equal(nope.status, 400);
});

test('스풀이 없으면 내려받기를 거절한다', async (t) => {
  const r = await rig(t);                    // 기본 rig 의 printer 는 spool 이 없다
  const res = await fetch(`http://127.0.0.1:${r.web.port}/print/job?seq=1&as=prn`);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /spool/);
});

test('이름을 바꾼다', async (t) => {
  const r = await rig(t);
  const f = path.join(os.tmpdir(), `pdmv-${process.pid}.TXT`);
  fs.writeFileSync(f, 'hello');
  t.after(() => { try { fs.unlinkSync(f); } catch {} });
  if (!realImage(t, r, [f])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'files', id: 60 });
  const before = await b.until((m) => m.type === 'reply' && m.id === 60, '트리');
  const was = before.root[0].name;

  b.send({ cmd: 'files_mv', path: was, name: 'RENAMED.TXT', id: 61 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 61, '이름 바꾸기');
  assert.equal(rep.ok, true, rep.why);

  b.send({ cmd: 'files', id: 62 });
  const after = await b.until((m) => m.type === 'reply' && m.id === 62, '트리');
  const got = after.root.find((n) => n.name === 'RENAMED.TXT');
  assert.ok(got, '새 이름이 보여야 한다');
  assert.equal(got.size, 5, '내용은 그대로여야 한다');
  assert.ok(!after.root.some((n) => n.name === was), '옛 이름은 없어야 한다');
  b.close();
});

test('8.3 을 벗어나는 이름은 거절한다', async (t) => {
  // 짧게 줄여 저장하면 AUTOEXEC.BAT 이 없는 파일을 가리키게 된다.
  const r = await rig(t);
  const f = path.join(os.tmpdir(), `pdmv2-${process.pid}.TXT`);
  fs.writeFileSync(f, 'x');
  t.after(() => { try { fs.unlinkSync(f); } catch {} });
  if (!realImage(t, r, [f])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files', id: 70 });
  const tree = await b.until((m) => m.type === 'reply' && m.id === 70, '트리');

  for (const bad of ['WAY.TOO.LONG.NAME.TXT', 'has space.txt', 'sub/dir.txt']) {
    b.send({ cmd: 'files_mv', path: tree.root[0].name, name: bad, id: 71 });
    const rep = await b.until((m) => m.type === 'reply' && m.id === 71, `거절: ${bad}`);
    assert.equal(rep.ok, false, `${bad} 는 거절돼야 한다`);
    assert.match(rep.why, /8\.3|not a name/);
  }
  b.close();
});

test('이미 있는 이름으로는 못 바꾼다', async (t) => {
  // 덮어쓰면 한 이름에 항목이 둘이 된다. MSX 는 먼저 찾은 쪽을 열고, 다른
  // 하나는 클러스터를 쥔 채 닿을 수 없는 데이터가 된다.
  const r = await rig(t);
  const a = path.join(os.tmpdir(), `pdA2-${process.pid}.TXT`);
  const c = path.join(os.tmpdir(), `pdC2-${process.pid}.TXT`);
  fs.writeFileSync(a, 'aa'); fs.writeFileSync(c, 'cc');
  t.after(() => { for (const x of [a, c]) { try { fs.unlinkSync(x); } catch {} } });
  if (!realImage(t, r, [a, c])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files', id: 80 });
  const tree = await b.until((m) => m.type === 'reply' && m.id === 80, '트리');
  assert.equal(tree.root.length, 2);

  b.send({ cmd: 'files_mv', path: tree.root[0].name, name: tree.root[1].name, id: 81 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 81, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /already there/);

  b.send({ cmd: 'files', id: 82 });
  const after = await b.until((m) => m.type === 'reply' && m.id === 82, '트리');
  assert.equal(after.root.length, 2, '둘 다 그대로 있어야 한다');
  b.close();
});

// ---------------------------------------------------------------------------
// 글 편집기. 여기서 틀리면 **손대지 않은 절반까지** 바뀐다.
// ---------------------------------------------------------------------------

test('글 파일을 읽고 고쳐 쓴다', async (t) => {
  const r = await rig(t);
  const f = path.join(os.tmpdir(), `pded-${process.pid}.BAT`);
  fs.writeFileSync(f, '@ECHO OFF\r\n@SET PATH=A:\\\r\n', 'latin1');
  t.after(() => { try { fs.unlinkSync(f); } catch {} });
  if (!realImage(t, r, [f])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  const name = path.basename(f).toUpperCase().slice(0, 8) + '.BAT';

  b.send({ cmd: 'files', id: 90 });
  const tree = await b.until((m) => m.type === 'reply' && m.id === 90, '트리');
  const target = tree.root[0].name;

  b.send({ cmd: 'file_read', path: target, id: 91 });
  const got = await b.until((m) => m.type === 'reply' && m.id === 91, '읽기');
  assert.equal(got.ok, true, got.why);
  assert.equal(got.charset, 'ascii');
  assert.equal(got.exact, true, '왕복이 정확해야 편집을 허락한다');
  assert.equal(got.crlf, true);
  assert.match(got.text, /@ECHO OFF/);

  b.send({ cmd: 'file_write', path: target, charset: 'ascii',
           text: got.text.replace('@ECHO OFF', '@ECHO CHANGED'), id: 92 });
  const wrote = await b.until((m) => m.type === 'reply' && m.id === 92, '쓰기');
  assert.equal(wrote.ok, true, wrote.why);

  b.send({ cmd: 'file_read', path: target, id: 93 });
  const again = await b.until((m) => m.type === 'reply' && m.id === 93, '다시 읽기');
  assert.match(again.text, /@ECHO CHANGED/);
  assert.match(again.text, /\r\n/, 'CRLF 가 유지돼야 한다');
  b.close();
});

test('편집기는 폴더와 없는 파일을 열지 않는다', async (t) => {
  const r = await rig(t);
  const f = path.join(os.tmpdir(), `pded2-${process.pid}.TXT`);
  fs.writeFileSync(f, 'x');
  t.after(() => { try { fs.unlinkSync(f); } catch {} });
  if (!realImage(t, r, [f])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'file_read', path: 'NOPE.TXT', id: 95 });
  const gone = await b.until((m) => m.type === 'reply' && m.id === 95, '없는 파일');
  assert.equal(gone.ok, false);
  assert.match(gone.why, /not on the disk/);

  b.send({ cmd: 'file_read', path: '', id: 96 });
  const empty = await b.until((m) => m.type === 'reply' && m.id === 96, '빈 경로');
  assert.equal(empty.ok, false);
  b.close();
});

test('읽기 전용 이미지에는 글을 쓰지 않는다', async (t) => {
  const r = await rig(t);
  r.disk.readonly = true;
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'file_write', path: 'A.TXT', text: 'x', id: 97 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 97, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /read-only/);
  b.close();
});

test('빈 글 파일을 만들고 바로 쓴다', async (t) => {
  const r = await rig(t);
  if (!realImage(t, r)) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'file_new', into: '', name: 'NOTES.TXT', id: 100 });
  const made = await b.until((m) => m.type === 'reply' && m.id === 100, '만들기');
  assert.equal(made.ok, true, made.why);
  assert.equal(made.path, 'NOTES.TXT');
  assert.equal(made.bytes, 0, '새 파일은 비어 있어야 한다');

  b.send({ cmd: 'file_read', path: 'NOTES.TXT', id: 101 });
  const got = await b.until((m) => m.type === 'reply' && m.id === 101, '읽기');
  assert.equal(got.ok, true, got.why);
  assert.equal(got.text, '');

  b.send({ cmd: 'file_write', path: 'NOTES.TXT', charset: 'ascii',
           text: 'hello\n', id: 102 });
  assert.equal((await b.until((m) => m.type === 'reply' && m.id === 102, '쓰기')).ok, true);
  b.close();
});

test('만들기는 있는 것을 덮지 않는다', async (t) => {
  // add_file 은 덮어쓴다 - 복사에는 맞고 "새로 만들기" 에는 틀리다. 오타 하나가
  // 부딪힌 파일을 먹고는 성공했다고 말하게 된다.
  const r = await rig(t);
  const f = path.join(os.tmpdir(), `pdnew-${process.pid}.TXT`);
  fs.writeFileSync(f, 'precious');
  t.after(() => { try { fs.unlinkSync(f); } catch {} });
  if (!realImage(t, r, [f])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'files', id: 110 });
  const tree = await b.until((m) => m.type === 'reply' && m.id === 110, '트리');
  const name = tree.root[0].name;

  b.send({ cmd: 'file_new', into: '', name, id: 111 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 111, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /already there/);

  b.send({ cmd: 'file_read', path: name, id: 112 });
  const still = await b.until((m) => m.type === 'reply' && m.id === 112, '읽기');
  assert.equal(still.text, 'precious', '있던 내용이 그대로여야 한다');
  b.close();
});

test('만들기도 8.3 과 읽기 전용을 지킨다', async (t) => {
  const r = await rig(t);
  if (!realImage(t, r)) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'file_new', into: '', name: 'has space.txt', id: 120 });
  const bad = await b.until((m) => m.type === 'reply' && m.id === 120, '거절');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /8\.3|not a name/);

  b.send({ cmd: 'file_new', into: 'NOPE', name: 'A.TXT', id: 121 });
  const nodir = await b.until((m) => m.type === 'reply' && m.id === 121, '없는 폴더');
  assert.equal(nodir.ok, false);
  assert.match(nodir.why, /no such folder/);

  r.disk.readonly = true;
  b.send({ cmd: 'file_new', into: '', name: 'A.TXT', id: 122 });
  const ro = await b.until((m) => m.type === 'reply' && m.id === 122, '읽기 전용');
  assert.equal(ro.ok, false);
  assert.match(ro.why, /read-only/);
  b.close();
});

test('하위 폴더 안에 글 파일을 만든다', async (t) => {
  // 화면의 목적지 목록이 보내는 값이 이것이다. 한 단계만 되고 두 단계는
  // 안 되면 목록에는 보이는데 고르면 실패하는 항목이 생긴다.
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pddeep-'));
  fs.mkdirSync(path.join(dir, 'GAMES', 'SUB'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GAMES', 'A.ROM'), 'a');
  fs.writeFileSync(path.join(dir, 'GAMES', 'SUB', 'B.ROM'), 'b');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (!realImage(t, r, [path.join(dir, 'GAMES')])) { t.skip('make_disk 를 못 돌렸다'); return; }

  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 200;
  for (const [into, want] of [['', 'NOTE.TXT'],
                              ['GAMES', 'GAMES/NOTE.TXT'],
                              ['GAMES/SUB', 'GAMES/SUB/NOTE.TXT']]) {
    b.send({ cmd: 'file_new', into, name: 'NOTE.TXT', id: ++id });
    const rep = await b.until((m) => m.type === 'reply' && m.id === id, `만들기 ${into}`);
    assert.equal(rep.ok, true, `${into}: ${rep.why}`);
    assert.equal(rep.path, want);
  }

  // 그리고 셋이 서로 다른 파일이어야 한다 - 같은 이름이라고 겹치면 안 된다.
  b.send({ cmd: 'files', id: ++id });
  const tree = await b.until((m) => m.type === 'reply' && m.id === id, '트리');
  const games = tree.root.find((n) => n.name === 'GAMES');
  assert.ok(tree.root.some((n) => n.name === 'NOTE.TXT'), '루트에 있어야 한다');
  assert.ok(games.children.some((n) => n.name === 'NOTE.TXT'), 'GAMES 에 있어야 한다');
  assert.ok(games.children.find((n) => n.name === 'SUB')
                 .children.some((n) => n.name === 'NOTE.TXT'), 'SUB 에 있어야 한다');
  b.close();
});

test('폴더를 만들고, 그 안에 또 만든다', async (t) => {
  // "MSX 는 폴더 안에 폴더를 못 만드나" 에서 나왔다. MSX-DOS 2/Nextor 는
  // MKDIR 를 갖고 있고 FAT 은 깊이를 따지지 않는다 - 없던 것은 화면의 버튼
  // 쪽이었다. 중첩이 실제로 되는 것을 여기서 지킨다.
  const r = await rig(t);
  if (!realImage(t, r)) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 300;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };

  assert.equal((await send({ cmd: 'file_mkdir', into: '', name: 'TOOLS' })).ok, true);
  assert.equal((await send({ cmd: 'file_mkdir', into: 'TOOLS', name: 'MSX2' })).ok, true);
  assert.equal((await send({ cmd: 'file_mkdir', into: 'TOOLS/MSX2', name: 'SUB' })).ok, true);
  // 그 안에 파일까지 만들어져야 폴더가 진짜 쓸 수 있는 것이다.
  assert.equal((await send({ cmd: 'file_new', into: 'TOOLS/MSX2/SUB', name: 'A.TXT' })).ok, true);

  const tree = await send({ cmd: 'files' });
  const tools = tree.root.find((n) => n.name === 'TOOLS');
  assert.ok(tools && tools.dir, 'TOOLS 가 폴더로 보여야 한다');
  const msx2 = tools.children.find((n) => n.name === 'MSX2');
  const sub = msx2.children.find((n) => n.name === 'SUB');
  assert.ok(sub.children.some((n) => n.name === 'A.TXT'), '세 단계 아래 파일이 있어야 한다');
  b.close();
});

test('폴더 만들기도 거절할 것은 거절한다', async (t) => {
  const r = await rig(t);
  if (!realImage(t, r)) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 320;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };

  await send({ cmd: 'file_mkdir', into: '', name: 'ONE' });
  const dup = await send({ cmd: 'file_mkdir', into: '', name: 'one' });
  assert.equal(dup.ok, false, '대소문자만 다른 같은 이름은 거절한다');
  assert.match(dup.why, /already there/);

  // **부모를 만들어 주지 않는다.** 경로 가운데의 오타가 아무도 안 보는
  // 자리에 폴더 둘을 만들어 놓으면, 그건 성공으로 보인다.
  const orphan = await send({ cmd: 'file_mkdir', into: 'NOPE', name: 'CHILD' });
  assert.equal(orphan.ok, false);
  assert.match(orphan.why, /no such folder/);

  const bad = await send({ cmd: 'file_mkdir', into: '', name: 'has space' });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /8\.3|not a name/);

  r.disk.readonly = true;
  const ro = await send({ cmd: 'file_mkdir', into: '', name: 'X' });
  assert.equal(ro.ok, false);
  assert.match(ro.why, /read-only/);
  b.close();
});

test('내용이 있는 폴더는 지우지 않는다', async (t) => {
  // 폴더 하나를 지우면 그 아래 클러스터가 전부 풀린다 - 이 화면에서 가장
  // 파괴적인 한 번의 동작이다. rm 이 오십 년째 -r 을 요구하는 이유와 같다.
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdrm-'));
  fs.mkdirSync(path.join(dir, 'FULL'));
  fs.writeFileSync(path.join(dir, 'FULL', 'A.TXT'), 'keep me');
  fs.mkdirSync(path.join(dir, 'EMPTY'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (!realImage(t, r, [path.join(dir, 'FULL'), path.join(dir, 'EMPTY')])) {
    t.skip('make_disk 를 못 돌렸다'); return;
  }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 400;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };

  const no = await send({ cmd: 'files_rm', paths: ['FULL'] });
  assert.equal(no.ok, false, '내용이 있으면 거절해야 한다');
  assert.match(no.why, /not empty/);

  // 그리고 그 안의 파일이 멀쩡해야 한다. 거절했다는 말만 믿을 수는 없다.
  const inside = await send({ cmd: 'file_read', path: 'FULL/A.TXT' });
  assert.equal(inside.ok, true, inside.why);
  assert.equal(inside.text, 'keep me');

  // 빈 폴더는 -r 없이도 간다. 잃을 것이 없으니 막을 이유도 없다.
  const yes = await send({ cmd: 'files_rm', paths: ['EMPTY'] });
  assert.equal(yes.ok, true, yes.why);

  // 안을 비우면 폴더도 지워진다.
  assert.equal((await send({ cmd: 'files_rm', paths: ['FULL/A.TXT'] })).ok, true);
  assert.equal((await send({ cmd: 'files_rm', paths: ['FULL'] })).ok, true);
  b.close();
});

test('삭제 실패는 이유를 통째로 돌려준다', async (t) => {
  // 화면이 이 글을 그대로 띄운다. 첫 줄만 보여 주면 "왜" 를 잃는다 -
  // disk_rm 의 안내가 정확히 둘째 줄에 있다.
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdwhy-'));
  fs.mkdirSync(path.join(dir, 'FULL'));
  fs.writeFileSync(path.join(dir, 'FULL', 'A.TXT'), 'x');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (!realImage(t, r, [path.join(dir, 'FULL')])) { t.skip('make_disk 를 못 돌렸다'); return; }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'files_rm', paths: ['FULL'], id: 500 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 500, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /not empty/, '무엇이 문제인지');
  assert.match(rep.why, /Nothing was removed/, '무슨 일이 일어났는지');
  assert.match(rep.why, /Empty it first/, '어떻게 해야 하는지');
  assert.ok(rep.why.includes('\n'), '여러 줄이다 - 첫 줄만 쓰면 안 된다');
  b.close();
});

// ---------------------------------------------------------------------------
// 인쇄 작업을 문서로 묶기.
// ---------------------------------------------------------------------------

async function rigWithJobs(t, texts) {
  const { Printer } = await import('../src/printer.js');
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pddoc-t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const printer = new Printer(r.hub, { mode: 'off', outDir: dir, spool: true, timeout: 0.02 });
  t.after(() => { try { printer.close(); } catch {} });
  Object.assign(r.printer, printer);
  Object.setPrototypeOf(r.printer, Printer.prototype);
  for (const txt of texts) {
    r.printer.feed(Buffer.from(txt, 'latin1'));
    r.printer.flush();
    await new Promise((res) => setTimeout(res, 30));
  }
  return r;
}

test('답의 결과 필드가 요청 id 를 덮지 않는다', async (t) => {
  // 답은 {type:'reply', id: 요청번호, ...결과} 로 합쳐져 나간다. 결과에 `id`
  // 가 있으면 요청 번호를 덮어쓰고, 기다리던 쪽은 제 답을 영영 못 알아본다 -
  // doc_make 가 문서 id 를 `id` 로 부르는 바람에 실제로 그렇게 멎었다.
  const r = await rigWithJobs(t, ['FIRST\r\n', 'SECOND\r\n']);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'doc_make', seqs: [1, 2], style: 'msx', id: 4242 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 4242, '문서');
  assert.equal(rep.id, 4242, '요청 id 가 살아 있어야 한다');
  if (rep.ok) {
    assert.ok(rep.doc, '문서 id 는 doc 으로 와야 한다');
    assert.notEqual(rep.doc, rep.id);
  }
  b.close();
});

test('고른 작업들이 PDF 한 벌로 묶인다', async (t) => {
  const r = await rigWithJobs(t, ['ONE\r\n', 'TWO\r\n', 'THREE\r\n']);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 600;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };

  for (const style of DOC_STYLES) {
    const d = await send({ cmd: 'doc_make', seqs: [1, 2, 3], style });
    assert.equal(d.ok, true, `${style}: ${d.why}`);
    assert.equal(d.pages, 3, `${style}: 작업 셋이면 세 쪽`);
    assert.ok(d.bytes > 1000, `${style}: 빈 PDF 가 아니어야 한다`);

    // 미리보기가 진짜 PDF 를 내주는가. 200 에 빈 몸통이 제일 나쁘다.
    const res = await fetch(`http://127.0.0.1:${r.web.port}/print/doc?id=${d.doc}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString(), '%PDF-', 'PDF 헤더여야 한다');
    assert.equal(body.length, d.bytes);
  }
  b.close();
});

test('문서 만들기는 거절할 것을 거절한다', async (t) => {
  const r = await rigWithJobs(t, ['ONE\r\n']);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 700;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };
  assert.match((await send({ cmd: 'doc_make', seqs: [], style: 'msx' })).why, /no jobs/);
  assert.match((await send({ cmd: 'doc_make', seqs: [1], style: 'nope' })).why, /unknown style/);
  assert.match((await send({ cmd: 'doc_print', doc: 'made-up' })).why, /no such document/);

  const gone = await fetch(`http://127.0.0.1:${r.web.port}/print/doc?id=made-up`);
  assert.equal(gone.status, 404, '없는 문서에 빈 200 을 주면 안 된다');
  b.close();
});

test('작업 여럿을 한 장에 쌓는다', async (t) => {
  // 세 줄짜리 LPRINT 셋이 종이 석 장이 되면 안 된다. 기본은 작업마다 한 장,
  // stack 을 주면 들어가는 데까지 이어 붙인다.
  const r = await rigWithJobs(t, ['ONE\r\n', 'TWO\r\n', 'THREE\r\n']);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 800;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };
  for (const style of DOC_STYLES) {
    const apart = await send({ cmd: 'doc_make', seqs: [1, 2, 3], style });
    const piled = await send({ cmd: 'doc_make', seqs: [1, 2, 3], style, stack: true });
    assert.equal(apart.ok, true, apart.why);
    assert.equal(piled.ok, true, piled.why);
    assert.equal(apart.pages, 3, `${style}: 기본은 작업마다 한 장`);
    assert.equal(piled.pages, 1, `${style}: 쌓으면 한 장`);
    assert.equal(piled.stack, true, '쌓았다고 답해야 한다');
    // 한 장으로 줄었다고 내용까지 줄면 안 된다.
    assert.ok(piled.bytes > 2000, `${style}: 빈 장이 아니어야 한다`);
  }
  b.close();
});

test('토큰화된 BASIC 은 열어도 고칠 수 없다', async (t) => {
  // .BAS 가 곧 글은 아니다. SAVE "X",A 는 ASCII 지만 그냥 SAVE "X" 는 첫
  // 바이트가 0xFF 인 **토큰화 바이너리**다. 둘 다 .BAS 로 끝난다.
  //
  // 왕복 검사는 이것을 못 잡는다 - latin-1 은 어떤 바이트든 그대로 되살리므로
  // exact 가 참이 되고, 그러면 저장 버튼이 열린다. 그래서 따로 본다.
  const r = await rig(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdbas-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 토큰화 BASIC 을 흉내 낸다: 0xFF 로 시작하고 NUL 이 섞인다.
  const tok = Buffer.from([0xff, 0x09, 0x80, 0x0a, 0x00, 0x41, 0x00, 0x80, 0x00]);
  fs.writeFileSync(path.join(dir, 'TOK.BAS'), tok);
  fs.writeFileSync(path.join(dir, 'PLAIN.BAS'), '10 PRINT "HI"\r\n20 END\r\n', 'latin1');
  if (!realImage(t, r, [path.join(dir, 'TOK.BAS'), path.join(dir, 'PLAIN.BAS')])) {
    t.skip('make_disk 를 못 돌렸다'); return;
  }
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  let id = 900;
  const send = async (msg) => {
    b.send({ ...msg, id: ++id });
    return b.until((m) => m.type === 'reply' && m.id === id, JSON.stringify(msg));
  };

  const t1 = await send({ cmd: 'file_read', path: 'TOK.BAS' });
  assert.equal(t1.ok, true, '열리기는 해야 한다 - 무엇인지 보여 줘야 하니까');
  assert.equal(t1.exact, false, '고칠 수 없다고 말해야 한다');
  assert.match(t1.binary, /tokenised BASIC/, '왜인지 이름을 대야 한다');

  // 화면을 안 거치고 와도 막혀야 한다.
  const w = await send({ cmd: 'file_write', path: 'TOK.BAS', charset: 'ascii', text: 'x' });
  assert.equal(w.ok, false);
  assert.match(w.why, /tokenised BASIC/);

  // 그리고 바이트가 그대로여야 한다. 거절했다는 말만 믿을 수는 없다.
  const after = await send({ cmd: 'file_read', path: 'TOK.BAS' });
  assert.equal(after.bytes, tok.length, '건드리지 않았어야 한다');

  // ASCII 로 저장한 .BAS 는 여전히 고칠 수 있어야 한다.
  const t2 = await send({ cmd: 'file_read', path: 'PLAIN.BAS' });
  assert.equal(t2.exact, true, 'ASCII .BAS 는 글이다');
  assert.equal(t2.binary ?? null, null);
  assert.match(t2.text, /10 PRINT/);
  b.close();
});

test('화면에서 답하는 쪽을 바꾼다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  const st = await b.until((m) => m.type === 'state');
  assert.equal(st.ask.mode, 'google', '기본은 검색이다');

  b.send({ cmd: 'ask_mode', mode: 'manual', id: 1000 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1000, '모드');
  assert.equal(rep.ok, true);
  assert.equal(rep.mode, 'manual');
  // 바뀐 것이 모든 화면에 가야 한다 - 창을 둘 열어 두면 한쪽만 맞는 것이
  // 제일 나쁘다.
  const after = await b.until((m) => m.type === 'state' && m.ask.mode === 'manual',
                              '바뀐 상태');
  assert.equal(after.ask.mode, 'manual');
  b.close();
});

// --- 찍는 대로 종이로 -------------------------------------------------------
//
// **여기서도 종이는 안 나간다** - rig 가 가짜 실행기를 끼운다. 보는 것은
// 화면이 무엇을 눌렀을 때 서버가 무엇을 하느냐 하나다.

test('화면은 어떤 프린터가 있는지 서버에게서 받는다', async (t) => {
  // 목록을 화면에 적어 두면 --printers 로 는 순간 어긋난다.
  const r = await rig(t);
  const b = await browser(r.url());
  const s = await b.until((m) => m.type === 'state', 'state');
  assert.ok(Array.isArray(s.printers) && s.printers.length, s.printers);
  assert.ok(s.printers.some((p) => p.id === 'escpos58'));
  // 이름만 보고 58 과 80 을 가릴 수 있어야 고를 수 있다.
  assert.match(s.printers.find((p) => p.id === 'escpos58').label, /58mm/);
  assert.equal(s.direct.on, false, '기본은 꺼짐이다 - 종이는 되돌릴 수 없다');
  b.close();
});

test('스풀이 꺼져 있어도 켜진다 - 서버가 스풀을 켜 준다', async (t) => {
  // 렌더러는 스풀 색인으로 작업을 찾으므로 스풀이 있어야 한다. 그렇다고
  // 사람에게 서버를 내렸다 올리라고 하면, 화면에 스위치를 둔 뜻이 없어진다.
  // 실제로 "Print straight through 가 클릭 안됨" 으로 드러났다 (2026-09-23).
  const r = await rig(t);                       // --spool 없이 띄운 서버
  assert.equal(r.printer.spool, null);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(rep.ok, true, rep.why);
  assert.ok(r.printer.spool, '스풀이 켜져 있어야 한다');
  assert.equal(r.direct.on, true);
  b.close();
});

test('이미 도는 스풀 위에 새 스풀을 열지 않는다', async (t) => {
  // 덮어쓰면 열려 있던 .prn/.idx 핸들을 놓고 색인이 1 번부터 다시 시작한다.
  // 이미 찍힌 작업들이 화면에서 통째로 사라진다.
  const r = await rig(t, { spool: true });
  const was = r.printer.spool;
  const wasPath = was.prnPath;
  r.printer.feed(Buffer.from('FIRST'));
  r.printer.flush();
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(rep.ok, true, rep.why);
  assert.equal(r.printer.spool, was, '같은 스풀이어야 한다');
  assert.equal(r.printer.spool.prnPath, wasPath);
  r.printer.feed(Buffer.from('SECOND'));
  r.printer.flush();
  // 색인이 이어져야 한다 - 1 번부터 다시 세면 앞엣것이 사라진 것이다.
  assert.equal(r.printer.spool.seq, 2, '작업 번호가 이어져야 한다');
  assert.equal(fs.readFileSync(wasPath).toString(), 'FIRSTSECOND');
  b.close();
});

test('프린터 자체가 없으면 그렇다고 말한다', async (t) => {
  // snapshot 은 printer 가 null 일 수 있다고 보고 그린다. 그러면 여기서도
  // null 을 밟는데, 막지 않으면 TypeError 가 나고 화면에는 스택 조각이 뜬다.
  const r = await rig(t, { noPrinter: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /printer is not configured/);
  b.close();
});

test('스풀을 못 켜면 켜진 척하지 않는다', async (t) => {
  // 조용히 삼키면 스위치는 켜졌는데 아무것도 안 나가고, 까닭이 어디에도 없다.
  const r = await rig(t);
  r.printer.startSpool = () => { throw new Error('the disk is full'); };
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /disk is full/);
  assert.equal(r.direct.on, false, '못 켰으면 꺼져 있어야 한다');
  b.close();
});

test('켜는 순간 찍고 있던 작업도 반쪽이 되지 않는다', async (t) => {
  // 버퍼에 있던 바이트를 안 옮기면 그 작업만 앞이 잘린 채 종이로 나간다.
  //
  // `--print raw` 로 띄운다. 아무것도 안 켠 서버(mode off, 스풀 없음)는
  // 프린터 바이트를 **받는 자리에서 버린다** - 일부러 그렇다. 그러니 그때는
  // 이어받을 것도 없고, 옮길 것이 생기는 것은 잡아는 두는데 스풀만 없는
  // 이쪽이다.
  const r = await rig(t, { printMode: 'raw' });
  r.printer.feed(Buffer.from('HALF A JOB'));
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  r.printer.flush();
  const kept = fs.readFileSync(r.printer.spool.prnPath);
  assert.equal(kept.toString(), 'HALF A JOB');
  b.close();
});

test('켜고 끄는 것이 화면에 되비친다', async (t) => {
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');

  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  const on = await b.until((m) => m.type === 'reply' && m.id === 1, 'on');
  assert.equal(on.ok, true);
  assert.equal(on.status.on, true);
  assert.equal(on.status.target, 'escpos58');
  // 스냅샷도 같은 말을 해야 한다 - 창이 둘일 때 둘이 다르면 안 된다.
  const s = await b.until((m) => m.type === 'state' && m.direct && m.direct.on,
                          'state with direct on');
  assert.match(s.direct.label, /58mm/);

  // 자동만 끈다: 프린터는 골라 둔 채로 남아야 한 장씩 보낼 수 있다.
  b.send({ cmd: 'direct', id: 2, auto: false });
  const off = await b.until((m) => m.type === 'reply' && m.id === 2, 'off');
  assert.equal(off.status.on, false);
  assert.equal(off.status.ready, true, '프린터는 그대로 골라져 있어야 한다');
  b.close();
});

test('모르는 프린터는 거절하고, 켜진 것은 그대로 둔다', async (t) => {
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  await b.until((m) => m.type === 'reply' && m.id === 1, 'on');
  b.send({ cmd: 'direct', id: 2, to: 'nosuch' });
  const bad = await b.until((m) => m.type === 'reply' && m.id === 2, 'bad');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /no printer/);
  assert.equal(r.direct.target, 'escpos58', '거절이 켜진 것을 끄면 안 된다');
  b.close();
});

test('나가다 만 작업을 다시 보낸다', async (t) => {
  // 프린터를 켜거나 종이를 끼운 뒤에 쓰는 길. 없으면 그 작업은 영영 안 나간다.
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct_again', id: 1, seq: 3 });
  const nope = await b.until((m) => m.type === 'reply' && m.id === 1, 'off');
  assert.equal(nope.ok, false, '꺼져 있으면 다시 보낼 것도 없다');

  b.send({ cmd: 'direct', id: 2, to: 'escpos58', auto: true });
  await b.until((m) => m.type === 'reply' && m.id === 2, 'on');
  b.send({ cmd: 'direct_again', id: 3, seq: 3 });
  const again = await b.until((m) => m.type === 'reply' && m.id === 3, 'again');
  assert.equal(again.ok, true);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(r.printed, ['escpos58:3']);
  // 어느 작업인지 안 대면 거절한다. Number(undefined) 는 NaN 이다.
  b.send({ cmd: 'direct_again', id: 4 });
  const which = await b.until((m) => m.type === 'reply' && m.id === 4, 'which');
  assert.equal(which.ok, false);
  b.close();
});

test('고른 작업을 지금 보낸다 - 자동과는 다른 일이다', async (t) => {
  // 화면에 이것이 없어서 "버튼이나 뭐 그런게 없어" 가 나왔다.
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');

  // 프린터를 고르되 자동은 켜지 않는다.
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: false });
  const set = await b.until((m) => m.type === 'reply' && m.id === 1, 'set');
  assert.equal(set.status.on, false, '자동은 꺼져 있다');
  assert.equal(set.status.ready, true, '그래도 보낼 곳은 정해졌다');

  b.send({ cmd: 'print_jobs', id: 2, seqs: [3, 5] });
  const sent = await b.until((m) => m.type === 'reply' && m.id === 2, 'sent');
  assert.equal(sent.ok, true, sent.why);
  assert.equal(sent.sent, 2);
  await new Promise((res) => setTimeout(res, 60));
  // **한 장으로 합쳐 나간다.** 종이 두 장이 아니라 이어진 하나다.
  assert.deepEqual(r.printed, ['escpos58:3+5']);
  b.close();
});

test('프린터를 안 골랐으면 보내기가 거절한다', async (t) => {
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'print_jobs', id: 1, seqs: [1] });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 1, 'reply');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /no printer is chosen/);
  assert.deepEqual(r.printed, []);
  b.close();
});

test('보낼 작업을 안 고르면 거절한다', async (t) => {
  const r = await rig(t, { spool: true });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: false });
  await b.until((m) => m.type === 'reply' && m.id === 1, 'set');
  b.send({ cmd: 'print_jobs', id: 2, seqs: [] });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 2, 'reply');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /no jobs/);
  b.close();
});

test('자동을 꺼도 손으로 보낸 것은 살아남는다', async (t) => {
  // 자동으로 줄 선 것은 스위치를 끄면 버린다. 사람이 대놓고 시킨 것은 다르다.
  const r = await rig(t, { spool: true });
  const held = new Promise(() => {});          // 첫 장을 붙잡아 둔다
  r.direct._run = () => held;
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state', 'state');
  b.send({ cmd: 'direct', id: 1, to: 'escpos58', auto: true });
  await b.until((m) => m.type === 'reply' && m.id === 1, 'on');
  r.direct.send(r.printer.spool.prnPath.replace(/\.prn$/, ''), 1);   // 돌고 있는 것
  r.direct.send(r.printer.spool.prnPath.replace(/\.prn$/, ''), 2);   // 자동, 줄에
  b.send({ cmd: 'print_jobs', id: 2, seqs: [9] });                   // 손으로, 줄에
  await b.until((m) => m.type === 'reply' && m.id === 2, 'sent');
  assert.equal(r.direct.status().queued, 2);
  b.send({ cmd: 'direct', id: 3, auto: false });
  await b.until((m) => m.type === 'reply' && m.id === 3, 'off');
  assert.equal(r.direct.status().queued, 1, '손으로 보낸 것만 남아야 한다');
  assert.deepEqual(r.direct.queue.map((j) => j.seq), [9]);
  b.close();
});

test('답을 무엇으로 돌려줄지는 ask 명령이다', async (t) => {
  // 화면에서 Ask 칸으로 옮겼다. 그리고 **음성 서비스가 없어도 text 로는
  // 되돌릴 수 있어야 한다** - 예전에는 voice 명령에 얹혀 있어서, 음성이 없는
  // 서버에서는 그것조차 거절당했다. 이 rig 에는 음성이 없다.
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'ask_reply', reply: 'both', id: 1 });
  const ok = await b.until((m) => m.type === 'reply' && m.id === 1);
  assert.equal(ok.ok, true, ok.why);
  assert.equal(r.ask.replyMode, 'both');
  await b.until((m) => m.type === 'state' && m.ask?.reply === 'both');

  b.send({ cmd: 'ask_reply', reply: 'sound', id: 2 });
  const bad = await b.until((m) => m.type === 'reply' && m.id === 2);
  assert.equal(bad.ok, false, '오타를 받았다');
  assert.match(bad.why, /unknown reply mode/);
  assert.equal(r.ask.replyMode, 'both', '거절해 놓고 바꿨다');
  b.close();
});

test('모니터 소리는 바이너리로, 속도와 함께 간다', async (t) => {
  // [0x56][rate:4 LE][int16 pcm...] 과 [0x57]. 화면이 이 틀을 풀어서 AudioBuffer
  // 에 싣는다 - 틀이 어긋나면 소리 대신 잡음이 나거나 엉뚱한 속도로 난다.
  const r = await rig(t);
  const ws = new WebSocket(r.url());
  ws.binaryType = 'arraybuffer';
  const bins = [];
  ws.addEventListener('message', (e) => { if (e.data instanceof ArrayBuffer) bins.push(e.data); });
  await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
  await new Promise((ok) => setTimeout(ok, 50));

  r.web.voice(Int16Array.from([0, 1000, -1000, 32767]), 10455);
  r.web.voiceStop();
  await new Promise((ok) => setTimeout(ok, 100));
  ws.close();

  assert.equal(bins.length, 2, `${bins.length} 개 받았다`);
  const dv = new DataView(bins[0]);
  assert.equal(dv.getUint8(0), 0x56);
  assert.equal(dv.getUint32(1, true), 10455, '속도가 틀렸다');
  const pcm = new Int16Array(bins[0].slice(5));
  assert.deepEqual([...pcm], [0, 1000, -1000, 32767], '샘플이 틀렸다');
  assert.deepEqual([...new Uint8Array(bins[1])], [0x57]);
});

// --- Claude 의 키 ----------------------------------------------------------
//
// 요구는 하나다: **키를 어디에도 남기지 않는다.** 여기서 보는 것은 화면으로
// 오가는 것 - 답, 상태, 이벤트, 그리고 늦게 연 화면이 받는 지난 일 - 어디에도
// 키가 실리지 않는가다. SDK 는 가짜라 네트워크도 돈도 안 쓴다.

const SECRET = 'sk-ant-api03-WEB-SECRET-9876543210';

function fakeClaudeSdk({ refuse = false } = {}) {
  class APIError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  class AuthenticationError extends APIError {}
  class Anthropic {
    constructor() {
      this.models = { retrieve: async (id) => {
        if (refuse) throw new AuthenticationError(401, `401 invalid x-api-key ${SECRET}`);
        return { id };
      } };
    }
  }
  Object.assign(Anthropic, { APIError, AuthenticationError,
                             PermissionDeniedError: class extends APIError {},
                             NotFoundError: class extends APIError {},
                             RateLimitError: class extends APIError {},
                             APIConnectionError: class extends APIError {},
                             APIConnectionTimeoutError: class extends APIError {} });
  return { default: Anthropic };
}

test('Claude 키: 받고, 놓고, 화면으로는 한 번도 되돌아가지 않는다', async (t) => {
  const r = await rig(t);
  r.ask.claude = new Claude({ limit: r.ask.limit, sdk: fakeClaudeSdk(), shape: async (x) => x });
  const b = await browser(r.url());
  const st = await b.until((m) => m.type === 'state');
  assert.deepEqual(st.ask.claude, { key: false, model: 'claude-opus-5' });

  b.send({ cmd: 'ask_key', who: 'claude', key: SECRET, id: 2001 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 2001, '키 답');
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.status, { key: true, model: 'claude-opus-5' });
  await b.until((m) => m.type === 'state' && m.ask.claude.key === true, '키가 들어간 상태');

  // 늦게 연 화면이 받는 지난 일에도 없어야 한다.
  const late = await browser(r.url());
  await late.until((m) => m.type === 'state');

  b.send({ cmd: 'ask_key_forget', who: 'claude', id: 2002 });
  await b.until((m) => m.type === 'state' && m.ask.claude.key === false, '놓은 상태');

  for (const m of [...b.msgs, ...late.msgs])
    assert.ok(!JSON.stringify(m).includes(SECRET), `화면으로 키가 갔다: ${JSON.stringify(m)}`);
  assert.ok(!JSON.stringify(r.hub.since(0)).includes(SECRET), '이벤트 기록에 키가 남았다');
  b.close(); late.close();
});

test('Claude 키: 거절당하면 왜인지 말하고, 상태는 그대로다', async (t) => {
  const r = await rig(t);
  r.ask.claude = new Claude({ limit: r.ask.limit, sdk: fakeClaudeSdk({ refuse: true }),
                              shape: async (x) => x });
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');

  b.send({ cmd: 'ask_key', who: 'claude', key: SECRET, id: 2003 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 2003, '거절');
  assert.equal(rep.ok, false);
  assert.match(rep.why, /refused \(401\)/);
  assert.ok(!JSON.stringify(rep).includes(SECRET));
  assert.equal(r.ask.claude.hasKey, false);
  // 서버 오류로 번지지 않았다 - 틀린 키는 답이지 사고가 아니다.
  assert.ok(!r.hub.since(0).some((e) => e.ev === 'command_failed'));
  b.close();
});

test('Claude 모드를 화면에서 고른다', async (t) => {
  const r = await rig(t);
  const b = await browser(r.url());
  await b.until((m) => m.type === 'state');
  b.send({ cmd: 'ask_mode', mode: 'claude', id: 2004 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 2004);
  assert.equal(rep.mode, 'claude');
  b.close();
});

test('루프백인지 가린다 - 키는 이 기계에서 온 것만 받는다', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
    assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.0.3', '10.0.0.1', '::ffff:10.0.0.1', 'fe80::1', '', undefined])
    assert.equal(isLoopback(a), false, String(a));
});

test('Gemini 키도 같은 길로 - 그리고 누구의 키인지 모르면 받지 않는다', async (t) => {
  const r = await rig(t);
  class ApiError extends Error {
    constructor(o) { super(o.message); this.status = o.status; }
  }
  const sdk = { ApiError, GoogleGenAI: class {
    constructor() { this.models = { get: async ({ model }) => ({ name: model }) }; }
  } };
  r.ask.gemini = new Gemini({ limit: r.ask.limit, sdk, shape: async (x) => x });
  const b = await browser(r.url());
  const st = await b.until((m) => m.type === 'state');
  assert.deepEqual(st.ask.gemini, { key: false, model: 'gemini-3.8-flash' });

  b.send({ cmd: 'ask_key', who: 'gemini', key: SECRET, id: 2010 });
  const rep = await b.until((m) => m.type === 'reply' && m.id === 2010, 'Gemini 키 답');
  assert.equal(rep.ok, true);
  await b.until((m) => m.type === 'state' && m.ask.gemini.key === true, 'Gemini 키가 들어간 상태');
  assert.equal(r.ask.claude.hasKey, false, 'Gemini 키가 Claude 로 가면 안 된다');

  // 이름이 없거나 틀리면 거절한다. 조용히 어느 한쪽으로 가면 안 된다.
  b.send({ cmd: 'ask_key', key: SECRET, id: 2011 });
  b.send({ cmd: 'ask_key', who: 'openai', key: SECRET, id: 2012 });
  for (const id of [2011, 2012]) {
    const no = await b.until((m) => m.type === 'reply' && m.id === id);
    assert.equal(no.ok, false);
    assert.match(no.why, /unknown answerer/);
  }
  for (const m of b.msgs)
    assert.ok(!JSON.stringify(m).includes(SECRET), `화면으로 키가 갔다: ${JSON.stringify(m)}`);
  b.close();
});
