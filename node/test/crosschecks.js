// SPDX-License-Identifier: GPL-2.0-only
//
// crosschecks.js — 파이썬 정답표와 Node 가 같은 바이트를 내는지, 있는 곳에서만.
//
// 호스트는 파이썬(src/host/)에서 Node 로 옮겨 왔고, 파이썬 판은 **교차검증의
// 정답표**로 남았다. test/*_crosscheck.py 들이 같은 입력을 양쪽에 먹여 바이트를
// 비교한다. 그 정답표는 개발 트리에만 있다 - 공개 트리(msx-picodock)는 Node 만
// 싣고 파이썬은 없다. 그래서 여기서 갈린다:
//
//   src/host/ 가 있다   -> 전부 돌린다. 하나라도 틀리면 실패. python3 이 없으면
//                          그것도 실패 - 정답표가 있는데 안 본 것은 통과가 아니다
//   src/host/ 가 없다   -> 건너뛰었다고 말하고 통과
//
// 목록은 package.json 에 있던 순서 그대로다.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(HERE, '..', '..', 'src', 'host', 'fat16.py');

const CHECKS = [
  'crosscheck.py', 'disk_crosscheck.py', 'askshape_crosscheck.py', 'voice_crosscheck.py',
  'print_crosscheck.py', 'ask_crosscheck.py', 'psg_crosscheck.py', 'hold_interop.py',
  'normalize_crosscheck.py', 'tree_crosscheck.py', 'name_crosscheck.py', 'text_crosscheck.py',
  'printer_crosscheck.py', 'escp_crosscheck.py', 'native_crosscheck.py', 'hangul_crosscheck.py',
  'kanji_crosscheck.py',
];

if (!fs.existsSync(REFERENCE) || !fs.existsSync(path.join(HERE, CHECKS[0]))) {
  console.log('[*] cross-checks skipped: the Python reference (src/host/) is not in this tree');
  process.exit(0);
}

for (const name of CHECKS) {
  const r = spawnSync('python3', [path.join(HERE, name)], { stdio: 'inherit', cwd: path.dirname(HERE) });
  if (r.error) {
    console.log(`[-] ${name}: could not run python3 (${r.error.code ?? r.error.message})`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.log(`[-] ${name} failed`);
    process.exit(r.status ?? 1);
  }
}
