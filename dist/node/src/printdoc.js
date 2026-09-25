// SPDX-License-Identifier: GPL-2.0-only
//
// printdoc.js — 인쇄 작업 여러 개를 문서 하나로 묶고, 맥에서 인쇄한다.
//
// **FAT 쪽과 같은 규칙이다: 렌더링을 다시 짜지 않는다.**
// `bin/msx_printer_spool.js merge` 를 따로 띄운다 (2026-09-25 에 파이썬 판에서
// 옮겼다 - 인자와 결과가 같다). 그쪽은 이미 이걸
// 안다 - ESC/P 는 줄 간격·피치·강조·페이지 위치가 **작업 경계를 넘어 살아
// 남으므로**, 두 작업의 바이트를 이어 붙이면 둘째 작업이 첫째의 설정으로
// 조용히 그려진다. 그래서 작업마다 깨끗한 인터프리터로 그린 뒤 **페이지를**
// 합친다. 그 판단을 브라우저에서 되풀이할 이유가 없다.
//
// 스타일 둘:
//   msx  - 프린터 제 글꼴(FX-80/한자 ROM). 찍힌 그대로, 비트이미지까지 산다.
//   host - 번들 TTF 로 글자를 다시 조판. 읽기 좋지만 ESC/P 레이아웃은 잃는다.
//
// 만든 PDF 는 **임시 폴더에 둔다.** 미리보기와 인쇄에만 쓰고, 서버가 내려갈 때
// 치운다 - 출력 폴더에 쌓아 두면 누가 만든 것인지 모를 파일이 늘어난다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '..', 'bin', 'msx_printer_spool.js');

export const STYLES = new Set(['msx', 'host']);

/** 만든 문서들. id -> { dir, pdf, style, seqs, bytes } */
export class Docs {
  constructor() { this.made = new Map(); }

  _open() {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pddoc-'));
    return { id, dir };
  }

  get(id) { return this.made.get(String(id || '')) || null; }

  drop(id) {
    const d = this.made.get(id);
    if (!d) return;
    this.made.delete(id);
    try { fs.rmSync(d.dir, { recursive: true, force: true }); } catch { /* 이미 없다 */ }
  }

  cleanup() { for (const id of [...this.made.keys()]) this.drop(id); }

  /**
   * 고른 작업들을 PDF 하나로.
   *
   * @param {string} spoolStem `.prn`/`.idx` 를 뺀 스풀 경로
   * @param {number[]} seqs 작업 번호들
   * @param {'msx'|'host'} style
   */
  make(spoolStem, seqs, style = 'msx', charset = 'cp437', glyphs = 'msx',
       stack = false) {
    return new Promise((resolve) => {
      if (!spoolStem) return resolve({ ok: false, why: 'nothing is being spooled' });
      if (!seqs.length) return resolve({ ok: false, why: 'no jobs were chosen' });
      if (!STYLES.has(style)) return resolve({ ok: false, why: `unknown style '${style}'` });

      const { id, dir } = this._open();
      const args = [TOOL, 'merge', spoolStem,
                    '-j', seqs.join(','), '-m', 'raster',
                    '--style', style, '--charset', charset,
                    '--glyphs', glyphs, '-o', dir];
      // 쌓기: 작업마다 한 장씩 주는 대신 한 장에 이어 붙인다. 세 줄짜리
      // LPRINT 셋이 종이 석 장이 되는 것을 막는다.
      if (stack) args.push('--stack');
      execFile(process.execPath, args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        const said = `${stdout || ''}${stderr || ''}`.trim();
        if (err) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          return resolve({ ok: false, why: said || `the tool exited with ${err.code}` });
        }
        // 도구는 만든 경로를 찍지만, **찍힌 경로를 믿지 않는다** - 폴더를 직접
        // 본다. 예전에 이 도구가 쓴 파일과 다른 경로를 돌려준 적이 있다
        // (폴백이 타임스탬프를 새로 만들었다).
        const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
        if (!pdfs.length) {
          const left = fs.readdirSync(dir);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          return resolve({ ok: false,
                           why: said || `no PDF came out (found: ${left.join(', ') || 'nothing'})` });
        }
        const pdf = path.join(dir, pdfs[0]);
        const bytes = fs.statSync(pdf).size;
        const doc = { dir, pdf, style, stack, seqs: [...seqs], bytes, text: said };
        this.made.set(id, doc);
        // **`id` 라고 부르지 않는다.** 답은 `{type:'reply', id: 요청번호, ...결과}`
        // 로 합쳐져 나가므로, 결과에 `id` 가 있으면 **요청 번호를 덮어쓴다.**
        // 그러면 기다리던 쪽은 제 답을 영영 못 알아본다 - 실제로 그렇게
        // 멎었다 (2026-09-22).
        resolve({ ok: true, doc: id, style, stack, seqs: doc.seqs, bytes,
                  pages: countPages(pdf) });
      });
    });
  }
}

/**
 * PDF 의 페이지 수.
 *
 * 라이브러리를 더 들이지 않으려고 `/Type /Page` 를 센다. 완벽한 파서는 아니지만
 * 여기 PDF 는 pdfwrite.js 가 만든 한 모양뿐이라 충분하고, 틀려도 화면의 숫자 하나가
 * 틀릴 뿐 인쇄물은 멀쩡하다.
 */
export function countPages(pdf) {
  try {
    const s = fs.readFileSync(pdf, 'latin1');
    const m = s.match(/\/Type\s*\/Page[^s]/g);
    return m ? m.length : null;
  } catch { return null; }
}

/**
 * 맥의 인쇄 대화상자로 보낸다.
 *
 * **바로 인쇄하지 않는다.** `lpr` 는 기본 프린터로 조용히 밀어 넣는데, 그러면
 * 프린터도 부수도 페이지 범위도 고를 수 없고 잘못 누르면 종이가 나간다.
 * 미리보기로 열어 주면 사람이 ⌘P 를 눌러 시스템 대화상자에서 정한다.
 */
export function openForPrint(pdf) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin')
      return resolve({ ok: false, why: 'opening the print dialog is macOS-only here' });
    if (!fs.existsSync(pdf)) return resolve({ ok: false, why: 'that document is gone' });
    execFile('open', ['-a', 'Preview', pdf], (err) => {
      resolve(err ? { ok: false, why: err.message }
                  : { ok: true, text: 'Opened in Preview \u2014 press Cmd-P there to print.' });
    });
  });
}
