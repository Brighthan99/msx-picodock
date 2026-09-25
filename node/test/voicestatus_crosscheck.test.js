// 카트리지가 쓴 상태 프레임을, 호스트의 파서가 정말 같게 읽는가.
//
// 형식은 한 벌인데 구현이 둘이다 - 펌웨어의 `pd_voice_status_frame` 과
// 여기 `VoiceStream.parseStatus`. **둘은 갈라진다.** 이 저장소에서 이미 한 번
// 그랬다: ESC/P 렌더러의 흰 줄 수정이 파이썬 쪽에만 들어가고 Node 포트에는
// 안 들어가서, 한쪽 미리보기에만 줄이 남았다. 크로스체크가 230 중 35 을
// 잡아냈다.
//
// 그래서 여기서는 **진짜 펌웨어 코드를 컴파일해서 돌린다.** 내가 손으로 적은
// 바이트를 내가 만든 파서에 먹이면, 내 오해가 양쪽에 똑같이 들어가 통과한다.

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceStream, ST_ARMED, ST_STARVED, ST_ENDED } from '../src/voicestream.js';

const here = dirname(fileURLToPath(import.meta.url));
const fw = join(here, '..', '..', 'src', 'picoverse-picodock');

function build() {
  const out = join(mkdtempSync(join(tmpdir(), 'pdvoice-')), 'sx');
  execFileSync('cc', [
    `-I${fw}`, '-o', out,
    join(fw, 'tests', 'status_crosscheck.c'),
    join(fw, 'pd_voice_win.c'),
  ], { stdio: 'pipe' });
  return execFileSync(out, { encoding: 'utf8' }).trim().split('\n');
}

// 컴파일러가 없는 곳에서는 건너뛴다 - 그렇다고 통과했다고 말하지는 않는다.
let lines = null;
let why = '';
try {
  if (!existsSync(join(fw, 'pd_voice_win.c'))) throw new Error('펌웨어 소스가 없다');
  lines = build();
} catch (e) {
  why = e.message;
}

test('펌웨어가 쓴 프레임을 호스트가 같게 읽는다', { skip: lines ? false : `cc 없음: ${why}` }, () => {
  assert.ok(lines.length >= 20, `경우가 너무 적다 (${lines.length})`);

  for (const line of lines) {
    const [hex, room, played, flags] = line.split(' ');
    const f = Buffer.from(hex, 'hex');

    // 프레임의 겉: 호스트의 프레이머가 보는 것.
    assert.equal(f.length, 12, line);
    assert.equal(f[0], 0x5A, `SOF: ${line}`);
    assert.equal(f[1], 0x72, `CMD VOICE_STAT: ${line}`);
    assert.equal(f[2] | (f[3] << 8), 7, `payload 길이: ${line}`);
    let chk = 0;
    for (let i = 1; i < 11; i++) chk ^= f[i];
    assert.equal(f[11], chk, `체크섬: ${line}`);

    // 속: 파서가 뜯은 것이 카트리지가 뜻한 것과 같은가.
    const got = VoiceStream.parseStatus(f.subarray(4, 11));
    assert.ok(got, `파서가 거절했다: ${line}`);
    assert.equal(got.room, Number(room), `room: ${line}`);
    assert.equal(got.played, Number(played), `played: ${line}`);
    assert.equal(got.flags, Number(flags), `flags: ${line}`);
  }
});

test('플래그 값이 양쪽에서 같은 자리다', { skip: lines ? false : 'cc 없음' }, () => {
  // 크로스체크가 값은 맞춰 주지만 **이름은 안 맞춰 준다.** ST_ARMED 를 2 로
  // 바꿔 놓아도 위 시험은 다 통과한다 - 숫자만 비교하니까. 그래서 여기서
  // 뜻을 직접 건다: 시작한 경우와 안 한 경우를 골라 이름으로 읽는다.
  const parse = (l) => VoiceStream.parseStatus(Buffer.from(l.split(' ')[0], 'hex').subarray(4, 11));

  const fresh = parse(lines[0]);                       // reset 직후, 시작 안 함
  assert.equal(fresh.flags & ST_ARMED, 0, '시작 안 했는데 armed');
  assert.equal(fresh.flags & ST_STARVED, 0, '읽지도 않았는데 starved');
  assert.equal(fresh.flags & ST_ENDED, 0, '닫지도 않았는데 ended');

  // 마지막 일곱은 플래그를 하나씩 켜 본 것들이다(status_crosscheck.c).
  const tail = lines.slice(-7).map(parse);
  const [none, armed, starved, ended, cleared, closedFull, stopped] = tail;
  assert.equal(none.flags, 0, '아무것도 아닌데 뭔가 켜졌다');
  assert.ok(armed.flags & ST_ARMED, 'CTRL=1 인데 armed 가 아니다');
  assert.ok(starved.flags & ST_STARVED, '빈 링을 읽었는데 starved 가 아니다');
  assert.ok(ended.flags & ST_ENDED, '닫고 비었는데 ended 가 아니다');
  assert.equal(cleared.flags & ST_STARVED, 0, '다시 시작했는데 표가 남았다');
  // **닫았다고 끝난 것이 아니다.** 여기서 ended 가 서면 호스트가 말 끝을
  // 자른다 - 링에 아직 여덟 바이트가 남아 있다.
  assert.equal(closedFull.flags & ST_ENDED, 0, '남은 게 있는데 ended');
  assert.ok(closedFull.room < 4096, '여덟을 넣었는데 링이 비었다고 한다');

  // **MSX 가 손을 뗀 것도 끝이다.** 호스트가 "말 다 했다" 를 아는 길이 이것
  // 하나뿐이라, 이게 빠지면 처음 한 마디를 말한 뒤로 영영 다음 말을 거절한다.
  // 실기에서 정확히 그렇게 됐다.
  assert.ok(stopped.flags & ST_ENDED, 'MSX 가 멈췄는데 아직 말하는 중이라고 한다');
  assert.equal(stopped.flags & ST_ARMED, 0, '멈췄는데 armed 가 남았다');
});
