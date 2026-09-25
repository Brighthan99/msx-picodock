// SPDX-License-Identifier: GPL-2.0-only
//
// midistat.js — MIDI 바이트 흐름을 채널 16 개의 "지금 상태" 로 줄인다.
//
// 화면이 그릴 재료를 만드는 곳이다. **소리가 아니라 명령을 본다** - MIDI 에는
// 파형이 없으므로 주파수 스펙트럼 같은 것은 나올 수 없고, 나올 수 있는 것은
// "어느 채널이 어떤 악기로 얼마나 세게 울리고 있나" 다.
//
// 브라우저와 Node 양쪽에서 돈다. 브라우저는 Web MIDI 로 받은 바이트를 여기
// 넣고, Node 는 시험에서 지어낸 바이트를 넣는다 - 같은 코드라야 시험이 지키는
// 것과 화면이 돌리는 것이 같다.
//
// **러닝 스테이터스를 지켜야 한다.** MIDI 는 상태 바이트를 생략할 수 있어서,
// `90 3C 64 3E 64` 는 노트온 두 개다. 이걸 놓치면 절반을 잃는다. 그리고
// 실시간 바이트(0xF8 이상)는 메시지 **한가운데에도** 끼어들 수 있는데, 그것이
// 러닝 스테이터스를 지워서는 안 된다.

/** GM 악기 이름. 프로그램 번호가 곧 자리다. */
export const GM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)',
  'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar',
  'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/** GM 에서 채널 10(0부터 세면 9)은 언제나 타악기다. */
export const DRUM_CHANNEL = 9;

/**
 * GM 악기 무리(8 개씩 16 무리)마다의 아이콘.
 *
 * 프로그램 번호를 8 로 나누면 곧 무리다 - 규격이 그렇게 짜여 있다.
 * 글꼴을 따로 받지 않아도 되는 그림이라 이모지를 쓴다.
 */
const FAMILY_ICONS = [
  '\u{1F3B9}', // 0   피아노
  '\u{1F514}', // 8   유율 타악기
  '\u{1FA97}', // 16  오르간
  '\u{1F3B8}', // 24  기타
  '\u{1F3BB}', // 32  베이스
  '\u{1F3BB}', // 40  현악
  '\u{1F3BC}', // 48  앙상블
  '\u{1F3BA}', // 56  금관
  '\u{1F3B7}', // 64  리드(목관)
  '\u{1F32C}', // 72  파이프
  '\u{26A1}',  // 80  신스 리드
  '\u{2601}',  // 88  신스 패드
  '\u{2728}',  // 96  신스 효과
  '\u{1FA95}', // 104 민속
  '\u{1F941}', // 112 타악
  '\u{1F4A5}', // 120 효과음
];

export function instrumentIcon(ch, program) {
  if (ch === DRUM_CHANNEL) return '\u{1F941}';
  return FAMILY_ICONS[(program & 0x7f) >> 3];
}

/**
 * 음높이 대역. 옥타브마다 하나씩, C1 부터 C8 까지 여덟 칸.
 *
 * **이것은 주파수 스펙트럼이 아니다.** MIDI 에는 파형이 없으므로 오디오의
 * 스펙트럼은 나올 수 없다. 대신 **어느 음높이가 울렸는가**를 보여 준다 -
 * 눈에는 이퀄라이저처럼 읽히고, 추정이 아니라 실제로 온 노트온이다.
 */
export const BANDS = 8;
const BAND_LOW = 24;            // C1
export const bandOf = (note) =>
  Math.max(0, Math.min(BANDS - 1, Math.floor((note - BAND_LOW) / 12)));

export function instrumentName(ch, program) {
  if (ch === DRUM_CHANNEL) return 'Drums';
  return GM_NAMES[program & 0x7f] || `Program ${program}`;
}

export class MidiStat {
  /**
   * @param {object} opts
   * @param {number} opts.halfLifeMs  미터가 절반으로 줄어드는 데 걸리는 시간.
   *   **감쇠를 두는 이유는 보기 좋으라고가 아니다.** Web MIDI 의 배달은
   *   부하를 받으면 튀는데, 순간값을 그대로 찍으면 그 지터가 그대로 보인다.
   *   감쇠를 걸면 튀어도 눈에 안 거슬리고, 짧은 음도 한 프레임 이상 남는다.
   */
  /**
   * @param {number} opts.idleResetMs  이만큼 아무 메시지도 없으면 채널을
   *   비운다. **곡이 바뀌는 것을 이것으로 안다** - MIDI 에는 "여기서 끝" 이
   *   없어서, 다음 곡이 앞 곡의 악기 목록을 물려받으면 안 쓰는 채널이 그대로
   *   남는다. 곡 사이에는 늘 틈이 있고, 곡 안에는 3 초짜리 쉼이 드물다.
   *   0 이면 안 비운다.
   *
   *   **곡이 끝날 때가 아니라 새 곡이 시작할 때 비운다.** 끝나자마자 지우면
   *   방금 무엇이 울렸는지 볼 수 없다 - 화면은 마지막 상태를 남겨 두는 편이
   *   낫다. 틈이 지나면 "낡음" 으로만 표시하고, 다음 메시지가 올 때 비운다.
   */
  constructor({ halfLifeMs = 180, idleResetMs = 3000 } = {}) {
    this.halfLifeMs = halfLifeMs;
    this.idleResetMs = idleResetMs;
    this.reset();
    this.resets = 0;
  }

  reset() {
    this.ch = [];
    for (let i = 0; i < 16; i++) {
      this.ch.push({
        program: 0,
        level: 0,          // 0..1, 감쇠한다
        sounding: new Set(),
        bands: new Array(BANDS).fill(0),
        notes: 0,          // 여태 울린 음 수
        volume: 100 / 127, // CC 7
        expr: 1,           // CC 11
        lastNote: null,
      });
    }
    this.run = 0;          // 러닝 스테이터스
    this.pend = [];
    this.bytes = 0;
    this.lastAt = 0;
    this.lastMsgAt = 0;        // 채널 메시지를 마지막으로 본 시각
    this.stale = false;        // 틈이 지났다 - 다음 메시지가 오면 비운다
  }

  /** 바이트를 먹인다. `now` 는 ms (없으면 감쇠 계산에 안 쓴다). */
  feed(data, now = 0) {
    for (const b of data) {
      this.bytes++;
      // 실시간 바이트는 메시지 한가운데에도 끼어든다. 건너뛰되 러닝
      // 스테이터스와 모으던 데이터는 건드리지 않는다.
      if (b >= 0xf8) continue;
      if (b >= 0x80) {
        // 0xF0~0xF7 은 시스템 공통 - 러닝 스테이터스를 지운다.
        this.run = b < 0xf0 ? b : 0;
        this.pend.length = 0;
        continue;
      }
      if (!this.run) continue;          // 상태 없이 온 데이터 - 버린다
      this.pend.push(b);
      const st = this.run & 0xf0;
      const need = (st === 0xc0 || st === 0xd0) ? 1 : 2;
      if (this.pend.length < need) continue;
      this._msg(st, this.run & 0x0f, this.pend, now);
      this.pend.length = 0;
    }
    if (now) this.lastAt = now;
  }

  _msg(st, ch, d, now) {
    // 새 곡의 첫 메시지다. 여기서 비운다 - 곡이 끝난 순간이 아니라.
    if (this.stale) {
      const run = this.run, resets = this.resets;
      this.reset();
      this.run = run;                    // 파싱 상태는 이어 간다
      this.resets = resets + 1;
    }
    if (now) this.lastMsgAt = now;
    const c = this.ch[ch];
    switch (st) {
      case 0x90:
        if (d[1] > 0) {
          c.sounding.add(d[0]);
          c.notes++;
          c.lastNote = d[0];
          // 세기는 벨로시티에 채널 볼륨·익스프레션을 곱한 것이다. MIDI-PAC 이
          // PSG 엔벨로프를 CC 11 로 옮기므로, 그걸 빼면 감쇠가 안 보인다.
          const v = (d[1] / 127) * c.volume * c.expr;
          if (v > c.level) c.level = v;
          const bi = bandOf(d[0]);
          if (v > c.bands[bi]) c.bands[bi] = v;
          break;
        }
        // 벨로시티 0 인 노트온은 노트오프다.
        c.sounding.delete(d[0]);
        break;
      case 0x80:
        c.sounding.delete(d[0]);
        break;
      case 0xb0:
        if (d[0] === 7) c.volume = d[1] / 127;
        else if (d[0] === 11) c.expr = d[1] / 127;
        else if (d[0] === 120 || d[0] === 123) c.sounding.clear();  // all sound/notes off
        break;
      case 0xc0:
        c.program = d[0] & 0x7f;
        break;
      default:
        break;
    }
  }

  /** 시간을 흘린다. 화면을 그리기 직전에 부른다. */
  tick(now) {
    // 조용한 지 오래면 **표시만** 해 둔다. 비우는 것은 다음 메시지가 올 때다.
    if (this.idleResetMs && this.lastMsgAt && !this.stale
        && now - this.lastMsgAt > this.idleResetMs
        && this.ch.some((c) => c.notes)) {
      this.stale = true;
    }
    if (!this.lastAt) { this.lastAt = now; return; }
    const dt = Math.max(0, now - this.lastAt);
    this.lastAt = now;
    const k = Math.pow(0.5, dt / this.halfLifeMs);
    for (const c of this.ch) {
      // 울리는 음이 있으면 바닥을 받쳐 준다 - 길게 끄는 음이 사라지면
      // "안 울린다" 로 보인다.
      const floor = c.sounding.size ? 0.18 * c.volume * c.expr : 0;
      c.level = Math.max(floor, c.level * k);
      for (let b = 0; b < BANDS; b++) c.bands[b] *= k;
      // 울리는 음이 있는 대역은 받쳐 준다 - 길게 끄는 음이 사라지면 안 된다.
      for (const n of c.sounding) {
        const bi = bandOf(n);
        if (c.bands[bi] < floor) c.bands[bi] = floor;
      }
    }
  }

  /** 화면이 쓸 모양. 조용한 채널은 빼고 준다. */
  active() {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const c = this.ch[i];
      if (!c.notes) continue;            // 한 번도 안 쓰인 채널
      out.push({
        ch: i,
        program: c.program,
        name: instrumentName(i, c.program),
        icon: instrumentIcon(i, c.program),
        bands: c.bands.slice(),
        // 지금 눌려 있는 음높이들. MIDRY 의 건반 표시와 같은 원리다 -
        // 노트온으로 들어오고 노트오프로 빠지는 집합이 전부다.
        down: [...c.sounding],
        level: c.level,
        sounding: c.sounding.size,
        notes: c.notes,
        lastNote: c.lastNote,
      });
    }
    return out;
  }
}
