// SPDX-License-Identifier: GPL-2.0-only
//
// printer.js — MSX 가 찍은 바이트를 하나도 잃지 않고 모은다.
//
// src/host/pd_diskserver.py 의 Printer 와 printer/msx_printer_spool.py 를
// 옮긴 것이다. **렌더링은 안 옮겼다** - 파이썬 쪽 3,035 줄 중 대부분이 한자
// TTF 래스터라이즈와 ESC/P 해석이고, 그것은 골든 이미지와 픽셀 단위로 맞춰야
// 하는 별개의 일이다. 여기는 **잡아 두는 쪽**만 한다. 잃은 바이트는 되돌릴 수
// 없지만 렌더링 결정은 나중에 몇 번이고 다시 할 수 있으니, 순서가 그렇다.
//
// 작업의 끝을 어떻게 아는가: MSX 프린터에는 "다 찍었다" 는 신호가 없다.
// 그래서 **조용한 시간**으로 가른다 - timeout 초 동안 프린터 바이트가 없으면
// 한 작업이 끝난 것으로 본다.
//
// 스풀이 왜 따로 있는가: 조용한 시간으로 파일을 쪼개 쓰면, 오후 내내 한 장씩
// 뱉는 MSX 에게는 Z80 이 멈춘 우연한 순간들로 이름 붙은 조각 더미가 남는다.
// 스풀은 **작업이 끝난 것**과 **파일이 써진 것**을 갈라 놓는다. 바이트는 하나의
// capture 에 이어 붙고, 작업 경계는 파일 분할이 아니라 색인 한 줄로 남는다.
// 그래서 "3번 작업을 텍스트로" 와 "1~7번을 한 PDF 로" 가 나중에도 둘 다 된다.
//
//     spool/msx_print_20260920_143210.prn    모든 바이트, 순서대로
//     spool/msx_print_20260920_143210.idx    작업 하나에 JSON 한 줄
//
//     {"seq":1,"off":0,"len":1284,"t0":1758...,"t1":1758...,"end":"idle"}
//
// 견디는 방식: 색인 줄은 작업이 닫힐 때 쓰고 fsync 한다. 바이트마다 하면 Z80 이
// 호스트의 디스크를 기다리게 된다. 그래서 죽어도 **닫힌** 작업은 하나도 안
// 잃고, 날아가던 작업의 바이트는 색인 없는 꼬리로 .prn 에 남는다. 읽는 쪽은
// 그 꼬리를 무시하지 않고 "unclosed" 인 마지막 작업으로 되살린다.

import fs from 'node:fs';
import path from 'node:path';

import { CH_PRINT } from './hub.js';
import { detect } from './printer_detect.js';
import { decodeMsx } from './printer_text.js';
import { KanjiRenderer } from './kanji.js';
import { savePrintJob } from './printrender.js';

//: --print 가 받는 것. 파이썬 서버와 같다: auto 는 끝난 작업을 보고 글/그림/한자/
//: 한글 가운데 고르고, **날것 .prn 을 늘 같이 남긴다** - 잘못 골라도 잃는 것이 없다.
export const PRINT_MODES = ['off', 'raw', 'auto', 'text', 'pdf', 'raster'];

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 이어 붙이기만 하는 capture 와 작업 색인.
 *
 * 서버 한 번 돌 때 하나. `write` 는 버퍼에 붙이는 것뿐이고, 판까지 닿는 것은
 * `mark` 뿐이다.
 */
export class SpoolWriter {
  constructor(baseName = 'msx_print', dir = 'spool', timestamp = null) {
    fs.mkdirSync(dir, { recursive: true });
    const stem = path.join(dir, `${baseName}_${timestamp || stamp()}`);
    this.prnPath = `${stem}.prn`;
    this.idxPath = `${stem}.idx`;
    this._prn = fs.openSync(this.prnPath, 'a');
    this._idx = fs.openSync(this.idxPath, 'a');
    this._off = fs.fstatSync(this._prn).size;   // 지금 작업이 시작하는 자리
    this._len = 0;
    this._t0 = null;
    this._t1 = null;
    this.seq = 0;
  }

  get openJob() { return this._len > 0; }

  write(data) {
    if (!data || !data.length) return;
    const now = Date.now() / 1000;
    if (this._len === 0) this._t0 = now;
    fs.writeSync(this._prn, data);
    this._len += data.length;
    this._t1 = now;
  }

  /** 지금 작업을 닫는다. 색인 기록을 돌려주고, 빈 작업이면 null. */
  mark(reason = 'idle') {
    if (this._len === 0) return null;
    fs.fsyncSync(this._prn);
    this.seq += 1;
    const rec = {
      seq: this.seq, off: this._off, len: this._len,
      t0: Math.round(this._t0 * 1000) / 1000,
      t1: Math.round(this._t1 * 1000) / 1000,
      end: reason,
    };
    fs.writeSync(this._idx, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this._idx);
    this._off += this._len;
    this._len = 0;
    this._t0 = this._t1 = null;
    return rec;
  }

  close(reason = 'shutdown') {
    try { this.mark(reason); }
    finally {
      for (const fd of [this._prn, this._idx]) {
        try { fs.closeSync(fd); } catch { /* 이미 닫혔다 */ }
      }
    }
  }
}

/** 디스크에 있는 capture 를 작업 목록으로 읽는다. */
export class Spool {
  constructor(p) {
    const stem = /\.(prn|idx)$/.test(p) ? p.slice(0, -4) : p;
    this.stem = stem;
    this.prnPath = `${stem}.prn`;
    this.idxPath = `${stem}.idx`;
    if (!fs.existsSync(this.prnPath))
      throw Object.assign(new Error(`no such capture: ${this.prnPath}`), { code: 'ENOENT' });
  }

  get name() { return path.basename(this.stem); }

  /** 색인 기록들, 그리고 쓰다 만 꼬리가 있으면 그것까지. */
  jobs() {
    const out = [];
    if (fs.existsSync(this.idxPath)) {
      for (const line of fs.readFileSync(this.idxPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); }
        catch {
          // 마지막 줄이 반쯤 써졌다 - fsync 도중에 죽은 것이다. 그 앞은 다
          // 멀쩡하고, 그 줄이 가리키던 바이트는 아래에서 꼬리로 되살아난다.
          break;
        }
      }
    }
    const end = out.reduce((m, j) => Math.max(m, j.off + j.len), 0);
    const size = fs.statSync(this.prnPath).size;
    if (size > end) {
      const mt = fs.statSync(this.prnPath).mtimeMs / 1000;
      out.push({ seq: out.length + 1, off: end, len: size - end,
                 t0: mt, t1: mt, end: 'unclosed' });
    }
    return out;
  }

  /** 작업 하나의 바이트. 기록이나 seq 번호로. */
  read(job) {
    let rec = job;
    if (typeof job === 'number') {
      rec = this.jobs().find((j) => j.seq === job);
      if (!rec) throw new Error(`no job ${job} in ${this.name}`);
    }
    const fd = fs.openSync(this.prnPath, 'r');
    try {
      const buf = Buffer.alloc(rec.len);
      fs.readSync(fd, buf, 0, rec.len, rec.off);
      return buf;
    } finally { fs.closeSync(fd); }
  }
}

/**
 * 프린터 바이트를 작업으로 모은다.
 *
 * 모드: `off` (버린다) · `raw` (작업마다 .prn 파일 하나) · `auto` · `text` ·
 * `pdf` · `raster` - 뒤의 넷은 printrender.js 가 그린다 (파이썬 서버의
 * --print 와 같은 것을 같은 이름으로 같은 폴더에 남긴다).
 */
export class Printer {
  constructor(hub, opts = {}) {
    this.hub = hub;
    this.mode = opts.mode || 'off';        // PRINT_MODES 가운데 하나
    if (!PRINT_MODES.includes(this.mode))
      throw new Error(`unknown print mode '${this.mode}' - have ${PRINT_MODES.join(', ')}`);
    //: 글로 풀 때의 문자 코드, 그림으로 그릴 때의 글리프.
    this.charset = opts.charset || 'cp437';
    this.glyphs = opts.glyphs || null;
    this.timeoutMs = (opts.timeout ?? 2) * 1000;
    this.baseName = opts.baseName || 'msx_print';
    this.outDir = opts.outDir || 'output';
    this.buf = [];
    this.bufLen = 0;
    this.last = null;
    this.spool = null;
    // 한자 폰트 ROM (선택). 있으면 실기가 찍던 16x16 글리프로 그리고, 없으면
    // 브라우저가 제 폰트로 글자를 그린다. ROM 은 재배포 대상이 아니라서
    // 기본값이 없다 - 가진 사람만 --kanji-rom 으로 댄다.
    this.kanjiRom = opts.kanjiRom || null;
    // 작업이 닫힐 때 부를 곳. 직접 출력이 여기에 붙는다. **색인에 줄이 써진
    // 뒤에** 부른다 - 렌더러는 스풀 색인으로 그 작업을 찾으므로, 먼저 부르면
    // "그런 작업 없다" 가 된다.
    this.onJob = opts.onJob || null;
    this.spoolDir = opts.spoolDir || path.join(this.outDir, 'spool');
    if (opts.spool) this.startSpool();
  }

  /**
   * 스풀을 지금 켠다. 이미 켜져 있으면 그대로 둔다.
   *
   * **왜 나중에 켤 수 있어야 하는가**: 직접 출력 스위치가 스풀을 필요로 한다
   * (렌더러가 색인으로 작업을 찾는다). 그것을 명령줄에서만 켤 수 있게 두면,
   * 화면의 스위치를 쓰려고 서버를 내렸다 올려야 한다 - 그건 스위치가 아니다.
   *
   * 지금 열려 있는 작업의 바이트도 같이 옮긴다. 안 그러면 그 작업만 반쪽이
   * 스풀에 들어가서, 나중에 종이로 뽑으면 앞이 잘린 채로 나온다.
   */
  startSpool() {
    if (this.spool) return this.spool;
    this.spool = new SpoolWriter(this.baseName, this.spoolDir);
    if (this.bufLen) this.spool.write(Buffer.concat(this.buf, this.bufLen));
    this.hub.emit(CH_PRINT, 'spool_open',
                  { path: this.spool.prnPath,
                    ...(this.bufLen ? { carried: this.bufLen } : {}) });
    return this.spool;
  }

  /**
   * 스풀만으로도 바이트를 지킬 이유가 된다. 모드가 `off` 여도 capture 는
   * 온전해야 한다 - 형식을 나중에 정하는 것이 스풀의 전부이기 때문이다.
   */
  get enabled() { return this.mode !== 'off' || this.spool !== null; }

  feed(payload) {
    if (!this.enabled) return;             // 펌웨어는 보냈지만 우리가 안 쓴다
    if (!this.bufLen) this.hub.emit(CH_PRINT, 'job_start', { mode: this.mode });
    this.buf.push(Buffer.from(payload));
    this.bufLen += payload.length;
    if (this.spool) this.spool.write(payload);
    this.last = Date.now();
  }

  /** 조용한 시간이 timeout 을 넘겼으면 작업을 닫는다. 주기적으로 부른다. */
  flushIfIdle() {
    if (this.bufLen && this.last && Date.now() - this.last > this.timeoutMs)
      this.flush();
  }

  flush() {
    if (!this.bufLen) return;
    const size = this.bufLen;
    const data = Buffer.concat(this.buf, size);

    if (this.spool) {
      // 경계를 **기록할 뿐 실행하지 않는다.** 렌더링은 나중에 누군가가 할
      // 결정이고, 그게 스풀의 존재 이유다.
      const rec = this.spool.mark('idle');
      // 필드 이름이 `seq` 가 아니라 `job` 인 이유: 허브가 이벤트마다 제
      // `seq` 를 붙인다. 같은 이름을 쓰면 보는 쪽에서 둘을 가릴 수 없고,
      // 실제로 로그에서 작업 번호가 통째로 안 보였다.
      if (rec) {
        this.hub.emit(CH_PRINT, 'spool_job', { job: rec.seq, size });
        // 받는 쪽이 터져도 스풀은 멀쩡해야 한다. 바이트는 이미 판에 있고,
        // 종이로 못 나간 것은 나중에 화면에서 다시 보낼 수 있다.
        if (this.onJob) {
          try { this.onJob(this.spool.prnPath.replace(/\.prn$/, ''), rec.seq); }
          catch { /* 무시 - 아래 job_end 는 나가야 한다 */ }
        }
      }
    }
    if (this.mode === 'raw') {
      fs.mkdirSync(this.outDir, { recursive: true });
      const out = path.join(this.outDir, `${this.baseName}_${stamp()}.prn`);
      fs.writeFileSync(out, data);
      this.hub.emit(CH_PRINT, 'saved', { path: out, size });
    } else if (this.mode !== 'off') {
      // 그리다가 터져도 서버는 살아야 하고, 바이트는 스풀에 이미 있다.
      try {
        const files = savePrintJob(data, this.mode, this.baseName, {
          charset: this.charset, glyphs: this.glyphs, outDir: this.outDir,
          kanjiRom: this.kanjiRom,
          say: (level, text) => this.hub.emit(CH_PRINT, level === '-' ? 'render_failed' : 'render',
                                              { text }),
        });
        if (files.length) this.hub.emit(CH_PRINT, 'saved', { paths: files, size });
      } catch (e) {
        this.hub.emit(CH_PRINT, 'render_failed', { text: e.message });
      }
    }
    this.hub.emit(CH_PRINT, 'job_end', { mode: this.mode, size });
    this.buf = [];
    this.bufLen = 0;
    this.last = null;
  }

  /**
   * 잡아 둔 작업들. 브라우저가 목록을 그리는 데 쓴다.
   *
   * 바이트를 다 보내지 않고 **판별 결과와 크기만** 먼저 준다. 한 작업이
   * 수백 KB 일 수 있고, 목록을 그리려고 그걸 다 보낼 이유는 없다.
   */
  jobs() {
    if (!this.spool) return [];
    let spool;
    try { spool = new Spool(this.spool.prnPath); }
    catch { return []; }               // 아직 아무것도 안 찍었다
    return spool.jobs().map((j) => {
      let head;
      try { head = spool.read({ ...j, len: Math.min(j.len, 4096) }); }
      catch { head = Buffer.alloc(0); }
      // 판별에는 앞부분이면 충분하다 - 방언은 처음 몇 백 바이트에서 드러난다.
      const d = detect(head);
      return { ...j, mode: d.mode, charset: d.charset, why: d.why };
    });
  }

  /**
   * 작업 하나를 글자로. `charset` 이 없으면 판별이 고른 것을 쓴다.
   *
   * `limit` 으로 자른다. 브라우저가 한 화면에 그릴 수 없는 양을 보내 봐야
   * 탭만 멈춘다.
   */
  jobText(seq, { charset = null, limit = 200000 } = {}) {
    if (!this.spool) return null;
    const spool = new Spool(this.spool.prnPath);
    const rec = spool.jobs().find((j) => j.seq === seq);
    if (!rec) return null;
    const data = spool.read({ ...rec, len: Math.min(rec.len, limit) });
    const d = detect(data);
    const cs = charset || d.charset || 'cp437';
    return {
      seq, bytes: rec.len, truncated: rec.len > limit,
      mode: d.mode, why: d.why, charset: cs,
      text: decodeMsx(data, cs),
    };
  }

  /**
   * 한자 작업을 ROM 글리프로 그린다. ROM 이 없으면 null - 그때는 브라우저가
   * 제 폰트로 그린다.
   *
   * **ROM 자체는 브라우저로 보내지 않는다.** 그린 결과만 보낸다 - 폰트 ROM 을
   * 통째로 내보내는 것과 그것으로 그린 한 장을 보여 주는 것은 다른 일이다.
   */
  jobGlyphs(seq) {
    if (!this.kanjiRom || !this.spool) return null;
    const data = this.jobBytes(seq);
    if (!data) return null;
    const r = new KanjiRenderer(this.kanjiRom).feed(data);
    const pages = [];
    for (const p of r.pages) {
      if (p.empty) continue;
      const c = p.crop();
      pages.push({ w: c.width, h: c.height, bits: Buffer.from(c.bits) });
    }
    return { pages, chars: r.chars, missing: r.missing };
  }

  /** 작업 하나의 원시 바이트. 브라우저가 직접 그릴 때 쓴다. */
  jobBytes(seq, limit = 4 * 1024 * 1024) {
    if (!this.spool) return null;
    const spool = new Spool(this.spool.prnPath);
    const rec = spool.jobs().find((j) => j.seq === seq);
    if (!rec) return null;
    return spool.read({ ...rec, len: Math.min(rec.len, limit) });
  }

  /**
   * 끝낸다: 열려 있던 작업을 닫아 색인에 남긴다. 읽는 쪽이 되살려야 하는
   * 꼬리로 남기지 않는다.
   */
  close() {
    if (this.spool) { this.spool.close('shutdown'); this.spool = null; }
  }
}
