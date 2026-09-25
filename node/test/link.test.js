// link.test.js — 카트리지가 왔다 갔다 하는 것을 하드웨어 없이 검증한다.
//
// serialport 의 MockBinding 은 가짜 포트를 만들고 지우고, 남이 쥐고 있는
// 상태까지 흉내 낸다. 그래서 여기서 보는 것이 "우리 코드가 우리 코드에
// 동의하는가" 가 아니라 **serialport 가 실제로 내는 이벤트에 우리가 맞게
// 반응하는가** 다. 뽑힘을 close 로 알릴지 error 로 알릴지는 우리가 정하는
// 것이 아니므로, 그 부분은 흉내로라도 남의 구현에 물어봐야 한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockBinding } from '@serialport/binding-mock';
import { SerialPortStream } from '@serialport/stream';

import { waitForPort, waitForLoss, runLink, findDevices, VID, PID }
  from '../src/link.js';
import { Hub, CH_LINK } from '../src/hub.js';
import { Disk } from '../src/disk.js';
import { serve } from '../src/server.js';
import { buildFrame, FrameParser } from '../src/frame.js';
import * as P from '../src/protocol.js';

/** 실물 SerialPort 와 같은 모양으로 감싼다 - link.js 가 쓰는 것만. */
class MockSerialPort extends SerialPortStream {
  constructor(opts, cb) { super({ binding: MockBinding, ...opts }, cb); }
  static list() { return MockBinding.list(); }
}

const CART = { vendorId: VID, productId: PID };

/**
 * 시험마다 제 고리를 끝내고 나간다.
 *
 * 안 그러면 waitForPort 의 타이머가 이벤트 루프를 붙잡아 **테스트 프로세스가
 * 끝나지 않는다** - 실패도 성공도 아닌 멈춤이라, 처음에 이걸로 한 번 걸렸다.
 * 멈출 수 없는 고리는 시험할 수도 없다는 것이 link.js 에 signal 이 있는 이유다.
 */
function opts(t, extra = {}) {
  const ac = new AbortController();
  t.after(() => ac.abort());
  return { pollMs: 5, signal: ac.signal, ...extra };
}

function recorder(hub) {
  const seen = [];
  hub.subscribe((ev) => { if (ev.ch === CH_LINK) seen.push(ev); });
  return seen;
}

/** 프라미스가 ms 안에 끝나지 않으면 시험을 실패시킨다 (영영 막히는 것을 잡는다). */
function within(ms, p, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`시간 초과: ${what}`)), ms)),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('없던 카트리지가 나타나면 잡는다', async (t) => {
  MockBinding.reset();
  const hub = new Hub();
  const seen = recorder(hub);

  const pending = waitForPort(MockSerialPort, hub, opts(t), {});
  await sleep(30);                       // 기다리는 중임을 먼저 말해야 한다
  assert.equal(seen.filter((e) => e.ev === 'waiting').length, 1);

  MockBinding.createPort('/dev/PD1', CART);
  const sp = await within(1000, pending, '나타난 카트리지를 잡기');
  assert.ok(sp.isOpen);
  assert.equal(seen.at(-1).ev, 'connected');
  assert.equal(seen.at(-1).port, '/dev/PD1');
  sp.close();
});

test('남이 포트를 쥐고 있으면 이유를 말한다 (ModemManager 와 같은 조건)', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('/dev/PD1', CART);

  // 다른 프로그램이 먼저 열어 둔 상태. MockBinding 은 이때 열기를 거부한다.
  const held = await MockBinding.open(
    { path: '/dev/PD1', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

  const hub = new Hub();
  const seen = recorder(hub);
  const pending = waitForPort(MockSerialPort, hub, opts(t), {});
  await sleep(40);

  // **이것이 이 시험의 요점이다.** 삼키면 화면에는 "기다린다" 만 남는다.
  const failed = seen.filter((e) => e.ev === 'open_failed');
  assert.equal(failed.length, 1, '못 연 이유를 정확히 한 번 말해야 한다');
  assert.match(failed[0].error, /lock/i);
  assert.equal(failed[0].port, '/dev/PD1');

  await held.close();                    // 쥐고 있던 쪽이 놓으면
  const sp = await within(1000, pending, '놓아준 뒤에 잡기');
  assert.ok(sp.isOpen);
  sp.close();
});

test('한 번 말을 튼 카트리지를 고수한다', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('/dev/PD1', CART);

  const hub = new Hub();
  const state = {};
  const O = opts(t);
  const sp = await within(1000, waitForPort(MockSerialPort, hub, O, state), '첫 연결');
  const locked = state.lockedSerial;
  assert.ok(locked, '시리얼을 잠갔어야 한다');
  sp.close();
  await sleep(10);

  // 두 번째 보드가 꽂힌다. 잠그지 않았다면 여기서 '둘이다' 로 멈출 것이다.
  MockBinding.createPort('/dev/PD2', CART);
  assert.equal((await findDevices(MockSerialPort)).length, 2);

  const seen = recorder(hub);
  const sp2 = await within(1000, waitForPort(MockSerialPort, hub, O, state), '재연결');
  assert.equal(sp2.path, '/dev/PD1', '남의 보드에 디스크를 넘기면 안 된다');
  assert.equal(seen.filter((e) => e.ev === 'several').length, 0);
  sp2.close();
});

test('둘 중에 고르지 않는다', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('/dev/PD1', CART);
  MockBinding.createPort('/dev/PD2', CART);

  const hub = new Hub();
  const seen = recorder(hub);
  // 영영 안 끝나는 것이 정답이다. 시험이 끝나면 signal 이 끊어 주는데, 그때
  // 나오는 Aborted 를 받아 줘야 한다 - 안 받으면 unhandledRejection 이 된다.
  waitForPort(MockSerialPort, hub, opts(t), {}).catch(() => {});
  await sleep(50);

  assert.equal(seen.filter((e) => e.ev === 'several').length, 1);
  assert.equal(seen.filter((e) => e.ev === 'connected').length, 0,
               '추측해서 연결하면 안 된다');
});

test('끊겼다 돌아와도 디스크가 계속 서빙된다', async (t) => {
  MockBinding.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdlink-'));
  const img = path.join(dir, 'd.img');
  const BLOCKS = 16;
  const body = Buffer.alloc(P.SECTOR * BLOCKS);
  for (let lba = 0; lba < BLOCKS; lba++)
    body.fill(lba & 0xff, lba * P.SECTOR, (lba + 1) * P.SECTOR);
  fs.writeFileSync(img, body);

  const disk = new Disk(img);
  const hub = new Hub();
  const seen = recorder(hub);
  let links = 0;
  let live = null;                       // 지금 서버가 들고 있는 링크

  MockBinding.createPort('/dev/PD1', { ...CART, record: true });
  runLink(MockSerialPort, hub, opts(t), (sp) => { links++; live = sp; serve(sp, disk, hub); });

  const until = async (fn, what) => {
    for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(5); }
    throw new Error(`시간 초과: ${what}`);
  };

  /** 카트리지 노릇: READ 프레임을 넣고 돌아온 섹터를 받는다. */
  async function readSector(lba) {
    await until(() => live && live.isOpen, '서버가 포트를 열기');
    const binding = live.port;           // 스트림이 쥔 바인딩. record 로 남는다.
    binding.recording = Buffer.alloc(0);
    const parser = new FrameParser();
    const req = Buffer.alloc(5);
    req.writeUInt32LE(lba, 0);
    req[4] = 1;
    binding.emitData(buildFrame(P.BLK_READ_REQ, req));

    let out = null;
    await until(() => {
      const rec = binding.recording;
      if (!rec.length) return false;
      binding.recording = Buffer.alloc(0);
      for (const f of parser.feed(rec))
        if (f.cmd === P.BLK_READ_RESP) { out = f.payload; return true; }
      return false;
    }, `LBA ${lba} 의 답`);
    return out;
  }

  const first = await readSector(3);
  assert.equal(first[0], P.ST_OK);
  assert.equal(first[1], 3, '3번 섹터의 내용이어야 한다');
  assert.equal(links, 1);

  // 뽑는다. 서버는 죽지 말고 다시 기다려야 한다.
  const was = live;
  live = null;
  was.close();
  await until(() => seen.some((e) => e.ev === 'lost'), '끊김을 알아채기');

  // 다시 꽂는다 - runLink 가 알아서 다시 연다.
  const second = await readSector(7);
  assert.equal(second[1], 7, '재접속 뒤에도 서빙해야 한다');
  assert.equal(links, 2, 'serve() 가 새 링크에 다시 걸려야 한다');

  disk.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
