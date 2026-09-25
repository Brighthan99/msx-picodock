// printers.test.js — 어디로 내보낼지, 그리고 찍는 대로 내보내는 일.
//
// **여기서 종이는 한 장도 안 나간다.** 진짜 프린터를 붙여 놓고 돌릴 수 있는
// 테스트는 없다 - 돌릴 때마다 롤이 줄기 때문이다. 그래서 `Direct` 는 실행하는
// 부분을 밖에서 갈아끼울 수 있게 만들어 두었고, 여기서는 그 자리에 가짜를
// 끼운다. 보는 것은 **어느 작업이 어느 프린터로, 어떤 순서로, 몇 번 갔는가**
// 하나다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Printers, Direct, BUILTIN, label, why, lastComplaint, QUEUE_MAX,
         escposArgs, escpArgs, cupsArgs, jobList, usesEscpos }
  from '../src/printers.js';
import { Printer } from '../src/printer.js';
import { Hub, CH_PRINT } from '../src/hub.js';

function rig(opts = {}) {
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_PRINT) seen.push(ev); });
  const printers = opts.printers || new Printers();
  delete opts.printers;
  const ran = [];
  const d = new Direct(hub, printers, {
    run: (job, def) => { ran.push(`${def.id}:${job.seq}`); return Promise.resolve('ok'); },
    ...opts,
  });
  return { hub, seen, printers, direct: d, ran };
}

const evs = (seen, ev) => seen.filter((e) => e.ev === ev);
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// --- 목록 -------------------------------------------------------------------

test('영수증 프린터는 너비가 곧 정체성이라 이름에 붙는다', () => {
  const p = new Printers();
  const r = p.get('escpos58');
  assert.equal(label(r), 'ESC/POS receipt printer (width: 58mm, 384 dots)');
  // 58mm 와 80mm 가 이름만으로 구별되지 않으면 고를 수가 없다.
  assert.notEqual(label(p.get('escpos58')), label(p.get('escpos80')));
});

test('기본 목록에 영수증 프린터와 호스트 큐가 있다', () => {
  const ids = new Printers().list().map((d) => d.id);
  assert.ok(ids.includes('escpos58'), ids);
  assert.ok(ids.includes('cups'), ids);
});

test('틀린 정의는 거절하고 **무엇이** 틀렸는지 말한다', () => {
  // 사람이 손으로 적는 JSON 이라, false 하나로는 고쳐 쓸 수가 없다.
  assert.match(why({ id: 'x y', kind: 'cups', name: 'n' }), /id must be/);
  assert.match(why({ id: 'x', kind: 'laser', name: 'n' }), /kind must be/);
  assert.match(why({ id: 'x', kind: 'cups' }), /name is missing/);
  assert.match(why({ id: 'x', kind: 'escpos', name: 'n' }), /dots/);
  assert.match(why({ id: 'x', kind: 'escpos', name: 'n', dots: 8 }), /dots/);
  assert.equal(why({ id: 'x', kind: 'escpos', name: 'n', dots: 384 }), null);
});

test('프린터는 코드를 안 고치고도 는다 - JSON 한 덩어리로', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'mine.json');
  fs.writeFileSync(f, JSON.stringify([
    { id: 'till', kind: 'escpos', name: 'The shop till', width: 80, dots: 576 },
    { id: 'nope', kind: 'fax', name: 'not a thing' },
  ]));
  const p = new Printers();
  const { added, bad } = p.load(f);
  assert.equal(added.length, 1);
  // **한 줄이 틀렸다고 나머지를 버리지 않는다.** 그러면 파일을 고치는 사람은
  // 한 번에 하나씩만 고칠 수 있다.
  assert.equal(bad.length, 1);
  assert.match(bad[0], /nope/);
  assert.ok(p.get('till'));
});

test('같은 id 는 덮어쓴다 - 기본 정의를 고치는 길이기도 하다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'mine.json');
  // USB 주소를 자동으로 못 찾는 기종에 직접 대는 경우.
  fs.writeFileSync(f, JSON.stringify(
    { id: 'escpos58', kind: 'escpos', name: 'My till', dots: 384,
      uri: 'usb://MAKER/MODEL' }));
  const p = new Printers();
  p.load(f);
  assert.equal(p.get('escpos58').uri, 'usb://MAKER/MODEL');
  assert.equal(p.list().filter((d) => d.id === 'escpos58').length, 1);
});

test('BUILTIN 을 건드려도 다음 Printers 는 깨끗하다', () => {
  const p = new Printers();
  p.get('cups').queue = 'scribbled';
  assert.equal(new Printers().get('cups').queue, undefined);
  assert.ok(BUILTIN.every((d) => d.queue === undefined));
});

// --- 직접 출력 --------------------------------------------------------------

test('꺼져 있으면 아무것도 안 나간다', async () => {
  const { direct, ran } = rig();
  assert.equal(direct.on, false);
  assert.equal(direct.ready, false);
  assert.equal(direct.send('/tmp/spool', 1), false);
  await settle();
  assert.deepEqual(ran, []);
});

test('켜면 그 뒤에 닫힌 작업이 나간다', async () => {
  const { direct, ran, seen } = rig();
  assert.equal(direct.setTarget('escpos58').ok, true);
  direct.setAuto(true);
  direct.send('/tmp/spool', 7);
  await settle();
  assert.deepEqual(ran, ['escpos58:7']);
  assert.equal(evs(seen, 'direct_done').length, 1);
  assert.equal(evs(seen, 'direct_done')[0].job, 7);
});

test('모르는 프린터는 켜지지 않는다', () => {
  const { direct } = rig();
  const r = direct.setTarget('nosuch');
  assert.equal(r.ok, false);
  assert.match(r.why, /no printer/);
  assert.equal(direct.on, false);
});

test('끄면 **줄에 있던 것도** 버린다', async () => {
  // 껐는데 뒤늦게 석 장이 나오는 것은 끈 것이 아니다.
  let release;
  const held = new Promise((r) => { release = r; });
  const { direct, ran, seen } = rig({
    run: (job, def) => held.then(() => { ran.push(`${def.id}:${job.seq}`); }),
  });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  direct.send('/tmp/s', 1);          // 이것은 이미 돌고 있다
  direct.send('/tmp/s', 2);
  direct.send('/tmp/s', 3);
  await settle();
  assert.equal(direct.status().queued, 2);
  direct.setAuto(false);
  assert.equal(direct.status().queued, 0, '자동으로 선 것은 버린다');
  release();
  await settle();
  await settle();
  assert.deepEqual(ran, ['escpos58:1'], '돌던 것만 끝나고 나머지는 안 나간다');
  assert.equal(evs(seen, 'direct_off')[0].dropped, 2);
});

test('한 번에 하나씩 - 영수증 프린터는 한 줄기만 받는다', async () => {
  let live = 0, most = 0;
  const { direct } = rig({
    run: () => {
      live += 1; most = Math.max(most, live);
      return new Promise((r) => setImmediate(() => { live -= 1; r(); }));
    },
  });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  for (let i = 1; i <= 5; i += 1) direct.send('/tmp/s', i);
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(most, 1, `동시에 ${most} 개가 돌았다`);
  assert.equal(direct.status().done, 5);
});

test('순서대로 나간다', async () => {
  const ran = [];
  const { direct } = rig({
    run: (job) => new Promise((r) => setImmediate(() => { ran.push(job.seq); r(); })),
  });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  for (const s of [3, 1, 2]) direct.send('/tmp/s', s);
  for (let i = 0; i < 20; i += 1) await settle();
  assert.deepEqual(ran, [3, 1, 2]);
});

test('한 장이 실패해도 줄은 계속 돈다', async () => {
  // 종이가 걸렸다 빠진 뒤에 아무것도 안 나오면 그게 더 나쁘다.
  const ran = [];
  const { direct, seen } = rig({
    run: (job) => (job.seq === 2 ? Promise.reject(new Error('out of paper'))
                                 : Promise.resolve(ran.push(job.seq))),
  });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  for (const s of [1, 2, 3]) direct.send('/tmp/s', s);
  for (let i = 0; i < 20; i += 1) await settle();
  assert.deepEqual(ran, [1, 3]);
  assert.equal(direct.status().failed, 1);
  assert.equal(direct.status().done, 2);
  assert.match(evs(seen, 'direct_failed')[0].why, /out of paper/);
});

test('그 자리에서 던지는 것도 실패다 - 줄이 얼어붙으면 안 된다', async () => {
  // 약속을 돌려주지 않고 던지는 `_run`. 감싸 두지 않으면 예외가 `.catch` 를
  // 지나쳐 `send()` 밖으로 새고, `busy` 가 참인 채 남아 그 뒤로 **한 장도**
  // 안 나간다 - 그러고도 화면에는 아무 말이 없다.
  const ran = [];
  const { direct, seen } = rig({
    run: (job) => {
      if (job.seq === 1) throw new TypeError('require is not defined');
      ran.push(job.seq);
      return Promise.resolve();
    },
  });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  assert.doesNotThrow(() => direct.send('/tmp/s', 1));
  direct.send('/tmp/s', 2);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(direct.status().busy, false, '줄이 얼어붙었다');
  assert.equal(direct.status().failed, 1);
  assert.match(evs(seen, 'direct_failed')[0].why, /require is not defined/);
  assert.deepEqual(ran, [2], '뒤엣것은 그래도 나가야 한다');
});

test('실패한 까닭은 화면에서 읽을 수 있어야 한다', async () => {
  const { direct } = rig({ run: () => Promise.reject(new Error('no such printer')) });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  direct.send('/tmp/s', 1);
  await settle();
  assert.equal(direct.status().error, 'no such printer');
  // 다음 것이 성공하면 지워진다 - 고쳐졌는데 빨갛게 남아 있으면 안 된다.
  direct._run = () => Promise.resolve();
  direct.send('/tmp/s', 2);
  await settle();
  assert.equal(direct.status().error, null);
});

test('프린터가 안 받으면 줄이 넘치는 대신 오래된 것을 버린다', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { direct, seen } = rig({ run: () => held });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  const sent = QUEUE_MAX + 5;
  for (let i = 1; i <= sent; i += 1) direct.send('/tmp/s', i);
  await settle();
  // 하나는 이미 나가고 있고, QUEUE_MAX 가 줄에 서고, 나머지가 버려진다.
  assert.equal(direct.status().queued, QUEUE_MAX);
  assert.equal(direct.status().dropped, sent - QUEUE_MAX - 1);
  // **버렸다고 말한다.** 조용히 버리면 왜 몇 장이 안 나왔는지 알 길이 없다.
  assert.ok(evs(seen, 'direct_dropped').length > 0);
  release();
});

test('버려지는 쪽은 **오래된 것**이다', async () => {
  // 프린터가 죽어 있는 동안 쌓인 것은 다 묵은 것이고, 사람이 기다리는 것은
  // 방금 찍은 쪽이다. 어느 쪽이든 바이트는 스풀에 그대로 있다.
  let release;
  const held = new Promise((r) => { release = r; });
  const ran = [];
  const direct = (() => {
    const { direct: d } = rig({
      run: (job) => held.then(() => { ran.push(job.seq); }),
    });
    return d;
  })();
  direct.setTarget('escpos58');
  direct.setAuto(true);
  const sent = QUEUE_MAX + 3;
  for (let i = 1; i <= sent; i += 1) direct.send('/tmp/s', i);
  release();
  for (let i = 0; i < sent + 10; i += 1) await settle();
  // 1 번은 이미 나가고 있었고, 줄의 앞에서 dropped 개가 밀려났다.
  const dropped = sent - QUEUE_MAX - 1;
  assert.ok(dropped > 0, '이 시험이 뜻을 가지려면 실제로 버려져야 한다');
  assert.equal(direct.status().dropped, dropped);
  assert.equal(ran[0], 1, '돌고 있던 것은 끝난다');
  assert.equal(ran[1], 2 + dropped,
               `2..${1 + dropped} 이 밀려났어야 한다 - ${ran.slice(0, 4)}`);
  assert.equal(ran[ran.length - 1], sent, '가장 새것은 살아남는다');
  assert.equal(ran.length, sent - dropped);
});

test('고른 프린터가 목록에서 사라지면 그렇다고 말한다', () => {
  const { direct, printers } = rig();
  direct.setTarget('escpos58');
  direct.setAuto(true);
  printers.byId.delete('escpos58');
  const s = direct.status();
  assert.equal(s.auto, true);
  assert.equal(s.ready, false, '보낼 곳이 없는데 준비됐다고 하면 안 된다');
  assert.equal(s.unknown, true, '조용히 꺼진 것처럼 보이면 안 된다');
});

// --- 스풀과의 결선 ----------------------------------------------------------

test('작업이 닫히면 바로 넘어간다 - 그리고 **색인이 써진 뒤**에', async (t) => {
  // 순서가 뒤집히면 렌더러가 "그런 작업 없다" 를 본다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdprn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = new Hub();
  const saw = [];
  const p = new Printer(hub, {
    outDir: dir, spool: true, timeout: 0.01,
    onJob: (stem, seq) => {
      // 색인 파일에 이 작업이 이미 있어야 한다.
      const idx = fs.readFileSync(`${stem}.idx`, 'utf8');
      saw.push({ seq, inIndex: idx.includes(`"seq":${seq}`) });
    },
  });
  p.feed(Buffer.from('HELLO'));
  p.flush();
  assert.deepEqual(saw, [{ seq: 1, inIndex: true }]);
  p.close();
});

test('받는 쪽이 터져도 스풀은 멀쩡하다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdprn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_PRINT) seen.push(ev); });
  const p = new Printer(hub, {
    outDir: dir, spool: true, timeout: 0.01,
    onJob: () => { throw new Error('the printer exploded'); },
  });
  p.feed(Buffer.from('HELLO'));
  assert.doesNotThrow(() => p.flush());
  assert.equal(evs(seen, 'job_end').length, 1, 'job_end 는 그래도 나가야 한다');
  p.close();
});

// --- 도구가 한 말 -----------------------------------------------------------

test('탓에 해당하는 줄만 올린다', () => {
  // 전체를 그대로 올리면 [+] 진행 줄에 묻혀 정작 까닭이 안 보인다.
  assert.equal(lastComplaint('[+] 1 page(s)\n[-] no USB printer that says CMD:ESCPOS'),
               'no USB printer that says CMD:ESCPOS');
  assert.equal(lastComplaint('[-] first\n[-] second'), 'second');
  assert.equal(lastComplaint('just a line'), 'just a line');
  assert.equal(lastComplaint(''), '');
  assert.equal(lastComplaint(null), '');
});

// --- 눕힐 것인가 -------------------------------------------------------------
//
// 눕히면 해상도를 얻고 **종이를 쓴다.** 816x94 짜리 MSXLOGO 배너가 세우면
// 0.6cm, 눕히면 10.3cm 다. 고를 수 있어야 하고, 기본은 아껴야 한다.

test('기본은 auto 이고, 정의가 그것을 고정할 수 있다', () => {
  const p = new Printers();
  p.add({ id: 'up', kind: 'escpos', name: 'Always upright', dots: 384,
          rotate: 'off' });
  const { direct } = rig({ printers: p });
  direct.setTarget('escpos58');
  direct.setAuto(true);
  assert.equal(direct.status().rotate, 'auto');
  direct.setTarget('up');
  direct.setAuto(true);
  assert.equal(direct.status().rotate, 'off', '정의가 고정한다');
});

test('틀린 방향은 거절한다 - 조용히 auto 로 떨어지지 않는다', () => {
  const p = new Printers();
  assert.match(why({ id: 'x', kind: 'escpos', name: 'n', dots: 384,
                     rotate: 'sideways' }), /rotate must be/);
  assert.equal(why({ id: 'x', kind: 'escpos', name: 'n', dots: 384,
                     rotate: 'on' }), null);
  const { direct } = rig({ printers: p });
  const r = direct.setRotate('flip');
  assert.equal(r.ok, false);
  assert.match(r.why, /unknown rotation/);
});

test('화면에서 고른 방향이 정의를 이긴다', () => {
  const p = new Printers();
  p.add({ id: 'up', kind: 'escpos', name: 'Always upright', dots: 384,
          rotate: 'off' });
  const { direct } = rig({ printers: p });
  direct.setTarget('up');
  direct.setAuto(true);
  direct.setRotate('on');
  assert.equal(direct.status().rotate, 'on');
});

test('방향은 **명령줄에** 실린다', () => {
  // 화면에서 고르고 종이가 그대로 나오면, 고른 적이 없는 것과 같다.
  //
  // **가짜 실행기로는 이것을 못 본다.** 가짜가 제 논리로 `d.rotate` 를 읽어
  // 답해 버리므로, 진짜 명령줄이 `--rotate` 를 아예 안 달아도 시험은
  // 통과한다 - 실제로 그 변이가 빠져나갔다. 그래서 만들어진 인자를 본다.
  const p = new Printers();
  p.add({ id: 'pinned', kind: 'escpos', name: 'Pinned upright', dots: 384,
          rotate: 'off' });
  const { direct } = rig({ printers: p });
  const job = { stem: '/tmp/s', seq: 4 };
  const at = (args) => args[args.indexOf('--rotate') + 1];

  direct.setTarget('escpos58');

  direct.setAuto(true);
  assert.equal(at(escposArgs(job, p.get('escpos58'), direct, '/tmp/k')), 'auto');

  // 정의가 고정한 것.
  assert.equal(at(escposArgs(job, p.get('pinned'), direct, '/tmp/k')), 'off');

  // 화면에서 고른 것이 정의를 이긴다.
  direct.setRotate('on');
  assert.equal(at(escposArgs(job, p.get('pinned'), direct, '/tmp/k')), 'on');

  // 나머지도 제자리에 있어야 한다 - 작업 번호와 헤드 너비.
  const args = escposArgs(job, p.get('escpos58'), direct, '/tmp/keep');
  assert.equal(args[args.indexOf('-j') + 1], '4');
  assert.equal(args[args.indexOf('--dots') + 1], '384');
  assert.equal(args[args.indexOf('--keep') + 1], '/tmp/keep');
  assert.equal(args[args.indexOf('--spool') + 1], '/tmp/s');
  assert.equal(args[args.indexOf('--usb') + 1], 'auto');
  // uri 를 댄 정의는 찾지 않고 그것을 쓴다.
  p.add({ id: 'fixed', kind: 'escpos', name: 'Fixed', dots: 384,
          uri: 'usb://M/X' });
  const f = escposArgs(job, p.get('fixed'), direct, '/tmp/k');
  assert.equal(f[f.indexOf('--usb') + 1], 'usb://M/X');
});

test('호스트 큐는 영수증 바이트를 거치지 않는다', () => {
  // 뒤집히면 cups 작업이 `--dots undefined` 를 달고 영수증 쪽으로 가서,
  // 아무도 못 읽는 말로 실패한다.
  const p = new Printers();
  assert.equal(usesEscpos(p.get('cups')), false);
  assert.equal(usesEscpos(p.get('escpos58')), true);
  assert.equal(usesEscpos(p.get('escpos80')), true);
  assert.equal(usesEscpos(null), false);
});

test('호스트 큐에는 방향이 뜻이 없다', () => {
  const { direct } = rig();
  direct.setTarget('cups');
  direct.setAuto(true);
  assert.equal(direct.status().canRotate, false, '화면에서 회색이어야 한다');
  direct.setTarget('escpos58');
  direct.setAuto(true);
  assert.equal(direct.status().canRotate, true);
});

test('진짜 실행 경로가 무엇을 부르는지', async () => {
  // **가짜 `run` 으로는 여기가 안 보인다.** 가짜가 제 논리로 답해 버리므로
  // 갈림길이 뒤집혀도 통과한다. `exec` 만 끼우면 defaultRun 이 정말로 돌고,
  // 실행된 명령이 그대로 남는다.
  const calls = [];
  const printers = new Printers();
  const hub = new Hub();
  const direct = new Direct(hub, printers, {
    outDir: '/tmp/o',
    exec: (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      // cups 경로는 그려 놓은 페이지 경로를 stdout 에서 읽는다.
      cb(null, '[+] kept /tmp/o/direct/p1.png\n', '');
    },
  });

  direct.setTarget('escpos58');

  direct.setAuto(true);
  direct.setRotate('off');
  direct.send('/tmp/s', 2);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(calls.length, 1, '영수증은 도구 한 번이면 끝난다');
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /msx_printer_escpos\.js$/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--rotate') + 1], 'off');
  assert.ok(calls[0].args.includes('--usb'), '영수증은 --usb 로 나간다');
  assert.equal(direct.status().failed, 0, direct.status().error);

  // 호스트 큐는 **다른 길**이다 - 영수증 바이트를 만들지 않고 lp 로 민다.
  calls.length = 0;
  direct.setTarget('cups');
  direct.setAuto(true);
  direct.send('/tmp/s', 3);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(calls.length, 2, '그리고 나서 lp');
  assert.ok(!calls[0].args.includes('--usb'), '큐에 영수증 바이트를 보내지 않는다');
  assert.ok(!calls[0].args.includes('--dots'));
  assert.ok(calls[0].args.includes('-o'), '바이트는 버린다 - 페이지만 쓴다');
  assert.equal(calls[1].cmd, 'lp');
  assert.deepEqual(calls[1].args, ['/tmp/o/direct/p1.png']);
  assert.equal(direct.status().failed, 0, direct.status().error);

  // 큐 이름을 댄 정의는 -d 로 간다.
  calls.length = 0;
  printers.add({ id: 'study', kind: 'cups', name: 'Upstairs', queue: 'HP_X' });
  direct.setTarget('study');
  direct.setAuto(true);
  direct.send('/tmp/s', 4);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.deepEqual(calls[1].args, ['-d', 'HP_X', '/tmp/o/direct/p1.png']);
});

// --- 진짜 ESC/P 프린터: 바이트를 그대로 -------------------------------------
//
// 맥에 드라이버가 없어도 된다. 해석은 프린터가 하고 우리는 나르기만 한다 -
// 그리는 단계가 아예 없으니 렌더러도 래스터도 리샘플링도 거치지 않는다.

test('escp 는 그리지 않고 스풀의 바이트를 보낸다', () => {
  const p = new Printers();
  const { direct } = rig({ printers: p });
  const a = escpArgs({ stem: '/tmp/s', seq: 3 }, p.get('escp'), direct);
  assert.ok(a[0].endsWith('msx_printer_escpos.js'), a[0]);
  assert.ok(a.includes('--raw'), a);
  assert.equal(a[a.indexOf('-j') + 1], '3');
  assert.equal(a[a.indexOf('--spool') + 1], '/tmp/s');
  // 그릴 것이 없으니 그리기 쪽 인자는 하나도 없어야 한다.
  for (const flag of ['--dots', '--rotate', '--keep', '--halftone', '--glyphs'])
    assert.ok(!a.includes(flag), `escp 에 ${flag} 가 붙었다: ${a}`);
  assert.equal(a[a.indexOf('--usb') + 1], 'auto');
});

test('escp: uri 를 댄 정의는 그것을 쓴다', () => {
  const p = new Printers();
  p.add({ id: 'fx80', kind: 'escp', name: 'Epson FX-80', uri: '04b8:0005' });
  const { direct } = rig({ printers: p });
  const a = escpArgs({ stem: '/tmp/s', seq: 1 }, p.get('fx80'), direct);
  assert.equal(a[a.indexOf('--usb') + 1], '04b8:0005');
  assert.match(label(p.get('fx80')), /Epson FX-80 - 04b8:0005/);
});

test('escp: 사설 블록은 기본으로 빼고, 달라면 남긴다', () => {
  // ESC ( P 는 msx-picoprinter 의 것이다. ESC/P2 프린터는 길이 필드로 건너뛰지만
  // FX-80 같은 평범한 ESC/P 는 그것을 **글자로 찍는다** - 페이지 위쪽에.
  const p = new Printers();
  p.add({ id: 'p2', kind: 'escp', name: 'ESC/P2', private: true });
  const { direct } = rig({ printers: p });
  const job = { stem: '/tmp/s', seq: 1 };
  assert.ok(!escpArgs(job, p.get('escp'), direct).includes('--keep-private'));
  assert.ok(escpArgs(job, p.get('p2'), direct).includes('--keep-private'));
});

test('escp 는 영수증 쪽도 cups 쪽도 아니다', () => {
  const p = new Printers();
  assert.equal(usesEscpos(p.get('escp')), false);
  assert.equal(p.get('escp').kind, 'escp');
  const { direct } = rig({ printers: p });
  direct.setTarget('escp');
  direct.setAuto(true);
  // 방향은 래스터를 만들 때나 뜻이 있다.
  assert.equal(direct.status().canRotate, false);
});

test('escp 정의도 검사를 받는다', () => {
  assert.equal(why({ id: 'x', kind: 'escp', name: 'n' }), null,
               'escp 는 dots 가 필요 없다');
  assert.match(why({ id: 'x', kind: 'escp' }), /name is missing/);
  assert.match(why({ id: 'x', kind: 'dotmatrix', name: 'n' }), /kind must be/);
});

test('진짜 실행 경로: escp 는 도구를 한 번만 부르고 lp 를 안 부른다', async () => {
  const calls = [];
  const printers = new Printers();
  const hub = new Hub();
  const direct = new Direct(hub, printers, {
    outDir: '/tmp/o',
    exec: (cmd, args, opts, cb) => { calls.push({ cmd, args }); cb(null, '', ''); },
  });
  direct.setTarget('escp');
  direct.setAuto(true);
  direct.send('/tmp/s', 5);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(calls.length, 1, `lp 까지 불렀다: ${calls.map((c) => c.cmd)}`);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(calls[0].args.includes('--raw'), calls[0].args);
  assert.equal(direct.status().failed, 0, direct.status().error);
});

// --- 여럿을 합쳐 한 장으로 ---------------------------------------------------
//
// 셋을 골랐으면 종이 석 장이 아니라 이어진 하나다. 도구가 **그림을 쌓아**
// 합친다 - 바이트를 이어 붙이지 않는다. ESC/P 는 줄 간격·피치가 작업 경계를
// 넘어 살아남아서, 이어 붙이면 둘째가 첫째의 설정으로 그려진다.

test('한 번의 인쇄가 작업 여럿을 나른다', () => {
  assert.equal(jobList({ seq: 3 }), '3');
  assert.equal(jobList({ seq: 3, seqs: [3] }), '3');
  assert.equal(jobList({ seq: 3, seqs: [3, 5, 7] }), '3,5,7');
});

test('세 갈래 모두 작업 목록을 그대로 넘긴다', () => {
  const p = new Printers();
  const { direct } = rig({ printers: p });
  const job = { stem: '/tmp/s', seqs: [1, 2, 4] };
  const at = (a) => a[a.indexOf('-j') + 1];
  assert.equal(at(escposArgs(job, p.get('escpos58'), direct, '/tmp/k')), '1,2,4');
  assert.equal(at(escpArgs(job, p.get('escp'), direct)), '1,2,4');
  assert.equal(at(cupsArgs(job, '/tmp/k')), '1,2,4');
});

test('sendNow 로 여럿을 보내면 줄에 하나만 선다', async () => {
  // 줄에 여럿을 세우면 사이마다 용지가 밀려 나가고, 합친 뜻이 없어진다.
  const seen = [];
  const printers = new Printers();
  const hub = new Hub();
  const direct = new Direct(hub, printers, {
    run: (job) => { seen.push(job.seqs.join('+')); return Promise.resolve(); },
  });
  direct.setTarget('escpos58');
  const r = direct.sendNow('/tmp/s', [5, 1, 3]);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.status.queued + (r.status.busy ? 1 : 0), 1, '줄에 하나');
  for (let i = 0; i < 10; i += 1) await settle();
  assert.deepEqual(seen, ['5+1+3'], '한 번에 합쳐 나간다');
});

test('sendNow 는 빈 목록과 숫자 아닌 것을 거절한다', () => {
  const { direct } = rig();
  direct.setTarget('escpos58');
  assert.equal(direct.sendNow('/tmp/s', []).ok, false);
  assert.equal(direct.sendNow('/tmp/s', ['a', null]).ok, false);
  assert.equal(direct.sendNow('', [1]).ok, false);
  assert.equal(direct.sendNow('/tmp/s', 4).ok, true, '숫자 하나도 받는다');
});

test('한 장짜리 이벤트는 숫자, 여럿은 목록', async () => {
  const { direct, seen } = rig();
  direct.setTarget('escpos58');
  direct.sendNow('/tmp/s', [7]);
  for (let i = 0; i < 6; i += 1) await settle();
  assert.equal(evs(seen, 'direct_done')[0].job, 7, '한 장은 숫자 그대로');
  direct.sendNow('/tmp/s', [1, 2]);
  for (let i = 0; i < 6; i += 1) await settle();
  assert.equal(evs(seen, 'direct_done')[1].job, '1,2');
});
