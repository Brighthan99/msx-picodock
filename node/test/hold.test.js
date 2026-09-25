// hold.test.js — 이미지를 빌려 주고 돌려받는 규약.
//
// 여기서 지켜야 할 불변은 하나로 줄어든다:
//
//     `.held` 가 있다  ==>  우리는 파일 핸들을 쥐고 있지 않다
//
// 요청한 쪽은 `.held` 를 보고 이미지를 건드리기 시작한다. 그 순간 우리가
// 아직 쥐고 있으면 쓰는 쪽이 둘이 되고, 그것이 바로 이 규약이 막으려던
// 일이다. 그래서 시험마다 이 불변을 다시 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { Lending, holdActive, srvPath, holdPath, heldPath } from '../src/hold.js';
import { Disk } from '../src/disk.js';
import { Hub, CH_DISK } from '../src/hub.js';

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdhold-'));
  const img = path.join(dir, 'test.img');
  fs.writeFileSync(img, Buffer.alloc(512 * 64));
  const disk = new Disk(img);
  const hub = new Hub();
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_DISK) seen.push(ev); });
  // 마운트 검사는 서브프로세스라 시험에서는 끈다. 여기서 보는 것은 파일 규약이다.
  const lend = new Lending(hub, disk, img, { mountPollMs: 1e9 });
  lend._lastMountCheck = Date.now();
  t.after(() => { disk.close(); lend.cleanup();
                  fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, img, disk, hub, seen, lend };
}

/** 불변: .held 가 있으면 핸들은 놓여 있어야 한다. */
function invariant(r) {
  if (fs.existsSync(heldPath(r.img)))
    assert.equal(r.disk.fd, null,
                 '.held 를 써 놓고 핸들을 쥐고 있다 - 요청한 쪽이 지금 쓰기 시작한다');
}

/** 죽은 PID 하나. 낳아서 죽기를 기다린다 - 짐작한 번호는 남의 것일 수 있다. */
function deadPid() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', '']);
    c.on('exit', () => setTimeout(() => resolve(c.pid), 50));
  });
}

test('.hold 를 놓으면 멈추고 .held 로 답한다', (t) => {
  const r = rig(t);
  assert.equal(r.disk.paused, false);

  fs.writeFileSync(holdPath(r.img), String(process.pid));
  r.lend.tick();

  assert.equal(r.disk.paused, true);
  assert.ok(fs.existsSync(heldPath(r.img)), '놓았다고 답해야 한다');
  invariant(r);
  assert.equal(r.seen.at(-1).ev, 'paused');
  assert.equal(r.seen.at(-1).reason, 'disk_put');
});

test('.hold 를 치우면 돌려받는다', (t) => {
  const r = rig(t);
  fs.writeFileSync(holdPath(r.img), String(process.pid));
  r.lend.tick();
  assert.equal(r.disk.paused, true);

  fs.rmSync(holdPath(r.img));
  r.lend.tick();

  assert.equal(r.disk.paused, false);
  assert.ok(r.disk.fd !== null, '다시 열어야 한다');
  assert.equal(fs.existsSync(heldPath(r.img)), false, '.held 도 치워야 한다');
  assert.equal(r.seen.at(-1).ev, 'resumed');
});

test('요청한 쪽이 죽었으면 쓰레기로 친다', async (t) => {
  // SIGKILL 로 죽으면 .hold 가 남는다. 곧이곧대로 따르면 서버는 영영 멈춰
  // 있고, 사용자에게는 디스크가 죽은 것으로 보인다.
  const r = rig(t);
  const pid = await deadPid();
  fs.writeFileSync(holdPath(r.img), String(pid));

  assert.equal(holdActive(r.img), false, '죽은 PID 는 요청이 아니다');
  assert.equal(fs.existsSync(holdPath(r.img)), false, '쓰레기는 치워야 한다');

  r.lend.tick();
  assert.equal(r.disk.paused, false, '멈추면 안 된다');
});

test('막 만들어진 빈 .hold 는 존중한다', (t) => {
  // disk_put 이 파일을 만들고 PID 를 쓰기 전의 아주 짧은 창이다. 여기서
  // "내용이 없으니 요청이 아니다" 라고 하면 그 창에서 둘이 같이 쓴다.
  const r = rig(t);
  fs.writeFileSync(holdPath(r.img), '');
  assert.equal(holdActive(r.img), true);
  r.lend.tick();
  assert.equal(r.disk.paused, true);
  invariant(r);
});

test('뜻 모를 내용도 안전한 쪽으로 친다', (t) => {
  const r = rig(t);
  fs.writeFileSync(holdPath(r.img), 'who knows');
  assert.equal(holdActive(r.img), true);
  r.lend.tick();
  assert.equal(r.disk.paused, true);
});

test('화면에서 누른 일시정지와 .hold 는 따로 논다', (t) => {
  // 둘 다 멈추자고 하는데 하나만 풀렸다면, 아직 멈춰 있어야 한다.
  const r = rig(t);
  r.lend.setByUser(true);
  assert.equal(r.disk.paused, true);

  fs.writeFileSync(holdPath(r.img), String(process.pid));
  r.lend.tick();
  assert.equal(r.disk.paused, true);
  // **이미 멈춰 있었어도 .held 는 나가야 한다.** 멈추는 순간에만 쓰면 여기서
  // 전이가 없어 안 써지고, disk_put 은 30 초를 기다리다 포기한다.
  assert.ok(fs.existsSync(heldPath(r.img)),
            '이미 멈춰 있던 이미지에 .hold 가 와도 답해야 한다');
  invariant(r);

  r.lend.setByUser(false);                  // 화면에서는 풀었지만
  assert.equal(r.disk.paused, true, '.hold 가 아직 있다');

  fs.rmSync(holdPath(r.img));
  r.lend.tick();
  assert.equal(r.disk.paused, false, '이제야 돌려받는다');
});

test('.srv 로 서버가 여기 있다고 알리고, 나갈 때 치운다', (t) => {
  const r = rig(t);
  r.lend.announce();
  assert.equal(fs.readFileSync(srvPath(r.img), 'utf8'), String(process.pid));

  r.lend.cleanup();
  assert.equal(fs.existsSync(srvPath(r.img)), false,
               '남은 .srv 는 없는 서버가 있다고 말한다');
});

test('돌려받기 직전에 정리할 기회를 준다', (t) => {
  // macOS 는 마운트했다 빼면 ._ 사이드카를 남긴다. 그것을 치우는 것은 핸들을
  // 놓고 있는 동안에만 안전하다 - 이 자리가 그 자리다.
  const r = rig(t);
  let calledWhilePaused = null;
  r.lend.onResume = () => { calledWhilePaused = r.disk.paused && r.disk.fd === null; };

  fs.writeFileSync(holdPath(r.img), String(process.pid));
  r.lend.tick();
  fs.rmSync(holdPath(r.img));
  r.lend.tick();

  assert.equal(calledWhilePaused, true, '핸들이 놓인 동안에 불려야 한다');
  assert.equal(r.disk.paused, false);
});

test('멈춘 사이에 이미지가 커지면 새 크기를 안다', (t) => {
  // disk_put 이 하는 일이 바로 이것이다 - 빌려 가서 파일을 넣고 돌려준다.
  // 옛 블록 수를 들고 있으면 MSX 는 늘어난 부분을 영영 못 본다.
  const r = rig(t);
  assert.equal(r.disk.blocks, 64);

  fs.writeFileSync(holdPath(r.img), String(process.pid));
  r.lend.tick();
  fs.appendFileSync(r.img, Buffer.alloc(512 * 64));    // 두 배로
  fs.rmSync(holdPath(r.img));
  r.lend.tick();

  assert.equal(r.disk.blocks, 128, '다시 열면서 크기를 다시 세야 한다');
});
