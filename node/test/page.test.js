// page.test.js — 페이지가 브라우저에 닿기 전에 잡을 수 있는 것.
//
// 인라인 스크립트에 오타가 하나 있으면 브라우저는 **빈 화면**을 보여 준다.
// 콘솔을 열기 전까지는 서버가 죽은 것과 구별되지 않는다. 그래서 문법만은
// 여기서 확인한다 - 돌려 보는 것과는 다르지만, 제일 흔한 실패를 공짜로 막는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', 'web', 'index.html'), 'utf8');

test('인라인 스크립트가 문법에 맞다', () => {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length, '스크립트가 있어야 한다');
  for (const src of scripts)
    assert.doesNotThrow(() => new vm.Script(src), '문법 오류');
});

test('화면에 쓰이는 글이 영문이다', () => {
  // 이 저장소의 정한 바다. 절반만 번역된 화면은 어느 한쪽 언어보다 나쁘다.
  // 주석(<!-- -->)과 스크립트 안의 주석은 한글이어도 된다 - 화면에 안 나온다.
  let body = HTML.replace(/<!--[\s\S]*?-->/g, '')
                 .replace(/<script>[\s\S]*?<\/script>/g, '')
                 .replace(/<style>[\s\S]*?<\/style>/g, '');
  const hangul = body.match(/[가-힣]+/g);
  assert.equal(hangul, null, `화면에 한글이 있다: ${hangul && hangul.slice(0, 5)}`);
});

test('화면에 보이는 문자열에도 한글이 없다', () => {
  // 스크립트 안의 WORDS 표는 화면에 그대로 나간다. 주석만 걸러내고 본다.
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hangul = code.match(/[가-힣]+/g);
    assert.equal(hangul, null, `스크립트의 문자열에 한글이 있다: ${hangul && hangul.slice(0, 5)}`);
  }
});

test('바깥에서 받아오는 것이 없다', () => {
  // 인터넷 없는 기계에서도 떠야 한다. 뜨는 데 다운로드가 필요한 화면은
  // 정작 필요할 때 안 뜬다.
  assert.equal(HTML.match(/https?:\/\/(?!127\.0\.0\.1)/g), null,
               '바깥 주소를 가리키고 있다');
  assert.equal(/<script[^>]+src=/.test(HTML), false, '바깥 스크립트를 부른다');
  assert.equal(/<link[^>]+stylesheet/.test(HTML), false, '바깥 스타일시트를 부른다');
});

test('최상위 함수 이름이 겹치지 않는다', () => {
  // 자바스크립트는 스크립트 최상위에서 같은 이름의 function 선언이 겹쳐도
  // 오류를 내지 않는다 - 그냥 마지막이 이긴다. 그래서 `draw(s)` 와 `draw()`
  // 가 나란히 살아 있었고, 상태 메시지가 올 때마다 엉뚱한 함수가 불려서
  // 화면이 영영 "connecting" 에 멈췄다. 문법 검사로는 안 잡힌다.
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const names = [...code.matchAll(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual([...new Set(dup)], [], `이름이 겹치는 함수: ${[...new Set(dup)]}`);
  }
});

test('localStorage 접근이 전부 try 안에 있다', () => {
  // 사이트 데이터가 막혀 있거나 시크릿 창이면 접근 자체가 던진다. 읽기 하나를
  // 안 감쌌다가 스크립트가 통째로 죽은 적이 있다 - 쓰기만 감싸 두었었다.
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    for (const m of src.matchAll(/localStorage\.\w+\(/g)) {
      // 같은 줄이나 바로 앞 두 줄 안에 try 가 있어야 한다.
      const upto = src.slice(0, m.index);
      const near = upto.split('\n').slice(-3).join('\n');
      assert.ok(/\btry\b/.test(near),
                `감싸지 않은 localStorage 접근: ...${src.slice(m.index - 40, m.index + 30)}`);
    }
  }
});

test('$("...") 로 찾는 id 가 전부 마크업에 있다', () => {
  // 앞의 검사보다 넓다. 리스너를 안 걸어도 `$("x").textContent` 는 null 접근으로
  // 그 자리에서 죽고, 그 자리가 확인 대화 같은 곳이면 **되돌릴 수 없는 일을
  // 하려는 순간에** 죽는다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const ids = new Set([...HTML.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const refs = new Set([...src.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
  assert.ok(refs.size > 10, '이 패턴이 충분히 있어야 검사가 의미 있다');
  for (const r of refs)
    assert.ok(ids.has(r), `$("${r}") 를 쓰는데 id="${r}" 이 마크업에 없다`);
});

test('리스너를 거는 id 가 마크업에 실제로 있다', () => {
  // `$("x").addEventListener(...)` 에서 x 가 없으면 null 에 접근해 **스크립트
  // 전체가 그 자리에서 멎는다.** 증상은 빈 화면이고, 서버가 죽은 것과 구별되지
  // 않는다 - 이 파일이 존재하는 바로 그 이유다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const ids = new Set([...HTML.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const refs = [...src.matchAll(/\$\("([\w-]+)"\)\s*\.\s*addEventListener/g)].map((m) => m[1]);
  assert.ok(refs.length, '이 패턴이 하나는 있어야 검사가 의미 있다');
  for (const r of refs)
    assert.ok(ids.has(r), `$("${r}") 에 리스너를 거는데 id="${r}" 이 마크업에 없다`);
});

test('편집기는 고쳤는지를 textarea 를 거친 값으로 판단한다', () => {
  // textarea 의 value 는 CRLF 를 LF 로 정규화한다 (HTML 규격의 "API value").
  // 서버가 준 글을 그대로 "원본" 으로 들고 있으면 CRLF 파일은 **열자마자**
  // 고쳐진 것으로 보이고, 닫을 때마다 "저장 안 했다" 가 뜬다. 실제로 그랬다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const m = src.match(/edWas\s*=\s*([^;]+);/g) || [];
  assert.ok(m.length, 'edWas 를 정하는 곳이 있어야 한다');
  const fromPayload = m.filter((line) => /edWas\s*=\s*r\.text/.test(line));
  assert.equal(fromPayload.length, 0,
    'edWas 를 서버 응답에서 바로 가져오면 CRLF 파일이 늘 "고쳐짐" 으로 보인다: '
    + fromPayload.join(' '));
});

test('확인 대화의 버튼에 그 버튼이 하는 일이 적힌다', () => {
  // 지우기 대화를 재사용하면서 "고친 것을 버리시겠습니까" 에 Delete 가
  // 붙어 있었다 - 파일을 지우는 것으로 읽힌다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.match(src, /askConfirm\(title, lines, note, go, label/,
               'askConfirm 이 버튼 이름을 받아야 한다');
  assert.match(src, /"Discard"/, '고친 것을 버리는 쪽은 Discard 여야 한다');
});

test('인쇄하지 않는 버튼에 Print 라고 쓰지 않는다', () => {
  // `doc_print` 는 맥의 Preview 를 열 뿐이다 (printdoc.js 의 openForPrint -
  // 일부러 그렇다: 프린터·부수·범위를 시스템 대화상자에서 고르게 한다).
  // 그런데 버튼에 "Print…" 라고 적혀 있으면 눌러도 안 나오니 한 번 더 누르게
  // 되고, 두 번째에 종이가 나간다. 사용자가 그대로 겪었다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const m = src.match(/\$\("([\w-]+)"\)\.addEventListener\("click",[^)]*\)[\s\S]{0,200}?cmd:\s*"doc_print"/);
  assert.ok(m, 'doc_print 를 보내는 버튼이 있어야 한다');
  const btn = HTML.match(new RegExp(`<button[^>]*id="${m[1]}"[^>]*>([\\s\\S]*?)</button>`));
  assert.ok(btn, `${m[1]} 버튼이 마크업에 있어야 한다`);
  const label = btn[1].replace(/&[a-z]+;/g, '').trim();
  assert.match(label, /preview/i, `열기만 하는 버튼이므로 Preview 라고 해야 한다: ${label}`);
  assert.doesNotMatch(label, /^print/i, `인쇄하지 않는데 Print 로 시작한다: ${label}`);
});

test('스풀 작업을 프린터로 보낼 버튼이 화면에 있다', () => {
  // **이게 없어서 "버튼이나 뭐 그런게 없어" 가 나왔다.** 자동 전송과 CLI
  // 말고는 길이 없었다. 기능을 서버에만 넣고 화면에 두지 않으면 없는 것이다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  // 곧바로 보내지 않는다 - 모달을 거치므로 핸들러가 길다. 그래도 그 버튼의
  // 클릭에서 print_jobs 까지 한 줄기로 이어져 있어야 한다.
  const m = src.match(/\$\("([\w-]+)"\)\.addEventListener\("click",[\s\S]{0,900}?cmd:\s*"print_jobs"/);
  assert.ok(m, 'print_jobs 를 보내는 버튼이 있어야 한다');
  const btn = HTML.match(new RegExp(`<button[^>]*id="${m[1]}"[^>]*>`));
  assert.ok(btn, `${m[1]} 이 마크업에 button 이어야 한다`);
  // 눌리려면 프린터를 고를 수 있어야 한다. 고르는 자리가 자동 스위치에
  // 묶여 있으면 한 장만 보내려는 사람은 고를 수가 없다.
  assert.doesNotMatch(HTML, /<select id="direct-to"[^>]*\bdisabled\b/,
                      '프린터 고르기는 마크업에서 잠겨 있으면 안 된다');
  // 그리고 **쓰던 스위치는 그대로 있어야 한다.** 한 번 지웠다가 "사라짐" 을
  // 들었다. 새 버튼을 놓는 일과 있던 것을 치우는 일은 다르다.
  assert.match(HTML, /id="direct-on"[\s\S]{0,40}Print straight through/,
               '자동 전송 스위치가 그 이름 그대로 있어야 한다');
});

test('드롭다운이 보여 주는 프린터를 서버도 알고 있다', () => {
  // 드롭다운은 첫 항목을 고른 것처럼 보여 주지만, 서버의 target 은 비어
  // 있었다. 화면에 프린터 이름이 떠 있는데 버튼은 회색인, 설명할 수 없는
  // 상태다 - "한 파일 선택했는데, 버튼이 비활성화임" 이 그것이다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.match(src, /!d\.target[\s\S]{0,200}?cmd:\s*"direct",\s*to:\s*sel\.value/,
               '고른 적이 없으면 보이는 것을 서버에 알려야 한다');
  // 그리고 마크업에 빈 항목이 없어야 한다 - 있으면 보이는 것이 프린터가
  // 아니라 빈칸이므로 알릴 것도 없다.
  assert.doesNotMatch(HTML, /<select id="direct-to"[^>]*>\s*<option/,
                      '항목은 서버 목록으로만 채운다');
});

test('보내기 버튼이 어느 프린터로 가는지 스스로 말한다', () => {
  // 프린터 드롭다운은 윗줄, 보내기 버튼은 아랫줄이라 눈으로는 이어져 보이지
  // 않는다. 하나뿐인 선택을 둘이 나눠 쓰는데, 화면이 그걸 안 말해 준다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const uses = [...src.matchAll(/btn\.title\s*=[\s\S]{0,400}?;/g)].map((m) => m[0]);
  assert.equal(uses.length, 1, `보내기 버튼의 title 은 하나여야 한다: ${uses.length}`);
  assert.match(uses[0], /directLabel/,
               `title 이 고른 프린터 이름을 말해야 한다: ${uses[0].slice(0, 80)}`);
  // 고른 것이 없을 때는 어디서 고르는지 일러 준다.
  assert.match(src, /Choose a printer in the bar above/);
});

test('프린터로 보내기 전에 묻는다', () => {
  // 종이는 되돌릴 수 없고, 이 버튼은 체크한 것을 한꺼번에 내보낸다. 잘못
  // 누르면 여러 장이 한 번에 나간다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const h = src.match(/\$\("print-now"\)\.addEventListener\("click",[\s\S]*?\n  \}\);/);
  assert.ok(h, 'print-now 의 클릭 핸들러를 찾지 못했다');
  // **`askConfirm(` 이 있는지만 보면 모자란다** - 그 앞에 몰래 보내는 줄을
  // 넣어도 통과한다. 보내는 곳이 묻는 곳 **뒤**에 있어야 한다.
  const ask = h[0].indexOf('askConfirm(');
  const sends = [...h[0].matchAll(/cmd:\s*"print_jobs"/g)].map((m) => m.index);
  assert.ok(ask > -1, '묻지 않고 보내면 안 된다');
  assert.ok(sends.length, 'print_jobs 를 보내는 곳이 있어야 한다');
  for (const at of sends)
    assert.ok(at > ask, '보내는 것은 묻고 난 뒤여야 한다');
  // 무엇이 어느 프린터로 가는지 보여 주고 나서 누르게 한다.
  assert.match(h[0], /directLabel/, '어느 프린터인지 적혀야 한다');
  assert.match(h[0], /seqs\.map/, '보낼 작업들이 적혀야 한다');
  // 확인 버튼이 빨강이면 "없어진다" 로 읽힌다 - 인쇄는 지우는 일이 아니다.
  assert.match(h[0], /"go"\)/, '확인 버튼은 지우기 색이 아니어야 한다');
  assert.match(src, /askConfirm\(title, lines, note, go, label = "Delete", kind = "danger"\)/,
               'askConfirm 이 버튼 성격을 받아야 한다');
});

test('미리보기 줄에는 저장만 있다', () => {
  // 보내기는 윗줄 한 군데로 모았다. 같은 일을 하는 버튼이 두 자리에 있으면
  // 어느 것이 무엇을 보내는지(보고 있는 한 장? 체크한 것들?) 헷갈린다.
  const bar = HTML.match(/<div class="paperbar">([\s\S]*?)<\/div>\s*<div class="log"/)[1];
  assert.doesNotMatch(bar, /print_jobs|print-this/,
                      '미리보기 줄에 보내기 버튼이 있으면 안 된다');
  for (const id of ['save-txt', 'save-png', 'save-prn'])
    assert.ok(bar.includes(id), `${id} 은 남아 있어야 한다`);
});

test('프린터로 보내기는 문서 설정과 섞여 있지 않다', () => {
  // Font 와 one page 는 문서에만 걸린다. 프린터 버튼이 그 사이에 끼면
  // 인쇄에도 걸리는 줄 읽힌다 - 그래서 왼쪽에 떨어뜨려 둔다.
  const bar = HTML.match(/<div class="logbar" id="docbar">([\s\S]*?)<\/div>/)[1];
  const at = (id) => bar.indexOf(id);
  assert.ok(at('print-now') > -1, '보내기 버튼이 이 줄에 있어야 한다');
  assert.ok(at('print-now') < at('doc-style'),
            '보내기 버튼은 Font 보다 앞이어야 한다');
  assert.ok(at('print-now') < at('doc-stack'),
            '보내기 버튼은 one page 보다 앞이어야 한다');
  assert.ok(at('doc-make') > at('doc-stack'),
            'Make document 는 제 설정 뒤에 있어야 한다');
});

test('실패는 요약줄이 아니라 제 자리에 띄운다', () => {
  // 실패하면 곧바로 트리를 다시 읽고, 그 그리기가 요약줄을 덮어쓴다. 그래서
  // pending() 에 적은 오류는 깜빡이고 사라진다 - 실제로 그랬다.
  const src = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  // drawTree 와 pending 이 같은 칸을 쓰는 것이 전제다. 그것이 바뀌면 이 시험의
  // 이유도 바뀌므로 같이 확인한다.
  assert.match(src, /function pending\(text\) \{ \$\("files-sum"\)/,
               'pending 이 files-sum 을 쓴다');
  assert.match(src, /\$\("files-sum"\)\.textContent =\s*$/m,
               'drawTree 도 files-sum 을 쓴다 - 그래서 덮어쓴다');
  assert.match(src, /function showErr\(/, 'showErr 이 있어야 한다');

  // **정확히 재야 한다.** 처음에는 `showErr(` 를 세어 "셋 이상" 을 봤는데,
  // 그 정규식은 **함수 정의까지 센다** - 하나를 pending 으로 되돌려도 여전히
  // 셋이라 주입한 버그를 못 잡았다. 세지 않고, **없어야 할 것이 없는지** 본다.
  //
  // 범위는 이미지를 고치는 명령의 답을 다루는 곳으로 좁힌다. 트리 읽기가
  // 실패했을 때는 `pending` 이 맞다 - 읽기 자체가 실패했으니 그것을 덮어쓸
  // 트리 그리기가 없다.
  const a = src.indexOf('if (editWaiting.has(m.id))');
  // 끝은 `filesWaiting` 블록 앞이다. 그 뒤까지 넣으면 트리 읽기의 pending 을
  // 같이 집어 와서, 고칠 것이 없는데 빨간 줄이 뜬다 - 처음에 그랬다.
  const b = src.indexOf('if (filesWaiting.has(m.id))', a);
  assert.ok(a > 0 && b > a, '편집 답을 다루는 곳을 찾아야 한다');
  const editBlock = src.slice(a, b);
  const leaked = [...editBlock.matchAll(/pending\(([^;]*)\)/g)]
    .map((m) => m[1])
    .filter((arg) => /\bm\.why\b/.test(arg));
  assert.deepEqual(leaked, [],
    '실패 이유를 pending 으로 보내면 트리 갱신이 그것을 덮어쓴다: ' + leaked.join(' | '));
  // 그리고 실패 경로가 실제로 showErr 를 쓰고 있어야 한다.
  assert.ok(/showErr\(/.test(editBlock), '편집 실패는 showErr 로 가야 한다');
});

test('화면의 sanitize 가 MSX 의 줄 끝을 글자로 만들지 않는다', () => {
  // MSX 의 줄 끝은 CRLF 다. CR 을 제어문자로 쳐서 점으로 바꾸면 **모든 줄 끝에**
  // `·` 가 붙는다 - 실기에서 "hello msx·" 로 나왔다. 서버의 printer_text.js 에
  // 같은 이름의 함수가 있지만 그쪽은 바이트의 뜻을 지켜야 해서 CR 을 그대로
  // 둔다. 두 구현이 다른 것은 의도이고, **이쪽이 화면용**이다.
  const m = HTML.match(/function sanitize\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '화면의 sanitize 를 찾아야 한다');
  const sanitize = eval(`(${m[0]})`);
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const NUL = String.fromCharCode(0), BEL = String.fromCharCode(7);
  const TAB = String.fromCharCode(9);

  assert.equal(sanitize('hello msx' + CR + LF), 'hello msx' + LF,
               'CRLF 는 줄바꿈 하나다');
  assert.equal(sanitize('a' + CR + LF + 'b'), 'a' + LF + 'b');
  assert.equal(sanitize('old' + CR + 'mac'), 'old' + LF + 'mac',
               '홀로 선 CR 도 줄바꿈이다');
  assert.ok(!sanitize('x' + CR + LF).includes('·'),
            '줄 끝에 점이 남으면 안 된다');

  // 그러면서 진짜 제어문자는 여전히 보여야 한다. 안 보이면 이상한 바이트가
  // 왔다는 것을 알 길이 없다.
  assert.equal(sanitize('x' + NUL + 'y' + BEL), 'x·y·');
  assert.equal(sanitize('tab' + TAB + 'here'), 'tab' + TAB + 'here', '탭은 탭이다');
});

test('$("...") 로 찾는 id 가 전부 마크업에 있다', () => {
  // **빈 화면으로 나타나는 실패다.** $("v-rate") 가 없으면 null 이 돌아오고
  // 다음 줄이 던지고, 그리기가 통째로 멈춘다. 콘솔을 열기 전까지는 서버가
  // 죽은 것과 구별되지 않는다 - 이 파일이 있는 이유와 같은 종류다.
  const ids = new Set([...HTML.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const used = new Set([...HTML.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !ids.has(u));
  assert.deepEqual(missing, [], `마크업에 없는 id: ${missing.join(', ')}`);
});

test('창 목록과 마크업이 서로 맞는다', () => {
  // 목록에만 있으면 버튼을 눌러도 빈 곳이 나오고, 마크업에만 있으면 영영
  // 닿을 수 없다. 둘 다 조용한 실패라 눈으로는 안 잡힌다.
  // **끝까지 잡는 문자 묶음이라야 한다.** [a-z]+ 로 두면 "voiceX" 에서
  // "voice" 까지만 잡고 멈춰서, 창 이름을 잘못 바꿔도 시험이 통과한다.
  const listed = [...HTML.matchAll(/\{\s*id:\s*"([\w-]+)",\s*name:/g)].map((m) => m[1]);
  const panes = [...HTML.matchAll(/data-view="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed.slice().sort(), [...new Set(panes)].sort());
  assert.ok(listed.includes('voice'), 'Voice 창이 목록에 없다');

  // 단축키가 겹치면 하나는 영영 안 눌린다.
  const keys = [...HTML.matchAll(/key:\s*"(\d)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, `단축키가 겹친다: ${keys.join(',')}`);
});

test('Voice 창이 서버가 보내는 것만 쓴다', () => {
  // 서버 스냅샷에 없는 열쇠를 그리면 영영 undefined 다. 조용하고, 화면에는
  // "—" 만 남는다.
  const body = HTML.slice(HTML.indexOf('function drawVoice'),
                          HTML.indexOf('const press ='));
  for (const k of ['enabled', 'engines', 'measured', 'speaking'])
    assert.ok(body.includes(`v.${k}`), `drawVoice 가 v.${k} 를 안 본다`);
  // **답을 무엇으로 돌려줄지는 Voice 칸에 없다.** PDASK 의 성질이라 Ask 칸으로
  // 옮겼고, 두 칸에 다 있으면 어느 쪽이 참인지 모른다.
  assert.equal(body.includes('v-reply'), false, 'Voice 칸에 reply 가 남아 있다');
});

test('Ask 칸이 답을 무엇으로 돌려줄지 보여준다', () => {
  for (const id of ['ask-rtext', 'ask-rvoice', 'ask-rboth'])
    assert.ok(HTML.includes(`id="${id}"`), `${id} 가 없다`);
  // 그리는 쪽은 ask 스냅샷을 본다. voice 스냅샷을 보면 음성이 없는 서버에서
  // 누가 무엇을 골랐는지 영영 안 보인다.
  assert.ok(/s\.ask\?\.reply/.test(HTML), 'reply 를 ask 에서 안 읽는다');
  // echo 는 답하는 쪽의 하나라 "Answered by" 줄에 있다.
  assert.ok(/\["ask-echo", "echo"\]/.test(HTML), 'echo 가 Answered by 줄에 없다');
  // 누르면 ask 명령이 간다.
  assert.ok(HTML.includes('cmd: "ask_reply"'), 'ask_reply 를 안 보낸다');
});

test('API 키 칸: 폼 밖에 있고, 보내자마자 비우고, 어디에도 적지 않는다', () => {
  for (const [who, mode] of [['claude', 'claude'], ['gemini', 'gemini']]) {
    assert.ok(HTML.includes(`["ask-${who}", "${mode}"]`), `${who} 가 Answered by 줄에 없다`);
    // 템플릿으로 찾는 id 라 위의 id 검사가 못 본다. 여기서 본다.
    for (const part of ['row', 'use', 'forget', 'note'])
      assert.ok(HTML.includes(`id="${who}-${part}"`), `${who}-${part} 가 없다`);
    const tag = HTML.match(new RegExp(`<input id="${who}-key"[^>]*>`));
    assert.ok(tag, `${who}-key 칸이 없다`);
    assert.match(tag[0], /type="password"/);
    assert.match(tag[0], /autocomplete="off"/);
    // 폼을 제출하면 브라우저가 비밀번호로 저장하자고 나선다.
    const at = HTML.indexOf(`id="${who}-key"`);
    const open = HTML.lastIndexOf('<form', at), close = HTML.lastIndexOf('</form>', at);
    assert.ok(open < close || open === -1, `${who}-key 가 <form> 안에 있다`);
  }

  const body = HTML.match(/function useKey\(who\) \{([\s\S]*?)\n  \}/);
  assert.ok(body, 'useKey 가 없다');
  const src = body[1];
  assert.ok(/\$\(`\$\{who\}-key`\)\.value = ""/.test(src), '보낸 뒤 칸을 비우지 않는다');
  for (const bad of ['localStorage', 'sessionStorage', 'note(', 'console.'])
    assert.ok(!src.includes(bad), `키를 다루는 곳에 ${bad} 가 있다`);
  assert.ok(src.includes('cmd: "ask_key", who'), 'ask_key 에 누구의 키인지가 없다');
});

test('모니터: 소켓의 0x56/0x57 을 받고, 꺼져 있어도 PSG 를 입 다물게 한다', () => {
  assert.ok(/b\[0\] === VOICE_MONITOR\)/.test(HTML), '0x56 을 안 받는다');
  assert.ok(/b\[0\] === VOICE_MONITOR_STOP\)/.test(HTML), '0x57 을 안 받는다');
  // **입 다물게 하는 것이 모니터 스위치보다 먼저다.** 스위치가 꺼져 있으면
  // 돌아가기 전에 PSG 를 조용히 해 두지 않으면, 말하는 동안 두두둑이 난다 -
  // 이 기능이 생긴 이유가 그것이다.
  const body = HTML.slice(HTML.indexOf('async function monitorStart'),
                          HTML.indexOf('function monitorStop'));
  const hush = body.indexOf('hushPsg(');
  const bail = body.indexOf('if (!monitorOn) return');
  assert.ok(hush > 0 && bail > 0 && hush < bail, 'PSG 를 조용히 하기 전에 돌아간다');
  // PSG 게인을 만지는 길은 psgGainApply 하나뿐이어야 한다. 슬라이더나 얼음
  // 판정이 따로 만지면, 말하는 도중 볼륨을 움직이는 것만으로 두두둑이 돌아온다.
  const direct = HTML.match(/(?<!m)gain\.gain\.(value|setTargetAtTime)/g) || [];
  assert.ok(direct.length <= 2, `PSG 게인을 직접 만지는 곳이 ${direct.length} 군데다`);
  assert.ok(HTML.includes('id="sw-monitor"'));
});
