// classic.js — the 2D-canvas visualizers for Kaleidosound.
//
// Renders to a plain 2D <canvas> (separate from Butterchurn's WebGL canvas),
// reading audio from a shared AnalyserNode plus optional per-channel L/R
// analysers (for the stereo modes). One mode draws at a time; main.js shows/
// hides the canvas and starts/stops the loop when the View mode changes.
//
// Heavy simulations (fluid, metaballs, Voronoi, cymatics, terrain) use fast
// real-time approximations rather than physically-exact solvers, so they run
// smoothly in a browser and on a Raspberry Pi.

const SPECTRO_STOPS = [
  { t: 0.0, c: [0, 0, 0] },
  { t: 0.22, c: [40, 11, 84] },
  { t: 0.5, c: [139, 34, 110] },
  { t: 0.75, c: [222, 92, 58] },
  { t: 1.0, c: [252, 255, 164] },
];
function inferno(t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < SPECTRO_STOPS.length; i++) {
    const a = SPECTRO_STOPS[i - 1], b = SPECTRO_STOPS[i];
    if (x <= b.t) {
      const f = (x - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
      ];
    }
  }
  return SPECTRO_STOPS[SPECTRO_STOPS.length - 1].c;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Colour schemes. 'multicolor' spreads hue across the spectrum; the rest are
// two/three-stop gradients. Amplitude still drives brightness at the draw site,
// so louder = brighter (the perceptually-correct mapping for audio).
export const PALETTES = {
  multicolor: { hue: true, h0: 0, span: 300, sat: 90, light: 55 },
  aurora: { stops: [[33, 230, 193], [123, 92, 255], [255, 77, 157]] },
  ember: { stops: [[255, 214, 102], [255, 122, 26], [224, 30, 55]] },
  magenta: { stops: [[255, 90, 200], [162, 75, 255], [96, 92, 255]] },
  ocean: { stops: [[34, 224, 192], [42, 163, 255], [59, 91, 255]] },
  sunset: { stops: [[255, 209, 102], [255, 94, 148], [142, 68, 255]] },
  ice: { stops: [[224, 246, 255], [130, 205, 255], [96, 130, 255]] },
};

// Grouped for the View menu: Ambient / Reactive / Analytic / Generative.
export const CLASSIC_MODES = [
  // Ambient
  'orb', 'aurora', 'fluid', 'metaballs', 'cymatics',
  // Reactive
  'bars', 'mirror', 'spectrum', 'radial', 'kaleidoscope', 'ring', 'waveform',
  'tunnel', 'ripple', 'pulse', 'particles', 'phyllotaxis',
  // Analytic
  'spectrogram', 'waterfall', 'polarspectro', 'chroma', 'vu', 'vectorscope',
  'stereofield', 'dome', 'ribbons', 'hpss', 'constellation',
  // Generative
  'attractor', 'voronoi', 'network', 'harmonograph', 'depthfield',
  'ribbon3d', 'flythrough',
];

export class ClassicVisualizer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.analyserL = null;
    this.analyserR = null;
    this.freq = null;
    this.time = null;
    this.freqL = null;
    this.freqR = null;
    this.timeL = null;
    this.timeR = null;
    this.mode = 'bars';
    this.paletteName = 'multicolor';
    this.palette = PALETTES.multicolor;
    this._rafId = null;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 3);

    // Shared audio features.
    this.level = 0;
    this.bass = 0;
    this.beatEnv = 0;
    this.flux = 0;
    this._bassAvg = null;
    this._lastBeat = -1;
    this._t = 0;
    this._lastTs = 0;
    this._dt = 1 / 60;
    this._rot = 0;

    // Transient per-mode state (reset in setMode).
    this._bandsBuf = null;
    this._peaks = null;
    this._prevFreq = null;
    this._particles = [];
    this._ripples = [];
    this._history = [];
    this._ribbonHist = [];
    this._waveHist = [];
    this._flow = null;
    this._depth = null;
    this._net = null;
    this._voro = null;
    this._attractor = { x: 0.1, y: 0, z: 0 };
    this._polarAngle = 0;
    this._polarInit = false;

    this._specRows = 256;
    this._colCanvas = document.createElement('canvas');
    this._colCanvas.width = 1;
    this._colCanvas.height = this._specRows;
    this._colCtx = this._colCanvas.getContext('2d');
    this._colImage = this._colCtx.createImageData(1, this._specRows);
  }

  init(analyser, stereo = {}) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    if (stereo.left && stereo.right) {
      this.analyserL = stereo.left;
      this.analyserR = stereo.right;
      this.freqL = new Uint8Array(stereo.left.frequencyBinCount);
      this.freqR = new Uint8Array(stereo.right.frequencyBinCount);
      this.timeL = new Uint8Array(stereo.left.fftSize);
      this.timeR = new Uint8Array(stereo.right.fftSize);
    }
    this.resize();
  }

  setMode(mode) {
    this.mode = CLASSIC_MODES.includes(mode) ? mode : 'bars';
    this._particles = [];
    this._ripples = [];
    this._history = [];
    this._ribbonHist = [];
    this._waveHist = [];
    this._peaks = null;
    this._prevFreq = null;
    this._flow = null;
    this._depth = null;
    this._net = null;
    this._voro = null;
    this._attractor = { x: 0.1, y: 0, z: 0 };
    this._polarInit = false;
    this._polarAngle = 0;
    this._clear();
  }

  _clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  resize() {
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._pixelRatio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._pixelRatio));
    this._polarInit = false;
    this._clear();
  }

  start() {
    if (this._rafId != null) return;
    this._lastTs = performance.now();
    const loop = () => { this._draw(); this._rafId = requestAnimationFrame(loop); };
    this._rafId = requestAnimationFrame(loop);
  }
  stop() {
    if (this._rafId != null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  // ---- Shared analysis -----------------------------------------------------
  _computeFeatures() {
    const now = performance.now();
    let dt = (now - this._lastTs) / 1000;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    this._lastTs = now;
    this._t += dt;
    this._dt = dt;

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    this.level = Math.sqrt(sum / this.time.length);

    const bins = this.freq.length;
    const top = Math.max(1, Math.floor(bins / 16));
    let bs = 0;
    for (let b = 0; b < top; b++) bs += this.freq[b];
    const bass = bs / top / 255;
    this.bass = bass;

    // Spectral flux (positive change) — a percussive/onset indicator.
    if (!this._prevFreq || this._prevFreq.length !== bins) this._prevFreq = new Uint8Array(bins);
    let fl = 0;
    for (let b = 0; b < bins; b++) {
      const d = this.freq[b] - this._prevFreq[b];
      if (d > 0) fl += d;
      this._prevFreq[b] = this.freq[b];
    }
    this.flux = fl / (bins * 255);

    if (this._bassAvg == null) this._bassAvg = bass;
    const beat = bass > this._bassAvg * 1.35 + 0.02 && this._t - this._lastBeat > 0.22;
    if (beat) { this.beatEnv = 1; this._lastBeat = this._t; }
    this._bassAvg += (bass - this._bassAvg) * 0.08;
    this.beatEnv = Math.max(0, this.beatEnv - dt * 2.5);

    this._rot += dt * (0.15 + this.level * 0.8);
  }

  _bands(n) {
    const bins = this.freq.length;
    const maxLog = Math.log(bins);
    if (!this._bandsBuf || this._bandsBuf.length !== n) this._bandsBuf = new Float32Array(n);
    const out = this._bandsBuf;
    for (let i = 0; i < n; i++) {
      let b0 = Math.floor(Math.exp((i / n) * maxLog));
      let b1 = Math.max(b0 + 1, Math.floor(Math.exp(((i + 1) / n) * maxLog)));
      let s = 0, c = 0;
      for (let b = b0; b < b1 && b < bins; b++) { s += this.freq[b]; c++; }
      out[i] = c ? s / c / 255 : 0;
    }
    return out;
  }

  /** 4-band energies: bass, low-mid, high-mid, air (0..1). */
  _fourBands() {
    const b = this._bands(4);
    return [b[0], b[1], b[2], b[3]];
  }

  _fade(alpha) {
    const { ctx, canvas } = this;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Switch the active colour scheme. */
  setPalette(name) {
    this.paletteName = PALETTES[name] ? name : 'multicolor';
    this.palette = PALETTES[this.paletteName];
  }

  /** Colour from the active palette at position t (0..1), with alpha a. */
  _col(t, a = 1) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const p = this.palette;
    if (p.hue) return `hsla(${p.h0 + t * p.span}, ${p.sat}%, ${p.light}%, ${a})`;
    const s = p.stops, seg = s.length - 1, x = t * seg;
    const i = Math.min(seg - 1, Math.floor(x)), f = x - i;
    const c0 = s[i], c1 = s[i + 1];
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
    return `rgba(${r},${g},${b},${a})`;
  }

  _draw() {
    if (!this.analyser) return;
    this._computeFeatures();
    switch (this.mode) {
      // Ambient
      case 'orb': return this._drawOrb();
      case 'aurora': return this._drawAurora();
      case 'fluid': return this._drawFluid();
      case 'metaballs': return this._drawMetaballs();
      case 'cymatics': return this._drawCymatics();
      // Reactive
      case 'mirror': return this._drawMirror();
      case 'spectrum': return this._drawSpectrum();
      case 'radial': return this._drawRadial();
      case 'kaleidoscope': return this._drawKaleidoscope();
      case 'ring': return this._drawRing();
      case 'waveform': return this._drawWaveform();
      case 'tunnel': return this._drawTunnel();
      case 'ripple': return this._drawRipple();
      case 'pulse': return this._drawPulse();
      case 'particles': return this._drawParticles();
      case 'phyllotaxis': return this._drawPhyllotaxis();
      // Analytic
      case 'spectrogram': return this._drawSpectrogram();
      case 'waterfall': return this._drawWaterfall();
      case 'polarspectro': return this._drawPolarSpectro();
      case 'chroma': return this._drawChroma();
      case 'vu': return this._drawVU();
      case 'vectorscope': return this._drawVectorscope();
      case 'stereofield': return this._drawStereoField();
      case 'dome': return this._drawDome();
      case 'ribbons': return this._drawRibbons();
      case 'hpss': return this._drawHPSS();
      case 'constellation': return this._drawConstellation();
      // Generative
      case 'attractor': return this._drawAttractor();
      case 'voronoi': return this._drawVoronoi();
      case 'network': return this._drawNetwork();
      case 'harmonograph': return this._drawHarmonograph();
      case 'depthfield': return this._drawDepthField();
      case 'ribbon3d': return this._drawRibbon3D();
      case 'flythrough': return this._drawFlythrough();
      case 'bars':
      default: return this._drawBars();
    }
  }

  // ==== REACTIVE =============================================================
  _drawBars() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const n = 64, bands = this._bands(n);
    if (!this._peaks || this._peaks.length !== n) this._peaks = new Float32Array(n);
    const gap = Math.max(1, Math.round(2 * this._pixelRatio));
    const bw = (w - gap * (n - 1)) / n;
    ctx.shadowBlur = 16 * this._pixelRatio;
    for (let i = 0; i < n; i++) {
      const mag = bands[i], bh = Math.max(2, mag * h * 0.92), x = i * (bw + gap);
      const color = this._col(i / n, 0.55 + mag * 0.45);
      ctx.fillStyle = color; ctx.shadowColor = color;
      ctx.fillRect(x, h - bh, bw, bh);
    }
    ctx.shadowBlur = 0;
    // Peak-hold white caps that slowly fall (same look as H Bars).
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < n; i++) {
      this._peaks[i] = Math.max(bands[i], this._peaks[i] - this._dt * 0.4);
      const ph = Math.max(2, this._peaks[i] * h * 0.92);
      ctx.fillRect(i * (bw + gap), h - ph - 2, bw, 2);
    }
  }

  _drawMirror() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const n = 72, bands = this._bands(n);
    if (!this._peaks || this._peaks.length !== n) this._peaks = new Float32Array(n);
    const gap = Math.max(1, Math.round(2 * this._pixelRatio));
    const bw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const mag = bands[i];
      this._peaks[i] = Math.max(mag, this._peaks[i] - this._dt * 0.4);
      const bh = mag * mid * 0.92, x = i * (bw + gap);
      ctx.fillStyle = this._col(i / n, 0.6 + mag * 0.4);
      ctx.fillRect(x, mid - bh, bw, bh);
      ctx.fillRect(x, mid, bw, bh);
      const py = this._peaks[i] * mid * 0.92;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(x, mid - py - 2, bw, 2);
      ctx.fillRect(x, mid + py, bw, 2);
    }
  }

  // Smooth, calm, multicolour mirrored spectrum (filled area around centre).
  _drawSpectrum() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const n = 96, bands = this._bands(n);
    const amp = h * 0.42;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, this._col(0));
    grad.addColorStop(0.5, this._col(0.5));
    grad.addColorStop(1, this._col(1));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = mid - bands[i] * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1)) * w;
      ctx.lineTo(x, mid + bands[i] * amp);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2 * this._pixelRatio;
    ctx.shadowColor = this._col(0.5);
    ctx.shadowBlur = 12 * this._pixelRatio;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawRadial() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const inner = Math.min(w, h) * 0.16, maxLen = Math.min(w, h) * 0.34;
    const n = 96, bands = this._bands(n);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(this._rot * 0.2); ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const mag = bands[i], ang = (i / n) * Math.PI * 2, len = inner + mag * maxLen;
      ctx.strokeStyle = this._col(i / n, 0.6 + mag * 0.4);
      ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * inner) / n - 1);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.stroke();
    }
    const cr = inner * (0.5 + this.beatEnv * 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cr);
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(120,90,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, cr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawKaleidoscope() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.48, segments = 8, n = 40, bands = this._bands(n);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(this._rot * 0.3);
    ctx.globalCompositeOperation = 'lighter';
    for (let s = 0; s < segments; s++) {
      ctx.save(); ctx.rotate((s / segments) * Math.PI * 2);
      if (s % 2 === 1) ctx.scale(1, -1);
      const wedge = Math.PI * 2 / segments;
      for (let i = 0; i < n; i++) {
        const mag = bands[i]; if (mag < 0.02) continue;
        const rr = (i / n) * R, a1 = wedge * (0.35 + mag * 0.65);
        ctx.fillStyle = `hsla(${((i / n) * 300 + this._t * 30 + s * 8) % 360}, 95%, ${40 + mag * 35}%, ${0.35 + mag * 0.5})`;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, rr + mag * R * 0.15, 0, a1); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore(); ctx.globalCompositeOperation = 'source-over';
  }

  _drawRing() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) * 0.24 * (1 + this.beatEnv * 0.15), amp = Math.min(w, h) * 0.16;
    const n = this.time.length;
    ctx.lineWidth = Math.max(2, 2.2 * this._pixelRatio);
    ctx.strokeStyle = this._col((this._t * 0.08) % 1);
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 12 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const v = (this.time[i % n] - 128) / 128;
      const ang = (i / n) * Math.PI * 2 + this._rot * 0.2, r = base + v * amp;
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke(); ctx.shadowBlur = 0;
  }

  _drawWaveform() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const n = this.time.length;
    ctx.lineWidth = Math.max(2, 2.5 * this._pixelRatio);
    const wc = this._col(0.5);
    ctx.strokeStyle = wc;
    ctx.shadowColor = wc; ctx.shadowBlur = 14 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (this.time[i] - 128) / 128, x = (i / (n - 1)) * w, y = mid + v * mid * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  }

  _drawTunnel() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.25);
    const maxR = Math.hypot(w, h) / 2, rings = 18, sides = 6;
    const speed = 0.15 + this.level * 0.6 + this.beatEnv * 0.3;
    const phase = (this._t * speed) % 1;
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(this._rot * 0.4);
    for (let i = 0; i < rings; i++) {
      const frac = ((i + phase) % rings) / rings, r = frac * frac * maxR;
      ctx.strokeStyle = `hsla(${(frac * 300 + this._t * 40) % 360}, 90%, 60%, ${0.15 + frac * 0.7})`;
      ctx.lineWidth = 1 + frac * 4 * this._pixelRatio;
      ctx.beginPath();
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2, x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawRipple() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.18);
    if (this.beatEnv > 0.85) this._ripples.push({ r: 0, a: 1, t: Math.random() });
    const cx = w / 2, cy = h / 2, speed = Math.max(w, h) * 0.35;
    for (let i = this._ripples.length - 1; i >= 0; i--) {
      const rp = this._ripples[i];
      rp.r += speed * this._dt; rp.a -= this._dt * 0.55;
      if (rp.a <= 0) { this._ripples.splice(i, 1); continue; }
      ctx.strokeStyle = this._col(rp.t, rp.a);
      ctx.lineWidth = (2 + rp.a * 4) * this._pixelRatio;
      ctx.beginPath(); ctx.arc(cx, cy, rp.r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawPulse() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const n = 48, bands = this._bands(n);
    const base = Math.min(w, h) * 0.18 * (1 + this.beatEnv * 0.6 + this.level * 0.4);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(this._rot * 0.25);
    ctx.fillStyle = `hsla(${(this._t * 40) % 360}, 90%, 60%, 0.85)`;
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 25 * this._pixelRatio * (0.4 + this.beatEnv);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, r = base * (1 + bands[i % n] * 0.9);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.restore();
  }

  _drawParticles() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.2);
    const cx = w / 2, cy = h / 2;
    if (this.beatEnv > 0.8) {
      const burst = 18 + Math.floor(this.level * 30), hue = (this._t * 60) % 360;
      for (let i = 0; i < burst && this._particles.length < 500; i++) {
        const a = Math.random() * Math.PI * 2, sp = (0.4 + Math.random() * 0.8) * Math.max(w, h) * 0.35;
        this._particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue });
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.x += p.vx * this._dt; p.y += p.vy * this._dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= this._dt * 0.5;
      if (p.life <= 0) { this._particles.splice(i, 1); continue; }
      ctx.fillStyle = `hsla(${p.hue}, 90%, 65%, ${p.life})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, (1 + p.life * 3) * this._pixelRatio, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawPhyllotaxis() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const count = 340, bands = this._bands(count), golden = Math.PI * (3 - Math.sqrt(5));
    const scale = Math.min(w, h) * 0.028 * (1 + this.level * 0.4);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(this._rot * 0.1);
    for (let i = 0; i < count; i++) {
      const mag = bands[i], a = i * golden, rad = scale * Math.sqrt(i);
      ctx.fillStyle = `hsl(${((i / count) * 300 + this._t * 30) % 360}, 90%, ${40 + mag * 40}%)`;
      ctx.beginPath(); ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, (1.5 + mag * 6) * this._pixelRatio, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ==== AMBIENT ==============================================================
  _drawOrb() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.12); // gentle trails
    const cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) * 0.22 * (1 + this.level * 0.35 + this.beatEnv * 0.12);
    const bands = this._bands(24);
    const hue = (this._t * 12) % 360;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(this._rot * 0.05);
    // Layered translucent lobes = a soft breathing sphere.
    for (let layer = 3; layer >= 1; layer--) {
      const scale = 0.7 + layer * 0.12;
      ctx.beginPath();
      const pts = 72;
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2;
        const wob = 1 + 0.10 * Math.sin(a * 3 + this._t * 1.3 + layer) + 0.14 * bands[i % 24];
        const r = base * scale * wob;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(-base * 0.3, -base * 0.3, base * 0.1, 0, 0, base * scale * 1.2);
      g.addColorStop(0, `hsla(${(hue + layer * 20) % 360}, 85%, 70%, ${0.30})`);
      g.addColorStop(1, `hsla(${(hue + 60) % 360}, 80%, 40%, 0)`);
      ctx.fillStyle = g; ctx.fill();
    }
    // Specular highlight for a spherical feel.
    const hl = ctx.createRadialGradient(-base * 0.35, -base * 0.35, 1, -base * 0.35, -base * 0.35, base * 0.7);
    hl.addColorStop(0, 'rgba(255,255,255,0.5)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(0, 0, base, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawAurora() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, w, h);
    const [bassE, lowE, highE, airE] = this._fourBands();
    ctx.globalCompositeOperation = 'lighter';
    const blobs = 5;
    for (let k = 0; k < blobs; k++) {
      const ph = (k / blobs) * Math.PI * 2;
      const bx = w * (0.5 + 0.4 * Math.sin(this._t * 0.25 + ph));
      const by = h * (0.5 + 0.4 * Math.cos(this._t * 0.19 + ph * 1.4));
      const energy = [bassE, lowE, highE, airE, this.level][k % 5];
      const rad = Math.min(w, h) * (0.35 + energy * 0.5);
      const hue = (200 + k * 45 + this._t * 12) % 360;
      const g = ctx.createRadialGradient(bx, by, 1, bx, by, rad);
      g.addColorStop(0, `hsla(${hue}, 80%, 62%, ${0.22 + energy * 0.25})`);
      g.addColorStop(0.6, `hsla(${(hue + 30) % 360}, 80%, 50%, ${0.08})`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, rad, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawFluid() {
    // Continuous "ink" advected along a curl-noise-like field, modulated by audio.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    if (!this._flow) {
      this._flow = [];
      for (let i = 0; i < 700; i++) this._flow.push({ x: Math.random() * w, y: Math.random() * h, hue: Math.random() * 360 });
    }
    this._fade(0.06);
    ctx.globalCompositeOperation = 'lighter';
    const sc = 0.0016 + this.bass * 0.001;
    const speed = (40 + this.level * 260) * this._pixelRatio;
    for (const p of this._flow) {
      const a = (Math.sin(p.x * sc + this._t * 0.4) + Math.cos(p.y * sc - this._t * 0.3)) * Math.PI;
      p.x += Math.cos(a) * speed * this._dt;
      p.y += Math.sin(a) * speed * this._dt;
      if (p.x < 0) p.x += w; if (p.x > w) p.x -= w;
      if (p.y < 0) p.y += h; if (p.y > h) p.y -= h;
      ctx.fillStyle = `hsla(${(p.hue + this._t * 20) % 360}, 85%, 60%, 0.5)`;
      ctx.fillRect(p.x, p.y, 1.6 * this._pixelRatio, 1.6 * this._pixelRatio);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawMetaballs() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#04040a'; ctx.fillRect(0, 0, w, h);
    const bands = this._bands(6);
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      const ph = (k / 6) * Math.PI * 2;
      const bx = w * (0.5 + 0.32 * Math.sin(this._t * (0.3 + k * 0.05) + ph));
      const by = h * (0.5 + 0.32 * Math.cos(this._t * (0.25 + k * 0.04) + ph));
      const r = Math.min(w, h) * (0.12 + bands[k] * 0.28);
      const hue = (k * 55 + this._t * 20) % 360;
      const g = ctx.createRadialGradient(bx, by, 1, bx, by, r);
      g.addColorStop(0, `hsla(${hue}, 95%, 62%, 0.9)`);
      g.addColorStop(0.5, `hsla(${hue}, 95%, 50%, 0.35)`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawCymatics() {
    // Chladni standing-wave pattern; (n,m) driven by the dominant frequency.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const bands = this._bands(16);
    let peak = 0, peakI = 1;
    for (let i = 0; i < 16; i++) if (bands[i] > peak) { peak = bands[i]; peakI = i; }
    const n = 2 + (peakI % 7), m = 3 + ((peakI * 2) % 6);
    const cols = 120, rows = Math.round(cols * h / w);
    const eps = 0.06 + 0.04 * Math.sin(this._t);
    const hue = (this._t * 20 + peakI * 12) % 360;
    ctx.fillStyle = `hsl(${hue}, 80%, 65%)`;
    const dotR = 1.3 * this._pixelRatio;
    for (let gy = 0; gy < rows; gy++) {
      const y = gy / (rows - 1);
      for (let gx = 0; gx < cols; gx++) {
        const x = gx / (cols - 1);
        const val = Math.sin(n * Math.PI * x) * Math.sin(m * Math.PI * y)
          - Math.sin(m * Math.PI * x) * Math.sin(n * Math.PI * y);
        if (Math.abs(val) < eps) {
          ctx.beginPath(); ctx.arc(x * w, y * h, dotR, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  // ==== ANALYTIC =============================================================
  _drawSpectrogram() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const shift = Math.max(1, Math.round(2 * this._pixelRatio));
    ctx.drawImage(canvas, shift, 0, w - shift, h, 0, 0, w - shift, h);
    const bins = this.freq.length, rows = this._specRows, maxLog = Math.log(bins), data = this._colImage.data;
    for (let p = 0; p < rows; p++) {
      const frac = 1 - p / (rows - 1);
      const bin = Math.min(bins - 1, Math.floor(Math.exp(frac * maxLog)));
      const [r, g, b] = inferno(this.freq[bin] / 255);
      const o = p * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
    this._colCtx.putImageData(this._colImage, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._colCanvas, 0, 0, 1, rows, w - shift, 0, shift, h);
  }

  _drawWaterfall() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, w, h);
    const n = 96, bands = this._bands(n);
    this._history.push(Float32Array.from(bands));
    const HIST = 46; if (this._history.length > HIST) this._history.shift();
    const horizon = h * 0.22, rows = this._history.length;
    for (let j = 0; j < rows; j++) {
      const row = this._history[j], depth = j / (rows - 1 || 1);
      const y0 = horizon + (h - horizon) * Math.pow(depth, 1.6);
      const scaleX = 0.35 + depth * 0.65, amp = (h - horizon) * 0.30 * (0.4 + depth * 0.6);
      const x0 = w / 2 - (w / 2) * scaleX, dx = (w * scaleX) / (n - 1), light = 20 + depth * 45;
      ctx.beginPath(); ctx.moveTo(x0, y0 - row[0] * amp);
      for (let i = 1; i < n; i++) ctx.lineTo(x0 + i * dx, y0 - row[i] * amp);
      ctx.lineTo(x0 + (n - 1) * dx, y0 + 4); ctx.lineTo(x0, y0 + 4); ctx.closePath();
      ctx.fillStyle = `hsl(${(200 + depth * 80) % 360}, 70%, ${light * 0.35}%)`; ctx.fill();
      ctx.strokeStyle = `hsl(${(200 + depth * 80) % 360}, 90%, ${light}%)`;
      ctx.lineWidth = 1 + depth * this._pixelRatio; ctx.stroke();
    }
  }

  _drawPolarSpectro() {
    // Circular scrolling spectrogram: sweep a radial line around a disc.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    if (!this._polarInit) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); this._polarInit = true; }
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.48, inner = R * 0.12;
    const steps = 4; // radial lines per frame
    const bins = this.freq.length, maxLog = Math.log(bins);
    for (let s = 0; s < steps; s++) {
      const a = this._polarAngle;
      const a2 = a + 0.012;
      const segs = 120;
      for (let i = 0; i < segs; i++) {
        const frac = i / segs;
        const bin = Math.min(bins - 1, Math.floor(Math.exp(frac * maxLog)));
        const [r, g, b] = inferno(this.freq[bin] / 255);
        const r0 = inner + frac * (R - inner), r1 = inner + ((i + 1) / segs) * (R - inner);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a2) * r1, cy + Math.sin(a2) * r1);
        ctx.lineTo(cx + Math.cos(a2) * r0, cy + Math.sin(a2) * r0);
        ctx.closePath(); ctx.fill();
      }
      this._polarAngle += 0.012;
      if (this._polarAngle > Math.PI * 2) this._polarAngle -= Math.PI * 2;
    }
  }

  _drawChroma() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const sr = (this.analyser.context && this.analyser.context.sampleRate) || 44100;
    const binHz = sr / this.analyser.fftSize;
    const chroma = new Float32Array(12), bins = this.freq.length;
    for (let b = 1; b < bins; b++) {
      const f = b * binHz; if (f < 30 || f > 5000) continue;
      const pc = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
      chroma[pc] += this.freq[b] / 255;
    }
    let max = 1e-6; for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
    const inner = Math.min(w, h) * 0.14, outer = Math.min(w, h) * 0.42;
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      const v = chroma[i] / max, a0 = (i / 12) * Math.PI * 2 - Math.PI / 2 - Math.PI / 12, a1 = a0 + Math.PI * 2 / 12;
      const rr = inner + v * (outer - inner);
      ctx.fillStyle = `hsla(${(i / 12) * 360}, 85%, ${30 + v * 45}%, ${0.35 + v * 0.6})`;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, rr, a0, a1); ctx.closePath(); ctx.fill();
      const am = (a0 + a1) / 2, lr = outer + 16 * this._pixelRatio;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `${Math.round(13 * this._pixelRatio)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText(NOTE_NAMES[i], Math.cos(am) * lr, Math.sin(am) * lr);
    }
    ctx.restore();
  }

  _drawVU() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, w, h);
    const r = Math.min(w / 2, h) * 0.6;
    this._gauge(w * 0.28, h * 0.72, r, this.level, 'LEVEL', 0.3);
    this._gauge(w * 0.72, h * 0.72, r, this.bass, 'BASS', 0.75);
  }
  _gauge(cx, cy, r, value, label, hue) {
    const { ctx } = this;
    const start = Math.PI + Math.PI * 0.15, end = -Math.PI * 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.max(2, 2 * this._pixelRatio);
    ctx.beginPath(); ctx.arc(cx, cy, r, start, end, true); ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, a = start + (end - start) * t;
      ctx.strokeStyle = t > 0.8 ? 'rgba(255,120,120,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
      ctx.lineTo(cx + Math.cos(a) * (r + 2), cy + Math.sin(a) * (r + 2)); ctx.stroke();
    }
    const v = Math.min(1, value * 1.4), a = start + (end - start) * v;
    ctx.strokeStyle = this._col(hue); ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10 * this._pixelRatio;
    ctx.lineWidth = Math.max(2, 3 * this._pixelRatio);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)); ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(12 * this._pixelRatio)}px -apple-system, "Helvetica Neue", Arial, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + 22 * this._pixelRatio);
  }

  _drawVectorscope() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.12);
    const cx = w / 2, cy = h / 2, scale = Math.min(w, h) * 0.42;
    let xs, ys, n, delay;
    if (this.analyserL && this.analyserR) {
      this.analyserL.getByteTimeDomainData(this.timeL);
      this.analyserR.getByteTimeDomainData(this.timeR);
      xs = this.timeL; ys = this.timeR; n = this.timeL.length; delay = 0;
    } else { xs = this.time; ys = this.time; n = this.time.length; delay = 24; }
    ctx.strokeStyle = `hsla(${(140 + this._t * 10) % 360}, 90%, 60%, 0.9)`;
    ctx.lineWidth = Math.max(1, 1.5 * this._pixelRatio);
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 8 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const xv = (xs[i] - 128) / 128, yv = (ys[(i + delay) % n] - 128) / 128;
      const px = cx + (xv - yv) * scale * 0.707, py = cy - (xv + yv) * scale * 0.707;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }

  /** Get per-band L/R magnitudes (falls back to mono when no stereo). */
  _stereoBands(n) {
    const l = new Float32Array(n), r = new Float32Array(n);
    const useStereo = !!(this.analyserL && this.analyserR);
    if (useStereo) { this.analyserL.getByteFrequencyData(this.freqL); this.analyserR.getByteFrequencyData(this.freqR); }
    const src = this.freq, bins = src.length, maxLog = Math.log(bins);
    for (let i = 0; i < n; i++) {
      let b0 = Math.floor(Math.exp((i / n) * maxLog));
      let b1 = Math.max(b0 + 1, Math.floor(Math.exp(((i + 1) / n) * maxLog)));
      let sl = 0, sr = 0, c = 0;
      for (let b = b0; b < b1 && b < bins; b++) {
        sl += useStereo ? this.freqL[b] : src[b];
        sr += useStereo ? this.freqR[b] : src[b];
        c++;
      }
      l[i] = c ? sl / c / 255 : 0; r[i] = c ? sr / c / 255 : 0;
    }
    return { l, r, useStereo };
  }

  _drawStereoField() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    // Reference grid: centre line + edges.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = `${Math.round(11 * this._pixelRatio)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'left'; ctx.fillText('L', 8, h - 8);
    ctx.textAlign = 'right'; ctx.fillText('R', w - 8, h - 8);
    const n = 48, { l, r } = this._stereoBands(n);
    for (let i = 0; i < n; i++) {
      const mag = (l[i] + r[i]) / 2; if (mag < 0.01) continue;
      const total = l[i] + r[i] + 1e-6, pan = (r[i] - l[i]) / total; // -1..1
      const x = w / 2 + pan * (w / 2 - 20);
      const y = h - (i / n) * h; // low freq bottom, high top
      const size = (2 + mag * 12) * this._pixelRatio;
      ctx.fillStyle = `hsla(${(i / n) * 300}, 90%, 60%, ${0.4 + mag * 0.5})`;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawDome() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#04040a'; ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.82, R = Math.min(w * 0.45, h * 0.7);
    // Dome outline + grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, R, R * 0.22, 0, 0, Math.PI * 2); ctx.stroke();
    for (let e = 1; e <= 3; e++) {
      const el = (e / 4) * Math.PI / 2;
      ctx.beginPath(); ctx.ellipse(cx, cy - Math.sin(el) * R * 0.0, R * Math.cos(el), R * Math.cos(el) * 0.22, 0, Math.PI, 0); ctx.stroke();
    }
    const n = 40, { l, r } = this._stereoBands(n);
    for (let i = 0; i < n; i++) {
      const mag = (l[i] + r[i]) / 2; if (mag < 0.02) continue;
      const total = l[i] + r[i] + 1e-6, pan = (r[i] - l[i]) / total;
      const az = pan * Math.PI / 2;              // -90..90 left-right
      const el = (i / n) * Math.PI / 2;          // 0..90 low->high freq
      const x = cx + Math.cos(el) * Math.sin(az) * R;
      const y = cy - Math.sin(el) * R;
      const size = (2 + mag * 10) * this._pixelRatio;
      ctx.fillStyle = `hsla(${(i / n) * 300}, 90%, 62%, ${0.4 + mag * 0.5})`;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8 * this._pixelRatio;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  _drawRibbons() {
    // Stacked translucent band ribbons scrolling left->right.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, w, h);
    const bands = this._fourBands();
    this._ribbonHist.push(bands);
    const maxLen = Math.ceil(w / (2 * this._pixelRatio));
    while (this._ribbonHist.length > maxLen) this._ribbonHist.shift();
    const len = this._ribbonHist.length;
    const colors = [ [255, 90, 90], [255, 180, 60], [90, 220, 140], [90, 170, 255] ];
    const labels = ['bass', 'low-mid', 'high-mid', 'air'];
    const bandH = h / 4;
    for (let bi = 0; bi < 4; bi++) {
      const baseY = h - bi * bandH;
      const [r, g, b] = colors[bi];
      ctx.beginPath(); ctx.moveTo(0, baseY);
      for (let x = 0; x < len; x++) {
        const px = (x / (maxLen - 1)) * w;
        const v = this._ribbonHist[x][bi];
        ctx.lineTo(px, baseY - v * bandH * 1.6);
      }
      ctx.lineTo((len - 1) / (maxLen - 1) * w, baseY); ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},0.45)`; ctx.fill();
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`; ctx.lineWidth = 1.5 * this._pixelRatio; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.textAlign = 'left';
      ctx.font = `${Math.round(11 * this._pixelRatio)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText(labels[bi], 8, baseY - 6);
    }
  }

  _drawHPSS() {
    // Approximate harmonic/percussive split: smooth tonal ridge (bottom) +
    // transient flashes (top) driven by spectral flux.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.22);
    // Harmonic layer (bottom): smoothed spectrum ridge.
    const n = 96, bands = this._bands(n), mid = h * 0.62;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * w, mid - bands[i] * h * 0.34);
    ctx.lineTo(w, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(33,230,193,0.7)');
    g.addColorStop(0.5, 'rgba(123,92,255,0.7)');
    g.addColorStop(1, 'rgba(255,77,157,0.7)');
    ctx.fillStyle = g; ctx.fill();
    // Percussive layer (top): vertical flashes on transients.
    const perc = Math.min(1, this.flux * 6);
    if (perc > 0.15) {
      const flashes = 30;
      for (let i = 0; i < flashes; i++) {
        if (Math.random() > perc) continue;
        const x = Math.random() * w, len = (0.1 + Math.random() * 0.4) * h * perc;
        ctx.strokeStyle = `hsla(${20 + Math.random() * 30}, 95%, 65%, ${0.4 + perc * 0.5})`;
        ctx.lineWidth = (1 + perc * 2) * this._pixelRatio;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, len); ctx.stroke();
      }
    }
  }

  _drawConstellation() {
    // Detect spectral peaks -> stars; connect nearby ones.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.15);
    const bins = this.freq.length, maxLog = Math.log(bins);
    const stars = [];
    for (let b = 2; b < bins - 2; b++) {
      const v = this.freq[b];
      if (v > 90 && v >= this.freq[b - 1] && v >= this.freq[b + 1] && v > this.freq[b - 2] && v > this.freq[b + 2]) {
        const frac = Math.log(b) / maxLog;
        const x = frac * w;
        const y = h * (0.15 + 0.7 * (1 - v / 255)) + Math.sin(b) * 20;
        stars.push({ x, y, m: v / 255 });
        if (stars.length > 60) break;
      }
    }
    // Connections.
    ctx.strokeStyle = 'rgba(140,170,255,0.25)'; ctx.lineWidth = 1;
    const maxD = Math.min(w, h) * 0.2;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x, dy = stars[i].y - stars[j].y;
        const d = Math.hypot(dx, dy);
        if (d < maxD) {
          ctx.globalAlpha = (1 - d / maxD) * 0.5;
          ctx.beginPath(); ctx.moveTo(stars[i].x, stars[i].y); ctx.lineTo(stars[j].x, stars[j].y); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    for (const s of stars) {
      ctx.fillStyle = this._col(s.x / w, 0.6 + s.m * 0.4);
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8 * this._pixelRatio;
      ctx.beginPath(); ctx.arc(s.x, s.y, (1.5 + s.m * 4) * this._pixelRatio, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // ==== GENERATIVE ===========================================================
  _drawAttractor() {
    // Lorenz attractor, audio-modulated, projected to 2D with a slow spin.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.08);
    const s = 10, rho = 26 + this.level * 14, beta = 8 / 3;
    let { x, y, z } = this._attractor;
    const dt = 0.006 + this.level * 0.006;
    const scale = Math.min(w, h) / 60;
    const cx = w / 2, cy = h / 2, cosr = Math.cos(this._rot * 0.3), sinr = Math.sin(this._rot * 0.3);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < 500; i++) {
      const dx = s * (y - x), dy = x * (rho - z) - y, dz = x * y - beta * z;
      x += dx * dt; y += dy * dt; z += dz * dt;
      const px = cx + (x * cosr - y * sinr) * scale;
      const py = cy + (z - 26) * scale;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    this._attractor = { x, y, z };
    ctx.strokeStyle = `hsla(${(this._t * 20) % 360}, 85%, 65%, 0.85)`;
    ctx.lineWidth = 1.2 * this._pixelRatio;
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 6 * this._pixelRatio;
    ctx.stroke(); ctx.shadowBlur = 0;
  }

  _drawVoronoi() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    if (!this._voro) {
      this._voro = [];
      for (let i = 0; i < 22; i++) this._voro.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40 });
    }
    const bands = this._bands(this._voro.length);
    for (let i = 0; i < this._voro.length; i++) {
      const s = this._voro[i];
      s.x += s.vx * this._dt; s.y += s.vy * this._dt;
      if (s.x < 0 || s.x > w) s.vx *= -1; if (s.y < 0 || s.y > h) s.vy *= -1;
      s.x = Math.max(0, Math.min(w, s.x)); s.y = Math.max(0, Math.min(h, s.y));
    }
    const step = Math.max(8, Math.round(12 * this._pixelRatio));
    for (let gy = 0; gy < h; gy += step) {
      for (let gx = 0; gx < w; gx += step) {
        let best = 1e12, bi = 0;
        for (let i = 0; i < this._voro.length; i++) {
          const dx = gx - this._voro[i].x, dy = gy - this._voro[i].y, d = dx * dx + dy * dy;
          if (d < best) { best = d; bi = i; }
        }
        const mag = bands[bi];
        ctx.fillStyle = `hsl(${(bi / this._voro.length) * 300}, 80%, ${12 + mag * 45}%)`;
        ctx.fillRect(gx, gy, step, step);
      }
    }
  }

  _drawNetwork() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#05060c'; ctx.fillRect(0, 0, w, h);
    if (!this._net) {
      this._net = [];
      for (let i = 0; i < 60; i++) this._net.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30 });
    }
    const push = this.beatEnv * 60;
    for (const p of this._net) {
      p.x += (p.vx + (Math.random() - 0.5) * push) * this._dt;
      p.y += (p.vy + (Math.random() - 0.5) * push) * this._dt;
      if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > h) p.vy *= -1;
      p.x = Math.max(0, Math.min(w, p.x)); p.y = Math.max(0, Math.min(h, p.y));
    }
    const maxD = Math.min(w, h) * 0.16 * (1 + this.level);
    ctx.strokeStyle = 'rgba(120,180,255,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i < this._net.length; i++) {
      for (let j = i + 1; j < this._net.length; j++) {
        const dx = this._net[i].x - this._net[j].x, dy = this._net[i].y - this._net[j].y, d = Math.hypot(dx, dy);
        if (d < maxD) { ctx.globalAlpha = (1 - d / maxD) * 0.6; ctx.beginPath(); ctx.moveTo(this._net[i].x, this._net[i].y); ctx.lineTo(this._net[j].x, this._net[j].y); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1; ctx.fillStyle = `hsl(${(this._t * 20) % 360}, 80%, 70%)`;
    for (const p of this._net) { ctx.beginPath(); ctx.arc(p.x, p.y, (1.5 + this.beatEnv * 3) * this._pixelRatio, 0, Math.PI * 2); ctx.fill(); }
  }

  _drawHarmonograph() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.06);
    const bands = this._bands(8);
    const A = Math.min(w, h) * 0.32;
    const f1 = 2 + Math.round(bands[1] * 5), f2 = 3 + Math.round(bands[3] * 5);
    const f3 = 2 + Math.round(bands[5] * 4), f4 = 3 + Math.round(bands[6] * 4);
    const p1 = this._t * 0.5, p2 = this._t * 0.4;
    ctx.save(); ctx.translate(w / 2, h / 2);
    ctx.strokeStyle = `hsla(${(this._t * 15) % 360}, 85%, 65%, 0.5)`;
    ctx.lineWidth = 1.2 * this._pixelRatio; ctx.beginPath();
    const steps = 600;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const x = A * Math.sin(f1 * t + p1) * Math.exp(-0.0005 * i) + A * 0.4 * Math.sin(f3 * t);
      const y = A * Math.sin(f2 * t + p2) * Math.exp(-0.0005 * i) + A * 0.4 * Math.cos(f4 * t);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.restore();
  }

  _drawDepthField() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.25);
    if (!this._depth) {
      this._depth = [];
      for (let i = 0; i < 260; i++) this._depth.push({ x: (Math.random() - 0.5) * w, y: (Math.random() - 0.5) * h, z: Math.random() });
    }
    const cx = w / 2, cy = h / 2, speed = 0.06 + this.level * 0.5 + this.beatEnv * 0.2;
    ctx.fillStyle = '#fff';
    for (const p of this._depth) {
      p.z -= speed * this._dt;
      if (p.z <= 0.02) { p.z = 1; p.x = (Math.random() - 0.5) * w; p.y = (Math.random() - 0.5) * h; }
      const k = 0.4 / p.z, px = cx + p.x * k, py = cy + p.y * k;
      if (px < 0 || px > w || py < 0 || py > h) continue;
      const size = (1 - p.z) * 3 * this._pixelRatio;
      ctx.globalAlpha = Math.min(1, (1 - p.z) * 1.2);
      ctx.fillStyle = `hsl(${(200 + (1 - p.z) * 120) % 360}, 80%, ${60 + (1 - p.z) * 30}%)`;
      ctx.beginPath(); ctx.arc(px, py, Math.max(0.5, size), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawRibbon3D() {
    // A waveform ribbon receding in faux-3D; new slices at the front.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, w, h);
    // Downsample the waveform to a compact slice.
    const N = 64, slice = new Float32Array(N), step = Math.floor(this.time.length / N);
    for (let i = 0; i < N; i++) slice[i] = (this.time[i * step] - 128) / 128;
    this._waveHist.push(slice);
    const HIST = 40; if (this._waveHist.length > HIST) this._waveHist.shift();
    const horizon = h * 0.3, rows = this._waveHist.length;
    for (let j = 0; j < rows; j++) {
      const row = this._waveHist[j], depth = j / (rows - 1 || 1);
      const y0 = horizon + (h - horizon) * Math.pow(depth, 1.5);
      const scaleX = 0.3 + depth * 0.7, amp = (h - horizon) * 0.22 * (0.4 + depth * 0.6);
      const x0 = w / 2 - (w / 2) * scaleX, dx = (w * scaleX) / (N - 1);
      ctx.beginPath();
      for (let i = 0; i < N; i++) { const x = x0 + i * dx, y = y0 - row[i] * amp; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.strokeStyle = `hsla(${(170 + depth * 60) % 360}, 90%, ${30 + depth * 45}%, ${0.3 + depth * 0.7})`;
      ctx.lineWidth = (0.6 + depth * 1.8) * this._pixelRatio; ctx.stroke();
    }
  }

  _drawFlythrough() {
    // Terrain flythrough: perspective grid of band-height rows scrolling near.
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#04060c'; ctx.fillRect(0, 0, w, h);
    const N = 40, bands = this._bands(N);
    this._history.push(Float32Array.from(bands));
    const HIST = 34; if (this._history.length > HIST) this._history.shift();
    const rows = this._history.length, horizon = h * 0.32;
    const proj = (i, j) => {
      const depth = j / (rows - 1 || 1);
      const scaleX = 0.18 + depth * 0.82;
      const y0 = horizon + (h - horizon) * Math.pow(depth, 1.7);
      const amp = (h - horizon) * 0.28 * (0.3 + depth * 0.7);
      const x0 = w / 2 - (w / 2) * scaleX, dx = (w * scaleX) / (N - 1);
      return { x: x0 + i * dx, y: y0 - this._history[j][i] * amp, depth };
    };
    ctx.lineWidth = 1;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = proj(i, j), b = proj(i + 1, j), c = proj(i, j + 1);
        const hgt = this._history[j][i];
        ctx.strokeStyle = `hsla(${(190 + a.depth * 90) % 360}, 85%, ${20 + a.depth * 40 + hgt * 20}%, ${0.25 + a.depth * 0.6})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      }
    }
  }
}
