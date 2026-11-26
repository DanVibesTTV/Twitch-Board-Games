// Sound effects. Every sound is synthesized with the Web Audio API, so there are
// no audio files to license or load. To use your own recordings instead, list them
// in sounds/sounds.json, e.g. { "dice": "dice.ogg", "step": ["step1.wav", "step2.wav"] }.
// When a name has a file, the file is played instead of the synth (an array → random pick).
//
// Shared by every game: play('dice' | 'step' | 'punch' | 'whoosh', options).

export class Sfx {
  constructor({ volume = 0.8, muted = false, baseUrl = new URL('../sounds/', import.meta.url) } = {}) {
    this.volume = volume;
    this.muted = muted;
    this.baseUrl = new URL(baseUrl);
    this.buffers = new Map(); // name → AudioBuffer[]
    this.ctx = null;
    // Browsers only allow audio after a click/keypress. OBS browser sources allow it right away.
    const unlock = () => this.#context()?.resume();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlock, { passive: true });
  }

  #context() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Gentle limiter so overlapping sounds never clip on stream.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noise = makeNoise(this.ctx);
    return this.ctx;
  }

  // Optional custom files from sounds/sounds.json. A missing file is fine: the synth is used.
  async loadOverrides() {
    let map;
    try {
      const res = await fetch(new URL('sounds.json', this.baseUrl));
      if (!res.ok) return;
      map = await res.json();
    } catch { return; }
    const ctx = this.#context();
    if (!ctx) return;
    for (const [name, files] of Object.entries(map)) {
      const list = [];
      for (const file of [].concat(files)) {
        try {
          const data = await (await fetch(new URL(file, this.baseUrl))).arrayBuffer();
          list.push(await ctx.decodeAudioData(data));
        } catch (err) { console.warn(`[sfx] could not load ${file}`, err); }
      }
      if (list.length) this.buffers.set(name, list);
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  play(name, opts = {}) {
    if (this.muted) return;
    const ctx = this.#context();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime + 0.005;
    const custom = this.buffers.get(name);
    if (custom) return this.#playBuffer(custom[Math.floor(Math.random() * custom.length)], t, opts);
    const synth = SYNTHS[name];
    if (!synth) return;
    const level = ctx.createGain();
    level.gain.value = LEVELS[name] ?? 1;
    level.connect(this.master);
    synth(ctx, level, this.noise, t, opts);
    setTimeout(() => level.disconnect(), 3000);
  }

  #playBuffer(buffer, t, { gain = 1, pitch = 1 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(t);
  }
}

// ───────────────────────────── synths ─────────────────────────────

export function makeNoise(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

const rand = (a, b) => a + Math.random() * (b - a);

// Short filtered noise burst — the basis of clicks, taps and impacts.
function burst(ctx, out, noise, t, { dur = 0.03, freq = 3000, q = 4, type = 'bandpass', gain = 0.5 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.5, dur + 0.02);
}

// Pitched body with a falling pitch — wood "tock" or punch "thump".
function tone(ctx, out, t, { from, to, dur, gain = 0.5, type = 'sine' }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// One die hitting the table: bright plastic click + small hollow knock.
function dieHit(ctx, out, noise, t, strength) {
  burst(ctx, out, noise, t, { dur: 0.025 + 0.02 * strength, freq: rand(2500, 4200), q: 6, gain: 0.55 * strength });
  tone(ctx, out, t, { from: rand(700, 950), to: rand(380, 480), dur: 0.05 + 0.04 * strength, gain: 0.22 * strength, type: 'triangle' });
}

// Balances the synths against each other (measured peaks), so they sit at similar loudness.
export const LEVELS = { dice: 3.6, step: 7, punch: 2.4, whoosh: 4.5 };

export const SYNTHS = {
  // Rattle that follows the 3D die: a big hit at each of the three bounces,
  // with little tumbling clicks in between, getting quieter and closer together.
  // opts.duration = animation length in ms (dice.js passes it), opts.dice = how many dice.
  dice(ctx, out, noise, t, { duration = 900, dice = 1 } = {}) {
    const T = duration / 1000;
    for (let d = 0; d < dice; d++) {
      const off = d * rand(0.015, 0.05);
      const bounces = [T / 3, (2 * T) / 3, T * 0.97];
      bounces.forEach((bt, i) => {
        const s = 1 - i * 0.28;
        dieHit(ctx, out, noise, t + off + bt, s);
        const clicks = 3 - i;
        for (let c = 1; c <= clicks; c++) {
          dieHit(ctx, out, noise, t + off + bt + c * rand(0.03, 0.06) * (1 - i * 0.25), s * 0.35);
        }
      });
      // soft shake before the throw
      for (let i = 0; i < 4; i++) burst(ctx, out, noise, t + off + i * 0.035, { dur: 0.02, freq: rand(3000, 5000), q: 3, gain: 0.12 });
    }
  },

  // Wooden pawn tapping a square. opts.pitch > 1 raises it (renderer rises along a move).
  step(ctx, out, noise, t, { pitch = 1, gain = 1 } = {}) {
    const p = pitch * rand(0.96, 1.04);
    tone(ctx, out, t, { from: 620 * p, to: 300 * p, dur: 0.07, gain: 0.32 * gain, type: 'sine' });
    burst(ctx, out, noise, t, { dur: 0.018, freq: 1800 * p, q: 2.5, gain: 0.28 * gain });
  },

  // Cartoon punch: low thump + crunchy smack, slightly overdriven.
  punch(ctx, out, noise, t, { gain = 1 } = {}) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.5);
    const g = ctx.createGain();
    g.gain.value = 0.9 * gain;
    shaper.connect(g).connect(out);
    tone(ctx, shaper, t, { from: 170, to: 42, dur: 0.22, gain: 0.9, type: 'sine' });
    tone(ctx, shaper, t, { from: 90, to: 40, dur: 0.16, gain: 0.5, type: 'triangle' });
    burst(ctx, shaper, noise, t, { dur: 0.09, freq: 1100, q: 0.8, type: 'lowpass', gain: 0.9 });
    burst(ctx, shaper, noise, t + 0.004, { dur: 0.035, freq: 2600, q: 1.5, gain: 0.6 });
  },

  // Air whoosh, e.g. a captured pawn flying back home. opts.duration in ms.
  whoosh(ctx, out, noise, t, { duration = 600, gain = 1 } = {}) {
    const T = duration / 1000;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + T * 0.5);
    f.frequency.exponentialRampToValueAtTime(700, t + T);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * gain, t + T * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + T);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + T + 0.05);
  },
};

function softClip(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
