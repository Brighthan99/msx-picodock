// SPDX-License-Identifier: GPL-2.0-only
//
// printers.js — 어디로 내보낼지, 그리고 MSX 가 찍는 대로 바로 내보내는 일.
//
// 두 가지가 들어 있다.
//
//   1. **프린터 목록.** 지금은 영수증 프린터(ESC/POS) 둘과 호스트 큐 하나뿐이지만,
//      늘어난다는 전제로 짰다. 새 프린터는 `BUILTIN` 에 한 줄이거나, 서버에
//      `--printers my.json` 으로 대는 JSON 한 덩어리다. **코드를 고치지 않고도
//      늘어날 수 있어야** 한다 - 프린터는 사람마다 다르고, 이 저장소에 없는
//      기종이 기본이다.
//
//   2. **직접 출력.** 켜면 MSX 가 한 작업을 끝낼 때마다 그것이 그대로 종이로
//      나간다. 사람이 화면에서 고르고 누르는 단계가 없다.
//
// 직접 출력이 위험한 이유를 먼저 적는다: **종이는 되돌릴 수 없다.** LPRINT 한
// 줄이 곧 한 장이고, 잘못 켜 두면 시험 삼아 찍은 것까지 전부 나간다. 그래서
//   - 기본은 꺼짐이고,
//   - 켠 **뒤에** 끝난 작업만 나간다 (켜기 전에 쌓여 있던 것은 안 나간다),
//   - 그리고 작업은 언제나 파일로도 남는다. 종이는 증거가 아니다.
//
// 왜 자식 프로세스인가: 렌더링은 파이썬 `msx_printer_escpos.py --spool` 이
// 한다. 여기서 다시 짜면 골든 이미지와 픽셀을 맞춰야 하는 일이 하나 더 는다.
// 그리고 한 장 그리는 데 몇 초가 걸리는데, 그동안 이 프로세스가 막히면 MSX 가
// 섹터를 못 받아 디스크가 죽는다 - ask.js 와 같은 이유로 async 다.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CH_PRINT } from './hub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
//: 영수증 도구. 2026-09-25 에 파이썬 판(src/host/printer/msx_printer_escpos.py)을
//: 옮긴 것이다 - 인자와 찍는 말이 같다. **따로 띄우는 것은 그대로다**: 큰 페이지를
//: 줄이는 동안 서버의 이벤트 루프가 서면 안 된다.
const TOOL = path.resolve(HERE, '..', 'bin', 'msx_printer_escpos.js');
//: 도구를 띄울 node. 이 서버를 돌리는 바로 그것 - PATH 에 무엇이 있든.
const NODE = process.execPath;

//: 한 작업을 그려서 내보내는 데 이 이상 걸리면 포기한다. 한 장 그리는 것은
//: 보통 1~2 초다. 넘어간다면 프린터가 안 받고 있는 것이고, 기다려 봐야 뒤에
//: 쌓인 작업만 늘어난다.
export const PRINT_TIMEOUT_MS = 120000;

//: 줄을 세워 두는 한도. 프린터가 꺼져 있는데 MSX 가 계속 찍으면 줄은 끝없이
//: 는다. 넘치면 **오래된 것부터 버리고 버렸다고 말한다** - 조용히 쌓아 두다
//: 메모리를 먹는 것보다 낫고, 바이트 자체는 스풀에 그대로 있으니 잃는 것은
//: "자동으로 나간다" 는 약속뿐이다.
export const QUEUE_MAX = 32;

/**
 * 내보낼 수 있는 곳 하나.
 *
 *   id     화면과 명령줄에서 고르는 이름
 *   kind   'escpos' 영수증 프린터로 비트이미지
 *          'escp'   진짜 ESC/P 프린터로 **MSX 가 쓴 바이트를 그대로**
 *          'cups'   호스트 큐로 PDF
 *   name   사람이 읽는 이름
 *   width  mm. escpos 에서만. 종이 너비가 아니라 **헤드 너비**를 정한다
 *   dots   헤드의 도트 수. width 로 정해지지만, 흔치 않은 기종은 직접 댄다
 *   queue  cups 에서 쓸 큐 이름. 없으면 기본 프린터
 *   uri    escpos 에서 USB 장치를 직접 댈 때. 없으면 CMD:ESCPOS 를 찾는다
 *   rotate escpos 에서 페이지를 눕힐지. auto(기본) | off(늘 세움) | on(늘 눕힘)
 */
export const BUILTIN = [
  { id: 'escpos58', kind: 'escpos', name: 'ESC/POS receipt printer',
    width: 58, dots: 384 },
  { id: 'escpos80', kind: 'escpos', name: 'ESC/POS receipt printer',
    width: 80, dots: 576 },
  // 진짜 ESC/P 프린터(도트 매트릭스). 맥에 드라이버가 없어도 된다 - 해석은
  // 프린터가 하고 우리는 바이트를 나른다. 그게 제일 정확한 길이기도 하다:
  // 렌더러도, 래스터도, 리샘플링도 거치지 않는다.
  { id: 'escp', kind: 'escp', name: 'ESC/P printer (bytes straight through)' },
  { id: 'cups', kind: 'cups', name: 'Host printer (default queue)' },
];

export const KINDS = new Set(['escpos', 'escp', 'cups']);

//: 페이지를 눕힐지. **눕히면 종이를 훨씬 많이 쓴다** - 816x94 짜리 MSXLOGO
//: 배너가 세우면 0.6cm, 눕히면 10.3cm 다. 그래서 auto 는 세우는 쪽으로 기운다.
//: 자세한 근거는 msx_printer_escpos.py 의 ROTATE_ABOVE 에 있다.
export const ROTATIONS = new Set(['auto', 'off', 'on']);

/** 목록에 보일 한 줄. 영수증 프린터는 너비가 곧 정체성이라 이름에 붙인다. */
export function label(def) {
  if (def.kind === 'escpos')
    return `${def.name} (width: ${def.width}mm, ${def.dots} dots)`;
  if (def.kind === 'escp') return def.uri ? `${def.name} - ${def.uri}` : def.name;
  if (def.kind === 'cups' && def.queue) return `${def.name} - ${def.queue}`;
  return def.name;
}

/**
 * 정의 하나가 쓸 만한지.
 *
 * 돌려주는 것은 **까닭**이다. `false` 하나로는 JSON 을 고쳐 쓸 수 없다 -
 * 사람이 직접 적는 파일이니, 뭐가 틀렸는지 말해 주어야 한다.
 */
export function why(def) {
  if (!def || typeof def !== 'object') return 'not an object';
  if (!def.id || !/^[A-Za-z0-9_-]+$/.test(String(def.id)))
    return 'id must be letters, digits, - or _';
  if (!KINDS.has(def.kind)) return `kind must be one of ${[...KINDS].join(', ')}`;
  if (!def.name) return 'name is missing';
  if (def.kind === 'escpos') {
    const d = Number(def.dots);
    if (!Number.isInteger(d) || d < 64 || d > 4096)
      return 'dots must be a whole number between 64 and 4096';
    if (def.rotate != null && !ROTATIONS.has(def.rotate))
      return `rotate must be one of ${[...ROTATIONS].join(', ')}`;
  }
  return null;
}

/** 고를 수 있는 프린터들. */
export class Printers {
  constructor(defs = BUILTIN) {
    this.byId = new Map();
    for (const d of defs) this.add(d);
  }

  add(def) {
    const bad = why(def);
    if (bad) throw new Error(`printer '${def && def.id}': ${bad}`);
    const d = { ...def };
    if (d.kind === 'escpos' && d.width == null) d.width = null;
    this.byId.set(String(d.id), d);
    return d;
  }

  get(id) { return this.byId.get(String(id || '')) || null; }

  list() {
    return [...this.byId.values()].map((d) => ({ ...d, label: label(d) }));
  }

  /**
   * JSON 파일에서 더 읽어 들인다. 같은 id 면 덮어쓴다 - 기본 정의를 고치는
   * 길이기도 하다(예: 영수증 프린터의 USB 주소를 못 찾을 때 직접 대기).
   *
   * 한 줄이 틀렸다고 나머지를 버리지 않는다. 틀린 것만 말하고 넘어간다.
   */
  load(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const defs = Array.isArray(raw) ? raw : [raw];
    const added = [];
    const bad = [];
    for (const d of defs) {
      try { added.push(this.add(d)); }
      catch (e) { bad.push(e.message); }
    }
    return { added, bad };
  }
}

/**
 * 작업이 끝나는 대로 종이로.
 *
 * `Printer.flush()` 가 작업을 닫으면 여기 `send()` 가 불린다. 줄을 세워 하나씩
 * 처리한다 - 동시에 둘을 그리면 CPU 만 나눠 갖고, 영수증 프린터는 어차피 한
 * 번에 한 줄기만 받는다.
 */
export class Direct {
  /**
   * @param hub 이벤트를 적을 곳
   * @param printers 고를 수 있는 프린터들
   * @param opts.target 켜 둘 프린터 id. null 이면 꺼짐
   * @param opts.outDir 그린 페이지를 남길 곳
   */
  constructor(hub, printers, opts = {}) {
    this.hub = hub;
    this.printers = printers;
    //: **고른 프린터와 자동 전송은 다른 것이다.** 한 값에 묶어 두었더니
    //: 자동을 꺼 놓고는 어디로 보낼지 고를 수조차 없었고, 그래서 화면에
    //: "이 작업을 지금 보내기" 를 놓을 자리가 없었다.
    this.target = opts.target || null;
    this.auto = opts.auto ?? !!opts.target;
    this.outDir = opts.outDir || 'output';
    //: 화면에서 고른 방향. null 이면 프린터 정의(또는 도구의 auto)를 따른다.
    this.rotate = opts.rotate || null;
    this.timeoutMs = opts.timeout ?? PRINT_TIMEOUT_MS;
    this.queue = [];
    this.busy = false;
    this.done = 0;
    this.failed = 0;
    this.dropped = 0;
    this.lastError = null;
    // 테스트에서 갈아끼울 수 있게 밖으로 낸다. 진짜 프린터를 붙여 놓고 돌릴
    // 수 있는 테스트는 없다 - 종이가 나가기 때문이다.
    //
    // 자리가 둘인 이유: `run` 은 내보내는 일 **전체**를 대신하고, `exec` 는
    // 프로세스 하나만 대신한다. `run` 만 있었을 때는 가짜가 제 논리로 답해
    // 버려서 **진짜 명령줄이 틀려도 시험이 통과했다** - 방향이 도구에 안
    // 넘어가는 변이가 그렇게 빠져나갔다 (2026-09-23). `exec` 를 끼우면
    // defaultRun 이 정말로 돌고, 무엇이 실행됐는지 그대로 보인다.
    this._run = opts.run || defaultRun;
    this._exec = opts.exec || execFile;
  }

  /** 자동으로 나가는 중인가. 프린터를 골랐고 자동이 켜져 있어야 한다. */
  get on() { return this.auto && this.target !== null; }

  /** 고른 프린터가 있는가. 손으로 보내려면 이것만 있으면 된다. */
  get ready() { return this.target !== null; }

  /** 화면이 그릴 "지금 어떤가". */
  status() {
    const def = this.target ? this.printers.get(this.target) : null;
    return {
      on: this.on,
      auto: this.auto,
      ready: this.ready && !!def,
      target: this.target,
      label: def ? label(def) : null,
      // 고른 프린터가 목록에서 사라졌을 때(설정 파일이 바뀌었다) 조용히 꺼진
      // 것처럼 보이면 안 된다.
      unknown: this.ready && !def,
      rotate: this.rotate || (def && def.rotate) || 'auto',
      canRotate: !!(def && def.kind === 'escpos'),
      queued: this.queue.length,
      busy: this.busy,
      done: this.done, failed: this.failed, dropped: this.dropped,
      error: this.lastError,
    };
  }

  /**
   * 자동 전송을 켜고 끈다.
   *
   * **끄면 자동으로 줄에 선 것은 버린다.** 껐는데 뒤늦게 석 장이 나오는 것은
   * 끈 것이 아니다. 손으로 보낸 것은 남긴다 - 그건 사람이 대놓고 시킨 것이라
   * 스위치와 상관이 없다.
   */
  setAuto(on) {
    this.auto = !!on;
    if (!this.auto) {
      const had = this.queue.length;
      this.queue = this.queue.filter((j) => j.why === 'manual');
      const dropped = had - this.queue.length;
      this.hub.emit(CH_PRINT, 'direct_off', dropped ? { dropped } : {});
    } else {
      this.hub.emit(CH_PRINT, 'direct_on',
                    { printer: this.target, label: this.target
                      ? label(this.printers.get(this.target) || {}) : null });
    }
    return { ok: true, status: this.status() };
  }

  /**
   * 어디로 보낼지 정한다. `null` 이면 고른 것을 지운다.
   *
   * **지우면 줄에 있던 것도 버린다** - 보낼 곳이 없어졌으니 손으로 시킨
   * 것도 갈 데가 없다.
   */
  /** 페이지를 눕힐지. 잘못된 값이면 거절한다 - 조용히 auto 로 떨어지지 않는다. */
  setRotate(how) {
    if (!ROTATIONS.has(how)) return { ok: false, why: `unknown rotation '${how}'` };
    this.rotate = how;
    this.hub.emit(CH_PRINT, 'direct_rotate', { rotate: how });
    return { ok: true, status: this.status() };
  }

  setTarget(id) {
    if (id === null || id === undefined || id === '' || id === 'off') {
      const had = this.queue.length;
      this.queue = [];
      this.target = null;
      this.auto = false;
      this.hub.emit(CH_PRINT, 'direct_off', had ? { dropped: had } : {});
      return { ok: true, status: this.status() };
    }
    const def = this.printers.get(id);
    if (!def) return { ok: false, why: `no printer '${id}'` };
    this.target = def.id;
    this.lastError = null;
    this.hub.emit(CH_PRINT, 'direct_target', { printer: def.id, label: label(def) });
    return { ok: true, status: this.status() };
  }

  /**
   * 사람이 고른 작업을 **지금** 보낸다. 자동이 꺼져 있어도 간다.
   *
   * 화면에 이것이 없어서 "버튼이나 뭐 그런게 없어" 가 나왔다. 자동 전송은
   * 켜 두고 잊는 것이고, 이것은 한 장을 집어 보내는 것이다 - 다른 일이다.
   */
  sendNow(spoolStem, seqs) {
    if (!this.ready) return { ok: false, why: 'no printer is chosen' };
    const want = (Array.isArray(seqs) ? seqs : [seqs]).filter(Number.isFinite);
    if (!spoolStem || !want.length) return { ok: false, why: 'which job?' };
    // **한 번의 인쇄다.** 여럿이면 도구가 합쳐 한 장으로 낸다 - 줄에 여럿을
    // 세우면 사이마다 용지가 밀려 나가고, 합친 뜻이 없어진다.
    this._queue(spoolStem, want, 'manual');
    return { ok: true, status: this.status() };
  }

  /**
   * 작업 하나를 줄에 세운다. 꺼져 있으면 아무 일도 안 한다.
   *
   * **작업이 닫힌 뒤에 부른다.** 스풀 색인에 줄이 있어야 파이썬 쪽이 그 작업을
   * 찾을 수 있다.
   */
  send(spoolStem, seq) {
    if (!this.on || !spoolStem || !Number.isFinite(seq)) return false;
    this._queue(spoolStem, seq, 'auto');
    return true;
  }

  _queue(spoolStem, seqs, why) {
    const want = Array.isArray(seqs) ? seqs : [seqs];
    if (this.queue.length >= QUEUE_MAX) {
      this.queue.shift();
      this.dropped += 1;
      this.hub.emit(CH_PRINT, 'direct_dropped',
                    { dropped: this.dropped, why: 'the queue is full' });
    }
    this.queue.push({ stem: spoolStem, seq: want[0], seqs: want, why });
    this._pump();
  }

  _pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift();
    const def = this.target ? this.printers.get(this.target) : null;
    if (!def) return;                      // 그 사이에 껐다
    this.busy = true;
    const t0 = Date.now();
    this.hub.emit(CH_PRINT, 'direct_start',
                  { job: (job.seqs && job.seqs.length > 1 ? job.seqs.join(',') : job.seq), printer: def.id });
    // **`Promise.resolve().then()` 으로 감싸는 이유**: `_run` 이 약속을 돌려주지
    // 않고 그 자리에서 던지면 - 오타 하나면 그렇게 된다 - 그 예외는 아래
    // `.catch` 를 지나쳐 `send()` 밖으로 새고, `printer.js` 가 그것을 삼킨다.
    // 그러면 `busy` 가 참인 채로 남아 **줄이 영영 얼어붙고, 아무 말도 안 나온다.**
    // 실제로 그렇게 멎었다 (2026-09-23).
    Promise.resolve().then(() => this._run(job, def, this))
      .then(() => {
        this.done += 1;
        this.lastError = null;
        this.hub.emit(CH_PRINT, 'direct_done',
                      { job: (job.seqs && job.seqs.length > 1 ? job.seqs.join(',') : job.seq),
                        printer: def.id, ms: Date.now() - t0 });
      })
      .catch((e) => {
        this.failed += 1;
        this.lastError = e.message;
        // **줄은 계속 돈다.** 한 장이 실패했다고 뒤의 것까지 멈추면, 종이가
        // 걸렸다 빠진 뒤에도 아무것도 안 나온다.
        this.hub.emit(CH_PRINT, 'direct_failed',
                      { job: (job.seqs && job.seqs.length > 1 ? job.seqs.join(',') : job.seq),
                        printer: def.id, why: e.message });
      })
      .finally(() => { this.busy = false; this._pump(); });
  }
}

/**
 * 파이썬 도구에 줄 명령줄.
 *
 * **따로 꺼내 둔 이유**: 이것이 틀리면 화면에서 고른 것이 종이에 안 닿는데,
 * 가짜 실행기로는 그걸 못 본다 - 가짜가 제 논리로 답해 버린다. 실제로
 * "방향이 도구에 안 넘어간다" 는 변이가 시험을 그대로 통과했다 (2026-09-23).
 * 여기 있으면 만들어진 인자를 그대로 볼 수 있다.
 */
export function escposArgs(job, def, direct, keep) {
  return [TOOL, '--spool', job.stem, '-j', jobList(job), '--keep', keep,
          '--dots', String(def.dots),
          // 화면에서 고른 것이 먼저, 그 다음이 정의, 마지막이 도구의 auto.
          '--rotate', direct.rotate || def.rotate || 'auto',
          '--usb', def.uri || 'auto'];
}

/**
 * 영수증 바이트를 만들 프린터인가.
 *
 * 영수증 프린터만 그렇다. cups 는 제 드라이버가 있고 그린 페이지를 받으며,
 * escp 는 MSX 의 바이트를 그대로 받는다 - 둘 다 래스터를 만들 이유가 없다.
 * 갈림길을 여기 두는 이유는 `escposArgs` 와 같다: 이 판단이 뒤집히면 cups
 * 작업이 `--dots undefined` 를 달고 영수증 쪽으로 가서, 아무도 못 읽는 말로
 * 실패한다.
 */
export const usesEscpos = (def) => !!def && def.kind === 'escpos';

/**
 * 진짜 ESC/P 프린터로 갈 때의 인자. 그릴 것이 없으므로 `--keep` 도 없다 -
 * 남는 사본은 스풀의 `.prn` 그 자체다.
 */
export function escpArgs(job, def, direct) {
  return [TOOL, '--spool', job.stem, '-j', jobList(job), '--raw',
          ...(def.private ? ['--keep-private'] : []),
          '--usb', def.uri || 'auto'];
}

/** 파이썬 도구를 부른다. 한 작업 -> 그린 페이지(남는다) -> 프린터. */
function defaultRun(job, def, direct) {
  const keep = path.join(direct.outDir, 'direct');
  // cups: 그린 페이지를 큐로. 영수증 바이트를 만들 이유가 없다.
  if (def.kind === 'cups') return cupsRun(job, def, keep, direct);
  const args = def.kind === 'escp' ? escpArgs(job, def, direct)
                                   : escposArgs(job, def, direct, keep);
  return new Promise((resolve, reject) => {
    direct._exec(NODE, args, { timeout: direct.timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const said = `${stdout || ''}${stderr || ''}`.trim();
        if (err) {
          return reject(new Error(err.killed
            ? `it took longer than ${Math.round(direct.timeoutMs / 1000)}s`
            : (lastComplaint(said) || `the tool exited with ${err.code}`)));
        }
        resolve(said);
      });
  });
}

/** 호스트 큐로 갈 때 도구에 줄 인자. 영수증 바이트는 만들지 않는다. */
export function cupsArgs(job, keep) {
  return [TOOL, '--spool', job.stem, '-j', jobList(job),
          '--keep', keep, '-o', '/dev/null'];
}

/**
 * 한 번의 인쇄가 다룰 작업 번호들. 하나면 "3", 여럿이면 "3,5,7".
 *
 * **여럿은 합쳐서 한 장으로 나간다.** 도구가 그림을 쌓아 하나로 만든다 -
 * 바이트를 이어 붙이지 않는다. ESC/P 는 줄 간격·피치가 작업 경계를 넘어
 * 살아남아서, 이어 붙이면 둘째가 첫째의 설정으로 그려진다.
 */
export function jobList(job) {
  return (job.seqs || [job.seq]).join(',');
}

/** 호스트 큐로. 페이지를 그려 놓고 `lp` 로 민다. */
function cupsRun(job, def, keep, direct) {
  const args = cupsArgs(job, keep);
  return new Promise((resolve, reject) => {
    direct._exec(NODE, args, { timeout: direct.timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const said = `${stdout || ''}${stderr || ''}`.trim();
        if (err) return reject(new Error(lastComplaint(said)
                                         || `the tool exited with ${err.code}`));
        // 도구가 남긴 페이지 경로를 읽는다. 폴더를 훑지 않는 이유: 같은 폴더에
        // 다른 작업의 페이지가 쌓여 있고, 그중 무엇이 이번 것인지는 도구만 안다.
        const pages = String(stdout || '').split('\n')
          .filter((l) => l.startsWith('[+] kept '))
          .map((l) => l.slice(9).trim());
        if (!pages.length) return reject(new Error('the renderer drew no pages'));
        const lpArgs = def.queue ? ['-d', def.queue, ...pages] : pages;
        direct._exec('lp', lpArgs, { timeout: direct.timeoutMs }, (e2, o2, s2) => {
          if (e2) return reject(new Error(lastComplaint(`${o2 || ''}${s2 || ''}`)
                                          || e2.message));
          resolve(String(o2 || '').trim());
        });
      });
  });
}

/**
 * 도구가 한 말 중 **탓**에 해당하는 줄.
 *
 * `[-]` 로 시작하는 줄이 그것이다. 없으면 마지막 줄. 전체를 그대로 화면에
 * 올리면 `[+]` 진행 줄에 묻혀 정작 까닭이 안 보인다.
 */
export function lastComplaint(said) {
  const lines = String(said || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => l.startsWith('[-]'));
  if (bad.length) return bad[bad.length - 1].slice(3).trim();
  return lines.length ? lines[lines.length - 1] : '';
}
