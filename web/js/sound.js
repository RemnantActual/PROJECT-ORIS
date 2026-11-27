// ORIS web — procedural sound design, synthesized from scratch (port of sound.py; no samples).
// A scene lists timed events in sounds(mix); this renders them, puts them in a reverb space and masters the result.
import { rng } from "./util.js";

export const SR = 48000;

// ─────────────────────────── FFT (radix-2, in place) ───────────────────────────
const nextPow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ─────────────────────────── building blocks ───────────────────────────
const _t = dur => { const n = Math.trunc(dur * SR), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = i / SR; return o; };
function env(sig, attack = 0.003, release = null) {
  const n = sig.length, a = Math.max(1, Math.min(n, Math.trunc(attack * SR))), out = new Float32Array(sig);
  for (let i = 0; i < a; i++) out[i] *= (a > 1 ? i / (a - 1) : 1) ** 2;
  if (release) {
    const r = Math.min(n, Math.trunc(release * SR));
    for (let i = 0; i < r; i++) out[n - r + i] *= (r > 1 ? 1 - i / (r - 1) : 0) ** 2;
  }
  return out;
}
function noise(dur, seed = 0) {
  const r = rng(seed * 101 + 7), n = Math.trunc(dur * SR), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = r.normal();
  return o;
}
/** Smooth FFT band-pass (soft skirts, no ringing). */
function band(sig, lo, hi, slope = 1) {
  const n = sig.length, N = nextPow2(n), re = new Float64Array(N), im = new Float64Array(N);
  re.set(sig);
  fft(re, im);
  for (let k = 0; k <= N / 2; k++) {
    const f = (k * SR) / N + 1e-3;
    let g = 1;
    if (lo > 0) g *= 1 / (1 + (lo / f) ** (4 * slope));
    if (hi < SR / 2) g *= 1 / (1 + (f / hi) ** (4 * slope));
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
  }
  fft(re, im, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i];
  return out;
}
const sat = (x, drive = 1.5) => { const k = Math.tanh(drive), o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = Math.tanh(x[i] * drive) / k; return o; };
/** Resonant low-pass whose cutoff glides f0 → f1 (state-variable filter). */
function sweepFilter(sig, f0, f1, q = 6) {
  const n = sig.length, out = new Float32Array(n), k = 1 / q;
  let ic1 = 0, ic2 = 0;
  for (let i = 0; i < n; i++) {
    const fc = Math.min(f0 * (f1 / f0) ** (i / Math.max(1, n - 1)), SR * 0.45);
    const g = Math.tan((Math.PI * fc) / SR), a1 = 1 / (1 + g * (g + k));
    const v3 = sig[i] - ic2, v1 = a1 * ic1 + g * a1 * v3, v2 = ic2 + g * v1;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = v2;
  }
  return out;
}
function fm(freq, ratio, index, dur, decay, indexDecay = null) {
  const n = Math.trunc(dur * SR), o = new Float32Array(n), id = indexDecay || decay;
  for (let i = 0; i < n; i++) {
    const t = i / SR, idx = index * Math.exp(-t / id);
    o[i] = Math.sin(2 * Math.PI * freq * t + idx * Math.sin(2 * Math.PI * freq * ratio * t)) * Math.exp(-t / decay);
  }
  return o;
}
const mulS = (a, k) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * k; return o; };
const addTo = (a, b, k = 1, at = 0) => { for (let i = 0; i < b.length && i + at < a.length; i++) a[i + at] += b[i] * k; return a; };
/** sin(2π · cumsum(freq) / SR), the phase-continuous sweep numpy builds with cumsum */
function chirp(n, fAt) { const o = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { ph += fAt(i / SR); o[i] = Math.sin((2 * Math.PI * ph) / SR); } return o; }
const saw = (fr, t) => 2 * ((fr * t) % 1) - 1;

// ─────────────────────────── sounds ───────────────────────────
/** Data tick for typing: a tiny filtered click with a hint of pitch. */
export function tick(seed = 0, bright = 1) {
  const r = rng(seed), nz = band(noise(0.03, seed), 2500 * bright, 9000), f = 3200 + 1600 * r.random();
  const fmS = fm(f, 1.41, 1.5, 0.03, 0.006), out = new Float32Array(nz.length);
  for (let i = 0; i < out.length; i++) out[i] = (nz[i] * Math.exp(-i / SR / 0.004) * 0.6 + fmS[i] * 0.25) * 0.5;
  return out;
}
export const blip = (freq = 2200) => mulS(env(fm(freq, 2.0, 2.0, 0.09, 0.03, 0.01), 0.001), 0.35);
/** Two-note glassy confirmation. */
export function lock() {
  const a = fm(1046, 3.5, 2.4, 0.35, 0.06, 0.015), b = fm(1568, 3.5, 2.4, 0.45, 0.09, 0.02);
  const out = new Float32Array(Math.trunc(0.8 * SR));
  addTo(out, a, 0.5);
  addTo(out, b, 0.55, Math.trunc(0.075 * SR));
  return mulS(env(out, 0.001), 0.55);
}
/** Sonar: low bell; shorter decay = a drier contact ping. */
export function ping(decay = 0.32, freq = 740) {
  const s = fm(freq, 1.0, 1.2, decay * 4.4, decay, 0.06);
  addTo(s, fm(freq * 2, 2.76, 0.8, decay * 4.4, decay * 0.47, 0.04), 0.25);
  return mulS(env(s, 0.002), 0.45);
}
/** Noise riser through a resonant filter that opens up, plus a rising tone. */
export function riser(dur = 2.0, seed = 1) {
  const swept = sweepFilter(mulS(noise(dur, seed), 0.6), 120, 7000, 4.5), n = swept.length;
  const tone = chirp(n, t => 90 * (1 + 3 * (t / dur) ** 2));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (swept[i] + tone[i] * 0.25) * (i / SR / dur) ** 2.2;
  return mulS(env(o, 0.05, 0.02), 0.9);
}
/** Air pass: band-limited noise with a Doppler-ish filter swing. */
export function whoosh(dur = 1.4, seed = 6) {
  const n0 = noise(dur, seed), lo = band(n0, 150, 900), hi = band(n0, 900, 5000), o = new Float32Array(n0.length);
  for (let i = 0; i < o.length; i++) {
    const t = i / SR / dur, e = Math.exp(-(((t - 0.45) / 0.22) ** 2));
    o[i] = (lo[i] * e * 0.8 + hi[i] * e * Math.min(Math.max(1.2 - t, 0), 1) * 0.45) * 0.5;
  }
  return o;
}
/** Reversed reverb-like swell that sucks into a hit. */
export function reverseSwell(dur = 0.8, seed = 7) {
  const b = band(noise(dur, seed), 300, 6000), n = b.length, o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[n - 1 - i] = b[i] * Math.exp(-i / SR / (dur * 0.35)) * 0.35;
  return o;
}
/** Layered hit: sub drop + body thump + crack, saturated. */
export function impact(seed = 3, size = 1.0) {
  const n = Math.trunc(2.2 * SR);
  const sub = chirp(n, t => 30 + 70 * Math.exp(-t / 0.09));
  const thump = band(noise(2.2, seed), 60, 300), crack = band(noise(2.2, seed + 1), 1500, 9000), o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    o[i] = sub[i] * Math.exp(-t / (0.6 * size)) * 1.1 + thump[i] * Math.exp(-t / 0.07) * 1.6 + crack[i] * Math.exp(-t / 0.015) * 0.7;
  }
  return mulS(env(sat(o, 1.8), 0.0008), 0.85);
}
/** Low pulsing alert: detuned saws, low-passed, 3 Hz pulse. */
export function alarm(dur = 2.4) {
  const n = Math.trunc(dur * SR), s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = saw(146.8, t) + saw(147.9, t) + 0.6 * saw(220.4, t) + 0.4 * saw(293.0, t); }
  const b = band(s, 60, 1400);
  for (let i = 0; i < n; i++) b[i] *= (0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * (i / SR) - Math.PI / 2)) ** 2 * 0.4;
  return mulS(env(sat(b, 1.4), 0.02, 0.4), 0.55);
}
/** Glitch: repeats tiny slices of a source sound, bitcrushed. */
function stutter(src, dur = 0.25, sliceMs = 28, seed = 4) {
  const r = rng(seed), n = Math.trunc(dur * SR), sl = Math.trunc((sliceMs / 1000) * SR), out = new Float32Array(n);
  let pos = 0;
  while (pos < n) {
    const st = r.integers(0, Math.max(1, src.length - sl)), piece = src.subarray(st, st + sl);
    const reps = r.integers(1, 4);
    let stop = false;
    for (let k = 0; k < reps; k++) {
      const m = Math.min(piece.length, n - pos);
      if (m <= 0) { stop = true; break; }
      out.set(piece.subarray(0, m), pos);
      pos += m;
    }
    if (stop) break;
  }
  const crushed = new Float32Array(n);
  for (let i = 0; i < n; i++) crushed[i] = Math.round(out[Math.floor(i / 6) * 6] * 6) / 6;
  return mulS(band(crushed, 200, 10000), 0.5);
}
export function glitch(dur, seed = 4) {
  const hiss = mulS(band(noise(0.5, seed), 1500, 9000), 0.5), f = fm(1200, 1.7, 6, 0.5, 0.3);
  const src = new Float32Array(hiss.length + f.length);
  src.set(hiss); src.set(f, hiss.length);
  return stutter(src, dur, 22 + (seed % 15), seed);
}
/** Dark bed: detuned low saws through a slowly moving filter + air. */
export function drone(dur) {
  const n = Math.trunc(dur * SR), s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = saw(55.0, t) + saw(55.35, t) + 0.5 * saw(82.4, t) + 0.3 * saw(110.1, t); }
  const b = band(s, 30, 320), air = band(noise(dur, 9), 200, 1200), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (b[i] * 0.5 + air[i] * 0.25) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.07 * (i / SR)));
  return mulS(env(o, 2.0, 1.5), 0.22);
}
export function powerOn() {
  const n = SR, s = chirp(n, t => 40 * (1 + 9 * t ** 1.5)), hum = band(noise(1.0, 5), 80, 600), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; o[i] = (s[i] * t ** 0.5 * Math.exp(-t / 0.7) + hum[i] * Math.exp(-t / 0.5) * 0.3) * 0.8; }
  return mulS(env(sat(o, 1.6), 0.05, 0.15), 0.5);
}
/** High airy tail for the outro sigil. */
export function shimmer(dur = 1.2) {
  const s = new Float32Array(Math.trunc(dur * SR));
  for (const f of [1568, 2093, 2637]) addTo(s, fm(f, 2.01, 1.5, dur, dur * 0.45), 1 / 3);
  return mulS(env(s, 0.3, 0.5), 0.25);
}

// ─────────────────────────── mixer ───────────────────────────
/** Short, damped room: highs die faster than lows, so tails go dark, not ringy. */
function reverbIR(dur = 1.8, seed = 11) {
  return [0, 1].map(ch => {
    const n0 = noise(dur, seed + ch), low = band(n0, 200, 1500), high = band(n0, 1500, 6000), o = new Float32Array(n0.length);
    for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = (low[i] * Math.exp(-t / 0.26) + high[i] * Math.exp(-t / 0.12) * 0.6) * Math.min(t / 0.015, 1); }
    return o;
  });
}
function convolve2(x, h0, h1) {   // x with two impulse responses, sharing the forward transform of x
  const N = nextPow2(x.length + Math.max(h0.length, h1.length) - 1);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  xr.set(x);
  fft(xr, xi);
  return [h0, h1].map(h => {
    const hr = new Float64Array(N), hi = new Float64Array(N);
    hr.set(h);
    fft(hr, hi);
    for (let k = 0; k < N; k++) { const r = xr[k] * hr[k] - xi[k] * hi[k]; hi[k] = xr[k] * hi[k] + xi[k] * hr[k]; hr[k] = r; }
    fft(hr, hi, true);
    const o = new Float32Array(x.length);
    for (let i = 0; i < o.length; i++) o[i] = hr[i];
    return o;
  });
}
function highpass(x, fc) {   // 2nd-order Butterworth high-pass (clears rumble below fc)
  const w = Math.tan((Math.PI * fc) / SR), k = Math.SQRT2, n = 1 / (1 + k * w + w * w);
  const b0 = n, b1 = -2 * n, b2 = n, a1 = 2 * (w * w - 1) * n, a2 = (1 - k * w + w * w) * n;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** Two buses: dry (with a reverb send) and a bed (no reverb). Mastered by render(). */
export class Mix {
  constructor(duration) {
    this.dur = duration;
    const n = Math.trunc((duration + 3) * SR);
    this.dry = [new Float32Array(n), new Float32Array(n)];
    this.send = new Float32Array(n);
    this._ticks = new Map();
  }
  add(t, sig, gain = 1, pan = 0, verb = 0.35) {
    let i = Math.round(t * SR);
    if (i < 0) { sig = sig.subarray(-i); i = 0; }
    const n = Math.min(sig.length, this.send.length - i);
    if (n <= 0) return;
    const l = Math.cos(((pan + 1) * Math.PI) / 4) * 1.414, r = Math.sin(((pan + 1) * Math.PI) / 4) * 1.414;
    const L = this.dry[0], R = this.dry[1], S = this.send;
    for (let k = 0; k < n; k++) { const s = sig[k] * gain; L[i + k] += s * l; R[i + k] += s * r; S[i + k] += s * verb; }
  }
  /** Data ticks for typed characters (matches the type-on timing). */
  typeOn(text, t0, cps, gain = 0.25, every = 1) {
    const ch = [...text];
    for (let k = 0; k < ch.length; k += every) {
      if (ch[k] === " ") continue;
      const seed = k * 31 + Math.trunc(t0 * 10);
      if (!this._ticks.has(seed)) this._ticks.set(seed, tick(seed));
      this.add(t0 + k / cps, this._ticks.get(seed), gain, (((k * 13) % 7) - 3) / 6, 0.15);
    }
  }
  /** Mastered stereo: [left, right] Float32Arrays of duration × SR samples. */
  render() {
    const n = Math.trunc(this.dur * SR), [irL, irR] = reverbIR(), [wL, wR] = convolve2(this.send, irL, irR);
    const st = [0, 1].map(c => { const o = new Float32Array(n), d = this.dry[c], w = c ? wR : wL; for (let i = 0; i < n; i++) o[i] = d[i] + w[i] * 0.3; return o; });
    st.forEach(c => highpass(c, 25));
    let sq = 0;
    for (const c of st) for (let i = 0; i < n; i++) sq += c[i] * c[i];
    const rms = Math.sqrt(sq / (2 * n)) || 1, g = 0.12 / rms, k = Math.tanh(1.15);
    let peak = 0;
    for (const c of st) for (let i = 0; i < n; i++) { c[i] = Math.tanh(c[i] * g * 1.15) / k; peak = Math.max(peak, Math.abs(c[i])); }
    if (peak > 0.84) for (const c of st) for (let i = 0; i < n; i++) c[i] *= 0.84 / peak;
    const fade = Math.trunc(0.08 * SR);
    for (const c of st) for (let i = 0; i < fade; i++) c[n - fade + i] *= 1 - i / (fade - 1);
    return st;
  }
}

/** 16-bit stereo WAV of a rendered mix. */
export function wav([L, R]) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
