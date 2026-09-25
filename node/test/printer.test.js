// printer.test.js — 찍은 바이트를 잃지 않는가.
//
// 이 파일이 보는 것은 하나로 모인다: **바이트를 잃는 길이 있는가.** 렌더링은
// 나중에 몇 번이고 다시 할 수 있지만 잃은 바이트는 못 되돌린다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Printer, Spool, SpoolWriter } from '../src/printer.js';
import { Hub, CH_PRINT } from '../src/hub.js';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdprn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mk(t, opts = {}) {
  const dir = scratch(t);
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_PRINT) seen.push(ev); });
  return { dir, hub, seen, p: new Printer(hub, { outDir: dir, ...opts }) };
}

test('조용해지면 작업이 끝난다 - MSX 에는 "다 찍었다" 가 없다', async (t) => {
  const { p, seen } = mk(t, { mode: 'raw', timeout: 0.02 });
  p.feed(Buffer.from('HELLO'));
  p.flushIfIdle();
  assert.equal(p.bufLen, 5, '아직 조용해지지 않았다');

  await new Promise((r) => setTimeout(r, 40));
  p.flushIfIdle();
  assert.equal(p.bufLen, 0);
  const saved = seen.find((e) => e.ev === 'saved');
  assert.equal(saved.size, 5);
  assert.equal(fs.readFileSync(saved.path, 'latin1'), 'HELLO');
});

test('off 이고 스풀도 없으면 버린다', (t) => {
  const { p } = mk(t, { mode: 'off' });
  assert.equal(p.enabled, false);
  p.feed(Buffer.from('gone'));
  assert.equal(p.bufLen, 0);
});

test('off 여도 스풀이 있으면 온전히 잡는다', (t) => {
  // 이게 요점이다. 형식을 나중에 정하는 것이 스풀의 전부이므로, 모드가
  // 꺼져 있다는 것이 바이트를 버릴 이유가 되면 안 된다.
  const { p, dir } = mk(t, { mode: 'off', spool: true });
  assert.equal(p.enabled, true);
  p.feed(Buffer.from('kept anyway'));
  p.flush();
  p.close();

  const s = new Spool(path.join(dir, 'spool',
                                fs.readdirSync(path.join(dir, 'spool'))
                                  .find((f) => f.endsWith('.prn'))));
  const jobs = s.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(s.read(1).toString(), 'kept anyway');
});

test('작업 경계는 파일 분할이 아니라 색인 한 줄이다', (t) => {
  const { p, dir, seen } = mk(t, { mode: 'off', spool: true });
  p.feed(Buffer.from('one'));   p.flush();
  p.feed(Buffer.from('two!!')); p.flush();
  p.feed(Buffer.from('three')); p.flush();
  p.close();

  const stem = path.join(dir, 'spool',
                         fs.readdirSync(path.join(dir, 'spool'))
                           .find((f) => f.endsWith('.prn')));
  // .prn 은 하나다. 세 조각이 아니라.
  assert.equal(fs.readdirSync(path.join(dir, 'spool'))
                 .filter((f) => f.endsWith('.prn')).length, 1);
  assert.equal(fs.readFileSync(stem, 'latin1'), 'onetwo!!three');

  const s = new Spool(stem);
  const jobs = s.jobs();
  assert.deepEqual(jobs.map((j) => j.len), [3, 5, 5]);
  assert.deepEqual(jobs.map((j) => j.off), [0, 3, 8]);
  assert.equal(s.read(2).toString(), 'two!!');
  const marks = seen.filter((e) => e.ev === 'spool_job');
  assert.equal(marks.length, 3);
  assert.deepEqual(marks.map((e) => e.job), [1, 2, 3], '작업 번호가 보여야 한다');
});

test('죽어도 닫힌 작업은 안 잃고, 날아가던 것은 꼬리로 되살아난다', (t) => {
  const dir = scratch(t);
  const w = new SpoolWriter('crash', dir, '20260920_000000');
  w.write(Buffer.from('closed job'));
  w.mark('idle');
  w.write(Buffer.from('in flight when the lights went out'));
  // close() 를 안 부른다 = 전원이 나갔다. 색인에 이 작업은 없다.

  const s = new Spool(path.join(dir, 'crash_20260920_000000'));
  const jobs = s.jobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].end, 'idle');
  assert.equal(jobs[1].end, 'unclosed', '색인 없는 꼬리도 작업으로 봐야 한다');
  assert.equal(s.read(2).toString(), 'in flight when the lights went out');
});

test('색인 마지막 줄이 반쯤 써졌어도 그 앞은 멀쩡하다', (t) => {
  const dir = scratch(t);
  const w = new SpoolWriter('half', dir, '20260920_000001');
  w.write(Buffer.from('first')); w.mark();
  w.write(Buffer.from('second')); w.mark();
  w.close();

  // fsync 도중에 죽은 흉내: 색인 마지막 줄을 잘라 놓는다.
  const idx = path.join(dir, 'half_20260920_000001.idx');
  const lines = fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(idx, lines[0] + '\n' + lines[1].slice(0, 12));

  const s = new Spool(path.join(dir, 'half_20260920_000001'));
  const jobs = s.jobs();
  assert.equal(jobs[0].len, 5, '앞 작업은 그대로 읽혀야 한다');
  assert.equal(s.read(1).toString(), 'first');
  // 두 번째 작업의 바이트는 색인을 잃었지만 .prn 에는 남아 있다.
  const tail = jobs.find((j) => j.end === 'unclosed');
  assert.ok(tail, '잘린 줄이 가리키던 바이트가 되살아나야 한다');
  assert.equal(s.read(tail).toString(), 'second');
});

test('끝낼 때 열려 있던 작업을 색인에 남긴다', (t) => {
  const { p, dir } = mk(t, { mode: 'off', spool: true });
  p.feed(Buffer.from('never went idle'));
  p.close();                              // flush 없이 바로 종료

  const stem = path.join(dir, 'spool',
                         fs.readdirSync(path.join(dir, 'spool'))
                           .find((f) => f.endsWith('.prn')));
  const jobs = new Spool(stem).jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].end, 'shutdown', '꼬리가 아니라 닫힌 작업이어야 한다');
});

test('스풀은 두 번 켜도 하나다', (t) => {
  // 덮어쓰면 열려 있던 .prn/.idx 핸들을 놓고 색인이 1 번부터 다시 시작한다.
  // 지금은 web.js 가 `if (!printer.spool)` 로 걸러 주지만, 그 검사는 부르는
  // 쪽에 있다 - 부르는 쪽이 둘이 되는 날 여기가 마지막 방벽이다.
  const { p } = mk(t, { spool: true });
  const first = p.spool;
  p.feed(Buffer.from('ONE'));
  p.flush();
  assert.equal(p.startSpool(), first, '같은 스풀을 돌려줘야 한다');
  p.feed(Buffer.from('TWO'));
  p.flush();
  assert.equal(p.spool.seq, 2, '작업 번호가 이어져야 한다');
  assert.equal(fs.readFileSync(first.prnPath).toString(), 'ONETWO');
  p.close();
});
