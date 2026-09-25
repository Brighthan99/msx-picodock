// serve.test.js — 하드웨어 없이 서버를 통째로 검증한다.
//
// 링크를 스트림으로 받게 해 둔 덕에, 시험에서는 TCP 소켓을 카트리지 대신
// 쓴다. 프레임을 직접 만들어 넣고 답을 뜯어보므로 **프로토콜 수준에서** 맞는지
// 보는 것이지, 우리 코드가 우리 코드에 동의하는지 보는 것이 아니다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Disk } from '../src/disk.js';
import { Hub } from '../src/hub.js';
import { serve } from '../src/server.js';
import { buildFrame, FrameParser } from '../src/frame.js';
import * as P from '../src/protocol.js';
import * as A from '../src/ask.js';
import { AskService } from '../src/ask.js';

const BLOCKS = 64;

function scratchImage() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdnode-')), 'test.img');
  const buf = Buffer.alloc(P.SECTOR * BLOCKS);
  for (let lba = 0; lba < BLOCKS; lba++) buf.fill(lba & 0xff, lba * P.SECTOR, (lba + 1) * P.SECTOR);
  fs.writeFileSync(p, buf);
  return p;
}

/**
 * 서버를 TCP 로 띄우고, 카트리지 노릇을 하는 클라이언트를 돌려준다.
 *
 * `t` 를 주면 시험이 끝날 때 **실패했더라도** 치운다. 안 치우면 열린 소켓이
 * 러너를 붙잡아, 실패가 '실패' 가 아니라 '멈춤' 으로 나타난다 - 어느 단언이
 * 틀렸는지조차 안 보인다. 실제로 그렇게 한 번 걸렸다.
 */
async function start(opts = {}, t = null) {
  const image = scratchImage();
  const disk = new Disk(image, opts);
  const hub = new Hub();
  const srv = net.createServer((sock) => serve(sock, disk, hub, opts));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const sock = net.createConnection(srv.address().port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));

  const parser = new FrameParser();
  const inbox = [];
  const waiters = [];
  sock.on('data', (d) => {
    for (const f of parser.feed(d)) {
      inbox.push(f);
      if (waiters.length) waiters.shift()(inbox.shift());
    }
  });
  const stop = () => { sock.destroy(); srv.close(); disk.close(); };
  if (t) t.after(stop);

  return {
    image, disk, hub, srv, sock,
    send: (cmd, payload) => sock.write(buildFrame(cmd, payload ?? Buffer.alloc(0))),
    next: () => (inbox.length ? Promise.resolve(inbox.shift())
                              : new Promise((r) => waiters.push(r))),
    stop,
  };
}

test('INFO: 블록 수와 섹터 크기를 돌려준다', async () => {
  const s = await start();
  s.send(P.BLK_INFO_REQ);
  const f = await s.next();
  assert.equal(f.cmd, P.BLK_INFO_RESP);
  assert.equal(f.payload[0], P.ST_OK);
  assert.equal(f.payload.readUInt32LE(1), BLOCKS);
  assert.equal(f.payload.readUInt16LE(5), P.SECTOR);
  s.stop();
});

test('READ: 이미지의 내용이 그대로 나온다', async () => {
  const s = await start();
  const req = Buffer.alloc(5); req.writeUInt32LE(3, 0); req[4] = 2;
  s.send(P.BLK_READ_REQ, req);
  const f = await s.next();
  assert.equal(f.cmd, P.BLK_READ_RESP);
  assert.equal(f.payload[0], P.ST_OK);
  assert.equal(f.payload.length, 1 + P.SECTOR * 2);
  assert.equal(f.payload[1], 3);                       // lba 3 은 0x03 으로 채워 뒀다
  assert.equal(f.payload[1 + P.SECTOR], 4);            // 다음 섹터는 0x04
  s.stop();
});

test('READ: 끝을 넘어서면 오류', async () => {
  const s = await start();
  const req = Buffer.alloc(5); req.writeUInt32LE(BLOCKS - 1, 0); req[4] = 4;
  s.send(P.BLK_READ_REQ, req);
  const f = await s.next();
  assert.equal(f.payload[0], P.ST_ERR);
  assert.equal(f.payload.length, 1);
  s.stop();
});

test('WRITE: 파일에 실제로 쓰이고, 다시 읽으면 나온다', async () => {
  const s = await start();
  const body = Buffer.alloc(P.SECTOR, 0xa5);
  const req = Buffer.concat([Buffer.alloc(5), body]);
  req.writeUInt32LE(7, 0); req[4] = 1;
  s.send(P.BLK_WRITE_REQ, req);
  assert.equal((await s.next()).payload[0], P.ST_OK);

  const rd = Buffer.alloc(5); rd.writeUInt32LE(7, 0); rd[4] = 1;
  s.send(P.BLK_READ_REQ, rd);
  const f = await s.next();
  assert.equal(f.payload[1], 0xa5);

  const onDisk = fs.readFileSync(s.image).subarray(7 * P.SECTOR, 8 * P.SECTOR);
  assert.ok(onDisk.every((b) => b === 0xa5), '파일에 실제로 쓰였어야 한다');
  s.stop();
});

test('WRITE: --readonly 면 거절한다', async () => {
  const s = await start({ readonly: true });
  const req = Buffer.concat([Buffer.alloc(5), Buffer.alloc(P.SECTOR, 1)]);
  req.writeUInt32LE(2, 0); req[4] = 1;
  s.send(P.BLK_WRITE_REQ, req);
  assert.equal((await s.next()).payload[0], P.ST_ERR);
  s.stop();
});

test('paused: 답은 하되 오류로 — 침묵은 죽은 링크처럼 보인다', async () => {
  const s = await start();
  s.disk.paused = true;
  s.send(P.BLK_INFO_REQ);
  const f = await s.next();
  assert.equal(f.cmd, P.BLK_INFO_RESP);
  assert.equal(f.payload[0], P.ST_ERR);
  s.stop();
});

test('프린터·PSG·메일박스는 디스크와 무관하게 지나간다', async (t) => {
  const seen = { print: 0, psg: 0, ask: 0 };
  // ask 는 AskService 의 자리다. 여기서 보는 것은 **바이트가 거기까지 가는가**
  // 뿐이라, 상태 기계 대신 세는 것만 하는 가짜를 끼운다.
  const ask = {
    feed: (p) => (seen.ask += p.length),
    pump: () => {},
    linkReset: () => {},
  };
  const s = await start({
    onPrint: (p) => (seen.print += p.length),
    onPsg: () => (seen.psg += 1),
    ask,
  }, t);
  s.disk.paused = true;                       // 멈춰 있어도 통과해야 한다
  s.send(P.PRINT_DATA, Buffer.from('MSX'));
  s.send(P.PSG_FRAME, Buffer.alloc(17));
  s.send(P.MB_TO_HOST, Buffer.from('?'));
  s.send(P.BLK_INFO_REQ);                     // 이게 돌아오면 앞의 셋은 처리된 뒤다
  await s.next();
  assert.deepEqual(seen, { print: 3, psg: 1, ask: 1 });
  s.stop();
});

test('한 번에 몰려 들어와도 (프레임이 쪼개져도) 다 처리한다', async () => {
  const s = await start();
  const many = Buffer.concat(Array.from({ length: 20 }, () => buildFrame(P.BLK_INFO_REQ)));
  for (let i = 0; i < many.length; i += 7) s.sock.write(many.subarray(i, i + 7));
  for (let i = 0; i < 20; i++) assert.equal((await s.next()).cmd, P.BLK_INFO_RESP);
  s.stop();
});

test('CALL PDASK: 물으면 답이 청크로 돌아온다 (선을 통째로)', async (t) => {
  // 여기까지 와야 비로소 "결선이 됐다" 고 할 수 있다. 상태 기계는 ask.test.js
  // 가 따로 보고, 이 시험이 보는 것은 **메일박스 프레임에 실려 오가는가** 다.
  const ask = new AskService(new Hub(), { answerer: async (q) => `you asked: ${q}` });
  const s = await start({ ask }, t);

  const q = Buffer.from('msx', 'latin1');
  s.send(P.MB_TO_HOST,
         Buffer.concat([Buffer.from([A.OP_REQ, q.length, 0]), q]));

  const first = await s.next();
  assert.equal(first.cmd, P.MB_TO_MSX);
  assert.equal(first.payload[0], A.OP_CHUNK);
  assert.equal(first.payload.subarray(2).toString('latin1'), 'you asked: msx');

  // ACK 하기 전에는 END 가 오면 안 된다. 그러니 ACK 를 보내고 받는다.
  s.send(P.MB_TO_HOST, Buffer.from([A.OP_ACK]));
  const end = await s.next();
  assert.equal(end.cmd, P.MB_TO_MSX);
  assert.deepEqual([...end.payload], [A.OP_END]);
  assert.equal(ask.state, 'idle');
});

test('CALL PDASK: 디스크가 멈춰 있어도 답한다', async (t) => {
  // 빌려간 이미지 때문에 질문까지 거절하면 어리둥절한 실패가 된다.
  const ask = new AskService(new Hub(), { answerer: async () => 'still here' });
  const s = await start({ ask }, t);
  s.disk.paused = true;

  const q = Buffer.from('?', 'latin1');
  s.send(P.MB_TO_HOST, Buffer.concat([Buffer.from([A.OP_REQ, 1, 0]), q]));
  const f = await s.next();
  assert.equal(f.payload.subarray(2).toString('latin1'), 'still here');
});
