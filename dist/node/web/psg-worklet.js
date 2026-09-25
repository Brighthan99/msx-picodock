// SPDX-License-Identifier: GPL-2.0-only
//
// psg-worklet.js — the AY-3-8910 as the browser hears it.
//
// The cartridge sends the PSG's fourteen registers fifty times a second. That
// is not audio: it is the state of a chip. This file is the chip. Tone on three
// channels, one noise generator, one envelope, mixed the way the real part
// mixes them.
//
// WHY THE BROWSER AND NOT THE SERVER
//   Node cannot open an audio device without a native module, and a native
//   module is the exact thing this port exists to avoid - it would put an
//   install step back in front of the person who just wanted to hear their MSX.
//   The browser already has an audio device, so the registers travel one hop
//   further and nothing has to be installed.
//
// WHY OVERSAMPLING
//   The Python renderer steps the tone counters once per output sample and
//   flips the square wave at sample boundaries. An edge that belongs 10 µs into
//   a sample therefore lands at its start or its end, which at 44.1 kHz is
//   ±23 µs of jitter - audible as roughness on high notes, where half a period
//   is only a dozen samples. Here each output sample is computed from OVERSAMPLE
//   sub-steps and averaged, which is the same thing as weighting each level by
//   how long it actually lasted. The cost is a few million integer operations a
//   second, which is nothing, and the roughness goes away.
//
// WHY A QUEUE
//   Frames arrive over a WebSocket on the main thread and are consumed by the
//   audio thread, which runs in 128-sample quanta on its own clock. The two are
//   never exactly in step. A small queue absorbs that; running dry means the
//   registers simply hold, which sounds like a note sustaining rather than like
//   a gap. Holding is the right failure: the MSX usually *is* still playing the
//   same note, and silence would be a lie about what the machine is doing.

const CLK = 1789772.5;            // the MSX's PSG clock
const OVERSAMPLE = 8;

// The AY's volume scale is logarithmic. These are the measured curve, 0..15.
const VOL = [0.0000, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
             0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0000];

// Each channel is scaled so three at full volume do not clip. The real chip
// sums them into one pin and clips too, but its clipping is not what anyone
// wants to reproduce.
const CHANNEL_GAIN = 0.28;

// How many frames to hold before starting, and the most to hold at all. Three
// frames is 60 ms - enough to ride out a scheduler hiccup, short enough that
// nobody plays a game through it and notices.
const START_FRAMES = 3;
const MAX_FRAMES = 12;

class Psg extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rate = sampleRate;
    this.sub = this.rate * OVERSAMPLE;

    this.r = new Uint8Array(16);
    this.r[7] = 0x3f;                    // power-on: everything off

    this.tc = [0, 0, 0];                 // tone phase counters
    this.tb = [1, 1, 1];                 // tone square state
    this.nc = 0; this.nb = 1; this.nrng = 1;
    this.ec = 0; this.estep = 0; this.ehold = false;
    this.erise = false; this.elevel = 0;

    // f_tone = CLK / (16 x TP). The 16 already contains the two flips that make
    // one full period, so flips happen CLK/(8 x TP) times a second.
    this.tick = CLK / 8 / this.sub;      // divide by TP
    this.ntick = CLK / 16 / this.sub;    // divide by NP

    this.queue = [];
    this.started = false;
    this.left = 0;                       // samples left of the current frame
    this.underruns = 0;
    this.frames = 0;
    // 채널마다 이 창에서 가장 크게 울린 값. 화면의 채널별 미터가 쓴다.
    //
    // **여기서 재는 것이 맞는 이유:** 레지스터의 볼륨 숫자만 보면 엔벨로프로
    // 우는 채널을 못 읽는다 (R8 의 bit4 만 서 있고 값은 0 이다). 엔벨로프
    // 레벨을 실제로 계산하는 곳이 여기뿐이라, 재는 것도 여기서 한다.
    this.peak = [0, 0, 0];
    this.envLast = 0;
    this.running = true;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'frame') {
        // Too far behind means the audio thread stalled or the tab was in the
        // background. Catching up by playing all of it would be minutes of
        // stale music, so drop to the newest and say so.
        if (this.queue.length >= MAX_FRAMES) {
          this.queue.length = 0;
          this.port.postMessage({ ev: 'overrun' });
        }
        this.queue.push({ regs: m.regs, flags: m.flags | 0 });
      } else if (m.cmd === 'stop') {
        this.running = false;
      } else if (m.cmd === 'reset') {
        this.queue.length = 0;
        this.started = false;
        this.r.fill(0);
        this.r[7] = 0x3f;
      }
    };
  }

  /** Take the next frame's registers, if one is due and available. */
  _pull() {
    if (!this.started) {
      if (this.queue.length < START_FRAMES) return;
      this.started = true;
    }
    const frame = this.queue.shift();
    if (!frame) { this.underruns++; return; }   // hold what we have
    const prev13 = this.r[13];
    this.r.set(frame.regs.subarray(0, 14));

    // Writing R13 restarts the envelope **even with the same value**, and a
    // lot of MSX music does exactly that: R13 = 0x00 every frame, retriggering
    // a decay. Registers alone cannot tell a rewrite from no write, so the
    // cartridge counts the writes and sets bit 0 of the flags byte for us.
    //
    // Without it, every envelope-driven voice decays once and stays at zero -
    // the tone channels go silent and only the noise-based sound effects are
    // left. That is what it sounded like before this line existed.
    const rewritten = (frame.flags & 1) !== 0;
    if (rewritten || this.r[13] !== prev13) {
      this.estep = 0; this.ehold = false;
      this.erise = (this.r[13] & 0x04) !== 0;
      this.ec = 0;
    }
    this.frames++;
  }

  _envLevel() {
    if (this.ehold) return this.elevel;
    const sh = this.r[13] & 0x0f;
    const cont = sh & 8, att = sh & 4, alt = sh & 2, hold = sh & 1;
    const ep = (this.r[11] | (this.r[12] << 8)) || 1;
    this.ec += (CLK / (8 * ep)) / this.sub;
    while (this.ec >= 1) {
      this.ec -= 1;
      if (this.estep < 31) this.estep++;
      else if (!cont) { this.ehold = true; this.elevel = 0; return 0; }
      else if (hold) {
        this.ehold = true;
        this.elevel = (!!att !== !!alt) ? 15 : 0;
        return this.elevel;
      } else {
        this.estep = 0;
        if (alt) this.erise = !this.erise;
      }
    }
    const lv = this.erise ? this.estep : 31 - this.estep;
    return lv >> 1;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return this.running;

    // Silence before the queue has filled, so the first thing anyone hears is
    // music rather than the tail of whatever was in the buffer.
    if (!this.started && this.queue.length < START_FRAMES) {
      out.fill(0);
      this._pull();
      return this.running;
    }

    const perFrame = this.rate / 50;     // samples in one 50 Hz tick
    const mixReg = () => this.r[7];

    for (let i = 0; i < out.length; i++) {
      if (this.left <= 0) { this._pull(); this.left += perFrame; }
      this.left--;

      const mix = mixReg();
      let acc = 0;

      for (let o = 0; o < OVERSAMPLE; o++) {
        const env = this._envLevel();

        const npd = (this.r[6] & 0x1f) || 1;
        this.nc += this.ntick / npd;
        while (this.nc >= 1) {
          this.nc -= 1;
          // 17-bit LFSR, taps 0 and 3 - the same polynomial as the real AY.
          this.nrng = (this.nrng >> 1) ^ ((this.nrng & 1) ? 0x12000 : 0);
          this.nb = this.nrng & 1;
        }

        this.envLast = env;
        let s = 0;
        for (let c = 0; c < 3; c++) {
          const tp = this.r[2 * c] | ((this.r[2 * c + 1] & 0x0f) << 8);
          let tone;
          if (tp) {
            this.tc[c] += this.tick / tp;
            while (this.tc[c] >= 1) { this.tc[c] -= 1; this.tb[c] ^= 1; }
            tone = this.tb[c];
          } else {
            tone = 1;                    // period 0 stops the oscillator high
          }
          const amp = this.r[8 + c];
          const v = (amp & 0x10) ? VOL[env] : VOL[amp & 0x0f];
          const tOn = !((mix >> c) & 1);
          const nOn = !((mix >> (3 + c)) & 1);
          let lvl = 1;
          if (tOn) lvl &= tone;
          if (nOn) lvl &= this.nb;
          if (!tOn && !nOn) lvl = 1;     // both disabled: the DC level, not silence
          s += v * (lvl ? 1 : -1) * CHANNEL_GAIN;
          // 이 채널이 실제로 내보내는 크기. 톤도 노이즈도 꺼져 있으면 DC 라
          // 소리가 아니므로 0 으로 친다.
          const audible = (tOn || nOn) ? v : 0;
          if (audible > this.peak[c]) this.peak[c] = audible;
        }
        acc += s;
      }

      const v = acc / OVERSAMPLE;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }

    // Let the page draw the queue depth and the underrun count. It is the one
    // number that says whether the sound is going to be clean.
    if ((currentFrame & 0x1fff) === 0)
      this.port.postMessage({ ev: 'stats', queued: this.queue.length,
                              underruns: this.underruns, frames: this.frames,
                              peak: this.peak.slice(), env: this.envLast,
                              regs: Array.from(this.r.subarray(0, 14)) });
      this.peak[0] = this.peak[1] = this.peak[2] = 0;
    return this.running;
  }
}

registerProcessor('psg', Psg);
