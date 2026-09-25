// SPDX-License-Identifier: GPL-2.0-only
//
// voice.js — 글 -> 말 -> MSX 의 PSG 가 낼 수 있는 바이트.
//
// src/host/pd_voice.py 를 옮겼다 (2026-09-25). 사용자가 파이썬을 깔지 않아도
// 되게 하려고. 바이트가 파이썬과 같은지는 test/voice_crosscheck.py 가 본다.
//
// MSX 에는 DAC 가 없다. 있는 것은 PSG 인데, 톤 주기를 0 으로 두면 발진이 멈추고
// **볼륨 레지스터가 곧 출력 레벨**이 된다 - 4 비트 DAC 셋. 세 채널을 더하면 808
// 가지 레벨이 된다. 이 요령은 우리 것이 아니다; 1984 년의 MSX 게임이 그렇게
// 말했다. 호스트는 말을 합성하고, 파형을 Z80 이 칩에 부어 넣을 볼륨 번호의 줄로
// 바꾼다. 비싼 일은 전부 여기서 하고, MSX 는 바이트만 옮긴다.
//
// 합성기도 우리 것이 아니고, 그것이 요점이다:
//
//     say        macOS 에 들어 있다. 요즘 macOS 에서는 신경망이고 가장 좋다
//     sapi       Windows 에 들어 있는 목소리 (SAPI, Windows PowerShell 의 System.Speech)
//     espeak-ng  어디에나. 포먼트 합성기, 141 개 언어. 로봇 같지만 알아듣는다
//     piper      신경망, 어디에나. 목소리마다 모델 파일이 필요하다
//
// sapi 는 Node 판에만 있다 (2026-09-25). Windows 에서 돌려 보니 엔진이 하나도
// 없었다 - say 는 맥 것이고, eSpeak NG 는 깔아도 설치기가 PATH 에 넣지 않는다.
// Windows 에는 목소리가 이미 있으니 그것을 쓴다. 파이썬 정답표에는 없다.
//
// **숫자가 파이썬과 같아야 한다.** 곡선 값은 파이썬이 계산한 double 을 그대로
// 적었고 (pow 가 마지막 비트에서 다를 수 있다), round(x, 6) 은 파이썬의 규칙
// (정확히 반이면 짝수 쪽)을 따른다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

//: MSX 에서의 재생 속도. 볼륨 레지스터 셋을 쓰면서 Z80 이 따라갈 수 있는 값.
export const PSG_RATE = 11025;

//: 볼륨 한 칸이 0..1 진폭으로 얼마인가. **모든 것이 기대는 숫자다.** 칩이 둘
//: (AY-3-8910, YM2149)이라 후보도 여럿이다. 값은 pd_voice.py 가 계산한 그대로.
export const CURVES = {
  ay: [0.0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369, 0.1691, 0.2647,
       0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0],
  ym: [0.0, 0.0078125, 0.011048543456039806, 0.015625, 0.02209708691207961, 0.03125,
       0.04419417382415922, 0.0625, 0.08838834764831845, 0.125, 0.1767766952966369, 0.25,
       0.3535533905932738, 0.5, 0.7071067811865476, 1.0],
  db15: [0.0, 0.08912509381337455, 0.10592537251772889, 0.12589254117941673,
         0.14962356560944334, 0.1778279410038923, 0.21134890398366465, 0.251188643150958,
         0.29853826189179594, 0.35481338923357547, 0.4216965034285822, 0.5011872336272722,
         0.5956621435290105, 0.7079457843841379, 0.8413951416451951, 1.0],
};

//: **"ay" 다.** 순음 시험(PDVOICE /S1 /S2 /S3)에서 "셋 다 나쁘지 않은데 S3 로"
//: 를 듣고 db15 로 바꿨더니 말이 알아들을 수 없게 높아졌다. 순음은 이것을 가릴
//: 수 없다 - 말의 코덱을 시험하는 것은 말이다.
export const DEFAULT_CURVE = 'ay';

function vol(curve) {
  const v = CURVES[curve || DEFAULT_CURVE];
  if (!v) throw new Error(`unknown curve '${curve}' - have ${Object.keys(CURVES).join(', ')}`);
  return v;
}

/**
 * 파이썬의 round(x, 6). 정확한 십진 전개에서 7 번째 자리를 보고, 정확히 반이면
 * 짝수 쪽으로 간다. toFixed 는 반을 위로 올린다 - ym 곡선의 2^-7 = 0.0078125 가
 * 정확히 그 반이라, 그대로 두면 표가 달라진다.
 */
export function pyRound6(x) {
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100);          // 이 크기의 double 이면 정확하다
  const [ip, fp] = s.split('.');
  let n = BigInt(ip + fp.slice(0, 6));
  const rest = fp.slice(6);
  if (rest[0] > '5' || (rest[0] === '5' && /[1-9]/.test(rest.slice(1)))) n += 1n;
  else if (rest[0] === '5' && n % 2n === 1n) n += 1n;
  const v = Number.parseFloat(`${n}e-6`);
  return neg ? -v : v;
}

const levelCache = new Map();

/**
 * 세 채널 볼륨의 서로 다른 합 전부와 그것을 만드는 한 가지 방법. 레벨 순.
 * 같은 레벨을 여러 방법으로 만들 수 있으면 처음 찾은 것을 쓴다.
 */
export function psgLevels(curve = DEFAULT_CURVE) {
  const key = curve || DEFAULT_CURVE;
  if (levelCache.has(key)) return levelCache.get(key);
  const V = vol(key);
  const best = new Map();
  for (let a = 0; a < 16; a++)
    for (let b = 0; b < 16; b++)
      for (let c = 0; c < 16; c++) {
        const k = pyRound6(V[a] + V[b] + V[c]);
        if (!best.has(k)) best.set(k, [a, b, c]);
      }
  const levels = [...best.keys()].sort((x, y) => x - y);
  const got = { levels, combos: levels.map((k) => best.get(k)) };
  levelCache.set(key, got);
  return got;
}

// ------------------------------------------------------------------ 합성기

/** PATH 에서 찾는다 (shutil.which). */
export function which(cmd) {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* 다음 */ }
    }
  }
  return null;
}

/**
 * PATH 에 없을 때 Windows 에서 볼 자리. 설치기가 PATH 를 건드리지 않는 것들이다.
 * `env` 는 process.env 모양 - 시험이 제 것을 넣을 수 있게 받는다.
 */
export function windowsCandidates(name, env = process.env) {
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  if (name === 'espeak-ng') return pf.map((d) => path.win32.join(d, 'eSpeak NG', 'espeak-ng.exe'));
  if (name === 'powershell' && env.SystemRoot)
    return [path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  return [];
}

//: 엔진 이름 -> 실제로 부를 프로그램. sapi 는 Windows PowerShell 을 부른다 -
//: **pwsh (PowerShell 7) 가 아니다.** System.Speech 는 .NET Framework 에만 있다.
const PROGRAM = { sapi: 'powershell' };

/** 엔진을 부를 실행 파일의 경로, 없으면 null. */
export function exe(name) {
  if (name === 'sapi' && process.platform !== 'win32') return null;
  const prog = PROGRAM[name] || name;
  const hit = which(prog);
  if (hit || process.platform !== 'win32') return hit;
  for (const p of windowsCandidates(prog)) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 다음 */ }
  }
  return null;
}

function run(cmd, args, { timeout = 20000, input = null, encoding = 'utf8', env = null } = {}) {
  return new Promise((resolve) => {
    const ch = execFile(cmd, args, { timeout, maxBuffer: 8 << 20, encoding,
                                     ...(env ? { env: { ...process.env, ...env } } : {}) },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    if (input !== null) ch.stdin.end(input);
    else ch.stdin?.end();
  });
}

/**
 * `say -v ?` 의 출력 -> [[이름, 로캘]]. 이름에 공백과 괄호가 들 수 있고 로캘이
 * 다음 칸이라, **오른쪽에서** 공백 덩어리 하나로 가른다.
 */
export function parseSayVoices(out) {
  const got = [];
  for (const line of String(out).split(/\r\n|\r|\n/)) {
    const head = line.split('#')[0].replace(/\s+$/, '');
    const m = head.match(/^([\s\S]*?)\s+(\S+)$/);
    if (m && m[2].includes('_')) got.push([m[1].trim(), m[2]]);
  }
  return got;
}

let sayCache = null;
/** macOS 의 목소리들. `say` 가 없으면 빈 목록. */
export async function sayVoices() {
  if (sayCache) return sayCache;
  const r = await run('say', ['-v', '?']);
  if (r.err && !r.stdout) return [];
  sayCache = parseSayVoices(r.stdout);
  return sayCache;
}

//: 아무도 고르지 않았을 때 쓸 macOS 목소리. **순서가 뜻이고 알파벳 순이 아니다.**
//: 알파벳 순일 때는 영어 기본이 Albert 였는데, 기본 주파수가 280 Hz 인 장난감
//: 목소리다. 이 채널은 폭이 5 kHz 이고 잡음이 35 dB 아래 깔려 있어서, 낮은
//: 목소리가 칩이 가장 잘 풀어내는 자리에 앉는다.
//:
//:     Reed 116 Hz   Daniel 118   Grandpa 106   Eddy 132   Fred 128   Albert 281
export const SAY_PREFERRED = ['Reed', 'Daniel', 'Grandpa', 'Eddy', 'Fred'];

/**
 * `say` 에게 줄 목소리의 온 이름, 아니면 null (say 가 고르게).
 *
 * **맨 이름은 모호하다.** 영어 `Eddy` 도 `Eddy (한국어(대한민국))` 도 있고,
 * `say -v Eddy` 는 영어 것을 골라 한국어를 0.02 초짜리 무음으로 읽는다. 그래서
 * 먼저 **물은 언어 안에서** 찾는다.
 */
export function resolveSayVoice(voices, voice, lang) {
  if (!voices.length) return voice;
  const want = (lang || 'en').split('-')[0].toLowerCase();
  const same = voices.filter(([, loc]) => loc.toLowerCase().startsWith(want));
  if (voice) {
    for (const [n] of same) if (n === voice || n.split(' (')[0] === voice) return n;
    for (const [n] of voices) if (n === voice) return n;
    const names = [...new Set(same.map(([n]) => n.split(' (')[0]))].sort().slice(0, 8);
    throw new Error(`no '${voice}' voice for ${want}. Try: ${names.join(', ')}`);
  }
  for (const pref of SAY_PREFERRED)
    for (const [n] of same) if (n === pref || n.split(' (')[0] === pref) return n;
  return same.length ? same[0][0] : null;
}

//: espeak-ng 의 목소리 변주. `+m1`..`+m7` 남성, `+f1`..`+f5` 여성, 언어 위에 얹는다.
export const ESPEAK_VARIANTS = [...Array.from({ length: 7 }, (_, i) => `+m${i + 1}`),
                                ...Array.from({ length: 5 }, (_, i) => `+f${i + 1}`)];

async function espeakVoices(lang) {
  const r = await run(exe('espeak-ng') || 'espeak-ng', ['--voices']);
  if (r.err && !r.stdout) return [];
  if (lang) return ESPEAK_VARIANTS.map((v) => `${lang}${v}`);
  return String(r.stdout).split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 4).map((f) => [f[1], f[3]]);
}

// --- Windows 의 목소리 (SAPI) ----------------------------------------------
//
// Windows PowerShell 5.1 이 Windows 10/11 에 늘 있고, 그 안의 System.Speech 가
// SAPI 목소리로 WAV 를 쓴다. 스크립트는 -EncodedCommand (UTF-16LE base64) 로
// 넘긴다 - Windows 의 명령줄 따옴표 규칙을 거치지 않게. 말할 글은 환경 변수로
// 넘긴다 - 명령줄과 달리 유니코드가 그대로 가고, `ps` 에도 안 보인다.

// 진행 표시를 끈다: 출력이 파이프일 때 powershell.exe 는 진행 기록을 CLIXML 로
// stderr 에 섞는데, 그러면 실패했을 때 stderr 의 마지막 줄 - 우리가 보여 줄 말 -
// 이 그 XML 이 된다.
const PS_HEAD = "$ErrorActionPreference = 'Stop'\n"
  + "$ProgressPreference = 'SilentlyContinue'\n"
  + '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n'
  + 'Add-Type -AssemblyName System.Speech\n'
  + '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n';

//: 목소리 목록: 한 줄에 이름<TAB>문화권<TAB>성별.
export const SAPI_LIST = PS_HEAD
  + '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {\n'
  + '  $_.VoiceInfo.Name + "`t" + $_.VoiceInfo.Culture.Name + "`t" + $_.VoiceInfo.Gender }\n'
  + '$s.Dispose()\n';

//: 합성: PDVOICE_TEXT 를 PDVOICE_OUT 에 16 비트 모노 22050 Hz WAV 로.
//: 목소리를 안 골랐으면 그 언어의 **남성** 목소리가 먼저다 - say 의 기본이
//: 낮은 목소리인 것과 같은 까닭이다 (SAY_PREFERRED 위의 설명).
export const SAPI_SPEAK = PS_HEAD
  + 'try {\n'
  + '  $all = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })\n'
  + '  if ($env:PDVOICE_VOICE) {\n'
  + '    $v = $all | Where-Object { $_.Name -eq $env:PDVOICE_VOICE } | Select-Object -First 1\n'
  + '    if (-not $v) { [Console]::Error.WriteLine("no Windows voice called \'$($env:PDVOICE_VOICE)\'"); exit 3 }\n'
  + '  } else {\n'
  + "    $v = $all | Where-Object { $_.Culture.Name -like ($env:PDVOICE_LANG + '*') } |\n"
  + "      Sort-Object { if ($_.Gender -eq 'Male') { 0 } else { 1 } } | Select-Object -First 1\n"
  + '    if (-not $v) { [Console]::Error.WriteLine("no Windows voice for \'$($env:PDVOICE_LANG)\' - add the language under Settings > Time & language > Speech"); exit 3 }\n'
  + '  }\n'
  + '  $s.SelectVoice($v.Name)\n'
  + '  $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050,\n'
  + '    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)\n'
  + '  $s.SetOutputToWaveFile($env:PDVOICE_OUT, $f)\n'
  + '  $s.Speak($env:PDVOICE_TEXT)\n'
  + '} finally { $s.Dispose() }\n';

/** PowerShell 에 스크립트를 넘길 인자. */
export function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** SAPI_LIST 의 출력 -> [[이름, 문화권, 성별]]. */
export function parseSapiVoices(out) {
  return String(out).split(/\r\n|\r|\n/).map((l) => l.split('\t'))
    .filter((f) => f.length >= 3 && f[0].trim()).map((f) => [f[0].trim(), f[1].trim(), f[2].trim()]);
}

async function sapiVoices() {
  const r = await run(exe('sapi') || 'powershell', psArgs(SAPI_LIST));
  if (r.err && !r.stdout) return [];
  return parseSapiVoices(r.stdout);
}

//: id -> [명령 짓기, stdin 을 원하는가, 한 줄 설명]. 명령 짓기는 [프로그램, 인자]
//: 또는 [프로그램, 인자, 더할 환경 변수] 를 돌려준다.
export const ENGINES = {
  say: [async (text, out, lang, voice) => {
    const v = resolveSayVoice(await sayVoices(), voice, lang);
    return ['say', [...(v ? ['-v', v] : []), '-o', out, '--data-format=LEI16@22050', text]];
  }, false, 'macOS built-in (best quality, Mac only)'],
  'espeak-ng': [async (text, out, lang, voice) => {
    // 맨 변주(`+f3`)는 "이 언어의 그 목소리", 온 이름(`ko+f3`)은 그대로.
    let v = voice || lang;
    if (v.startsWith('+')) v = `${lang}${v}`;
    return [exe('espeak-ng') || 'espeak-ng', ['-v', v, '-w', out, text]];
  }, false, 'formant, 141 languages, 26MB'],
  sapi: [async (text, out, lang, voice) => [exe('sapi') || 'powershell', psArgs(SAPI_SPEAK),
    { PDVOICE_TEXT: text, PDVOICE_OUT: out, PDVOICE_LANG: (lang || 'en').split('-')[0], PDVOICE_VOICE: voice || '' }],
  false, 'Windows built-in voices (Windows only)'],
  piper: [async (text, out, lang, voice) => ['piper', ['--model', voice || '', '--output_file', out]],
          true, 'neural, needs a model per voice'],
};

//: auto 가 시도하는 순서. 품질 순이고, say 는 차이가 크다. say 는 맥에만, sapi 는
//: Windows 에만 있으니 둘의 앞뒤는 뜻이 없다 - 어느 쪽이든 espeak-ng 보다 낫다.
export const AUTO_ORDER = ['say', 'sapi', 'espeak-ng', 'piper'];

/** 실제로 깔린 엔진들. */
export function available() { return AUTO_ORDER.filter((n) => exe(n)); }

//: 엔진이 하나도 없을 때 할 말.
export const NONE_FOUND = 'no speech engine found. On a Mac `say` is built in, and on Windows '
  + 'its own voices are (they need Windows PowerShell); elsewhere: apt install espeak-ng '
  + '(or brew install espeak-ng)';

/** auto 를 풀거나, 이름 댄 엔진이 있는지 본다. */
export function pick(engine = 'auto') {
  if (engine === 'auto') {
    const got = available();
    if (!got.length) throw new Error(NONE_FOUND);
    return got[0];
  }
  if (!ENGINES[engine]) throw new Error(`unknown engine '${engine}' - try ${Object.keys(ENGINES).join(', ')}`);
  if (!exe(engine))
    throw new Error(engine === 'sapi' ? "'sapi' is Windows only" : `'${engine}' is not installed`);
  return engine;
}

/** `--voice` 가 받을 것들: [[이름, 설명]]. piper 의 목소리는 물을 수 없다. */
export async function voicesFor(engine, lang = 'en') {
  const name = pick(engine);
  if (name === 'say') {
    const want = (lang || 'en').split('-')[0].toLowerCase();
    const got = (await sayVoices()).filter(([, loc]) => loc.toLowerCase().startsWith(want))
      .map(([n, loc]) => [n.split(' (')[0], loc]);
    // **잰 것들이 먼저, 잰 순서대로.** 영어 목소리 마흔 개는 대부분 장난감이다.
    const rank = new Map(SAY_PREFERRED.map((v, i) => [v, i]));
    got.sort((a, b) => ((rank.get(a[0]) ?? rank.size) - (rank.get(b[0]) ?? rank.size))
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const seen = new Set();
    const out = [];
    for (const [n, loc] of got) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push([n, rank.has(n) ? `${loc} · low, carries best here` : loc]);
    }
    return out;
  }
  if (name === 'espeak-ng')
    return (await espeakVoices(lang || 'en')).map((v) => [v, v.includes('+m') ? 'male' : 'female']);
  if (name === 'sapi') return sapiFor(await sapiVoices(), lang);
  return [];
}

/** SAPI 목소리 중 `lang` 의 것, 남성이 먼저 (합성이 기본으로 고르는 순서와 같다). */
export function sapiFor(voices, lang = 'en') {
  const want = (lang || 'en').split('-')[0].toLowerCase();
  return voices.filter(([, culture]) => culture.toLowerCase().startsWith(want))
    .sort((a, b) => (a[2] === 'Male' ? 0 : 1) - (b[2] === 'Male' ? 0 : 1))
    .map(([n, culture, gender]) => [n, `${culture} · ${gender.toLowerCase()}`]);
}

/** `text` 를 말한다. [샘플 -1..1, 속도]. 엔진은 WAV 를 쓰고 우리가 도로 읽는다. */
export async function synthesise(text, { engine = 'auto', lang = 'en', voice = null } = {}) {
  const name = pick(engine);
  const [build, stdin] = ENGINES[name];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdvoice-'));
  const out = path.join(dir, 'say.wav');
  try {
    const [cmd, args, env] = await build(text, out, lang, voice);
    const r = await run(cmd, args, { timeout: 120000, input: stdin ? text : null, encoding: 'buffer', env });
    let size = 0;
    try { size = fs.statSync(out).size; } catch { /* 안 만들었다 */ }
    if (r.err || !size) {
      const why = Buffer.from(r.stderr || '').toString('utf8').trim().split('\n');
      throw new Error(`${name}: ${why.length && why[why.length - 1] ? why[why.length - 1] : 'produced nothing'}`);
    }
    return readWav(fs.readFileSync(out), out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 16 비트 WAV -> [샘플 -1..1, 속도]. 스테레오는 섞는다. */
export function readWav(buf, name = 'wav') {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE')
    throw new Error(`${name}: not a WAV file`);
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') { data = body; break; }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${name}: no fmt or data chunk`);
  const ch = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const width = fmt.readUInt16LE(14) / 8;
  if (width !== 2) throw new Error(`${name}: expected 16-bit, got ${width * 8}-bit`);
  const frames = Math.floor(data.length / (ch * width));
  const out = new Array(frames);
  for (let i = 0; i < frames; i++) {
    if (ch === 1) { out[i] = data.readInt16LE(i * 2) / 32768.0; continue; }
    let s = 0;
    for (let k = 0; k < ch; k++) s += data.readInt16LE((i * ch + k) * 2);
    out[i] = (s / ch) / 32768.0;
  }
  return [out, rate];
}

// ------------------------------------------------------------------ PSG 로

//: 앨리어싱 필터의 탭 수. 31 이면 63 dB 아래이고, 그 너머는 8 비트 DAC 보다 좋아
//: 사는 것이 없다.
export const RESAMPLE_TAPS = 31;

/**
 * 속도를 바꾼다. **걸러 내고 나서.** 가장 가까운 샘플만 고르면 새 나이퀴스트
 * 위의 것이 전부 접혀 들어와, 말 위에 쉿 소리가 깔린다 ("멀리서 라디오로 듣는
 * 것 같다").
 */
export function resample(samples, rateIn, rateOut, taps = RESAMPLE_TAPS) {
  const n = samples.length ? Math.trunc(samples.length * rateOut / rateIn) : 0;
  if (n === 0) return [];
  if (rateOut >= rateIn) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = samples[Math.min(Math.trunc(i * rateIn / rateOut), samples.length - 1)];
    return out;
  }
  const fc = 0.45 * rateOut / rateIn;
  const m = Math.floor(taps / 2);
  let h = [];
  for (let k = -m; k <= m; k++) {
    const x = 2 * fc * (k === 0 ? 1.0 : Math.sin(2 * Math.PI * fc * k) / (2 * Math.PI * fc * k));
    h.push(x * (0.5 - 0.5 * Math.cos(2 * Math.PI * (k + m) / (taps - 1))));
  }
  let total = 0;
  for (const x of h) total += x;              // sum(h), 왼쪽부터
  h = h.map((x) => x / total);
  const out = new Array(n);
  const last = samples.length - 1;
  for (let i = 0; i < n; i++) {
    const c = Math.trunc(i * rateIn / rateOut);
    let acc = 0.0;
    for (let k = -m; k <= m; k++) {
      const j = c + k;
      if (j >= 0 && j <= last) acc += samples[j] * h[k + m];
    }
    out[i] = acc;
  }
  return out;
}

export const AGC_WINDOW_MS = 25.0;
export const AGC_FLOOR = 0.05;
export const AGC_CEILING = 0.94;

/**
 * 창마다 크기를 고른다 - 전화기가 하는 일. 말은 봉우리가 짧고 나머지가 한참
 * 아래라, 봉우리에 맞추면 평균이 1/5 에 머문다. 이웃 창 사이로 이득을 미끄러뜨려
 * 창 경계에서 딸깍거리지 않게 한다.
 */
export function agc(samples, rate, winMs = AGC_WINDOW_MS, floor = AGC_FLOOR, ceil = AGC_CEILING) {
  const n = Math.max(1, Math.trunc(rate * winMs / 1000.0));
  const peaks = [];
  for (let i = 0; i < samples.length; i += n) {
    let p = 0.0;
    for (let k = i; k < Math.min(i + n, samples.length); k++) p = Math.max(p, Math.abs(samples[k]));
    peaks.push(Math.max(p, floor));
  }
  const out = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const b = Math.floor(i / n);
    const t = (i % n) / n;
    const nxt = peaks[Math.min(b + 1, peaks.length - 1)];
    const p = peaks[b] + (nxt - peaks[b]) * t;
    out[i] = Math.max(-ceil, Math.min(ceil, samples[i] * ceil / p));
  }
  return out;
}

/** to_psg 가 실제로 양자화하는 파형 - 속도를 바꾸고, 키우고, 고른 것. */
export function shapeWave(samples, rateIn, rateOut = PSG_RATE, normalise = true, loud = true) {
  const at = resample(samples, rateIn, rateOut);
  if (!at.length) return [];
  let gain = 1.0;
  if (normalise) {
    let peak = 0;
    for (const s of at) peak = Math.max(peak, Math.abs(s));
    if (peak > 1e-6) gain = 0.98 / peak;
  }
  const scaled = at.map((s) => s * gain);
  // **이득을 준 뒤에.** agc 의 바닥이 무음을 무음으로 지키는데, 키우기 전의 작은
  // 녹음은 전부 그 바닥 아래에 앉아 그대로 나온다.
  return loud ? agc(scaled, rateOut) : scaled;
}

function nearest(sorted, want) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < want) lo = mid + 1; else hi = mid;
  }
  if (lo && Math.abs(sorted[lo - 1] - want) <= Math.abs(sorted[lo] - want)) return lo - 1;
  return lo;
}

/**
 * 파형 -> 샘플마다 바이트 하나 (256 칸 볼륨 표의 번호). 808 가운데 256 을
 * **진폭으로 고르게** 고른다 - 번호로 고르게 고르는 것보다 4 dB 낫다.
 * [데이터, 768 바이트 표 (256 x 채널 A B C)].
 */
export function toPsg(samples, rateIn, { rateOut = PSG_RATE, normalise = true, loud = true,
                                         curve = DEFAULT_CURVE } = {}) {
  const { levels, combos } = psgLevels(curve);
  const lo = levels[0], hi = levels[levels.length - 1];
  const table = Buffer.alloc(768);
  const picked = [];
  let at = 0;
  for (let i = 0; i < 256; i++) {
    const want = lo + (hi - lo) * i / 255.0;
    while (at + 1 < levels.length && Math.abs(levels[at + 1] - want) <= Math.abs(levels[at] - want)) at += 1;
    picked.push(levels[at]);
    table.set(combos[at], i * 3);
  }
  const wave = shapeWave(samples, rateIn, rateOut, normalise, loud);
  const data = Buffer.alloc(wave.length);
  for (let i = 0; i < wave.length; i++) {
    const want = (Math.max(-1.0, Math.min(1.0, wave[i])) * 0.5 + 0.5) * (hi - lo) + lo;
    data[i] = nearest(picked, want);
  }
  return [data, table];
}

/** 줄을 파형으로 되돌린다 - 칩이 실제로 낼 소리. 들어 보고 재는 데 쓴다. */
export function decodePsg(data, table, curve = DEFAULT_CURVE) {
  const V = vol(curve);
  const lo = V[table[0]] + V[table[1]] + V[table[2]];
  const hi = V[table[765]] + V[table[766]] + V[table[767]];
  const span = (hi - lo) || 1.0;
  return Array.from(data, (b) => {
    const lvl = V[table[b * 3]] + V[table[b * 3 + 1]] + V[table[b * 3 + 2]];
    return (lvl - lo) / span * 2 - 1;
  });
}

/** 코드 256 개가 각각 내는 레벨 (-1..1). 브라우저 모니터가 이것으로 푼다. */
export function levels(curve = DEFAULT_CURVE) {
  const [, table] = toPsg([], PSG_RATE, { curve });
  return decodePsg(Buffer.from(Array.from({ length: 256 }, (_, i) => i)), table, curve);
}

/**
 * PSG 가 파형을 얼마나 충실히 냈는가 (dB). **사람 같은가가 아니다.** 기준은
 * 인코드와 같은 shapeWave 를 거친다 - 안 그러면 모양 잡기를 잰다.
 */
export function snr(original, rateIn, played, rateOut = PSG_RATE, normalise = true, loud = true) {
  const n = played.length;
  if (!n) return 0.0;
  let ref = shapeWave(original, rateIn, rateOut, normalise, loud).slice(0, n);
  if (ref.length < n) ref = ref.concat(new Array(n - ref.length).fill(0.0));
  let p = 0, e = 0;
  for (let i = 0; i < n; i++) { p += ref[i] * ref[i]; e += (ref[i] - played[i]) ** 2; }
  return 10 * Math.log10((p || 1e-12) / (e || 1e-12));
}

/** 들어 볼 WAV. 봉우리를 0.95 로 맞춘 16 비트 모노. */
export function wavBytes(samples, rate) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  peak = peak || 1.0;
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(Math.trunc(Math.max(-1.0, Math.min(1.0, s / peak * 0.95)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
