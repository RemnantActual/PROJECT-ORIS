"""
ORIS sound — procedural sound design, synthesized from scratch (no samples, nothing to license).
A scene lists timed events in sounds(mix); this module renders them, puts them in a reverb space,
masters the result and writes a stereo WAV.

Every sound is shaped like real sound design rather than test tones: filtered noise, FM bells,
detuned/saturated layers, resonant sweeps, and a shared reverb.
"""
import math
import wave

import numpy as np

SR = 48000


# ─────────────────────────── building blocks ───────────────────────────
def _t(dur):
    return np.arange(int(dur * SR), dtype=np.float32) / SR


def _env(sig, attack=0.003, release=None):
    n = len(sig)
    a = max(1, min(n, int(attack * SR)))
    e = np.ones(n, np.float32)
    e[:a] = np.linspace(0, 1, a) ** 2
    if release:
        r = min(n, int(release * SR))
        e[n - r:] *= np.linspace(1, 0, r) ** 2
    return sig * e


def _noise(dur, seed=0):
    return np.random.default_rng(seed).standard_normal(int(dur * SR)).astype(np.float32)


def _band(sig, lo, hi, slope=1.0):
    """Smooth FFT band-pass (soft skirts, no ringing)."""
    F = np.fft.rfft(sig)
    f = np.fft.rfftfreq(len(sig), 1 / SR) + 1e-3
    g = np.ones_like(f)
    if lo > 0:
        g *= 1 / (1 + (lo / f) ** (4 * slope))
    if hi < SR / 2:
        g *= 1 / (1 + (f / hi) ** (4 * slope))
    return np.fft.irfft(F * g, len(sig)).astype(np.float32)


def _sat(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


def _sweep_filter(sig, f0, f1, q=6.0):
    """Resonant low-pass whose cutoff glides f0 → f1 (state-variable filter)."""
    n = len(sig)
    fc = f0 * (f1 / f0) ** (np.arange(n) / max(1, n - 1))
    g = np.tan(np.pi * np.minimum(fc, SR * .45) / SR)
    k = 1 / q
    out = np.empty(n, np.float32)
    ic1 = ic2 = 0.0
    for i in range(n):
        gi = g[i]
        a1 = 1 / (1 + gi * (gi + k))
        v3 = sig[i] - ic2
        v1 = a1 * ic1 + gi * a1 * v3
        v2 = ic2 + gi * v1
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        out[i] = v2
    return out


def _fm(freq, ratio, index, dur, decay, index_decay=None):
    t = _t(dur)
    idx = index * np.exp(-t / (index_decay or decay))
    s = np.sin(2 * np.pi * freq * t + idx * np.sin(2 * np.pi * freq * ratio * t))
    return (s * np.exp(-t / decay)).astype(np.float32)


# ─────────────────────────── sounds ───────────────────────────
def tick(seed=0, bright=1.0):
    """Data tick for typing: a tiny filtered click with a hint of pitch."""
    rng = np.random.default_rng(seed)
    n = _band(_noise(.03, seed), 2500 * bright, 9000) * np.exp(-_t(.03) / .004)
    f = 3200 + 1600 * rng.random()
    return (n * .6 + _fm(f, 1.41, 1.5, .03, .006) * .25) * .5


def blip(freq=2200, seed=0):
    return _env(_fm(freq, 2.0, 2.0, .09, .03, .01), .001) * .35


def lock():
    """Two-note glassy confirmation."""
    a = _fm(1046, 3.5, 2.4, .35, .06, .015)
    b = _fm(1568, 3.5, 2.4, .45, .09, .02)
    out = np.zeros(int(.8 * SR), np.float32)
    out[:len(a)] += a * .5
    i = int(.075 * SR)
    out[i:i + len(b)] += b[:len(out) - i] * .55
    return _env(out, .001) * .55


def ping(decay=.32, freq=740):
    """Sonar: low bell; shorter decay = a drier contact ping."""
    s = _fm(freq, 1.0, 1.2, decay * 4.4, decay, .06) + _fm(freq * 2, 2.76, .8, decay * 4.4, decay * .47, .04) * .25
    return _env(s, .002) * .45


def riser(dur=2.0, seed=1):
    """Noise riser through a resonant filter that opens up, plus a rising tone."""
    n = _noise(dur, seed) * .6
    t = _t(dur)
    swept = _sweep_filter(n, 120, 7000, q=4.5)
    tone = np.sin(2 * np.pi * np.cumsum(90 * (1 + 3 * (t / dur) ** 2)) / SR) * .25
    sh = (t / dur) ** 2.2
    return _env((swept + tone) * sh, .05, .02) * .9


def whoosh(dur=1.4, seed=6):
    """Air pass: band-limited noise with a Doppler-ish filter swing."""
    n = _noise(dur, seed)
    t = _t(dur) / dur
    lo = _band(n, 150, 900)
    hi = _band(n, 900, 5000)
    env = np.exp(-((t - .45) / .22) ** 2)
    return (lo * env * .8 + hi * env * np.clip(1.2 - t, 0, 1) * .45) * .5


def reverse_swell(dur=.8, seed=7):
    """Reversed reverb-like swell that sucks into a hit."""
    n = _band(_noise(dur, seed), 300, 6000) * np.exp(-_t(dur) / (dur * .35))
    return n[::-1] * .35


def impact(seed=3, size=1.0):
    """Layered hit: sub drop + body thump + crack, saturated."""
    t = _t(2.2)
    f = 30 + 70 * np.exp(-t / .09)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (.6 * size))
    thump = _band(_noise(2.2, seed), 60, 300) * np.exp(-t / .07) * 1.6
    crack = _band(_noise(2.2, seed + 1), 1500, 9000) * np.exp(-t / .015) * .7
    return _env(_sat(sub * 1.1 + thump + crack, 1.8), .0008) * .85


def alarm(dur=2.4):
    """Low pulsing alert: detuned saws, low-passed, 3 Hz pulse — tense, not cartoonish."""
    t = _t(dur)
    saw = lambda fr: 2 * ((fr * t) % 1) - 1
    s = saw(146.8) + saw(147.9) + .6 * saw(220.4) + .4 * saw(293.0)
    s = _band(s.astype(np.float32), 60, 1400)
    pulse = (.55 + .45 * np.sin(2 * np.pi * 3 * t - np.pi / 2)) ** 2
    return _env(_sat(s * pulse * .4, 1.4), .02, .4) * .55


def stutter(src, dur=.25, slice_ms=28, seed=4):
    """Glitch: repeats tiny slices of a source sound, bitcrushed."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    sl = int(slice_ms / 1000 * SR)
    out = np.zeros(n, np.float32)
    pos = 0
    while pos < n:
        st = int(rng.integers(0, max(1, len(src) - sl)))
        piece = src[st:st + sl]
        for _ in range(int(rng.integers(1, 4))):
            m = min(len(piece), n - pos)
            if m <= 0:
                break
            out[pos:pos + m] = piece[:m]
            pos += m
    crushed = np.round(np.repeat(out[::6], 6)[:n] * 6) / 6
    return _band(crushed.astype(np.float32), 200, 10000) * .5


def glitch(dur, seed=4):
    hiss = _band(_noise(.5, seed), 1500, 9000) * .5
    src = np.concatenate([hiss, _fm(1200, 1.7, 6, .5, .3)])
    return stutter(src, dur, 22 + seed % 15, seed)


def drone(dur):
    """Dark bed: detuned low saws through a slowly moving filter + air."""
    t = _t(dur)
    saw = lambda fr: 2 * ((fr * t) % 1) - 1
    s = saw(55.0) + saw(55.35) + .5 * saw(82.4) + .3 * saw(110.1)
    s = _band(s.astype(np.float32), 30, 320)
    air = _band(_noise(dur, 9), 200, 1200) * .25
    mov = .75 + .25 * np.sin(2 * np.pi * .07 * t)
    return _env((s * .5 + air) * mov, 2.0, 1.5) * .22


def power_on():
    t = _t(1.0)
    f = 40 * (1 + 9 * (t / 1.0) ** 1.5)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * (t ** .5) * np.exp(-t / .7)
    hum = _band(_noise(1.0, 5), 80, 600) * np.exp(-t / .5) * .3
    return _env(_sat((s + hum) * .8, 1.6), .05, .15) * .5


def shimmer(dur=1.2):
    """High airy tail for the outro sigil."""
    s = sum(_fm(f, 2.01, 1.5, dur, dur * .45) for f in (1568, 2093, 2637)) / 3
    return _env(s, .3, .5) * .25


# ─────────────────────────── mixer ───────────────────────────
def _reverb_ir(dur=1.8, seed=11):
    """Short, damped room (~1.6 s to silence): highs die faster than lows, so tails go dark, not ringy."""
    t = _t(dur)
    irs = []
    for ch in range(2):
        n = np.random.default_rng(seed + ch).standard_normal(len(t)).astype(np.float32)
        low = _band(n, 200, 1500) * np.exp(-t / .26)
        high = _band(n, 1500, 6000) * np.exp(-t / .12)
        irs.append((low + high * .6) * np.clip(t / .015, 0, 1))
    return irs


def _convolve(x, h):
    n = len(x) + len(h) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[:len(x)].astype(np.float32)


class Mix:
    """Two buses: dry (with a reverb send) and a bed (no reverb). Mastered on write."""

    def __init__(self, duration):
        self.dur = duration
        n = int((duration + 3) * SR)
        self.dry = [np.zeros(n, np.float32), np.zeros(n, np.float32)]
        self.send = np.zeros(n, np.float32)

    def add(self, t, sig, gain=1.0, pan=0.0, verb=0.35):
        i = int(round(t * SR))
        if i < 0:
            sig, i = sig[-i:], 0
        n = min(len(sig), len(self.send) - i)
        if n <= 0:
            return
        s = sig[:n] * gain
        l, r = math.cos((pan + 1) * math.pi / 4) * 1.414, math.sin((pan + 1) * math.pi / 4) * 1.414
        self.dry[0][i:i + n] += s * l
        self.dry[1][i:i + n] += s * r
        self.send[i:i + n] += s * verb

    def type_on(self, text, t0, cps, gain=.25, every=1):
        """Data ticks for typed characters (matches oris.typed timing)."""
        for k in range(0, len(text), every):
            if text[k] == " ":
                continue
            self.add(t0 + k / cps, tick(k * 31 + int(t0 * 10)), gain, pan=((k * 13) % 7 - 3) / 6, verb=.15)

    def write(self, path):
        n = int(self.dur * SR)
        irL, irR = _reverb_ir()
        wetL, wetR = _convolve(self.send, irL) * .3, _convolve(self.send, irR) * .3
        st = np.stack([self.dry[0] + wetL, self.dry[1] + wetR], 1)[:n]
        for c in range(2):                       # clean up rumble below 25 Hz
            st[:, c] = _band(st[:, c], 25, SR / 2)
        rms = float(np.sqrt(np.mean(st ** 2))) or 1.0
        st *= 0.12 / rms                         # loudness target before limiting
        st = np.tanh(st * 1.15) / np.tanh(1.15)  # gentle bus saturation / limiting
        peak = float(np.abs(st).max()) or 1.0
        if peak > .84:                           # ~1.5 dB headroom so the AAC encode can't clip
            st *= .84 / peak
        fade = int(.08 * SR)
        st[-fade:] *= np.linspace(1, 0, fade)[:, None]
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((st * 32767).astype("<i2").tobytes())
