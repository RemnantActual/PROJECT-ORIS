// ORIS web — the render engine: camera, vector overlays (2D canvas) and the per-pixel passes (WebGL2).
// Port of oris.py (Cam, CamPath, Overlay, Frame) and oris_gpu.py + shaders/. The frame lives on the GPU as a
// float texture from the first map pass to the last post pass; only the two overlay canvases are uploaded.
//
// Pixel convention: (x, y) with y going DOWN the screen, pixel centres at +.5, exactly like the numpy arrays
// in oris.py. GL rows run bottom-up, so screen row y is stored in GL row H-1-y everywhere (frame textures,
// overlays as uploaded from a canvas, and the canvas the finished frame is drawn to) and nothing is flipped.
import { ACC, DW, DH, EASE, MAP_TINT, PALE, RED, clamp, hexc, hsh, rng } from "./util.js";

// ─────────────────────────── 3x3 matrices ───────────────────────────
const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const T = (x, y) => [[1, 0, x], [0, 1, y], [0, 0, 1]];
function inv(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const apply = (H, x, y) => {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
};

// ─────────────────────────── camera ───────────────────────────
/** 2.5D camera over the world plane. center: world point at screen centre, span: world width across the
 *  screen, rot: radians, tilt: 0 (top-down) .. 0.7 (strong perspective). */
export class Cam {
  constructor(center = [0.5, 0.5], span = 1, rot = 0, tilt = 0) {
    this.center = center; this.span = span; this.rot = rot; this.tilt = Math.min(tilt, 0.75);
    this._H = null;
  }
  H() {
    if (this._H) return this._H;
    const s = DW / this.span, c = Math.cos(this.rot), sn = Math.sin(this.rot);
    const A = mul([[s * c, -s * sn, 0], [s * sn, s * c, 0], [0, 0, 1]], T(-this.center[0], -this.center[1]));
    const k = (-this.tilt * 1.3) / DH;
    const P = [[1, 0, 0], [0, 1 - 0.25 * this.tilt, 0], [0, k, 1]];
    return (this._H = mul(mul(T(DW / 2, DH / 2 + this.tilt * 50), P), A));
  }
  /** World points → design-px points. */
  proj(pts) { const H = this.H(); return pts.map(p => apply(H, p[0], p[1])); }
  pt(p) { return apply(this.H(), p[0], p[1]); }
}

/** Camera keyframes. Zoom is interpolated in log space, so a 100x zoom feels as steady as a 2x one. */
export class CamPath {
  constructor() { this.keys = []; }
  add(t, center, span, rot = 0, tilt = 0.3, ease = "inout") { this.keys.push([t, center, span, rot, tilt, ease]); return this; }
  at(t) {
    const k = this.keys;
    if (t <= k[0][0]) { const [, c, s, r, tl] = k[0]; return new Cam(c, s, r, tl); }
    for (let i = 0; i + 1 < k.length; i++) {
      const k0 = k[i], k1 = k[i + 1];
      if (t <= k1[0]) {
        const u = EASE[k1[5]]((t - k0[0]) / Math.max(1e-6, k1[0] - k0[0]));
        const span = Math.exp(Math.log(k0[2]) + (Math.log(k1[2]) - Math.log(k0[2])) * u);
        const c = [k0[1][0] + (k1[1][0] - k0[1][0]) * u, k0[1][1] + (k1[1][1] - k0[1][1]) * u];
        return new Cam(c, span, k0[3] + (k1[3] - k0[3]) * u, k0[4] + (k1[4] - k0[4]) * u);
      }
    }
    const [, c, s, r, tl] = k[k.length - 1];
    return new Cam(c, s, r, tl);
  }
}

// ─────────────────────────── overlay (vector layer on a 2D canvas) ───────────────────────────
// Font files and their ascender/descender (fractions of the em, as Pillow's getmetrics reports them).
export const FONTS = {
  mono: ["OrisMono", "fonts/DejaVuSansMono.ttf", 0.929, 0.236],
  monob: ["OrisMonoB", "fonts/DejaVuSansMono-Bold.ttf", 0.929, 0.236],
  thin: ["OrisThin", "fonts/DejaVuSans-ExtraLight.ttf", 0.929, 0.236],
  glyph: ["OrisGlyph", "fonts/FreeMono.ttf", 0.8, 0.2],
  bold: ["OrisBold", "fonts/DejaVuSansCondensed-Bold.ttf", 0.929, 0.236],
};
let fontsReady = null;
export function loadFonts(base = "") {
  if (!fontsReady) {
    fontsReady = Promise.all(Object.values(FONTS).map(async ([fam, url]) => {
      const ff = new FontFace(fam, `url(${base}${url})`);
      await ff.load();
      document.fonts.add(ff);
    }));
  }
  return fontsReady;
}

/** Anti-aliased vector drawing in design px (premultiplied once it reaches the GPU). */
export class Overlay {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.f = W / DW;
    this.c = document.createElement("canvas");
    this.c.width = W; this.c.height = H;
    this.x = this.c.getContext("2d");
    this.x.lineJoin = "round";
    this.x.lineCap = "butt";
    this.used = false;
    this._font = "";
    this._imgs = new WeakMap();
  }
  reset() { this.x.clearRect(0, 0, this.W, this.H); this.used = false; }
  _c(col, a) {
    return `rgba(${Math.round(clamp(col[0]) * 255)},${Math.round(clamp(col[1]) * 255)},${Math.round(clamp(col[2]) * 255)},${clamp(a)})`;
  }
  _w(w) { return Math.max(1, Math.round(w * this.f * 2)) / 2; }
  _path(pts, close = false) {
    const x = this.x, f = this.f;
    x.beginPath();
    x.moveTo(pts[0][0] * f, pts[0][1] * f);
    for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0] * f, pts[i][1] * f);
    if (close) x.closePath();
  }
  line(pts, col, a = 1, w = 1) {
    if (a <= 0.004 || pts.length < 2) return;
    this.used = true;
    this._path(pts);
    this.x.strokeStyle = this._c(col, a);
    this.x.lineWidth = this._w(w);
    this.x.stroke();
  }
  dashed(pts, col, a = 1, w = 1, dash = 10, gap = 7, phase = 0) {
    if (a <= 0.004 || pts.length < 2) return;
    const seg = [], cum = [0];
    for (let i = 0; i + 1 < pts.length; i++) {
      seg.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
      cum.push(cum[i] + seg[i]);
    }
    const total = cum[cum.length - 1], period = Math.max(dash + gap, 1e-3);
    if (total <= 0 || total / period > 20000) return;
    const at = d => {
      let i = 0;
      while (i < seg.length - 1 && cum[i + 1] <= d) i++;
      const u = seg[i] === 0 ? 0 : (d - cum[i]) / seg[i];
      return [[pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u], i];
    };
    for (let d0 = (((phase % period) + period) % period) - period; d0 < total; d0 += period) {
      const a0 = Math.max(d0, 0), a1 = Math.min(d0 + dash, total);
      if (a1 > a0) {
        const [p0, i0] = at(a0), [p1, i1] = at(a1);
        const run = [p0];
        for (let j = i0 + 1; j <= i1; j++) run.push(pts[j]);
        run.push(p1);
        this.line(run, col, a, w);
      }
    }
  }
  poly(pts, col, a = 1, fill = true, w = 1) {
    if (a <= 0.004 || pts.length < 3) return;
    this.used = true;
    this._path(pts, true);
    if (fill) { this.x.fillStyle = this._c(col, a); this.x.fill(); }
    else { this.x.strokeStyle = this._c(col, a); this.x.lineWidth = this._w(w); this.x.stroke(); }
  }
  rect(x, y, w, h, col, a = 1, fill = false, lw = 1) {
    if (a <= 0.004) return;
    this.used = true;
    const f = this.f;
    if (fill) { this.x.fillStyle = this._c(col, a); this.x.fillRect(x * f, y * f, w * f, h * f); return; }
    const L = this._w(lw);
    this.x.strokeStyle = this._c(col, a);
    this.x.lineWidth = L;
    this.x.strokeRect(x * f + L / 2, y * f + L / 2, Math.max(0, w * f - L), Math.max(0, h * f - L));
  }
  circle(c, r, col, a = 1, w = 1, fill = false) {
    if (a <= 0.004 || r <= 0) return;
    this.used = true;
    const f = this.f, x = this.x;
    x.beginPath();
    if (fill) {
      x.arc(c[0] * f, c[1] * f, r * f, 0, Math.PI * 2);
      x.fillStyle = this._c(col, a);
      x.fill();
    } else {
      const L = this._w(w);
      x.arc(c[0] * f, c[1] * f, Math.max(0, r * f - L / 2), 0, Math.PI * 2);
      x.strokeStyle = this._c(col, a);
      x.lineWidth = L;
      x.stroke();
    }
  }
  pie(c, r, a0, a1, col, a = 1) {
    if (a <= 0.004) return;
    this.used = true;
    const f = this.f, x = this.x;
    x.beginPath();
    x.moveTo(c[0] * f, c[1] * f);
    x.arc(c[0] * f, c[1] * f, r * f, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180);
    x.closePath();
    x.fillStyle = this._c(col, a);
    x.fill();
  }
  erase_circle(c, r) {
    const f = this.f, x = this.x;
    x.save();
    x.globalCompositeOperation = "destination-out";
    x.beginPath();
    x.arc(c[0] * f, c[1] * f, r * f, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  _setFont(kind, px) {
    const s = `${Math.max(3, px).toFixed(2)}px ${(FONTS[kind] || FONTS.mono)[0]}`;
    if (s !== this._font) { this.x.font = s; this._font = s; }
  }
  text_w(s, size = 12, kind = "mono", spacing = 0) {
    this._setFont(kind, size * this.f);
    return (this.x.measureText(s).width + spacing * this.f * Math.max(0, [...s].length - 1)) / this.f;
  }
  text(xy, s, col, a = 1, size = 12, kind = "mono", anchor = "la", spacing = 0) {
    if (a <= 0.004 || !s) return;
    this.used = true;
    const f = this.f, px = size * f, fm = FONTS[kind] || FONTS.mono;
    this._setFont(kind, px);
    const x = this.x;
    let X = xy[0] * f, Y = xy[1] * f;
    const v = anchor[1];
    if (v === "a") Y += fm[2] * px;
    else if (v === "m") Y += ((fm[2] - fm[3]) / 2) * px;
    else if (v === "d" || v === "b") Y -= fm[3] * px;
    else if (v === "t") Y += fm[2] * px;
    x.textBaseline = "alphabetic";
    x.fillStyle = this._c(col, a);
    if (!spacing) {
      x.textAlign = anchor[0] === "r" ? "right" : anchor[0] === "m" ? "center" : "left";
      x.fillText(s, X, Y);
      return;
    }
    const total = this.text_w(s, size, kind, spacing) * f;
    this._setFont(kind, px);
    if (anchor[0] === "r") X -= total;
    else if (anchor[0] === "m") X -= total / 2;
    x.textAlign = "left";
    for (const ch of s) {
      x.fillText(ch, X, Y);
      X += x.measureText(ch).width + spacing * f;
    }
  }
  /** Place a grayscale image ({w, h, d} 0..1) tinted with col; brightness = opacity (hologram look). */
  image(gray, x, y, w, h, col, a = 1, cache = false) {
    if (a <= 0.004) return;
    this.used = true;
    const f = this.f;
    let src = cache ? this._imgs.get(gray) : null;
    const tag = col.join() + "|" + a.toFixed(3);
    if (!src || src.tag !== tag) {
      const c = src ? src.c : document.createElement("canvas");
      c.width = gray.w; c.height = gray.h;
      const cx = c.getContext("2d"), im = cx.createImageData(gray.w, gray.h), d = im.data;
      const r = Math.round(col[0] * 255), g = Math.round(col[1] * 255), b = Math.round(col[2] * 255);
      for (let i = 0; i < gray.d.length; i++) {
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b;
        d[i * 4 + 3] = clamp(gray.d[i]) * a * 255 + 0.5;
      }
      cx.putImageData(im, 0, 0);
      src = { c, tag };
      if (cache) this._imgs.set(gray, src);
    }
    this.x.imageSmoothingEnabled = true;
    this.x.drawImage(src.c, Math.trunc(x * f), Math.trunc(y * f), Math.max(1, Math.trunc(w * f)), Math.max(1, Math.trunc(h * f)));
  }
}

// ─────────────────────────── shaders ───────────────────────────
const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uSize;               // frame size in px (W, H)
uniform float uS;                 // W / 1920
uniform vec3 uH0, uH1, uH2;       // inverse camera homography, rows (screen px -> world)
uniform sampler2D uImg;           // the frame so far
out vec4 fragColor;
ivec2 pix() { return ivec2(gl_FragCoord.xy); }
vec2 P() { return vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y); }   // screen px, y down, pixel centre
vec3 img() { return texelFetch(uImg, pix(), 0).rgb; }
float edgeR() { vec2 q = P(); return length(vec2((q.x / uSize.x - .5) * 1.6, (q.y / uSize.y - .5) * 1.6 * uSize.y / uSize.x * 1.3)); }
float vignette() { return clamp(1. - .6 * pow(edgeR(), 2.4), 0., 1.); }
float edge() { return clamp(edgeR(), 0., 1.2); }
float dots() { float p = max(3., 4. * uS); vec2 q = P(); return (mod(q.x, p) < p * .45 && mod(q.y, p) < p * .45) ? 1. : 0.; }
vec2 world() { vec3 p = vec3(P(), 1.); return vec2(dot(uH0, p), dot(uH1, p)) / dot(uH2, p); }
float rect_mask(vec3 r, float feather) {
  vec2 w = world();
  float u = (w.x - r.x) / r.z, v = (w.y - r.y) / r.z;
  return clamp(min(min(u, 1. - u), min(v, 1. - v)) / feather, 0., 1.);
}
// a map texture covering the world rect r (x0, y0, size), mip level uLod; 0 outside it
uniform float uLod;
float mapSample(sampler2D t, vec3 r) {
  vec2 uv = (world() - r.xy) / r.z;
  if (uv.x < 0. || uv.y < 0. || uv.x >= 1. || uv.y >= 1.) return 0.;
  return textureLod(t, uv, uLod).r;
}
// a screen-space affine lookup into a texture (clouds / fog): uv = (P * a.x + a.yz)
float screenSample(sampler2D t, vec3 a) {
  vec2 uv = P() * a.x + a.yz;
  if (uv.x < 0. || uv.y < 0. || uv.x >= 1. || uv.y >= 1.) return 0.;
  return texture(t, uv).r;
}
float pymod(float x, float m) { float r = x - m * floor(x / m); if (r < 0.) r += m; if (r >= m) r -= m; return r; }
`;
const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

const PASSES = {
  map: `uniform sampler2D uTex; uniform vec3 uRect; uniform float uGain, uDots; uniform vec3 uTint;
    void main() { float m = mapSample(uTex, uRect) * uGain; if (uDots != 0.) m *= 1. - uDots * (1. - dots()); fragColor = vec4(m * uTint, 1.); }`,
  layer: `uniform sampler2D uTex; uniform vec3 uRect; uniform float uGain, uA, uFeather; uniform int uHasRect; uniform vec3 uTint;
    void main() { float m = mapSample(uTex, uRect) * uGain; float mask = uHasRect != 0 ? uA * rect_mask(uRect, uFeather) : uA;
      fragColor = vec4(img() * (1. - mask) + (m * mask) * uTint, 1.); }`,
  dots: `uniform float uDots; void main() { fragColor = vec4(img() * (1. - uDots * (1. - dots())), 1.); }`,
  light: `uniform vec2 uC; uniform float uSigma, uAmb, uGainL;
    void main() { vec2 d = world() - uC; fragColor = vec4(img() * (uAmb + uGainL * exp(-dot(d, d) / (uSigma * uSigma))), 1.); }`,
  reveal: `uniform sampler2D uTex; uniform vec3 uRect; uniform int uHasRect; uniform vec3 uCol; uniform vec2 uC; uniform float uR, uA, uSoft;
    void main() { float c = mapSample(uTex, uRect); if (uHasRect != 0) c *= rect_mask(uRect, .08);
      float m = clamp((uR - length(world() - uC)) / uSoft, 0., 1.); fragColor = vec4(img() + (c * m * uA) * uCol, 1.); }`,
  zone: `uniform vec2 uC; uniform float uR, uFill, uPpw, uSoftPx; uniform vec3 uCol;
    void main() { vec3 im = img(); float d = length(world() - uC); float m = clamp((uR - d) * uPpw / uSoftPx, 0., 1.);
      float q = clamp(d / uR, 0., 1.); float k = m * uFill * (.45 + .55 * q * q * q * q);
      fragColor = vec4(im * (1. - k) + k * uCol * (.22 + 1.7 * im), 1.); }`,
  hazards: `uniform sampler2D uTex; uniform vec3 uRect; uniform vec3 uEm[64]; uniform int uN; uniform vec3 uCol;
    void main() { vec3 im = img(); float N = mapSample(uTex, uRect); vec2 w = world(); float A = 0.;
      for (int i = 0; i < 64; i++) { if (i >= uN) break;
        float fall = clamp(1. - length(w - uEm[i].xy) / uEm[i].z, 0., 1.);
        A = max(A, clamp((fall * 1.25 + N - 1.05) * 1.7, 0., 1.) * (.55 + .45 * fall)); }
      float speck = clamp((N - .62) * 6., 0., 1.);
      fragColor = vec4(im * (1. - .6 * A) + A * uCol * (.25 + .95 * N) * (1. - .5 * speck), 1.); }`,
  wedge: `uniform vec2 uC; uniform float uR, uAng, uWidth, uA; uniform vec3 uCol;
    void main() { vec3 im = img(); vec2 dv = world() - uC; float d = length(dv);
      float behind = pymod(uAng - atan(dv.y, dv.x), 6.2831855);
      float trail = exp(-behind / uWidth) * clamp((uR - d) / (uR * .08), 0., 1.);
      fragColor = vec4(im + (trail * uA) * uCol * (.35 + im), 1.); }`,
  reveal_swept: `uniform sampler2D uTex; uniform vec3 uRect; uniform vec2 uC; uniform float uR, uA0, uSwept, uA; uniform vec3 uCol;
    void main() { float c = mapSample(uTex, uRect); vec2 dv = world() - uC; float d = length(dv);
      float done = pymod(atan(dv.y, dv.x) - uA0, 6.2831855) <= uSwept ? 1. : 0.;
      float m = done * clamp((uR - d) / (uR * .06), 0., 1.); fragColor = vec4(img() + (c * m * uA) * uCol, 1.); }`,
  clouds: `uniform sampler2D uTex; uniform vec3 uAff; uniform float uStrength, uReach; uniform vec3 uCol;
    void main() { vec3 im = img(); float C = screenSample(uTex, uAff);
      float a = clamp((C * .9 + edge() * 1.25 * uReach - 1.05) * 2.6, 0., 1.) * uStrength;
      fragColor = vec4(im * (1. - a) + a * uCol * (.6 + .8 * C), 1.); }`,
  fog: `uniform sampler2D uTex; uniform vec3 uAff; uniform float uAmount, uK; uniform vec3 uCol;
    void main() { vec3 im = img(); float C = screenSample(uTex, uAff);
      float a = clamp((C - (1. - uAmount) * 1.05) * 3., 0., 1.) * uK;
      fragColor = vec4(im * (1. - a) + a * uCol * (.7 + .4 * C), 1.); }`,
  tint: `uniform vec3 uCol; uniform float uAmount; void main() { vec3 im = img(); fragColor = vec4(im * (1. - uAmount) + im * uCol * uAmount * 1.4, 1.); }`,
  edgefade: `void main() { fragColor = vec4(img() * clamp(1.35 - edge() * 1.1, 0., 1.), 1.); }`,
  add: `uniform vec3 uCol; void main() { fragColor = vec4(img() + uCol, 1.); }`,
  over: `uniform sampler2D uOv; uniform float uK, uG; uniform int uSS;
    void main() { ivec2 q = ivec2(int(P().x), int(P().y)); vec4 o;
      if (uSS == 2) { q *= 2; o = (texelFetch(uOv, q, 0) + texelFetch(uOv, q + ivec2(1, 0), 0) + texelFetch(uOv, q + ivec2(0, 1), 0)
                                  + texelFetch(uOv, q + ivec2(1, 1), 0)) * .25; }
      else o = texelFetch(uOv, q, 0);
      fragColor = vec4(img() * (1. - o.a * uK) + o.rgb * uG * uK, 1.); }`,
  post: `uniform int uReveal, uScan; uniform float uEdge, uScanY; uniform vec3 uPale;
    void main() { vec3 im = img(); float Y = P().y;
      if (uReveal != 0) im *= clamp((uEdge - Y) / (14. * uS), 0., 1.);
      if (uScan != 0) { float d = abs(Y - uScanY) / uS; im += (exp(-d / 1.2) * .9 + exp(-d / 18.) * .18) * uPale; }
      fragColor = vec4(im, 1.); }`,
  // bloom: bright parts shrunk 4x (box average), blurred at two radii, added back
  bdown: `uniform float uThr;
    void main() { ivec2 o = pix() * 4; ivec2 n = textureSize(uImg, 0) - 1; vec3 acc = vec3(0.);
      for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
        acc += clamp((texelFetch(uImg, min(o + ivec2(i, j), n), 0).rgb - uThr) * 2., 0., 1.);
      fragColor = vec4(acc / 16., 1.); }`,
  bblur: `uniform sampler2D uSrc; uniform vec2 uDir; uniform float uSigma;
    void main() { ivec2 o = pix(); ivec2 n = textureSize(uSrc, 0) - 1; int R = int(ceil(uSigma * 3.));
      vec3 acc = vec3(0.); float tw = 0.;
      for (int k = -40; k <= 40; k++) { if (k < -R || k > R) continue;
        float w = exp(-float(k * k) / (2. * uSigma * uSigma));
        acc += texelFetch(uSrc, clamp(o + ivec2(uDir) * k, ivec2(0), n), 0).rgb * w; tw += w; }
      fragColor = vec4(acc / tw, 1.); }`,
  badd: `uniform sampler2D uG1, uG2; uniform float uStrength;
    void main() { vec2 uv = gl_FragCoord.xy / uSize;
      fragColor = vec4(img() + (texture(uG1, uv).rgb * .6 + texture(uG2, uv).rgb * .4) * uStrength, 1.); }`,
  // vignette, flicker, film grain, fade
  final: `uniform float uFlick, uFade; uniform int uF;
    uint hash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
    void main() { ivec2 p = pix(); vec3 im = img() * vignette(); im *= uFlick;
      uint h = hash(uint(p.x) + hash(uint(p.y) + hash(uint(uF) * 7919u)));
      float u1 = (float(h & 0xffffu) + .5) / 65536., u2 = (float(h >> 16) + .5) / 65536.;
      float g = sqrt(-2. * log(u1)) * cos(6.2831853 * u2);
      im += (g * .028) * (.35 + im); im *= uFade;
      fragColor = vec4(clamp(im, 0., 1.), 1.); }`,
  // finished frame to the canvas, through the glitch (row tears + colour split) when there is one
  present: `uniform sampler2D uOut; uniform vec3 uBands[16]; uniform int uNB, uK;
    void main() { ivec2 o = pix(); int W = int(uSize.x); int y = int(P().y); int S = 0;
      for (int i = 0; i < 16; i++) { if (i >= uNB) break; if (y >= int(uBands[i].x) && y < int(uBands[i].x + uBands[i].y)) S += int(uBands[i].z); }
      int xr = ((o.x - uK - S) % W + W) % W, xg = ((o.x - S) % W + W) % W, xb = ((o.x + uK - S) % W + W) % W;
      fragColor = vec4(texelFetch(uOut, ivec2(xr, o.y), 0).r, texelFetch(uOut, ivec2(xg, o.y), 0).g, texelFetch(uOut, ivec2(xb, o.y), 0).b, 1.); }`,
};

// ─────────────────────────── engine ───────────────────────────
export class Engine {
  constructor(W, H) {
    this.W = W; this.H = H; this.s = W / DW;
    const c = this.canvas = document.createElement("canvas");
    c.width = W; c.height = H;
    const gl = this.gl = c.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error("this browser has no WebGL2");
    this.lost = false;
    c.addEventListener("webglcontextlost", e => { e.preventDefault(); this.lost = true; });
    const fl = gl.getExtension("EXT_color_buffer_float") ? "f32" : gl.getExtension("EXT_color_buffer_half_float") ? "f16" : null;
    gl.getExtension("OES_texture_float_linear");
    this.fmt = fl === "f32" ? [gl.RGBA16F, gl.HALF_FLOAT] : fl === "f16" ? [gl.RGBA16F, gl.HALF_FLOAT] : [gl.RGBA8, gl.UNSIGNED_BYTE];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.vao = gl.createVertexArray();
    const vs = this._shader(gl.VERTEX_SHADER, VERT);
    this.prog = {};
    for (const [name, body] of Object.entries(PASSES)) {
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, PRELUDE + body, name));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`shader ${name}: ${gl.getProgramInfoLog(p)}`);
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        u[info.name.replace(/\[0\]$/, "")] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
      }
      this.prog[name] = { p, u };
    }
    this.img = [this._target(W, H, this.fmt), this._target(W, H, this.fmt)];
    this.cur = 0;
    this.out = this._target(W, H, [gl.RGBA8, gl.UNSIGNED_BYTE]);
    const sw = Math.max(1, Math.floor(W / 4)), sh = Math.max(1, Math.floor(H / 4));
    this.bs = [0, 1, 2, 3].map(() => this._target(sw, sh, [gl.RGBA8, gl.UNSIGNED_BYTE], true));
    this.ovTex = [this._tex2d(), this._tex2d()];
    // overlays are drawn at 2x for small frames and shrunk on the GPU (as oris.py does), so thin lines and
    // small text keep their weight in previews; at full HD the canvas's own anti-aliasing is enough
    this.ss = W < 1600 ? 2 : 1;
    this.ov = new Overlay(W * this.ss, H * this.ss);
    this.hud = new Overlay(W * this.ss, H * this.ss);
  }
  _shader(type, src, name = "vert") {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader ${name}: ${gl.getShaderInfoLog(s)}`);
    return s;
  }
  _tex2d(linear = false) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _target(w, h, [ifmt, type], linear = false) {
    const gl = this.gl, tex = this._tex2d(linear);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, gl.RGBA, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      if (ifmt !== gl.RGBA8) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); this.fmt = [gl.RGBA8, gl.UNSIGNED_BYTE]; return this._target(w, h, this.fmt, linear); }
      throw new Error("this browser can't draw into textures");
    }
    return { tex, fbo, w, h };
  }
  /** Upload a grayscale 8-bit map ({w, h, d: Uint8Array}) with mipmaps. */
  mapTex(g8) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, g8.w, g8.h, 0, gl.RED, gl.UNSIGNED_BYTE, g8.d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    let levels = 1;
    for (let w = g8.w; w > 600; w = Math.floor(w / 2)) levels++;
    return { tex: t, n: g8.w, levels };
  }
  freeTex(t) { if (t && t.tex) this.gl.deleteTexture(t.tex); }
  /** Give the GPU context back right away (browsers only allow a handful at once). */
  destroy() {
    const x = this.gl.getExtension("WEBGL_lose_context");
    if (x) x.loseContext();
    this.canvas.width = this.canvas.height = 1;
    for (const o of [this.ov, this.hud]) o.c.width = o.c.height = 1;
  }

  _run(name, target, tex, uni) {
    const gl = this.gl, P = this.prog[name];
    gl.useProgram(P.p);
    let unit = 0;
    const all = Object.assign({ uSize: [target ? target.w : this.W, target ? target.h : this.H], uS: this.s }, uni);
    for (const [k, t] of Object.entries(tex)) {
      const u = P.u[k];
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u.loc, unit++);
    }
    for (const [k, v] of Object.entries(all)) {
      const u = P.u[k];
      if (!u) continue;
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v instanceof Float32Array ? v : new Float32Array(v.flat ? v.flat() : v)); break;
        case gl.INT: gl.uniform1i(u.loc, v); break;
        default: break;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.W, target ? target.h : this.H);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** Run a pass over the frame: reads the current image, writes the other one, swaps. */
  step(name, tex = {}, uni = {}) {
    this._run(name, this.img[1 - this.cur], Object.assign({ uImg: this.img[this.cur].tex }, tex), uni);
    this.cur = 1 - this.cur;
  }
  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.img[this.cur].fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  bloom(thr, strength, radius) {
    const [a, b, g1, g2] = this.bs, src = this.img[this.cur].tex;
    this._run("bdown", a, { uImg: src }, { uThr: thr });
    const sig = [(radius * this.s) / 4, (radius * 3 * this.s) / 4];
    [g1, g2].forEach((g, j) => {
      this._run("bblur", b, { uSrc: a.tex }, { uDir: [1, 0], uSigma: Math.max(0.3, sig[j]) });
      this._run("bblur", g, { uSrc: b.tex }, { uDir: [0, 1], uSigma: Math.max(0.3, sig[j]) });
    });
    this.step("badd", { uG1: g1.tex, uG2: g2.tex }, { uStrength: strength });
  }
  overlay(o, idx, k = 1, g = 1) {
    const gl = this.gl, t = this.ovTex[idx];
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.step("over", { uOv: t }, { uK: k, uG: g, uSS: this.ss });
  }
  final(flick, fade, f, glitch) {
    this._run("final", this.out, { uImg: this.img[this.cur].tex }, { uFlick: flick, uFade: fade, uF: f });
    this._run("present", null, { uOut: this.out.tex }, glitch);
  }
  /** The finished frame as RGBA bytes, top row first. */
  readRGBA() {
    const gl = this.gl, W = this.W, H = this.H, buf = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8Array(buf.length), row = W * 4;
    for (let y = 0; y < H; y++) out.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    return out;
  }
}

// ─────────────────────────── frame (compositor) ───────────────────────────
export class Frame {
  constructor(eng, t, f) {
    this.e = eng; this.t = t; this.f = f;
    eng.clear();
    eng.ov.reset();
    eng.hud.reset();
    this.ov = eng.ov;      // world-space graphics: fogged and bloomed
    this.hud = eng.hud;    // screen chrome: always on top
    this.cam = null;
    this.glitch = 0;
    this.fade = 1;
    this.hud_alpha = 1;    // HUD power-on
    this.reveal_y = 1;     // boot scan line: map shown above this fraction of the screen
    this.scan_y = null;    // bright scan line at this fraction of the screen height
  }
  set_cam(cam) {
    this.cam = cam;
    const s = this.e.s;
    this.Hr = mul([[s, 0, 0], [0, s, 0], [0, 0, 1]], cam.H());
    const Hi = inv(this.Hr);
    this.cu = { uH0: Hi[0], uH1: Hi[1], uH2: Hi[2] };
    this.Hi = Hi;
  }
  P(p) { return this.cam.pt(p); }
  _lod(tex, rect) {
    const size = rect ? rect[2] : 1;
    for (let k = 0; k < tex.levels; k++) if ((tex.n / 2 ** k) * this.cam.span / (size * this.e.W) <= 1.5) return k;
    return tex.levels - 1;
  }
  _tex(tex, rect) {
    return [{ uTex: tex.tex }, { uRect: rect || [0, 0, 1], uLod: this._lod(tex, rect), ...this.cu }];
  }
  map(tex, tint = MAP_TINT, gain = 1, dots = 0.18) {
    const [t, u] = this._tex(tex);
    this.e.step("map", t, { ...u, uGain: gain, uDots: dots || 0, uTint: tint });
  }
  /** Several map textures placed in one world, coarse first, detail on top (feathered edges).
   *  layer = {tex, rect: [x0, y0, size] or null, a: opacity, tint, gain, feather} */
  map_layers(layers, dots = 0.18) {
    this.e.clear();
    for (const L of layers) {
      const a = L.a === undefined ? 1 : L.a;
      if (a <= 0.003) continue;
      const [t, u] = this._tex(L.tex, L.rect);
      this.e.step("layer", t, { ...u, uGain: L.gain || 1, uA: a, uHasRect: L.rect ? 1 : 0, uFeather: L.feather || 0.08, uTint: L.tint || MAP_TINT });
    }
    if (dots) this.e.step("dots", {}, { uDots: dots });
  }
  /** World coords of the screen corners (what the camera sees). */
  footprint() {
    const W = this.e.W, H = this.e.H;
    return [[0.5, 0.5], [W - 0.5, 0.5], [W - 0.5, H - 0.5], [0.5, H - 0.5]].map(([x, y]) => apply(this.Hi, x, y));
  }
  light(center, sigma, amb = 0.35, gain = 1.4) {
    this.e.step("light", {}, { ...this.cu, uC: center, uSigma: sigma, uAmb: amb, uGainL: gain });
  }
  /** Add a texture (e.g. contour lines) inside a world-space circle. */
  reveal(tex, center, radius, col = PALE, a = 0.6, soft = 0.015, rect = null) {
    if (radius <= 0 || a <= 0) return;
    const [t, u] = this._tex(tex, rect);
    this.e.step("reveal", t, { ...u, uHasRect: rect ? 1 : 0, uC: center, uR: radius, uA: a, uSoft: soft, uCol: col });
  }
  /** Tinted disk on the map (keeps terrain detail visible). */
  zone(center, R, col = RED, fill = 0.5, softPx = 1.5) {
    if (R <= 0 || fill <= 0) return;
    this.e.step("zone", {}, { ...this.cu, uC: center, uR: R, uFill: fill, uPpw: this.e.W / this.cam.span, uSoftPx: softPx, uCol: col });
  }
  /** Clouds that bloom out of world points. emitter: {p: [x, y], t: start, r: radius, grow: seconds}. */
  hazards(noise, emitters, col = ACC) {
    const live = emitters.filter(e => this.t > e.t).slice(0, 64);
    if (!live.length) return;
    const em = new Float32Array(64 * 3);
    live.forEach((e, i) => {
      const g = ramp_(this.t, e.t, e.t + (e.grow || 2), "out");
      em.set([e.p[0], e.p[1], Math.max(e.r * g, 1e-4)], i * 3);
    });
    const [t, u] = this._tex(noise);
    this.e.step("hazards", t, { ...u, uEm: em, uN: live.length, uCol: col });
  }
  /** Radar sweep: bright leading edge at angle `ang` (radians), fading trail behind it. */
  wedge(center, R, ang, width = 0.6, col = PALE, a = 0.35) {
    if (a <= 0 || R <= 0) return;
    this.e.step("wedge", {}, { ...this.cu, uC: center, uR: R, uAng: ang, uWidth: width, uA: a, uCol: col });
  }
  /** Reveal a texture (contours) in the wake of a sweep that started at a0 and has turned `swept` radians. */
  reveal_swept(tex, center, R, a0, swept, col = PALE, a = 0.5) {
    if (swept <= 0 || a <= 0) return;
    const [t, u] = this._tex(tex);
    this.e.step("reveal_swept", t, { ...u, uC: center, uR: R, uA0: a0, uSwept: swept, uA: a, uCol: col });
  }
  /** Dark cloud banks creeping in from the screen edges. */
  clouds(strength = 1, col = CLOUD_COL, reach = 1) {
    if (strength <= 0) return;
    const e = this.e, n = e.cloud.n, sc = n / (e.W * 1.6);
    const aff = [sc / n, (n * 0.1 + this.t * 4) / n, (n * 0.15) / n];
    this.e.step("clouds", { uTex: e.cloud.tex }, { uAff: aff, uStrength: strength, uReach: reach, uCol: col });
  }
  tint(col, amount) { if (amount > 0) this.e.step("tint", {}, { uCol: col, uAmount: amount }); }
  /** Screen-space cloud bank (fly-through transition). */
  fog(amount, zoom = 1, drift = [0, 0], col = FOG_COL) {
    if (amount <= 0) return;
    const e = this.e, W = e.W, H = e.H, n = e.cloud.n, sc = n / (W * 1.15) / zoom;
    const aff = [sc / n, (n / 2 - (sc * W) / 2 + drift[0] * n) / n, (n / 2 - (sc * H) / 2 + drift[1] * n) / n];
    this.e.step("fog", { uTex: e.cloud.tex }, { uAff: aff, uAmount: amount, uK: clamp(amount * 2.2), uCol: col });
  }
  /** Pool of light behind the outro card (fr.img *= clip(1.35 - edge * 1.1) in oris.py). */
  edgeFade() { this.e.step("edgefade"); }
  /** fr.img += col * k */
  addColor(col, k) { if (k > 0) this.e.step("add", {}, { uCol: col.map(v => v * k) }); }

  finish() {
    const e = this.e;
    if (this.ov.used) e.overlay(this.ov, 0);
    e.bloom(0.55, 0.55, 16);
    if (this.reveal_y < 1 || this.scan_y !== null)
      e.step("post", {}, { uReveal: this.reveal_y < 1 ? 1 : 0, uEdge: this.reveal_y * e.H, uScan: this.scan_y !== null ? 1 : 0,
                           uScanY: (this.scan_y || 0) * e.H, uPale: PALE });
    if (this.hud.used && this.hud_alpha > 0) {
      e.overlay(this.hud, 1, this.hud_alpha, 0.95);
      e.bloom(0.85, 0.25, 6);
    }
    const g = { uNB: 0, uK: 0, uBands: new Float32Array(48) };
    if (this.glitch > 0) {
      const amt = this.glitch, r = rng(this.f * 7 + 3), H = e.H, s = e.W / DW;
      const n = Math.min(16, Math.trunc(3 + amt * 9));
      for (let i = 0; i < n; i++) {
        const y0 = r.integers(0, H), h = r.integers(2, Math.trunc(H * 0.07 * amt) + 4), sh = Math.trunc(r.normal(0, 60 * amt * s));
        g.uBands.set([y0, h, sh], i * 3);
      }
      g.uNB = n;
      g.uK = Math.round(7 * amt * s);
    }
    e.final(1 - 0.035 * hsh(this.f, 3), this.fade, this.f, g);
  }
}
const CLOUD_COL = hexc("#1a1d1c"), FOG_COL = hexc("#c9cdcb");
function ramp_(t, t0, t1, ease) {
  if (t1 <= t0) return t >= t0 ? 1 : 0;
  return EASE[ease](clamp((t - t0) / (t1 - t0)));
}
