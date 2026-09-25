// SPDX-License-Identifier: GPL-2.0-only
//
// voice_windows.test.js — Windows 의 목소리 (sapi) 와 PATH 밖의 eSpeak NG.
//
// 이 맥에는 Windows PowerShell 이 없어서 합성 자체는 여기서 돌릴 수 없다. 그래서
// **명령을 짓는 쪽**을 못 박는다: PowerShell 에 넘길 스크립트가 온전히 도착하는가
// (-EncodedCommand 는 UTF-16LE base64 다), 글과 목소리가 환경 변수로 가는가,
// 목소리 목록을 제대로 읽는가, 어디서 프로그램을 찾는가. 실제로 소리가 나는지는
// Windows 에서 `node bin/pd_voice.js --list` 와 PDVOICE 로 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as V from '../src/voice.js';
import { ENGINES as SHOWN } from '../src/voices.js';

test('sapi 는 auto 에서 espeak-ng 보다 앞이다', () => {
  assert.ok(V.AUTO_ORDER.includes('sapi'));
  assert.ok(V.AUTO_ORDER.indexOf('sapi') < V.AUTO_ORDER.indexOf('espeak-ng'));
});

test('화면의 엔진 목록과 실제 엔진이 같은 이름이다', () => {
  assert.deepEqual(Object.keys(SHOWN).filter((k) => k !== 'auto').sort(), Object.keys(V.ENGINES).sort());
});

test('PowerShell 에는 스크립트가 UTF-16LE base64 로 온전히 간다', () => {
  const args = V.psArgs(V.SAPI_SPEAK);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.equal(Buffer.from(args[5], 'base64').toString('utf16le'), V.SAPI_SPEAK);
  assert.match(args[5], /^[A-Za-z0-9+/=]+$/, '명령줄 따옴표 규칙을 탈 글자가 없다');
});

test('합성 스크립트: 16 비트 모노 WAV, 환경 변수로 받는다, 진행 표시는 끈다', () => {
  for (const want of ['SetOutputToWaveFile($env:PDVOICE_OUT', 'Speak($env:PDVOICE_TEXT)',
                      '$env:PDVOICE_VOICE', '$env:PDVOICE_LANG', 'AudioBitsPerSample]::Sixteen',
                      'AudioChannel]::Mono', "$ProgressPreference = 'SilentlyContinue'"])
    assert.ok(V.SAPI_SPEAK.includes(want), want);
});

test('sapi 명령: 글은 명령줄이 아니라 환경 변수로, 언어는 앞부분만', async () => {
  const text = '안녕하세요 "quoted" & <tags> 100%';
  const [prog, args, env] = await V.ENGINES.sapi[0](text, 'C:\\tmp\\say.wav', 'ko-KR', null);
  assert.match(prog, /powershell/i);
  assert.ok(!args.some((a) => a.includes('안녕')), '글이 명령줄에 없다');
  assert.deepEqual(env, { PDVOICE_TEXT: text, PDVOICE_OUT: 'C:\\tmp\\say.wav', PDVOICE_LANG: 'ko', PDVOICE_VOICE: '' });
  const named = (await V.ENGINES.sapi[0]('hi', 'o.wav', 'en', 'Microsoft Zira Desktop'))[2];
  assert.equal(named.PDVOICE_VOICE, 'Microsoft Zira Desktop');
});

test('목소리 목록: 이름, 문화권, 성별 - CRLF 도 읽는다', () => {
  const out = 'Microsoft David Desktop\ten-US\tMale\r\nMicrosoft Zira Desktop\ten-US\tFemale\r\n'
    + 'Microsoft Heami Desktop\tko-KR\tFemale\r\n\r\n';
  const got = V.parseSapiVoices(out);
  assert.deepEqual(got, [['Microsoft David Desktop', 'en-US', 'Male'],
                         ['Microsoft Zira Desktop', 'en-US', 'Female'],
                         ['Microsoft Heami Desktop', 'ko-KR', 'Female']]);
  assert.deepEqual(V.sapiFor(got, 'ko'), [['Microsoft Heami Desktop', 'ko-KR · female']]);
  assert.deepEqual(V.sapiFor(got, 'ja'), []);
  // 합성이 기본으로 고르는 것과 같은 순서: 남성 먼저.
  const en = V.sapiFor([got[1], got[0]], 'en');
  assert.equal(en[0][0], 'Microsoft David Desktop');
});

test('PATH 밖의 자리: eSpeak NG 는 Program Files, PowerShell 은 System32', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
                SystemRoot: 'C:\\Windows' };
  assert.deepEqual(V.windowsCandidates('espeak-ng', env),
    ['C:\\Program Files\\eSpeak NG\\espeak-ng.exe', 'C:\\Program Files (x86)\\eSpeak NG\\espeak-ng.exe']);
  assert.deepEqual(V.windowsCandidates('powershell', env),
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  assert.deepEqual(V.windowsCandidates('piper', env), []);
});

test('Windows 가 아니면 sapi 는 없다고 말한다', { skip: process.platform === 'win32' }, () => {
  assert.equal(V.exe('sapi'), null);
  assert.throws(() => V.pick('sapi'), /Windows only/);
  assert.ok(!V.available().includes('sapi'));
});

test('엔진이 없을 때의 말에 Windows 도 있다', () => {
  assert.match(V.NONE_FOUND, /Windows/);
});
