// SPDX-License-Identifier: GPL-2.0-only
//
// ws.js — WebSocket 서버. 의존성 없이 RFC 6455 의 쓰는 부분만.
//
// **왜 `ws` 를 안 쓰는가.** 이 포트의 존재 이유가 배포다 - 파이썬을 깔게
// 하지 않으려고 Node 로 옮겼다. 그런데 의존성을 늘리면 같은 문제가 모양만
// 바꿔 돌아온다(설치, 네이티브 빌드, 버전). 지금 필수 의존성은 0 개이고
// (serialport 마저 optional 이다), 서버 쪽 WebSocket 은 이 정도 분량이다.
//
// **어디까지 하는가.** 브라우저가 실제로 쓰는 것만 한다: 핸드셰이크, 텍스트/
// 바이너리 프레임, 조각난 프레임 잇기, ping/pong, close. 확장(permessage-
// deflate)은 협상하지 않는다 - 안 하겠다고 답하면 브라우저는 그냥 안 쓴다.
//
// **한 가지 비대칭을 반드시 지킨다.** 클라이언트가 보내는 프레임은 **반드시**
// 마스킹돼 있고, 서버가 보내는 프레임은 **반드시** 마스킹돼 있지 않다. 이것을
// 뒤집으면 브라우저가 연결을 끊는데, 이유를 말해 주지 않아서 찾기 어렵다.
//
// Node 23 의 전역 `WebSocket` 은 **클라이언트**뿐이라 서버 자리를 못 메운다.
// 다만 시험에서 상대역으로 쓸 수 있어서, 우리 구현을 남의 구현에 대 볼 수
// 있다 - 우리 코드가 우리 코드에 동의하는 것을 막는 장치다.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// 한 메시지의 상한. 브라우저에서 오는 것은 짧은 JSON 명령뿐이라 넉넉하다.
// 상한이 없으면 망가진 길이 필드 하나가 메모리를 통째로 먹는다.
const MAX_MESSAGE = 1 << 20;   // 1 MiB

/**
 * 서버가 쥐고 있는 연결 하나.
 *
 * 이벤트: 'message'(text|Buffer) · 'close'(code, reason) · 'error'(Error)
 */
export class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._frags = [];        // 조각난 메시지를 잇는 자리
    this._fragOp = null;

    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', (e) => { this.emit('error', e); this._finish(1006, e.message); });
  }

  /** 텍스트 한 줄. 객체를 주면 JSON 으로. */
  send(data) {
    if (!this.open) return false;
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8')
               : Buffer.isBuffer(data) ? data
               : Buffer.from(JSON.stringify(data), 'utf8');
    const op = Buffer.isBuffer(data) ? OP_BIN : OP_TEXT;
    return this.socket.write(encode(op, body));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try { this.socket.write(encode(OP_CLOSE, body)); } catch { /* 이미 갔다 */ }
    this._finish(code, reason);
    this.socket.end();
  }

  _finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    for (;;) {
      const f = decode(this._buf);
      if (f === null) return;                    // 아직 프레임 하나가 안 찼다
      if (f === false) { this.close(1002, 'protocol error'); return; }
      this._buf = this._buf.subarray(f.size);

      if (f.op === OP_CLOSE) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        this.close(code, f.payload.subarray(2).toString('utf8'));
        return;
      }
      if (f.op === OP_PING) { this.socket.write(encode(OP_PONG, f.payload)); continue; }
      if (f.op === OP_PONG) continue;

      // 조각난 메시지. FIN 이 설 때까지 모은다.
      if (f.op === OP_CONT) {
        if (this._fragOp === null) { this.close(1002, 'continuation without start'); return; }
        this._frags.push(f.payload);
      } else {
        if (this._fragOp !== null) { this.close(1002, 'new message inside a fragmented one'); return; }
        this._fragOp = f.op;
        this._frags = [f.payload];
      }

      const total = this._frags.reduce((n, b) => n + b.length, 0);
      if (total > MAX_MESSAGE) { this.close(1009, 'message too big'); return; }
      if (!f.fin) continue;

      const body = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags);
      const op = this._fragOp;
      this._frags = [];
      this._fragOp = null;
      this.emit('message', op === OP_TEXT ? body.toString('utf8') : body);
    }
  }
}

/** 프레임 하나를 만든다. 서버가 보내는 것이므로 **마스킹하지 않는다.** */
function encode(op, payload) {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const buf = Buffer.alloc(head + n);
  buf[0] = 0x80 | op;                            // FIN + opcode
  if (n < 126) buf[1] = n;
  else if (n < 65536) { buf[1] = 126; buf.writeUInt16BE(n, 2); }
  else { buf[1] = 127; buf.writeBigUInt64BE(BigInt(n), 2); }
  payload.copy(buf, head);
  return buf;
}

/**
 * 앞에서 프레임 하나를 읽는다.
 *
 * 아직 안 찼으면 null, 규약 위반이면 false. 버퍼를 자르지 않고 `size` 로
 * 알려 준다 - 자르는 일은 부르는 쪽이 한다.
 */
function decode(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  if (buf[0] & 0x70) return false;               // RSV 비트는 쓰지 않는다
  const op = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  if (!masked) return false;                     // 클라이언트는 반드시 마스킹한다

  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE)) return false;
    len = Number(big); off = 10;
  }

  // 제어 프레임은 125 바이트를 넘을 수 없고 조각날 수 없다.
  if (op >= 0x8 && (len > 125 || !fin)) return false;

  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
  return { fin, op, payload, size: off + 4 + len };
}

/**
 * http 서버의 upgrade 요청을 받아 WebSocket 으로 만든다.
 *
 * `path` 가 맞는 것만 받는다. 나머지는 끊는다 - 같은 포트에 다른 upgrade 가
 * 올 일은 없지만, 받아 놓고 아무것도 안 하면 브라우저가 영영 기다린다.
 */
export function attach(server, { path = '/ws', onConnection } = {}) {
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    onConnection(new WsConn(socket), req);
  });
  return server;
}
