// ws.test.js — 직접 짠 WebSocket 서버를 **남의 구현에 대 본다.**
//
// 상대역은 Node 23 의 전역 `WebSocket` (undici) 이다. 우리 인코더로 만든 것을
// 우리 디코더로 읽는 시험은 둘이 같이 틀렸을 때 통과한다. 브라우저가 쓰는
// 것과 같은 계열의 클라이언트에 대 보면 그 함정이 없다.
//
// 클라이언트가 안 하는 것(조각내기, 마스킹 안 하고 보내기)은 생 소켓으로
// 직접 만들어 넣는다. 브라우저가 보통 안 한다고 해서 안 오는 것은 아니다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

import { attach } from '../src/ws.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** ws 서버를 띄우고 주소를 돌려준다. 시험이 끝나면 닫는다. */
async function serveWs(t, onConnection) {
  const srv = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  attach(srv, { onConnection });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return `ws://127.0.0.1:${srv.address().port}/ws`;
}

function connect(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`열지 못했다: ${e.message || e}`)), { once: true });
  });
}

function next(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => resolve(e.data), { once: true });
    setTimeout(() => reject(new Error('메시지를 기다리다 시간 초과')), 2000);
  });
}

test('핸드셰이크가 서고 텍스트가 오간다', async (t) => {
  const url = await serveWs(t, (c) => c.on('message', (m) => c.send(`echo:${m}`)));
  const ws = await connect(url);
  ws.send('hello');
  assert.equal(await next(ws), 'echo:hello');
  ws.close();
});

test('길이 필드 세 갈래를 모두 지난다 (7비트·16비트·64비트)', async (t) => {
  // 125/126 과 65535/65536 이 경계다. 한 쪽만 맞고 다른 쪽이 틀리는 실수가
  // 흔해서, 경계마다 아래위를 다 넣는다.
  const url = await serveWs(t, (c) => c.on('message', (m) => c.send(m)));
  const ws = await connect(url);
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const s = 'x'.repeat(n);
    ws.send(s);
    const got = await next(ws);
    assert.equal(got.length, n, `${n} 바이트가 그대로 돌아와야 한다`);
    assert.equal(got, s);
  }
  ws.close();
});

test('한 덩어리로 몰려 와도 메시지 경계를 지킨다', async (t) => {
  // TCP 는 경계를 지켜 주지 않는다. 프레임 여러 개가 한 read 에 들어오거나
  // 프레임 하나가 두 read 로 쪼개지는 일은 평범하다.
  const got = [];
  const url = await serveWs(t, (c) => c.on('message', (m) => {
    got.push(m);
    if (got.length === 50) c.send(String(got.length));
  }));
  const ws = await connect(url);
  for (let i = 0; i < 50; i++) ws.send(`msg-${i}`);
  assert.equal(await next(ws), '50');
  assert.deepEqual(got.slice(0, 3), ['msg-0', 'msg-1', 'msg-2']);
  assert.equal(got[49], 'msg-49');
  ws.close();
});

test('바이너리도 그대로 오간다', async (t) => {
  const url = await serveWs(t, (c) => c.on('message', (m) => {
    assert.ok(Buffer.isBuffer(m), '바이너리는 Buffer 로 와야 한다');
    c.send(Buffer.from(m).reverse());
  }));
  const ws = await connect(url);
  ws.binaryType = 'arraybuffer';
  ws.send(new Uint8Array([1, 2, 3, 250]));
  const back = new Uint8Array(await next(ws));
  assert.deepEqual([...back], [250, 3, 2, 1]);
  ws.close();
});

test('브라우저가 닫으면 서버도 안다', async (t) => {
  let closed = null;
  const url = await serveWs(t, (c) => c.on('close', (code) => { closed = code; }));
  const ws = await connect(url);
  ws.close(1000, 'bye');
  for (let i = 0; i < 100 && closed === null; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1000);
});

test('서버가 닫으면 브라우저도 안다', async (t) => {
  const url = await serveWs(t, (c) => c.close(4001, 'server said so'));
  const ws = await connect(url);
  const ev = await new Promise((resolve) => {
    ws.addEventListener('close', resolve, { once: true });
  });
  assert.equal(ev.code, 4001);
  assert.equal(ev.reason, 'server said so');
});

// ------------------------------------------------- 클라이언트가 안 하는 것들

/** 생 소켓으로 핸드셰이크만 하고 프레임은 직접 만든다. */
async function raw(url) {
  const u = new URL(url.replace('ws://', 'http://'));
  const sock = net.createConnection(Number(u.port), u.hostname);
  await new Promise((r) => sock.once('connect', r));
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\n`
    + `Upgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const head = await new Promise((r) => sock.once('data', r));
  assert.match(head.toString('latin1'), /^HTTP\/1\.1 101 /);
  const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
  assert.match(head.toString('latin1'), new RegExp(`Sec-WebSocket-Accept: ${want.replace(/\+/g, '\\+')}`));
  return sock;
}

/** 클라이언트 프레임 하나. 마스킹은 규약상 필수다. */
function clientFrame(op, body, fin = true) {
  const p = Buffer.from(body);
  const mask = crypto.randomBytes(4);
  const head = p.length < 126 ? 2 : 4;
  const out = Buffer.alloc(head + 4 + p.length);
  out[0] = (fin ? 0x80 : 0) | op;
  if (p.length < 126) out[1] = 0x80 | p.length;
  else { out[1] = 0x80 | 126; out.writeUInt16BE(p.length, 2); }
  mask.copy(out, head);
  for (let i = 0; i < p.length; i++) out[head + 4 + i] = p[i] ^ mask[i & 3];
  return out;
}

test('조각난 메시지를 이어 붙인다', async (t) => {
  // 브라우저는 보통 안 쪼개지만, 규약상 쪼갤 수 있다. 안 오는 것과 못 받는
  // 것은 다르다.
  let got = null;
  const url = await serveWs(t, (c) => c.on('message', (m) => { got = m; }));
  const sock = await raw(url);
  sock.write(clientFrame(0x1, 'one ', false));   // TEXT, FIN 없음
  sock.write(clientFrame(0x0, 'two ', false));   // CONT
  sock.write(clientFrame(0x0, 'three', true));   // CONT + FIN
  for (let i = 0; i < 100 && got === null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got, 'one two three');
  sock.destroy();
});

test('마스킹 안 한 클라이언트 프레임은 규약 위반으로 끊는다', async (t) => {
  const url = await serveWs(t, () => {});
  const sock = await raw(url);
  // FIN|TEXT, 마스크 비트 없음 - 클라이언트는 이렇게 보내면 안 된다.
  sock.write(Buffer.concat([Buffer.from([0x81, 0x03]), Buffer.from('bad')]));
  const reply = await new Promise((r) => { sock.once('data', r); setTimeout(() => r(null), 1000); });
  assert.ok(reply, '끊기 전에 close 프레임이 와야 한다');
  assert.equal(reply[0] & 0x0f, 0x8, 'close 프레임이어야 한다');
  assert.equal(reply.readUInt16BE(2), 1002, '1002 = protocol error');
  sock.destroy();
});

test('ping 에 pong 으로 답한다', async (t) => {
  const url = await serveWs(t, () => {});
  const sock = await raw(url);
  sock.write(clientFrame(0x9, 'are you there'));
  const reply = await new Promise((r) => sock.once('data', r));
  assert.equal(reply[0] & 0x0f, 0xa, 'pong 이어야 한다');
  assert.equal(reply.subarray(2).toString(), 'are you there', '보낸 것을 그대로 돌려준다');
  sock.destroy();
});

test('/ws 가 아닌 곳의 upgrade 는 받지 않는다', async (t) => {
  const url = await serveWs(t, () => {});
  const u = new URL(url.replace('ws://', 'http://'));
  const sock = net.createConnection(Number(u.port), u.hostname);
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /nope HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n`
    + `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
    + `Sec-WebSocket-Version: 13\r\n\r\n`);
  const head = await new Promise((r) => sock.once('data', r));
  assert.match(head.toString('latin1'), /^HTTP\/1\.1 400 /);
  sock.destroy();
});
