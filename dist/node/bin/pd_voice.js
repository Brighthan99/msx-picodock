#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// pd_voice.js — 글 -> 말 -> MSX 의 PSG 가 낼 수 있는 바이트. src/host/pd_voice.py 의
// Node 판이고 사용법도 같다. 하는 일은 ../src/voice.js 에 있다.
//
//   node bin/pd_voice.js --list
//   node bin/pd_voice.js "안녕하세요" --lang ko -o voice.psg
//   node bin/pd_voice.js "hello" --engine espeak-ng --wav hear.wav

import fs from 'node:fs';
import * as V from '../src/voice.js';

const HELP = `usage: pd_voice [text] [--engine say|espeak-ng|piper|auto] [--lang en]
                [--voice NAME] [--curve ${Object.keys(V.CURVES).sort().join('|')}] [--no-loud]
                [--no-normalise] [--rate HZ] [-o OUT|-] [--table FILE] [--wav FILE]
                [--voices [--porcelain]] [--levels] [--list]

text -> speech -> what the MSX's PSG can play.`;

function parse(argv) {
  const a = { engine: 'auto', lang: 'en', voice: null, curve: V.DEFAULT_CURVE, loud: true,
              normalise: true, rate: V.PSG_RATE, out: null, table: null, wav: null,
              porcelain: false, voices: false, list: false, levels: false, text: null };
  const val = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') { console.log(HELP); process.exit(0); }
    else if (k === '--engine') { a.engine = val(i); i++; }
    else if (k === '--lang') { a.lang = val(i); i++; }
    else if (k === '--voice') { a.voice = val(i); i++; }
    else if (k === '--curve') {
      a.curve = val(i); i++;
      if (!V.CURVES[a.curve]) throw new Error(`argument --curve: invalid choice: '${a.curve}'`);
    }
    else if (k === '--no-loud') a.loud = false;
    else if (k === '--no-normalise') a.normalise = false;
    else if (k === '--rate') { a.rate = Number.parseInt(val(i), 10); i++; }
    else if (k === '-o' || k === '--out') { a.out = val(i); i++; }
    else if (k === '--table') { a.table = val(i); i++; }
    else if (k === '--wav') { a.wav = val(i); i++; }
    else if (k === '--porcelain') a.porcelain = true;
    else if (k === '--voices') a.voices = true;
    else if (k === '--list') a.list = true;
    else if (k === '--levels') a.levels = true;
    else if (a.text === null) a.text = k;
    else throw new Error(`unrecognized arguments: ${k}`);
  }
  return a;
}

async function list() {
  const got = V.available();
  console.log('speech engines:');
  for (const [name, [, , what]] of Object.entries(V.ENGINES))
    console.log(`  ${name.padEnd(10)} ${what}${got.includes(name) ? '  <- installed' : ''}`);
  if (got.length) {
    console.log(`\nauto picks: ${got[0]}`);
    for (const eng of got)
      for (const lang of ['en', 'ko', 'ja']) {
        const vs = await V.voicesFor(eng, lang);
        if (vs.length)
          console.log(`  ${eng} / ${lang}: ${vs.slice(0, 10).map(([n]) => n).join(', ')}${vs.length > 10 ? ' ...' : ''}`);
      }
  } else {
    console.log('\nnone installed. On a Mac `say` is built in, on Windows its own voices');
    console.log('are (through Windows PowerShell); elsewhere:');
    console.log('  apt install espeak-ng   /   brew install espeak-ng');
  }
  const { levels } = V.psgLevels();
  console.log(`\nPSG: ${levels.length} distinct levels from three channels, `
    + `${V.PSG_RATE} Hz playback, ${(V.PSG_RATE / 1024).toFixed(1)} KB a second`);
  return 0;
}

async function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(`${HELP}\npd_voice: error: ${e.message}`); return 2; }
  if (a.list) return list();
  if (a.levels) {
    for (const v of V.levels(a.curve)) console.log(v.toFixed(6));
    return 0;
  }
  if (a.voices) {
    let vs;
    try { vs = await V.voicesFor(a.engine, a.lang); } catch (e) { console.log(`[-] ${e.message}`); return 1; }
    // **stdout 에 다른 것은 없다.** 머리글 한 줄이 서버의 드롭다운 항목이 된다.
    if (a.porcelain) { for (const [n, note] of vs) console.log(`${n}\t${note}`); return 0; }
    if (!vs.length) {
      console.log(`${V.pick(a.engine)} has no voice list here (piper's voices are model files you point at with --voice)`);
      return 0;
    }
    console.log(`${V.pick(a.engine)} voices for ${a.lang}:`);
    for (const [n, note] of vs) console.log(`  ${n.padEnd(24)} ${note}`);
    return 0;
  }
  if (!a.text) { console.error(`${HELP}\npd_voice: error: give something to say (or --list)`); return 2; }

  // `-o -` 면 바이트가 stdout 으로 가므로 나머지 말은 전부 stderr 로 - 안 그러면
  // 파형 한가운데에 말이 섞인다.
  const piping = a.out === '-';
  const say = piping ? (s) => console.error(s) : (s) => console.log(s);
  let samples, rate;
  try { [samples, rate] = await V.synthesise(a.text, { engine: a.engine, lang: a.lang, voice: a.voice }); }
  catch (e) { say(`[-] ${e.message}`); return 1; }
  const [data, table] = V.toPsg(samples, rate, { rateOut: a.rate, normalise: a.normalise,
                                                loud: a.loud, curve: a.curve });
  say(`[+] ${V.pick(a.engine)}: ${(samples.length / rate).toFixed(2)}s -> ${data.length} bytes at `
    + `${a.rate} Hz (${(data.length / 1024).toFixed(1)} KB)`);
  let played = null;
  if (!piping || a.wav) {
    played = V.decodePsg(data, table, a.curve);
    say(`[+] ${V.snr(samples, rate, played, a.rate, a.normalise, a.loud).toFixed(1)} dB through the PSG `
      + `(${new Set(data).size} of 256 codes used)`);
  }
  if (piping) process.stdout.write(data);
  else if (a.out) { fs.writeFileSync(a.out, data); say(`[+] wrote ${a.out}`); }
  if (a.table) { fs.writeFileSync(a.table, table); say(`[+] wrote ${a.table} (${table.length} bytes)`); }
  if (a.wav) { fs.writeFileSync(a.wav, V.wavBytes(played, a.rate)); say(`[+] wrote ${a.wav}`); }
  if (!(a.out || a.table || a.wav)) say('    nothing written - pass -o, --table or --wav');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
