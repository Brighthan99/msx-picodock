// midistat.test.js — MIDI 흐름을 채널 상태로 줄이는 부분.
//
// 여기서 틀리기 쉬운 자리는 셋이다: 러닝 스테이터스(상태 바이트 생략),
// 메시지 한가운데 끼어드는 실시간 바이트, 그리고 벨로시티 0 인 노트온.
// 셋 다 실제 MIDI 흐름에 흔하고, 놓치면 조용히 절반을 잃는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiStat, instrumentName, GM_NAMES } from '../src/midistat.js';

const feed = (st, bytes, now = 0) => st.feed(Uint8Array.from(bytes), now);

test('노트온·노트오프를 센다', () => {
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 0x80, 60, 0]);
  assert.equal(s.ch[0].notes, 1);
  assert.equal(s.ch[0].sounding.size, 0);
  assert.ok(s.ch[0].level > 0);
});

test('러닝 스테이터스를 이어 받는다', () => {
  // 90 3C 64 3E 64 는 노트온 **두 개**다. 상태 바이트가 생략돼 있다.
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 62, 100, 64, 100]);
  assert.equal(s.ch[0].notes, 3);
  assert.equal(s.ch[0].sounding.size, 3);
});

test('실시간 바이트가 메시지 한가운데 끼어들어도 된다', () => {
  // 0xF8(타이밍 클럭)은 어디든 낄 수 있고, 러닝 스테이터스를 지우면 안 된다.
  const s = new MidiStat();
  feed(s, [0x90, 60, 0xf8, 100, 0xf8, 62, 100]);
  assert.equal(s.ch[0].notes, 2, '클럭 때문에 메시지를 잃으면 안 된다');
});

test('벨로시티 0 인 노트온은 노트오프다', () => {
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 60, 0]);
  assert.equal(s.ch[0].notes, 1);
  assert.equal(s.ch[0].sounding.size, 0, '같은 음이 꺼져야 한다');
});

test('시스템 공통 메시지는 러닝 스테이터스를 지운다', () => {
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 0xf1, 0x00, 62, 100]);
  assert.equal(s.ch[0].notes, 1, '0xF1 뒤의 바이트를 음으로 읽으면 안 된다');
});

test('프로그램 체인지가 악기를 바꾼다', () => {
  const s = new MidiStat();
  feed(s, [0xc0, 80, 0xc1, 30]);
  assert.equal(s.ch[0].program, 80);
  assert.equal(s.ch[1].program, 30);
  assert.equal(instrumentName(0, 80), 'Lead 1 (square)');
  assert.equal(instrumentName(1, 30), 'Distortion Guitar');
});

test('채널 10 은 언제나 타악기다', () => {
  assert.equal(instrumentName(9, 0), 'Drums');
  assert.equal(instrumentName(9, 80), 'Drums');
  assert.equal(GM_NAMES.length, 128);
});

test('볼륨과 익스프레션이 세기에 곱해진다', () => {
  // MIDI-PAC 은 PSG 엔벨로프를 CC 11 로 옮긴다. 그걸 빼면 감쇠가 안 보인다.
  const loud = new MidiStat();
  feed(loud, [0xb0, 7, 127, 0xb0, 11, 127, 0x90, 60, 127]);
  const soft = new MidiStat();
  feed(soft, [0xb0, 7, 127, 0xb0, 11, 32, 0x90, 60, 127]);
  assert.ok(loud.ch[0].level > soft.ch[0].level * 3,
            `익스프레션이 반영돼야 한다 (${loud.ch[0].level} vs ${soft.ch[0].level})`);
});

test('all notes off 가 울리던 것을 지운다', () => {
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 62, 100, 0xb0, 123, 0]);
  assert.equal(s.ch[0].sounding.size, 0);
});

test('시간이 지나면 미터가 내려간다', () => {
  const s = new MidiStat({ halfLifeMs: 100 });
  feed(s, [0x90, 60, 127, 0x80, 60, 0], 1000);
  const start = s.ch[0].level;
  s.tick(1100);                       // 반감기 한 번
  assert.ok(s.ch[0].level < start * 0.6 && s.ch[0].level > start * 0.4,
            `반감기만큼 줄어야 한다 (${start} -> ${s.ch[0].level})`);
});

test('울리는 동안에는 바닥을 받쳐 준다', () => {
  // 길게 끄는 음이 사라지면 "안 울린다" 로 보인다.
  const s = new MidiStat({ halfLifeMs: 10 });
  feed(s, [0x90, 60, 127], 1000);
  s.tick(2000);                       // 반감기 100 번
  assert.ok(s.ch[0].level > 0.1, `울리는 중에는 안 꺼져야 한다 (${s.ch[0].level})`);
});

test('한 번도 안 쓰인 채널은 안 내놓는다', () => {
  const s = new MidiStat();
  feed(s, [0x90, 60, 100, 0x92, 64, 100]);
  const a = s.active();
  assert.deepEqual(a.map((c) => c.ch), [0, 2]);
  assert.equal(a[0].name, 'Acoustic Grand Piano');
});

test('쪼개져 들어와도 같다', () => {
  const whole = new MidiStat();
  const bits = new MidiStat();
  const stream = [0xc0, 80, 0x90, 60, 100, 62, 90, 0xb0, 11, 64, 64, 80];
  feed(whole, stream);
  for (const b of stream) feed(bits, [b]);
  assert.equal(bits.ch[0].notes, whole.ch[0].notes);
  assert.equal(bits.ch[0].program, whole.ch[0].program);
  assert.equal(bits.ch[0].level.toFixed(6), whole.ch[0].level.toFixed(6));
});

test('악기 아이콘이 무리를 따라간다', async () => {
  const { instrumentIcon } = await import('../src/midistat.js');
  assert.equal(instrumentIcon(0, 0), instrumentIcon(0, 7), '피아노 무리는 같은 아이콘');
  assert.notEqual(instrumentIcon(0, 0), instrumentIcon(0, 24), '피아노와 기타는 달라야');
  assert.equal(instrumentIcon(9, 0), instrumentIcon(9, 80), '채널 10 은 늘 타악기');
});

test('음높이 대역이 실제로 울린 음을 따라간다', async () => {
  const { MidiStat, bandOf, BANDS } = await import('../src/midistat.js');
  const s = new MidiStat();
  // C1 = 24, C5 = 72. 서로 다른 대역이어야 한다.
  assert.notEqual(bandOf(24), bandOf(72));
  s.feed(Uint8Array.from([0x90, 72, 127]), 1000);
  const b = s.active()[0].bands;
  assert.equal(b.length, BANDS);
  assert.ok(b[bandOf(72)] > 0.5, '울린 대역이 서야 한다');
  assert.equal(b[bandOf(24)], 0, '안 울린 대역은 0 이어야 한다');
});

test('곡이 끝나도 목록은 남고, 새 곡이 시작할 때 비운다', async () => {
  // 끝나자마자 지우면 방금 무엇이 울렸는지 볼 수 없다. 화면은 마지막 상태를
  // 남겨 두는 편이 낫고, 비우는 것은 다음 곡의 첫 메시지가 올 때다.
  const { MidiStat } = await import('../src/midistat.js');
  const s = new MidiStat({ idleResetMs: 1000 });
  s.feed(Uint8Array.from([0xc0, 80, 0x90, 60, 100, 0x80, 60, 0]), 1000);
  assert.equal(s.active().length, 1);

  s.tick(1500);                       // 아직 틈 안
  assert.equal(s.active().length, 1);
  assert.equal(s.stale, false);

  s.tick(2500);                       // 틈을 넘겼다
  assert.equal(s.stale, true, '낡음으로 표시만 한다');
  assert.equal(s.active().length, 1, '곡이 끝났다고 지우지 않는다');
  assert.equal(s.resets, 0);

  // 새 곡의 첫 메시지. 여기서 비워진다.
  s.feed(Uint8Array.from([0xc2, 30, 0x92, 64, 100]), 2600);
  const a = s.active();
  assert.equal(s.resets, 1);
  assert.equal(a.length, 1, '앞 곡의 채널이 남으면 안 된다');
  assert.equal(a[0].ch, 2);
  assert.equal(a[0].name, 'Distortion Guitar');
  assert.equal(s.stale, false);
});

test('곡 안의 짧은 쉼으로는 안 비운다', async () => {
  const { MidiStat } = await import('../src/midistat.js');
  const s = new MidiStat({ idleResetMs: 3000 });
  s.feed(Uint8Array.from([0x90, 60, 100]), 1000);
  for (let t = 1100; t < 3500; t += 100) s.tick(t);
  assert.equal(s.active().length, 1, '2.5 초 쉼으로는 안 비운다');
});

test('지금 눌린 음을 내놓는다 (건반 표시용)', async () => {
  // MIDRY 의 건반 표시와 같은 원리다 - 노트온으로 들어오고 노트오프로 빠지는
  // 집합이 전부다. 화면은 그 집합의 음높이만 칠하면 된다.
  const { MidiStat } = await import('../src/midistat.js');
  const s = new MidiStat();
  s.feed(Uint8Array.from([0x90, 60, 100, 64, 100, 67, 100]), 1000);
  assert.deepEqual(s.active()[0].down.sort((a, b) => a - b), [60, 64, 67], '도미솔');

  s.feed(Uint8Array.from([0x80, 64, 0]), 1100);
  assert.deepEqual(s.active()[0].down.sort((a, b) => a - b), [60, 67], '미를 떼면 빠진다');

  s.feed(Uint8Array.from([0xb0, 123, 0]), 1200);
  assert.deepEqual(s.active()[0].down, [], 'all notes off 면 다 빠진다');
});
