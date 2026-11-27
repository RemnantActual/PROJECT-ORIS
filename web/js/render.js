// Place file → video file, in the browser.
import { ArrayBufferTarget, Muxer } from "../vendor/mp4-muxer.mjs";
import { Engine, Frame, loadFonts } from "./engine.js";
import { Scene } from "./scene.js";
import * as S from "./sound.js";
import { addPcmTrack } from "./mov.js";

const yieldNow = (() => {   // a macrotask without setTimeout's 4 ms clamp, so the page stays responsive
  const ch = new MessageChannel(), q = [];
  ch.port1.onmessage = () => q.shift()();
  return () => new Promise(r => { q.push(r); ch.port2.postMessage(0); });
})();

const VIDEO = [
  ["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42e028", "avc"], ["avc1.640032", "avc"],
  ["vp09.00.40.08", "vp9"], ["av01.0.08M.08", "av1"],
];
const AUDIO = [["mp4a.40.2", "aac"], ["opus", "opus"]];

async function pickVideo(W, H) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const [codec, mux] of VIDEO) {
    const cfg = { codec, width: W, height: H, bitrate: W >= 1920 ? 12e6 : 5e6, framerate: 30 };
    if (mux === "avc") cfg.avc = { format: "avc" };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch (e) { /* try the next */ }
  }
  return null;
}
async function pickAudio() {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
  for (const [codec, mux] of AUDIO) {
    const cfg = { codec, sampleRate: S.SR, numberOfChannels: 2, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch (e) { /* try the next */ }
  }
  return null;
}

/** What this browser can do: { ok, why, video, audio } */
export async function capabilities() {
  const c = document.createElement("canvas");
  if (!c.getContext("webgl2")) return { ok: false, why: "this browser has no WebGL2 (needs iOS 15 or newer)" };
  const v = await pickVideo(1920, 1080) || await pickVideo(960, 540);
  if (!v) return { ok: false, why: "this browser can't encode video (WebCodecs; needs iOS 16.4 or newer, or a current Chrome/Edge/Safari)" };
  const a = await pickAudio();
  return { ok: true, video: v.cfg.codec, audio: a ? a.cfg.codec : null };
}

export const SIZES = { preview: [960, 540], full: [1920, 1080] };

/** Set up an engine + scene for a place file. */
async function prepare(place, fileKey, mode, onProgress) {
  const [W, H] = SIZES[mode] || SIZES.preview;
  await loadFonts();
  const eng = new Engine(W, H);
  const scene = new Scene(place, fileKey);
  await scene.setup(eng, (f, what) => onProgress({ phase: "build", frac: f, what }));
  return { eng, scene, W, H };
}

/** One frame at time t as a PNG data URL (for checking the look). */
export async function still(place, fileKey, t, mode = "preview") {
  const { eng, scene } = await prepare(place, fileKey, mode, () => {});
  try {
    const f = Math.round(t * scene.fps), fr = new Frame(eng, f / scene.fps, f);
    scene.frame(fr);
    fr.finish();
    return eng.canvas.toDataURL("image/png");
  } finally { eng.destroy(); }
}

// Safari: sound as PCM in a .mov (its audio encoder is missing before iOS 26). Elsewhere: AAC/Opus in an .mp4.
const APPLE = typeof navigator !== "undefined" && /Apple/.test(navigator.vendor || "");

/** Render the whole sequence. Returns { blob, ext: 'mp4'|'mov', seconds, frames, audio: 'aac'|'opus'|'pcm'|null }. */
export async function render(place, fileKey, mode, { onProgress = () => {}, signal = null, pcm = APPLE } = {}) {
  const t0 = performance.now();
  const { eng, scene, W, H } = await prepare(place, fileKey, mode, onProgress);
  try { return await encode(eng, scene, W, H, t0, onProgress, signal, pcm); } finally { eng.destroy(); }
}

async function encode(eng, scene, W, H, t0, onProgress, signal, pcm) {
  const check = () => {
    if (signal && signal.aborted) throw new Error("cancelled");
    if (eng.lost) throw new Error("the graphics context was lost (the app went to the background?). Keep ORIS open on screen while it renders");
  };
  const vid = await pickVideo(W, H);
  if (!vid) throw new Error("this browser can't encode video");
  let aud = null, mixed = null;
  if (scene.opt.sound !== false) {
    onProgress({ phase: "sound", frac: 0, what: "synthesizing sound" });
    await yieldNow();
    const mix = new S.Mix(scene.duration);
    scene.sounds(mix, S);
    mixed = mix.render();
    if (!pcm) aud = await pickAudio();
    if (!aud) pcm = true;   // no audio encoder here: the sound goes in as PCM
  }
  check();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: mixed && pcm ? false : "in-memory", firstTimestampBehavior: "offset",
    video: { codec: vid.mux, width: W, height: H, frameRate: scene.fps },
    ...(aud ? { audio: { codec: aud.mux, numberOfChannels: 2, sampleRate: S.SR } } : {}),
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { encErr = e; } });
  venc.configure(vid.cfg);
  const N = scene.frames, fps = scene.fps, dur = 1e6 / fps;
  const tr = performance.now();
  for (let f = 0; f < N; f++) {
    check();
    if (encErr) throw encErr;
    const fr = new Frame(eng, f / fps, f);
    scene.frame(fr);
    fr.finish();
    const ts = Math.round(f * dur);
    // frames go to the encoder as pixel buffers: WebKit has had bugs making VideoFrames straight from a WebGL canvas
    const vf = new VideoFrame(eng.readRGBA(), { format: "RGBA", codedWidth: W, codedHeight: H, timestamp: ts, duration: Math.round(dur) });
    venc.encode(vf, { keyFrame: f % 60 === 0 });
    vf.close();
    while (venc.encodeQueueSize > 3) await new Promise(r => setTimeout(r, 2));
    if (f % 2 === 0 || f === N - 1) {
      const el = (performance.now() - tr) / 1000, left = (el / (f + 1)) * (N - f - 1);
      onProgress({ phase: "frames", frac: (f + 1) / N, frame: f + 1, frames: N, left });
    }
    await yieldNow();
  }
  await venc.flush();
  venc.close();
  if (encErr) throw encErr;
  if (aud && mixed) {
    onProgress({ phase: "audio", frac: 1, what: "adding sound" });
    let aErr = null;
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { aErr = e; } });
    aenc.configure(aud.cfg);
    const [L, R] = mixed, n = L.length, step = 4800;
    for (let i = 0; i < n; i += step) {
      const m = Math.min(step, n - i), data = new Float32Array(m * 2);
      data.set(L.subarray(i, i + m), 0);
      data.set(R.subarray(i, i + m), m);
      const ad = new AudioData({ format: "f32-planar", sampleRate: S.SR, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((i / S.SR) * 1e6), data });
      aenc.encode(ad);
      ad.close();
      if (aErr) break;
    }
    await aenc.flush();
    aenc.close();
    if (aErr) throw aErr;
  }
  muxer.finalize();
  const seconds = () => (performance.now() - t0) / 1000;
  if (mixed && !aud) {
    onProgress({ phase: "audio", frac: 1, what: "adding sound" });
    const mov = addPcmTrack(new Uint8Array(target.buffer), mixed[0], mixed[1], S.SR);
    return { blob: new Blob([mov], { type: "video/quicktime" }), ext: "mov", seconds: seconds(), frames: N, audio: "pcm", codec: vid.cfg.codec };
  }
  const blob = new Blob([target.buffer], { type: "video/mp4" });
  return { blob, ext: "mp4", seconds: seconds(), frames: N, audio: aud ? aud.mux : null, codec: vid.cfg.codec };
}
