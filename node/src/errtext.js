// SPDX-License-Identifier: GPL-2.0-only
//
// errtext.js — 오류를 사람이 읽을 한 줄로.
//
// Node 와 serialport 가 서로 다르게 담는다. fs 의 message 는 code 를 이미
// 품고 있고("ENOENT: no such file..."), serialport 의 것은 안 그렇다. 그냥
// 이어 붙이면 "ENOENT: ENOENT: ..." 가 되므로 겹칠 때는 하나만 쓴다.
export function errText(e) {
  const code = e.code || e.name || 'Error';
  const msg = e.message || String(e);
  return msg.startsWith(code) ? msg : `${code}: ${msg}`;
}
