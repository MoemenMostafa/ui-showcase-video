// UI sounds for the polish "sound" option, synthesised offline (no samples, no downloads): a soft click per click,
// very light ticks while typing, a gentle whoosh on page loads. All of them go through one small room reverb, so they
// sound like one space, and are ducked while a line is spoken. narrate.ts and tighten.ts mix the result under the voice.
import { writeFileSync } from 'node:fs';
import type { Track } from './camera.ts';

export interface Sfx { type: 'click' | 'key' | 'nav'; t: number }
export interface SoundOptions { volume: number; duck: number } // dB on top of the built-in levels; dB of ducking

const SR = 48000;

/** Deterministic noise, so a re-render sounds the same. */
function rng(seed: number): () => number {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A soft click: a short knock (low thump, mid body, small bright edge), slightly lowpassed. */
function click(out: Float32Array, at: number, rand: () => number): void {
  let lp = 0;
  for (let n = 0; n < 0.12 * SR && at + n < out.length; n++) {
    const t = n / SR, attack = Math.min(1, t / 0.0006);
    const tone = 0.5 * Math.sin(2 * Math.PI * 1650 * t) * Math.exp(-t / 0.006) + 0.35 * Math.sin(2 * Math.PI * 600 * t) * Math.exp(-t / 0.016)
      + 0.5 * Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t / 0.03);
    lp += 0.35 * ((rand() * 2 - 1) * Math.exp(-t / 0.0015) - lp);
    out[at + n] += 0.1 * attack * (tone + 0.6 * lp);
  }
}

/** A very light key tick: a tiny bright tap, a little different every time. */
function key(out: Float32Array, at: number, rand: () => number): void {
  const f = 2400 + rand() * 600, g = 0.03 * (0.7 + 0.3 * rand());
  let prev = 0;
  for (let n = 0; n < 0.03 * SR && at + n < out.length; n++) {
    const t = n / SR, x = (rand() * 2 - 1) * Math.exp(-t / 0.0012);
    out[at + n] += g * Math.min(1, t / 0.0004) * (0.6 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.003) + 0.8 * (x - prev)); // x - prev: highpassed
    prev = x;
  }
}

/** A gentle whoosh: noise through a band-pass sweeping up, swelling in and out over ~0.5 s. */
function whoosh(out: Float32Array, at: number, rand: () => number): void {
  const len = 0.55 * SR;
  let low = 0, band = 0; // state-variable filter
  for (let n = 0; n < len && at + n < out.length; n++) {
    const u = n / len, fc = 300 * Math.pow(2200 / 300, u), f = 2 * Math.sin((Math.PI * fc) / SR);
    const high = (rand() * 2 - 1) - low - 1.2 * band;
    band += f * high; low += f * band;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 2);
    out[at + n] += 0.12 * env * band;
  }
}

/** One small room: four damped feedback combs in parallel, then two allpasses (Schroeder). */
function room(dry: Float32Array, wet = 0.2): Float32Array {
  const combs = [0.0231, 0.0273, 0.0317, 0.0359].map(s => ({ buf: new Float32Array(Math.round(s * SR)), i: 0, lp: 0 }));
  const passes = [0.005, 0.0017].map(s => ({ buf: new Float32Array(Math.round(s * SR)), i: 0 }));
  const out = new Float32Array(dry.length);
  for (let n = 0; n < dry.length; n++) {
    let y = 0;
    for (const c of combs) {
      const d = c.buf[c.i];
      c.lp += 0.35 * (d - c.lp); // damping: the tail darkens like a furnished room
      c.buf[c.i] = dry[n] + 0.72 * c.lp;
      c.i = (c.i + 1) % c.buf.length;
      y += d / combs.length;
    }
    for (const p of passes) { const d = p.buf[p.i]; p.buf[p.i] = y + 0.6 * d; y = d - 0.6 * p.buf[p.i]; p.i = (p.i + 1) % p.buf.length; }
    out[n] = dry[n] + wet * y;
  }
  return out;
}

/** Sound events on the <out>.mp4 timeline (after any title card): clicks, typed keys, page loads. */
export function sfxEvents(track: Track): Sfx[] {
  const gotos = track.events.filter(e => e.type === 'goto');
  const out: Sfx[] = [];
  for (const e of track.events) {
    const t = e.t + track.offset;
    if (e.type === 'click') out.push({ type: 'click', t });
    else if (e.type === 'key') out.push({ type: 'key', t });
    else if (e.type === 'goto') out.push({ type: 'nav', t });
    // a page loaded by a click (not by a goto, which already has its whoosh)
    else if (e.type === 'doc' && !gotos.some(g => e.t >= g.t - 0.3 && e.t <= (g.end ?? g.t))) out.push({ type: 'nav', t });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Render the events to a mono WAV of `duration` s, ducked by `duck` dB inside the spoken [from, to] spans. */
export function renderSfx(events: Sfx[], speech: Array<[number, number]>, duration: number, file: string, o: SoundOptions): string {
  const dry = new Float32Array(Math.ceil(duration * SR)), rand = rng(7);
  const gap = { click: 0.08, key: 0.045, nav: 0.4 }, last = { click: -1, key: -1, nav: -1 };
  for (const e of events) {
    if (e.t < 0 || e.t >= duration || e.t - last[e.type] < gap[e.type]) continue; // thin out (tightened gaps squeeze events together)
    last[e.type] = e.t;
    ({ click, key, nav: whoosh })[e.type](dry, Math.round(e.t * SR), rand);
  }
  const wet = room(dry);
  // duck under the voice with 80 ms raised-cosine ramps
  const low = Math.pow(10, -o.duck / 20), ramp = 0.08, gain = Math.pow(10, o.volume / 20);
  const duckAt = (t: number) => {
    let g = 1;
    for (const [a, b] of speech) {
      const into = Math.min(t - (a - ramp), b + ramp - t);
      if (into <= 0) continue;
      const k = into >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * into) / ramp);
      g = Math.min(g, 1 - (1 - low) * k);
    }
    return g;
  };
  let peak = 0, g = 1;
  for (let n = 0; n < wet.length; n++) {
    if (n % 480 === 0) g = duckAt(n / SR) * gain; // every 10 ms is smooth enough
    wet[n] *= g;
    peak = Math.max(peak, Math.abs(wet[n]));
  }
  const ceil = 0.35; // keep the effects well below full scale (≈ -9 dBFS peaks)
  const k = peak > ceil ? ceil / peak : 1;
  const pcm = Buffer.alloc(44 + wet.length * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + wet.length * 2, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24);
  pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(wet.length * 2, 40);
  wet.forEach((s, n) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * k)) * 32767), 44 + n * 2));
  writeFileSync(file, pcm);
  return file;
}

/** ffmpeg filter: the normalised voice `[voice]` with the effects `[fx]` under it, limited, into `[out]`. */
export const SFX_MIX = (voice: string, fx: string, out: string) =>
  `${fx}aresample=48000[fxr];${voice}[fxr]amix=inputs=2:normalize=0,alimiter=limit=0.84:level=disabled,apad${out}`;
