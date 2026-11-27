// Adds a 16-bit PCM sound track to a video-only MP4 (moov at the end) and returns a .mov.

const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = v => [(v >>> 8) & 255, v & 255];
const str = s => [...s].map(c => c.charCodeAt(0));
function box(type, ...parts) {
  const body = parts.flat(Infinity);
  return [...u32(8 + body.length), ...str(type), ...body];
}
const full = (type, ver, flags, ...parts) => box(type, [ver, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

function topBoxes(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = {};
  for (let o = 0; o < b.length;) {
    let size = dv.getUint32(o), head = 8;
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); head = 16; }
    if (size === 0) size = b.length - o;
    out[type] = { o, size, head };
    o += size;
  }
  return out;
}

/** mp4: Uint8Array (video only, moov at the end). L, R: Float32Array samples at `rate`. Returns a .mov Uint8Array. */
export function addPcmTrack(mp4, L, R, rate = 48000) {
  const t = topBoxes(mp4);
  if (!t.ftyp || !t.mdat || !t.moov || t.moov.o < t.mdat.o) throw new Error("unexpected MP4 layout");
  const n = L.length, pcm = new Uint8Array(n * 4), pv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    pv.setInt16(i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true);
    pv.setInt16(i * 4 + 2, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true);
  }
  // movie header: timescale, duration, next track id
  const moov = mp4.subarray(t.moov.o + t.moov.head, t.moov.o + t.moov.size);
  const mv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let mvhd = -1;
  for (let o = 0; o < moov.length; o += mv.getUint32(o)) if (String.fromCharCode(...moov.subarray(o + 4, o + 8)) === "mvhd") { mvhd = o; break; }
  if (mvhd < 0 || moov[mvhd + 8] !== 0) throw new Error("unexpected movie header");
  const ts = mv.getUint32(mvhd + 20), aDur = Math.round((n / rate) * ts);
  const audioAt = t.moov.o;   // the PCM goes right after the video samples, at the end of the media data
  const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
  const trak = box("trak",
    full("tkhd", 0, 3, u32(0), u32(0), u32(2), u32(0), u32(aDur), u32(0), u32(0), u16(0), u16(1), u16(0x100), u16(0), identity, u32(0), u32(0)),
    box("mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(rate), u32(n), u16(0x55c4), u16(0)),
      full("hdlr", 0, 0, str("mhlr"), str("soun"), u32(0), u32(0), u32(0), [12], str("SoundHandler")),
      box("minf",
        full("smhd", 0, 0, u16(0), u16(0)),
        full("hdlr", 0, 0, str("dhlr"), str("url "), u32(0), u32(0), u32(0), [11], str("DataHandler")),
        box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
        box("stbl",
          full("stsd", 0, 0, u32(1),
            box("sowt", [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), u32(0), u16(2), u16(16), u16(0), u16(0), u32(rate * 65536),
              full("chan", 0, 0, u32(0x00650002), u32(0), u32(0)))),
          full("stts", 0, 0, u32(1), u32(n), u32(1)),
          full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
          full("stsz", 0, 0, u32(4), u32(n)),
          full("stco", 0, 0, u32(1), u32(audioAt))))));
  const newMoovLen = t.moov.size - t.moov.head + 8 + trak.length;
  const out = new Uint8Array(t.moov.o + pcm.length + newMoovLen);
  out.set(mp4.subarray(0, t.moov.o), 0);
  // ftyp: a QuickTime brand, padded with a 'free' box so it keeps its size (the video offsets stay valid)
  const ft = t.ftyp;
  if (ft.size < 20) throw new Error("unexpected file type box");
  const ftyp = box("ftyp", str("qt  "), u32(0x200), str("qt  "));
  out.set(ftyp, ft.o);
  if (ft.size > ftyp.length) out.set(box("free", new Array(ft.size - ftyp.length - 8).fill(0)), ft.o + ftyp.length);
  // media data grows by the PCM
  const od = new DataView(out.buffer), md = t.mdat, mdSize = md.size + pcm.length;
  if (md.head === 16) od.setBigUint64(md.o + 8, BigInt(mdSize));
  else if (mdSize < 2 ** 32) od.setUint32(md.o, mdSize);
  else throw new Error("video too large");
  out.set(pcm, audioAt);
  // movie box: the old one plus the sound track; longer duration if the sound is, next track id 3
  const mo = audioAt + pcm.length;
  od.setUint32(mo, newMoovLen);
  out.set(str("moov"), mo + 4);
  out.set(moov, mo + 8);
  out.set(trak, mo + 8 + moov.length);
  const mh = mo + 8 + mvhd;
  od.setUint32(mh + 24, Math.max(od.getUint32(mh + 24), aDur));
  od.setUint32(mh + 8 + 96, 3);
  return out;
}
