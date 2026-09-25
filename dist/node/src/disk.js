// SPDX-License-Identifier: GPL-2.0-only
//
// disk.js — 디스크 이미지. MSX 가 보는 하드디스크는 이 파일 하나다.
//
// **멈춘다는 것은 핸들을 놓는다는 뜻이다.** 이 이미지를 이 컴퓨터에 마운트한
// 채로 서빙하면 한 파일시스템에 쓰는 쪽이 둘이 되고, 그건 거의 확실한 손상이다.
// 그래서 pause() 는 플래그만 세우는 것이 아니라 fd 를 닫는다 - 플래그만 세우면
// "멈췄다" 고 화면에 쓰면서 핸들은 그대로 쥐고 있게 된다.

import fs from 'node:fs';
import { SECTOR } from './protocol.js';

export class Disk {
  constructor(path, { readonly = false } = {}) {
    this.path = path;
    this.readonly = readonly;
    this.fd = fs.openSync(path, readonly ? 'r' : 'r+');
    this.blocks = Math.floor(fs.fstatSync(this.fd).size / SECTOR);
    this.paused = false;
  }

  /** 핸들을 놓는다. 이미 멈춰 있으면 아무것도 안 한다. */
  pause() {
    if (this.paused) return;
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* 이미 닫혔다 */ } }
    this.fd = null;
    this.paused = true;
  }

  /** 다시 연다. 그 사이 크기가 바뀌었을 수 있으니 블록 수도 다시 센다. */
  resume() {
    if (!this.paused) return;
    this.fd = fs.openSync(this.path, this.readonly ? 'r' : 'r+');
    this.blocks = Math.floor(fs.fstatSync(this.fd).size / SECTOR);
    this.paused = false;
  }

  read(lba, count) {
    const buf = Buffer.alloc(SECTOR * count);           // 부족분은 0 으로 남는다
    fs.readSync(this.fd, buf, 0, buf.length, lba * SECTOR);
    return buf;                                          // 끝에서 짧게 읽혀도 길이는 유지
  }

  write(lba, body) {
    fs.writeSync(this.fd, body, 0, body.length, lba * SECTOR);
    fs.fsyncSync(this.fd);        // MSX 는 이미 "썼다" 고 믿는다. 미루지 않는다.
  }

  close() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch { /* 이미 닫혔다 */ }
    this.fd = null;
  }
}
