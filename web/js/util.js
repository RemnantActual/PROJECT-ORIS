// Shared helpers (ports of oris.py helpers and the Pillow bits the textures need).

// ─────────────── palette ───────────────
export const DW = 1920, DH = 1080;   // design size: all HUD coordinates are in these px
export function hexc(s) {
  s = s.replace("#", "");
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
}
export const MARK = "⊙ℝ⥍§";
export const GLYPH_SCRAMBLE = [..."⊕⊗⊘⊚⊛⊜⊝ℤℚℂℕℙ⥊⥋⥌⥎⥏∮∯∰¶†‡※⌬⍟◬◈◇◆"];
export const INK = hexc("#d9e0da");
export const DIM = hexc("#7d8882");
export const ACC = hexc("#f4dd55");
export const PALE = hexc("#efe6b4");
export const RED = hexc("#ea4259");
export const PINK = hexc("#ff9aa8");
export const DARK = hexc("#0b0e0d");
export const MAP_TINT = hexc("#cdd6d1");

export const mixc = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
export const scalec = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const addc = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ─────────────── time helpers ───────────────
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const EASE = {
  linear: x => x,
  in: x => x * x * x,
  out: x => 1 - (1 - x) ** 3,
  inout: x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  expo: x => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  hold: () => 0,
};
export function lerp(a, b, u) {
  if (Array.isArray(a)) return a.map((x, i) => x + (b[i] - x) * u);
  return a + (b - a) * u;
}
/** 0 before t0, 1 after t1, eased in between. */
export function ramp(t, t0, t1, ease = "inout") {
  if (t1 <= t0) return t >= t0 ? 1 : 0;
  return EASE[ease](clamp((t - t0) / (t1 - t0)));
}
/** Fades in at tIn, out at tOut. */
export const win = (t, tIn, tOut, fade = 0.3, ease = "inout") => ramp(t, tIn, tIn + fade, ease) * (1 - ramp(t, tOut - fade, tOut, ease));
/** Keyframes: [[time, value], [time, value, 'ease into this key'], ...]. */
export function key(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const k0 = keys[i], k1 = keys[i + 1];
    if (t <= k1[0]) return lerp(k0[1], k1[1], EASE[k1[2] || "inout"]((t - k0[0]) / (k1[0] - k0[0])));
  }
  return keys[keys.length - 1][1];
}
/** Deterministic pseudo-random 0..1 from any numbers (same input, same output). */
export function hsh(...v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += +v[i] * (12.9898 + i * 78.233);
  const x = Math.sin(s + 0.5) * 43758.5453;
  return x - Math.floor(x);
}
const SCRAMBLE = "#%&@$*+=/<>0123456789ABCDEFXZ";
/** Type-on text with a scrambling lead character. */
export function typed(s, t, t0, cps = 24) {
  const chars = [...s];
  const n = Math.floor(clamp((t - t0) * cps, 0, chars.length));
  if (n >= chars.length) return s;
  if (t < t0) return "";
  return chars.slice(0, n).join("") + SCRAMBLE[Math.floor(hsh(t * 30, n) * SCRAMBLE.length)];
}
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ─────────────── seeded randomness (stands in for numpy's default_rng) ───────────────
export function rng(seed) {
  let a = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const r = {
    random: next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    integers: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
    normal(mu = 0, sd = 1) {
      if (spare !== null) { const s = spare; spare = null; return mu + sd * s; }
      let u = 0, v = 0;
      while (u === 0) u = next();
      v = next();
      const m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return mu + sd * m * Math.cos(2 * Math.PI * v);
    },
    choice: arr => arr[Math.floor(next() * arr.length)],
  };
  return r;
}

// ─────────────── grayscale images: { w, h, d: Float32Array (0..1) } or Uint8 ───────────────
export const gimg = (w, h, d) => ({ w, h, d: d || new Float32Array(w * h) });

/** Float 0..1 → 8-bit (like oris._to_img). */
export function toU8(a) {
  const out = new Uint8Array(a.d.length);
  for (let i = 0; i < out.length; i++) {
    const v = a.d[i] * 255 + 0.5;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { w: a.w, h: a.h, d: out };
}
export function fromU8(g) {
  const out = new Float32Array(g.d.length);
  for (let i = 0; i < out.length; i++) out[i] = g.d[i] / 255;
  return { w: g.w, h: g.h, d: out };
}

// Pillow's resampling filters
const FILTERS = {
  box: [0.5, x => (x > -0.5 && x <= 0.5 ? 1 : 0)],
  bilinear: [1, x => Math.max(0, 1 - Math.abs(x))],
  bicubic: [2, x => {
    const a = -0.5;
    x = Math.abs(x);
    if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
    return 0;
  }],
  lanczos: [3, x => {
    const sinc = v => (v === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v));
    return x > -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0;
  }],
};
function coeffs(inSize, outSize, b0, b1, filter) {
  const [support0, fn] = FILTERS[filter];
  const scale = (b1 - b0) / outSize;
  const fscale = Math.max(scale, 1);
  const support = support0 * fscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const first = new Int32Array(outSize), count = new Int32Array(outSize), w = new Float32Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = b0 + (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const v = fn((x + xmin - center + 0.5) / fscale);
      w[xx * ksize + x] = v;
      ww += v;
    }
    if (ww) for (let x = 0; x < xmax; x++) w[xx * ksize + x] /= ww;
    first[xx] = xmin;
    count[xx] = xmax;
  }
  return { first, count, w, ksize };
}
/** Pillow-style Image.resize on a float image; box = [x0, y0, x1, y1] in source px. */
export function resize(src, dw, dh, filter = "bilinear", box = null) {
  const [x0, y0, x1, y1] = box || [0, 0, src.w, src.h];
  const ch = coeffs(src.w, dw, x0, x1, filter), cv = coeffs(src.h, dh, y0, y1, filter);
  // rows of the source that the vertical pass needs
  let ylo = src.h, yhi = 0;
  for (let y = 0; y < dh; y++) { ylo = Math.min(ylo, cv.first[y]); yhi = Math.max(yhi, cv.first[y] + cv.count[y]); }
  const rows = yhi - ylo;
  const tmp = new Float32Array(rows * dw);
  const S = src.d, W = src.w;
  for (let r = 0; r < rows; r++) {
    const so = (r + ylo) * W, to = r * dw;
    for (let x = 0; x < dw; x++) {
      const f = ch.first[x], n = ch.count[x], ko = x * ch.ksize;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += S[so + f + k] * ch.w[ko + k];
      tmp[to + x] = acc;
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const f = cv.first[y] - ylo, n = cv.count[y], ko = y * cv.ksize, oo = y * dw;
    for (let k = 0; k < n; k++) {
      const wk = cv.w[ko + k], to = (f + k) * dw;
      for (let x = 0; x < dw; x++) out[oo + x] += tmp[to + x] * wk;
    }
  }
  return { w: dw, h: dh, d: out };
}

/** Separable Gaussian blur, sigma in px (Pillow's GaussianBlur radius is a standard deviation). */
export function blur(src, sigma) {
  if (sigma <= 0) return { w: src.w, h: src.h, d: src.d.slice() };
  const R = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * R + 1);
  let s = 0;
  for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + R]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h } = src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), S = src.d;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) {
        let xx = x + i;
        xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
        acc += S[o + xx] * k[i + R];
      }
      tmp[o + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let i = -R; i <= R; i++) {
      let yy = y + i;
      yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
      const kw = k[i + R], so = yy * w, oo = y * w;
      for (let x = 0; x < w; x++) out[oo + x] += tmp[so + x] * kw;
    }
  }
  return { w, h, d: out };
}

/** 3x3 maximum (Pillow MaxFilter(3)). */
export function max3(src) {
  const { w, h } = src, S = src.d, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const v = S[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  return { w, h, d: out };
}

/** numpy.gradient: [d/dy, d/dx], central differences inside, one-sided at the edges. */
export function gradient(src, spacing = 1) {
  const { w, h } = src, S = src.d;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      gx[o + x] = x === 0 ? S[o + 1] - S[o] : x === w - 1 ? S[o + x] - S[o + x - 1] : (S[o + x + 1] - S[o + x - 1]) / 2;
      gy[o + x] = y === 0 ? S[w + x] - S[x] : y === h - 1 ? S[o + x] - S[o - w + x] : (S[o + w + x] - S[o - w + x]) / 2;
    }
  }
  if (spacing !== 1) for (let i = 0; i < gx.length; i++) { gx[i] /= spacing; gy[i] /= spacing; }
  return [gy, gx];
}

/** Percentiles (0..100) of an array, from every `step`-th value. */
export function percentile(arr, qs, step = 1) {
  const n = Math.ceil(arr.length / step), s = new Float32Array(n);
  for (let i = 0, j = 0; i < arr.length; i += step) s[j++] = arr[i];
  s.sort();
  return qs.map(q => {
    const pos = (q / 100) * (n - 1), lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  });
}
/** Percentiles of a square image sampled like numpy's a[::4, ::4]. */
function percentileGrid(img, qs, step) {
  const vals = [];
  for (let y = 0; y < img.h; y += step) for (let x = 0; x < img.w; x += step) vals.push(img.d[y * img.w + x]);
  return percentile(Float32Array.from(vals), qs);
}

/** Fractal noise, normalized 0..1 (oris.fbm). */
export function fbm(n, base, octaves, seed, gain = 0.5) {
  const r = rng(seed * 7919 + 17);
  const out = new Float32Array(n * n);
  let amp = 1, tot = 0;
  for (let i = 0; i < octaves; i++) {
    const cells = base * 2 ** i;
    if (cells > Math.floor(n / 2)) break;
    const g = gimg(cells + 3, cells + 3);
    for (let k = 0; k < g.d.length; k++) g.d[k] = r.random();
    const up = resize(g, n, n, "bicubic", [1, 1, cells + 1, cells + 1]);
    for (let k = 0; k < out.length; k++) out[k] += amp * up.d[k];
    tot += amp;
    amp *= gain;
  }
  const img = { w: n, h: n, d: out };
  for (let k = 0; k < out.length; k++) out[k] /= tot;
  const [lo, hi] = percentileGrid(img, [1, 99], 4);
  const k = 1 / (hi - lo + 1e-6);
  for (let i = 0; i < out.length; i++) out[i] = clamp((out[i] - lo) * k);
  return img;
}

/** Pillow ImageOps.autocontrast(cutoff) on 0..255 values (float array kept as floats 0..255). */
export function autocontrast(vals, cutoff = 1) {
  const hist = new Float64Array(256);
  for (let i = 0; i < vals.length; i++) hist[Math.max(0, Math.min(255, vals[i] | 0))]++;
  const n = vals.length, cut = (n * cutoff) / 100;
  let lo = 0, hi = 255, c = cut;
  for (; lo < 255; lo++) { if (c < hist[lo]) { hist[lo] -= c; break; } c -= hist[lo]; hist[lo] = 0; }
  c = cut;
  for (; hi > 0; hi--) { if (c < hist[hi]) { hist[hi] -= c; break; } c -= hist[hi]; hist[hi] = 0; }
  for (lo = 0; lo < 256 && !hist[lo]; lo++);
  for (hi = 255; hi >= 0 && !hist[hi]; hi--);
  const out = new Float32Array(vals.length);
  if (hi <= lo) { out.set(vals); return out; }
  const scale = 255 / (hi - lo), off = -lo * scale;
  for (let i = 0; i < vals.length; i++) {
    const v = Math.round((vals[i] | 0) * scale + off);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// ─────────────── drawing masks with a 2D canvas (stands in for Pillow's ImageDraw) ───────────────
export function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
export function freeCanvas(c) { c.width = c.height = 0; }
/** A grayscale drawing surface: fill/line in 0..255 gray, read back as floats 0..1. */
export class GrayDraw {
  constructor(n, bg = 0) {
    this.n = n;
    this.c = canvas(n, n);
    this.x = this.c.getContext("2d", { willReadFrequently: true });
    this.x.fillStyle = `rgb(${bg},${bg},${bg})`;
    this.x.fillRect(0, 0, n, n);
    this.x.lineJoin = "round";
    this.x.lineCap = "butt";
  }
  putFloat(a) {   // start from a float image 0..1
    const im = this.x.createImageData(this.n, this.n), d = im.data;
    for (let i = 0; i < a.d.length; i++) {
      const v = clamp(a.d[i]) * 255 + 0.5;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    this.x.putImageData(im, 0, 0);
  }
  line(pts, v, width) {
    if (pts.length < 2) return;
    const x = this.x;
    x.strokeStyle = `rgb(${v},${v},${v})`;
    x.lineWidth = width;
    x.beginPath();
    x.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
    x.stroke();
  }
  polygon(pts, fill, outline = null) {
    if (pts.length < 3) return;
    const x = this.x;
    x.beginPath();
    x.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
    x.closePath();
    if (fill !== null && fill !== undefined) { x.fillStyle = `rgb(${fill},${fill},${fill})`; x.fill(); }
    if (outline !== null) { x.strokeStyle = `rgb(${outline},${outline},${outline})`; x.lineWidth = 1; x.stroke(); }
  }
  read() {
    const d = this.x.getImageData(0, 0, this.n, this.n).data, out = new Float32Array(this.n * this.n);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
    return { w: this.n, h: this.n, d: out };
  }
  free() { freeCanvas(this.c); }
}

export function b64bytes(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Decode a base64 JPEG/PNG into a grayscale float image (optionally resized). */
export async function decodeGray(b64, w = null, h = null, mime = "image/jpeg") {
  const blob = new Blob([b64bytes(b64)], { type: mime });
  const bmp = await createImageBitmap(blob);
  const W = w || bmp.width, H = h || bmp.height;
  const c = canvas(W, H), x = c.getContext("2d", { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  x.drawImage(bmp, 0, 0, W, H);
  bmp.close && bmp.close();
  const d = x.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  freeCanvas(c);
  return { w: W, h: H, d: out };
}

export const nextTick = () => new Promise(r => setTimeout(r, 0));
