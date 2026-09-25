// SPDX-License-Identifier: GPL-2.0-only
//
// web.js — 브라우저로 보는 서버 화면.
//
// 서버가 아는 것을 터미널이 아니라 브라우저에서 본다. 그래야 하는
// 이유는 배포다 - 창 하나 띄우려고 터미널 쓰는 법을 가르칠 수는 없다.
//
// **왜 127.0.0.1 인가.** 이 화면은 디스크 이미지를 멈추고, 카트리지의 기능을
// 켜고 끄고, MSX 가 던진 질문에 답한다. 즉 **쓰기 권한**이다. 0.0.0.0 에 묶으면
// 같은 카페 와이파이에 있는 사람이 그것을 다 할 수 있다. 그래서 기본은
// 루프백이고, 바꾸려면 --web-host 로 일부러 말해야 한다.
//
// **왜 스냅샷과 이벤트를 둘 다 보내는가.** 이벤트만 보내면 늦게 연 브라우저는
// 빈 화면으로 시작한다. 스냅샷만 보내면 주기적으로 다시 물어야 해서 화면이
// 뒤늦게 움직인다. 붙을 때 한 번 스냅샷, 그 뒤로는 이벤트 - Hub.since() 가
// 원래 이러라고 있는 것이다.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach } from './ws.js';
import { CH_LINK } from './hub.js';
import { CTRL_PSG_STREAM, CTRL_MIDIPAC, CTRL_MIDI_PROG } from './cart.js';
import { readTree } from './tree.js';
import { ENGINES, REPLY_MODES } from './voices.js';
import { KEYED } from './ask.js';

//: 소켓 바이너리 첫 바이트. 0x50 은 PSG 원음, 0x40 은 인쇄, 0x4B 는 한자 그림.
export const VOICE_MONITOR = 0x56;       // 'V' [rate:4][int16 pcm...]
export const VOICE_MONITOR_STOP = 0x57;  // 'W'
import { Docs, openForPrint, STYLES } from './printdoc.js';
import { Staging, putStaged, rmPaths, mvPath, readText, writeText, newText,
         mkdirPath,
         MAX_FILE } from './diskedit.js';
import { PSG_FRAME, PRINT_DATA } from './protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');

// 브라우저가 쓰는 모듈은 src/ 에 산다. 같은 코드를 web/ 에 복사해 두면 둘이
// 갈라지는 것이 시간 문제라, 한 벌만 두고 여기서 내준다. escp.js 가 ESC/P 를
// 그리는데 그건 Node 시험도 쓰는 코드다 - 갈라지면 시험이 지키는 것이
// 브라우저가 돌리는 것과 달라진다.
const SRC_DIR = path.join(HERE);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 브라우저에게 보여 줄 "지금 참인 것".
 *
 * 로그(이벤트)가 "무슨 일이 있었나" 라면 이것은 "지금 어떤가" 다. 화면이
 * 이상해 보이는데 로그에 아무것도 없을 때 보는 것이 이쪽이다.
 */
function snapshot(deps) {
  const { disk, cart, ask, printer, link } = deps;
  return {
    type: 'state',
    t: Date.now() / 1000,
    link: { connected: !!link.connected, port: link.port || null,
            serial: link.serial || null, since: link.since || null },
    disk: { path: disk.path, blocks: disk.blocks,
            readonly: !!disk.readonly, paused: !!disk.paused },
    toggles: {
      psg: cart.get(CTRL_PSG_STREAM, false),
      midipac: cart.get(CTRL_MIDIPAC, false),
      pause: !!disk.paused,
    },
    // MIDI-PAC 이 톤 채널에 거는 GM 악기. 펌웨어 기본값과 같은 80 으로 시작한다.
    midiProg: cart.get(CTRL_MIDI_PROG, 80),
    ask: ask ? ask.status() : null,
    printer: printer ? { mode: printer.mode, spool: !!printer.spool,
                         open: printer.bufLen > 0,
                         kanjiRom: !!printer.kanjiRom } : null,
    // 고를 수 있는 프린터와, 지금 바로 내보내는지. 목록을 스냅샷에 싣는 이유:
    // 프린터는 설정 파일로 늘어날 수 있으므로 화면이 미리 알 수 없다.
    // 목소리. 화면이 고를 수 있는 것들(엔진 목록)과 지금 어떤지를 같이 싣는다 -
    // 엔진은 깔려 있는 것에 달려 있어서 브라우저가 알 도리가 없다.
    voice: deps.voice ? {
      ...deps.voice.status(),
      ...deps.voice.say.opts,
      engines: ENGINES,
      replyModes: REPLY_MODES,
      // 지금 엔진·언어가 아는 목소리들. 아직 모르면 빈 목록이고, 물어보는
      // 것은 알아서 시작된다 - 스냅샷은 기다리지 않는다.
      voiceList: deps.voice.say.voicesCached(),
    } : null,
    printers: deps.printers ? deps.printers.list() : [],
    direct: deps.direct ? deps.direct.status() : null,
  };
}

/**
 * 브라우저가 보내는 명령을 받는다.
 *
 * 모르는 명령은 조용히 버리지 않고 되돌려 말한다. 화면이 눌렀는데 아무 일도
 * 안 일어나는 것과, 서버가 그 명령을 모른다는 것은 다른 이야기다.
 */
function command(msg, deps, hub, conn = {}) {
  const { disk, cart, ask } = deps;
  switch (msg.cmd) {
    case 'set': {
      const what = { psg: CTRL_PSG_STREAM, midipac: CTRL_MIDIPAC }[msg.what];
      if (what !== undefined) { cart.set(what, !!msg.on); return { ok: true }; }
      if (msg.what === 'midiprog') {
        const n = Number(msg.value);
        if (!Number.isInteger(n) || n < 0 || n > 127)
          return { ok: false, why: 'program must be 0..127' };
        cart.set(CTRL_MIDI_PROG, n);
        return { ok: true };
      }
      if (msg.what === 'pause') {
        // 플래그만 세우면 "멈췄다" 고 쓰면서 핸들은 쥐고 있게 된다. 빌려 주는
        // 쪽이 있으면 그쪽에 맡기고, 없으면 디스크에 직접 말한다.
        if (deps.lending) deps.lending.setByUser(!!msg.on);
        else if (msg.on) disk.pause(); else disk.resume();
        return { ok: true };
      }
      return { ok: false, why: `unknown toggle: ${msg.what}` };
    }
    case 'voice': {
      // 한 번에 여러 개를 받는다. 화면에서 드롭다운 하나를 바꿀 때마다
      // 메시지가 하나씩 오지만, 묶어 보내도 같은 코드로 처리된다.
      const { voice, ask } = deps;
      if (!voice) return { ok: false, why: 'no voice service' };
      try {
        if (msg.enabled !== undefined) voice.enabled = !!msg.enabled;
        const said = {};
        if (msg.deliver !== undefined) voice.deliver = String(msg.deliver);
        for (const k of ['engine', 'lang', 'voice', 'curve']) {
          if (msg[k] !== undefined) said[k] = msg[k] || null;
        }
        if (Object.keys(said).length) voice.say.set(said);
      } catch (e) {
        // **왜 안 됐는지 화면에 그대로 보낸다.** 조용히 무시하면 드롭다운은
        // 바뀌었는데 아무 일도 안 일어나고, 그 상태는 아무 데도 안 남는다.
        return { ok: false, why: String(e && e.message || e) };
      }
      return { ok: true };
    }
    case 'voice_stop': {
      const { voice } = deps;
      if (!voice) return { ok: false, why: 'no voice service' };
      voice.stop(deps.toCart || (() => {}));
      return { ok: true };
    }
    case 'ask_reply': {
      // **ask 에 속한 설정이라 ask 만 있으면 된다.** 예전에는 voice 명령에
      // 얹혀 있어서, 음성 서비스가 없는 서버에서는 text 로 되돌리는 것조차
      // 거절당했다.
      const { ask } = deps;
      if (!ask) return { ok: false, why: 'no ask service' };
      try {
        return { ok: true, ...ask.setVoice({ reply: msg.reply }) };
      } catch (e) {
        return { ok: false, why: String(e && e.message || e) };
      }
    }
    case 'ask_mode': {
      const { ask } = deps;
      if (!ask) return { ok: false, why: 'no ask service' };
      return { ok: true, mode: ask.setMode(String(msg.mode || '')) };
    }
    case 'ask_key': {
      // Claude 나 Gemini 의 API 키. 이 줄을 지나 그쪽 객체의 private 필드로
      // 들어가고, 여기서는 아무 데도 남기지 않는다 - 메시지에서도 바로 떼어 낸다.
      // 돌려주는 답에는 "들어왔다" 와 모델 이름만 싣는다.
      const key = msg.key;
      delete msg.key;
      if (!ask) return { ok: false, why: 'no ask service' };
      if (!KEYED.includes(msg.who)) return { ok: false, why: `unknown answerer: ${msg.who}` };
      // **이 기계에서 온 것만 받는다.** 이 소켓은 평문 ws 다. --web-host 로
      // 화면을 밖에 열어 두었다면 키가 그 망을 맨몸으로 지나간다.
      if (!conn.local)
        return { ok: false, why: 'the key is only taken from this machine - the socket is not encrypted' };
      // 틀린 키는 실패가 아니라 답이다. 던지게 두면 command_failed 로
      // "server error" 가 붙는다.
      const who = msg.who;
      return { async: ask.setApiKey(who, key).then(
        (st) => ({ ok: true, who, status: st }),
        (e) => ({ ok: false, who, why: String(e && e.message || e) })) };
    }
    case 'ask_key_forget': {
      if (!ask) return { ok: false, why: 'no ask service' };
      if (!KEYED.includes(msg.who)) return { ok: false, why: `unknown answerer: ${msg.who}` };
      return { ok: true, who: msg.who, status: ask.forgetApiKey(msg.who) };
    }
    case 'answer':
      if (!ask) return { ok: false, why: 'no ask service' };
      if (!ask.waiting) return { ok: false, why: 'nothing is waiting for an answer' };
      ask.reply(String(msg.text ?? ''), 'web');
      return { ok: true };
    case 'files': {
      // 이미지를 **지금** 읽는다. 캐시를 두지 않는 이유는 이 창의 값어치가
      // "지금 디스크에 뭐가 있나" 에 있기 때문이다 - 오래된 목록을 빠르게
      // 보여 주는 것은 이 창이 하려는 일의 반대다.
      const { disk } = deps;
      if (disk.paused)
        return { ok: false, why: 'the image is paused - the host has it right now' };
      try { return { ok: true, ...readTree(disk.path) }; }
      catch (e) { return { ok: false, why: e.message }; }
    }
    case 'files_put': {
      // 올려 둔 것을 이미지에 넣는다. 실제 쓰기는 disk_put.py 가 하고, 그쪽이
      // 서버를 비켜 세우는 규약까지 쥐고 있다.
      const { disk, staging } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      return { async: putStaged(disk.path, staging, String(msg.id2 || ''),
                                String(msg.into || '')) };
    }
    case 'files_rm': {
      const { disk, staging: _s } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      const paths = Array.isArray(msg.paths) ? msg.paths.map(String) : [];
      if (!paths.length) return { ok: false, why: 'nothing was selected' };
      return { async: rmPaths(disk.path, paths) };
    }
    case 'files_mv': {
      const { disk } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      return { async: mvPath(disk.path, String(msg.path || ''),
                             String(msg.name || '')) };
    }
    case 'file_read': {
      const { disk } = deps;
      if (disk.paused)
        return { ok: false, why: 'the image is paused - the host has it right now' };
      return { async: readText(disk.path, String(msg.path || ''),
                               msg.charset ? String(msg.charset) : null) };
    }
    case 'file_write': {
      const { disk } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      return { async: writeText(disk.path, String(msg.path || ''),
                                msg.charset ? String(msg.charset) : null,
                                String(msg.text ?? '')) };
    }
    case 'file_new': {
      const { disk } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      return { async: newText(disk.path, String(msg.into || ''),
                              String(msg.name || '')) };
    }
    case 'file_mkdir': {
      const { disk } = deps;
      if (disk.readonly) return { ok: false, why: 'the image is read-only' };
      const into = String(msg.into || '');
      const name = String(msg.name || '');
      return { async: mkdirPath(disk.path, into ? `${into}/${name}` : name) };
    }
    case 'doc_make': {
      // 고른 인쇄 작업들을 문서 하나로. 렌더링과 병합은 파이썬 도구가 한다.
      const { printer, docs } = deps;
      if (!printer || !printer.spool)
        return { ok: false, why: 'nothing is being spooled - start the server with --spool' };
      const seqs = (Array.isArray(msg.seqs) ? msg.seqs : [])
        .map(Number).filter(Number.isFinite);
      const stem = printer.spool.prnPath.replace(/\.prn$/, '');
      return { async: docs.make(stem, seqs, String(msg.style || 'msx'),
                                String(msg.charset || 'cp437'), 'msx',
                                !!msg.stack) };
    }
    case 'direct': {
      // 찍는 대로 종이로 보낼지, 그리고 어디로. `off`/빈 값이면 끈다.
      const { direct, printer } = deps;
      if (!direct) return { ok: false, why: 'no printers are configured' };
      // 방향·프린터·자동은 따로 바뀔 수 있다. 화면에서 셋이 다른 스위치다.
      if (msg.rotate !== undefined) {
        const r = direct.setRotate(String(msg.rotate));
        if (!r.ok) return r;
        if (msg.to === undefined && msg.auto === undefined) return r;
      }
      const to = msg.to === undefined ? null : String(msg.to || '');
      if (to && to !== 'off') {
        if (!printer) return { ok: false, why: 'the printer is not configured' };
        // 스풀이 필요하면 **여기서 켠다.** 렌더러가 색인으로 작업을 찾으므로
        // 스풀 없이는 내보낼 것을 못 고른다. 그렇다고 사람에게 서버를 내렸다
        // 올리라고 하는 것은, 화면에 스위치를 두는 뜻을 없애는 일이다.
        if (!printer.spool) {
          try { printer.startSpool(); }
          catch (e) { return { ok: false, why: `could not start the spool: ${e.message}` }; }
        }
      }
      if (msg.to !== undefined) {
        const r = direct.setTarget(to || null);
        if (!r.ok) return r;
        if (msg.auto === undefined) return r;
      }
      if (msg.auto !== undefined) return direct.setAuto(!!msg.auto);
      return { ok: true, status: direct.status() };
    }
    case 'print_jobs': {
      // 고른 작업을 **지금** 프린터로. 자동 전송과 다른 일이다 - 자동은 켜
      // 두고 잊는 것이고, 이것은 한 장을 집어 보내는 것이다.
      const { direct, printer } = deps;
      if (!direct) return { ok: false, why: 'no printers are configured' };
      if (!printer || !printer.spool)
        return { ok: false, why: 'nothing is being spooled' };
      const seqs = (Array.isArray(msg.seqs) ? msg.seqs : [])
        .map(Number).filter(Number.isFinite);
      if (!seqs.length) return { ok: false, why: 'no jobs were chosen' };
      const stem = printer.spool.prnPath.replace(/\.prn$/, '');
      // **한 번의 인쇄로 합친다.** 셋을 골랐으면 종이 석 장이 아니라 이어진
      // 한 장이다 - 도구가 그림을 쌓아 하나로 만든다.
      const r = direct.sendNow(stem, seqs.sort((a, b) => a - b));
      if (!r.ok) return r;
      return { ok: true, sent: seqs.length, status: direct.status() };
    }
    case 'direct_again': {
      // 나가다 만 작업을 다시 보낸다. 프린터를 켜거나 종이를 끼운 뒤에 쓴다.
      const { direct, printer } = deps;
      if (!direct || !direct.on) return { ok: false, why: 'it is not switched on' };
      if (!printer || !printer.spool) return { ok: false, why: 'nothing is being spooled' };
      const seq = Number(msg.seq);
      if (!Number.isFinite(seq)) return { ok: false, why: 'which job?' };
      const stem = printer.spool.prnPath.replace(/\.prn$/, '');
      direct.send(stem, seq);
      return { ok: true, status: direct.status() };
    }
    case 'doc_print': {
      const { docs } = deps;
      const d = docs.get(msg.doc);
      if (!d) return { ok: false, why: 'no such document - make it again' };
      return { async: openForPrint(d.pdf) };
    }
    case 'doc_drop': {
      deps.docs.drop(String(msg.doc || ''));
      return { ok: true };
    }
    case 'jobs': {
      const { printer } = deps;
      if (!printer || !printer.spool)
        return { ok: false, why: 'nothing is being spooled - start the server with --spool' };
      try { return { ok: true, jobs: printer.jobs() }; }
      catch (e) { return { ok: false, why: e.message }; }
    }
    case 'job': {
      const { printer } = deps;
      if (!printer || !printer.spool) return { ok: false, why: 'nothing is being spooled' };
      try {
        const job = printer.jobText(Number(msg.seq), { charset: msg.charset || null });
        if (!job) return { ok: false, why: `no job ${msg.seq}` };
        return { ok: true, job };
      } catch (e) { return { ok: false, why: e.message }; }
    }
    case 'jobraw': {
      // 원시 바이트는 JSON 에 싣지 않는다. 몇 백 KB 가 base64 로 부풀고,
      // 받는 쪽은 그걸 다시 풀어야 한다. 바이너리 프레임으로 그냥 보낸다.
      const { printer } = deps;
      if (!printer || !printer.spool) return { ok: false, why: 'nothing is being spooled' };
      try {
        const b = printer.jobBytes(Number(msg.seq));
        if (!b) return { ok: false, why: `no job ${msg.seq}` };
        return { ok: true, binary: { tag: PRINT_DATA, seq: Number(msg.seq), body: b } };
      } catch (e) { return { ok: false, why: e.message }; }
    }
    case 'jobglyphs': {
      const { printer } = deps;
      if (!printer || !printer.kanjiRom)
        return { ok: false, why: 'no kanji ROM - start with --kanji-rom to use one' };
      try {
        const g = printer.jobGlyphs(Number(msg.seq));
        if (!g) return { ok: false, why: `no job ${msg.seq}` };
        // 비트맵은 JSON 에 싣지 않는다. 한 장이 수십만 픽셀이다.
        const head = Buffer.alloc(9);
        head[0] = 0x4b;                       // 'K' - 한자 글리프
        head.writeUInt32LE(Number(msg.seq), 1);
        head.writeUInt32LE(g.pages.length, 5);
        const parts = [head];
        for (const p of g.pages) {
          const ph = Buffer.alloc(8);
          ph.writeUInt32LE(p.w, 0);
          ph.writeUInt32LE(p.h, 4);
          parts.push(ph, p.bits);
        }
        return { ok: true, raw: Buffer.concat(parts) };
      } catch (e) { return { ok: false, why: e.message }; }
    }
    case 'note':
      // 화면이 서버 로그에 한 줄 남긴다. 브라우저 콘솔을 볼 수 없는 자리에서
      // "화면 쪽에서 무슨 일이 있었나" 를 아는 유일한 길이다.
      hub.emit(CH_LINK, 'viewer_note', { text: String(msg.text || '').slice(0, 200) });
      return { ok: true };
    case 'refuse':
      if (!ask || !ask.waiting) return { ok: false, why: 'nothing is waiting' };
      ask.fail('refused from the web UI');
      return { ok: true };
    default:
      return { ok: false, why: `unknown command: ${msg.cmd}` };
  }
}

/** 루프백 주소인가. IPv4 는 127/8 전체, IPv6 는 ::1, 그리고 v4 가 v6 옷을 입은 것. */
export function isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

/**
 * 명령 하나가 서버를 죽이지 못하게 감싼다.
 *
 * **이 서버는 살아 있는 MSX 에게 디스크를 서빙한다.** 브라우저가 보낸 한 줄
 * 때문에 프로세스가 죽으면, 그 순간 날아가던 섹터 쓰기는 영영 호스트에 안
 * 닿고 FAT 이 반쯤 갱신된 채 남는다. 화면은 편의이고 디스크는 그렇지 않다 -
 * 편의가 본업을 끌어내리면 안 된다.
 *
 * 실제로 그랬다: `note` 명령이 잡히지 않은 ReferenceError 를 던져 서버가
 * 통째로 죽었다 (2026-09-21).
 */
function safeCommand(msg, deps, hub, conn) {
  try {
    return command(msg, deps, hub, conn);
  } catch (e) {
    // 삼키지 않는다. 화면에도 서버 로그에도 남긴다.
    try {
      hub.emit(CH_LINK, 'command_failed',
               { cmd: String(msg && msg.cmd), error: e.message });
    } catch { /* 허브까지 망가졌으면 할 수 있는 게 없다 */ }
    return { ok: false, why: `server error: ${e.message}` };
  }
}

/**
 * 웹 화면을 띄운다.
 *
 * `deps.link` 는 서버가 링크 상태를 적어 두는 그릇이다 (connected/port/serial).
 * 여기서 시리얼 포트를 직접 보지 않는 이유는, TCP 로 돌 때도 같아야 해서다.
 */
export async function startWeb(hub, deps, opts = {}) {
  const port = opts.port ?? 8080;
  const host = opts.host ?? '127.0.0.1';

  // 올리는 파일을 모아 두는 곳. deps 에 얹어 명령 쪽에서도 본다.
  const staging = deps.staging || (deps.staging = new Staging());
  const docs = deps.docs || (deps.docs = new Docs());

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'x'}`);
    const url = u.pathname;

    // --- 파일 올리기 -----------------------------------------------------
    //
    // 드래그 앤 드롭은 파일을 여러 개 준다. 하나씩 여기로 올려 임시 폴더에
    // 모았다가, WebSocket 의 files_put 이 한 번에 이미지로 옮긴다. 파일마다
    // 옮기면 파일마다 서버를 멈췄다 켜게 된다.
    if (req.method === 'POST' && url === '/files/stage') {
      const id = u.searchParams.get('id') || '';
      const name = u.searchParams.get('name') || '';
      const chunks = [];
      let n = 0;
      let bad = false;
      req.on('data', (b) => {
        n += b.length;
        // 한 파일 한계를 **받으면서** 본다. 다 받아 놓고 재면 그 메모리는
        // 이미 쓴 것이다.
        if (n > MAX_FILE) {
          bad = true;
          req.destroy();
          return;
        }
        chunks.push(b);
      });
      req.on('aborted', () => { if (bad) reply(413, { ok: false, why: 'file is too large' }); });
      req.on('end', () => {
        if (bad) return;
        const r = staging.add(id, name, Buffer.concat(chunks));
        reply(r.ok ? 200 : 400, r);
      });
      function reply(code, body) {
        if (res.headersSent) return;
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }
      return;
    }
    // --- 인쇄 작업 내려받기 ---------------------------------------------
    //
    // 작업 하나를 파일로 꺼내는 길. `--spool` 로 돌면 모든 바이트가 한 덩어리
    // `.prn` 에 들어가고 작업은 색인으로만 구분되므로, **작업 하나에 해당하는
    // 파일이 디스크에 없다.** 그걸 꺼내려면 지금까지는 CLI 뿐이었다.
    //
    // WebSocket 이 아니라 HTTP 인 이유: 브라우저가 파일 저장을 스스로 한다.
    // 바이너리를 소켓으로 나르고 Blob 을 만들어 앵커를 합성할 일이 없다.
    if (req.method === 'GET' && url === '/print/job') {
      const { printer } = deps;
      // **`Number(null)` 은 0 이다.** seq 를 아예 안 보냈는데 "0 번 작업이
      // 없다" 로 답하면, 요청이 잘못된 것과 작업이 없는 것이 뭉개진다.
      const seqRaw = u.searchParams.get('seq');
      const seq = seqRaw === null || seqRaw === '' ? NaN : Number(seqRaw);
      const as = u.searchParams.get('as') || 'prn';
      const charset = u.searchParams.get('charset') || null;
      const fail = (code, why) => {
        res.writeHead(code, { 'content-type': 'text/plain' }); res.end(why);
      };
      if (!printer || !printer.spool) return fail(409, 'nothing is being spooled');
      if (!Number.isFinite(seq)) return fail(400, 'which job?');
      try {
        if (as === 'txt') {
          const job = printer.jobText(seq, { charset });
          if (!job) return fail(404, `no job ${seq}`);
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename="msx_print_${seq}.txt"`,
          });
          res.end(job.text);
          return;
        }
        const b = printer.jobBytes(seq);
        if (!b) return fail(404, `no job ${seq}`);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="msx_print_${seq}.prn"`,
        });
        res.end(b);
        return;
      } catch (e) { return fail(500, e.message); }
    }

    // 만든 문서. iframe 미리보기와 내려받기가 같은 주소를 쓴다 - ?dl=1 일
    // 때만 저장 대화가 뜨게 Content-Disposition 을 붙인다.
    if (req.method === 'GET' && url === '/print/doc') {
      const d = docs.get(u.searchParams.get('id') || '');
      if (!d) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such document'); return; }
      let body;
      try { body = fs.readFileSync(d.pdf); }
      catch { res.writeHead(410, { 'content-type': 'text/plain' }); res.end('that document is gone'); return; }
      const head = { 'content-type': 'application/pdf', 'cache-control': 'no-store' };
      if (u.searchParams.get('dl'))
        head['content-disposition'] = `attachment; filename="msx_print_${d.style}.pdf"`;
      res.writeHead(200, head);
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url === '/files/open') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: staging.open() }));
      return;
    }

    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');

    // 웹 폴더 밖으로 나가는 경로는 받지 않는다. 로컬 전용이라 해도, 파일을
    // 읽어 주는 곳에 ../ 를 허용할 이유는 없다.
    let file;
    if (rel.startsWith('js/')) {
      file = path.join(SRC_DIR, rel.slice(3));
      if (!file.startsWith(SRC_DIR + path.sep)) { res.writeHead(403); res.end('nope'); return; }
    } else {
      file = path.join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR + path.sep) && file !== path.join(WEB_DIR, 'index.html')) {
        res.writeHead(403); res.end('nope'); return;
      }
    }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',       // 고치는 중에 낡은 것을 보면 미친다
      });
      res.end(body);
    });
  });

  const clients = new Set();

  attach(srv, {
    path: '/ws',
    onConnection: (c, req) => {
      clients.add(c);
      // 이 화면이 이 기계에서 열렸는가. 키처럼 망을 건너면 안 되는 것을 받을 때
      // 본다 (ask_key).
      c.local = isLoopback(req?.socket?.remoteAddress);
      try {
        c.send(snapshot(deps));
      } catch (e) {
        // 스냅샷을 못 만들면 화면은 영영 "connecting" 에 멈춘다. 조용히
        // 두면 브라우저 콘솔에도 아무것도 안 남는다.
        hub.emit(CH_LINK, 'viewer_failed', { error: e.message });
      }
      // 지난 일도 준다. 늦게 연 브라우저가 빈 화면으로 시작하지 않도록.
      for (const ev of hub.since(0)) c.send({ type: 'ev', ...ev });

      // **알리는 것은 맨 마지막이다.** 먼저 알리면 그 이벤트가 이 화면의
      // 백필에 섞여 들어가서, 자기가 접속했다는 기록을 지난 일인 양 받는다.
      //
      // 이 줄이 없으면 "브라우저가 서버까지 왔는가" 를 lsof 로 짐작해야 하고,
      // 그건 짐작이다 - 화면이 connecting 에 멈춰 있을 때 제일 먼저 볼 곳이다.
      hub.emit(CH_LINK, 'viewer', { action: 'open', viewers: clients.size,
                                    agent: (req?.headers?.['user-agent'] || '').slice(0, 40) });

      c.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch { c.send({ type: 'reply', ok: false, why: 'not JSON' }); return; }
        const out = safeCommand(msg, deps, hub, c);
        if (out.raw) { c.send(out.raw); return; }
        if (out.binary) {
          // [tag:1][seq:4][bytes...]
          const { tag, seq, body } = out.binary;
          const m = Buffer.allocUnsafe(5 + body.length);
          m[0] = tag;
          m.writeUInt32LE(seq, 1);
          body.copy(m, 5);
          c.send(m);
          return;
        }
        // 읽기만 하는 명령은 상태를 안 바꾼다. 스냅샷을 뿌리면 남의 창이
        // 공연히 다시 그린다.
        const readOnly = msg.cmd === 'jobs' || msg.cmd === 'job' || msg.cmd === 'jobraw'
                      || msg.cmd === 'jobglyphs' || msg.cmd === 'note'
                      || msg.cmd === 'files';
        const done = (r) => {
          c.send({ type: 'reply', id: msg.id ?? null, ...r });
          // 명령이 상태를 바꿨을 수 있다. 모든 화면이 같은 것을 보게 한다.
          if (r.ok && !readOnly)
            for (const other of clients) other.send(snapshot(deps));
        };

        // 이미지를 고치는 명령은 바깥 도구를 부르므로 시간이 걸린다. 그동안
        // 소켓이 막히면 안 되니 약속으로 돌려받는다. **여기서 던지는 것까지
        // 잡는다** - 비동기 자리의 예외는 safeCommand 의 try 밖에서 터져
        // 프로세스를 통째로 죽인다.
        if (out.async) {
          out.async.then(done, (e) => {
            try {
              hub.emit(CH_LINK, 'command_failed',
                       { cmd: String(msg.cmd), error: e.message });
            } catch { /* 허브까지 망가졌으면 할 수 있는 게 없다 */ }
            done({ ok: false, why: `server error: ${e.message}` });
          });
          return;
        }
        done(out);
      });
      c.on('close', (code) => {
        clients.delete(c);
        hub.emit(CH_LINK, 'viewer', { action: 'close', code, viewers: clients.size });
      });
      c.on('error', () => clients.delete(c));
    },
  });

  // 어떤 일은 **상태**를 바꾼다. 이벤트만 보내면 화면은 그 일이 있었다는 줄은
  // 찍으면서 정작 "지금 어떤가" 는 낡은 채로 둔다.
  //
  // 실제로 그렇게 걸렸다. MSX 가 질문을 던지면 ask/question 이벤트는 가는데
  // 스냅샷은 접속할 때와 명령 뒤에만 가서, 답변 입력칸이 영영 안 열렸다.
  // 로그에는 질문이 보이는데 답할 수가 없는 화면이었다.
  //
  // 화면 쪽에서 이벤트를 보고 상태를 고쳐 잡게 할 수도 있지만, 그러면 참이
  // 두 군데에 있게 된다. 서버가 하나만 들고 있고 바뀔 때 알린다.
  const CHANGES_STATE = (ev) =>
    ev.ch === 'ask' || ev.ev === 'job_start' || ev.ev === 'job_end'
    || ev.ev === 'spool_open';

  hub.subscribe((ev) => {
    const msg = { type: 'ev', ...ev };
    for (const c of clients) c.send(msg);
    if (CHANGES_STATE(ev)) {
      const s = snapshot(deps);
      for (const c of clients) c.send(s);
    }
  });

  // 실제로 듣기 시작할 때까지 기다린다. listen() 은 비동기라, 바로 돌아가면
  // address() 가 null 이다 - 포트 0(아무거나)을 줬을 때 어디에 떴는지 말할
  // 수도 없다.
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => { srv.removeListener('error', reject); resolve(); });
  });
  const bound = srv.address().port;

  return {
    server: srv,
    port: bound,

    /**
     * PSG 레지스터 한 틱을 브라우저로 넘긴다 (초당 50 번).
     *
     * **허브를 타지 않는다.** 허브는 사람이 읽을 것을 모으는 곳이고 채널마다
     * 스크롤백이 있다. 초당 50 개를 거기 부으면 정작 중요한 한 줄이 밀려
     * 나가고, 로그 창은 쓸 수 없게 된다. 이것은 읽을 것이 아니라 흐름이라
     * 따로 간다.
     *
     * 바이너리로 보낸다 - 18 바이트가 JSON 으로 가면 100 바이트가 넘고,
     * 초당 50 번이면 브라우저가 그만큼 파싱해야 한다. 앞의 한 바이트는
     * 무슨 흐름인지 알리는 표식이다. 나중에 다른 흐름이 생겨도 같은 소켓을
     * 쓸 수 있다.
     */
    psg(payload) {
      if (!clients.size) return;            // 아무도 안 듣는다
      const msg = Buffer.allocUnsafe(1 + payload.length);
      msg[0] = PSG_FRAME;
      payload.copy(msg, 1);
      for (const c of clients) c.send(msg);
    },

    /**
     * MSX 가 지금 틀기 시작한 말, 16 비트 PCM 으로. [0x56][rate:4][pcm...]
     *
     * **PSG 원음으로는 이것을 들려줄 수 없다.** 그 흐름은 레지스터를 초당
     * 50 번 찍은 것이고, 음성은 볼륨을 초당 만 번 바꾼다 - 200 개 중 하나만
     * 보는 셈이라 두두둑이 된다. 그래서 호스트가 카트리지에 보낸 바이트를
     * 그대로 풀어서 따로 보낸다.
     *
     * 화면이 모니터를 꺼 두었어도 보낸다. 브라우저는 이것을 보고 그 길이만큼
     * PSG 원음을 입 다물게 해야 하기 때문이다 - 안 그러면 말하는 동안 두두둑이
     * 계속 난다. 127.0.0.1 로 초당 20 KB 라 아낄 것이 없다.
     */
    voice(pcm, rate) {
      if (!clients.size) return;
      const msg = Buffer.allocUnsafe(5 + pcm.byteLength);
      msg[0] = VOICE_MONITOR;
      msg.writeUInt32LE(rate >>> 0, 1);
      Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(msg, 5);
      for (const c of clients) c.send(msg);
    },

    /** 말이 도중에 그쳤다 - 모니터도 그치고, PSG 원음을 풀어 준다. [0x57] */
    voiceStop() {
      if (!clients.size) return;
      const msg = Buffer.from([VOICE_MONITOR_STOP]);
      for (const c of clients) c.send(msg);
    },

    url: `http://${host}:${bound}/`,
    /** 링크가 붙거나 끊겼다 - 화면의 "지금 어떤가" 를 새로 그리게 한다. */
    refresh: () => { const s = snapshot(deps); for (const c of clients) c.send(s); },
    close: () => {
      // 임시 폴더를 남기지 않는다. 다 올려 놓고 넣지 않은 묶음이 있을 수 있다.
      staging.cleanup();
      docs.cleanup();
      for (const c of clients) c.close(1001, 'server going away');
      srv.close();
    },
  };
}
