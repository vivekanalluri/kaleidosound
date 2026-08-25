// classic.js — the 2D-canvas visualizers for Kaleidosound.
//
// Renders to a plain 2D <canvas> (separate from Butterchurn's WebGL canvas),
// reading audio from a shared AnalyserNode (plus optional per-channel L/R
// analysers for the vectorscope). One mode draws at a time; main.js shows/hides
// the canvas and starts/stops the loop when the View mode changes.
//
// Modes:
//   bars, mirror, radial, kaleidoscope, ring, waveform, vu, phyllotaxis,
//   spectrogram, waterfall, chroma, tunnel, ripple, pulse, particles, vectorscope
//
// Shared per-frame audio features (level, bass, beat envelope) are computed
// once in _computeFeatures() so every mode can react to beats consistently.

/** Inferno-ish colour ramp: dark -> purple -> orange -> pale. */
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
    const a = SPECTRO_STOPS[i - 1];
    const b = SPECTRO_STOPS[i];
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

export const CLASSIC_MODES = [
  'bars', 'mirror', 'radial', 'kaleidoscope', 'ring', 'waveform', 'vu',
  'phyllotaxis', 'spectrogram', 'waterfall', 'chroma', 'tunnel', 'ripple',
  'pulse', 'particles', 'vectorscope',
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
    this.timeL = null;
    this.timeR = null;
    this.mode = 'bars';
    this._rafId = null;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    // Shared audio features (updated each frame).
    this.level = 0;      // RMS 0..1
    this.bass = 0;       // 0..1
    this.beatEnv = 0;    // decaying 1->0 on each detected beat
    this._bassAvg = null;
    this._lastBeat = -1;
    this._t = 0;         // seconds
    this._lastTs = 0;
    this._rot = 0;       // rotation accumulator

    // Transient per-mode state.
    this._bandsBuf = null;
    this._peaks = null;
    this._particles = [];
    this._ripples = [];
    this._history = [];  // waterfall band snapshots (newest last)

    // Offscreen 1px column for the scrolling spectrogram.
    this._specRows = 256;
    this._col = document.createElement('canvas');
    this._col.width = 1;
    this._col.height = this._specRows;
    this._colCtx = this._col.getContext('2d');
    this._colImage = this._colCtx.createImageData(1, this._specRows);
  }

  /**
   * @param {AnalyserNode} analyser mono analyser
   * @param {{left?:AnalyserNode,right?:AnalyserNode}} [stereo]
   */
  init(analyser, stereo = {}) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    if (stereo.left && stereo.right) {
      this.analyserL = stereo.left;
      this.analyserR = stereo.right;
      this.timeL = new Uint8Array(stereo.left.fftSize);
      this.timeR = new Uint8Array(stereo.right.fftSize);
    }
    this.resize();
  }

  setMode(mode) {
    this.mode = CLASSIC_MODES.includes(mode) ? mode : 'bars';
    // Reset transient state so switching never shows stale artifacts.
    this._particles = [];
    this._ripples = [];
    this._history = [];
    this._peaks = null;
    this._clear();
  }

  _clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  resize() {
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._pixelRatio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._pixelRatio));
    this._clear();
  }

  start() {
    if (this._rafId != null) return;
    this._lastTs = performance.now();
    const loop = () => {
      this._draw();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ---- Shared per-frame analysis ------------------------------------------
  _computeFeatures() {
    const now = performance.now();
    let dt = (now - this._lastTs) / 1000;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    this._lastTs = now;
    this._t += dt;
    this._dt = dt;

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    // RMS level from the time domain.
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    this.level = Math.sqrt(sum / this.time.length);

    // Bass energy + simple onset/beat detection.
    const bins = this.freq.length;
    const top = Math.max(1, Math.floor(bins / 16));
    let bs = 0;
    for (let b = 0; b < top; b++) bs += this.freq[b];
    const bass = bs / top / 255;
    this.bass = bass;
    if (this._bassAvg == null) this._bassAvg = bass;
    const beat = bass > this._bassAvg * 1.35 + 0.02 && this._t - this._lastBeat > 0.22;
    if (beat) {
      this.beatEnv = 1;
      this._lastBeat = this._t;
    }
    this._bassAvg += (bass - this._bassAvg) * 0.08;
    this.beatEnv = Math.max(0, this.beatEnv - dt * 2.5);

    this._rot += dt * (0.15 + this.level * 0.8);
    return dt;
  }

  /** Log-spaced band magnitudes (0..1), reused by several modes. */
  _bands(n) {
    const bins = this.freq.length;
    const maxLog = Math.log(bins);
    if (!this._bandsBuf || this._bandsBuf.length !== n) this._bandsBuf = new Float32Array(n);
    const out = this._bandsBuf;
    for (let i = 0; i < n; i++) {
      let b0 = Math.floor(Math.exp((i / n) * maxLog));
      let b1 = Math.floor(Math.exp(((i + 1) / n) * maxLog));
      b1 = Math.max(b0 + 1, b1);
      let s = 0, c = 0;
      for (let b = b0; b < b1 && b < bins; b++) { s += this.freq[b]; c++; }
      out[i] = c ? s / c / 255 : 0;
    }
    return out;
  }

  _fade(alpha) {
    const { ctx, canvas } = this;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  _draw() {
    if (!this.analyser) return;
    this._computeFeatures();
    switch (this.mode) {
      case 'mirror': return this._drawMirror();
      case 'radial': return this._drawRadial();
      case 'kaleidoscope': return this._drawKaleidoscope();
      case 'ring': return this._drawRing();
      case 'waveform': return this._drawWaveform();
      case 'vu': return this._drawVU();
      case 'phyllotaxis': return this._drawPhyllotaxis();
      case 'spectrogram': return this._drawSpectrogram();
      case 'waterfall': return this._drawWaterfall();
      case 'chroma': return this._drawChroma();
      case 'tunnel': return this._drawTunnel();
      case 'ripple': return this._drawRipple();
      case 'pulse': return this._drawPulse();
      case 'particles': return this._drawParticles();
      case 'vectorscope': return this._drawVectorscope();
      case 'bars':
      default: return this._drawBars();
    }
  }

  // ---- Frequency bars ------------------------------------------------------
  _drawBars() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const n = 64;
    const bands = this._bands(n);
    const gap = Math.max(1, Math.round(2 * this._pixelRatio));
    const bw = (w - gap * (n - 1)) / n;
    ctx.shadowBlur = 16 * this._pixelRatio;
    for (let i = 0; i < n; i++) {
      const mag = bands[i];
      const bh = Math.max(2, mag * h * 0.92);
      const x = i * (bw + gap);
      const hue = 200 - (i / n) * 200;
      const color = `hsl(${hue}, 90%, ${35 + mag * 30}%)`;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.fillRect(x, h - bh, bw, bh);
    }
    ctx.shadowBlur = 0;
  }

  // ---- Mirror bars with peak-hold caps ------------------------------------
  _drawMirror() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const n = 72;
    const bands = this._bands(n);
    if (!this._peaks || this._peaks.length !== n) this._peaks = new Float32Array(n);
    const gap = Math.max(1, Math.round(2 * this._pixelRatio));
    const bw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const mag = bands[i];
      this._peaks[i] = Math.max(mag, this._peaks[i] - this._dt * 0.4);
      const bh = mag * mid * 0.92;
      const x = i * (bw + gap);
      const hue = (200 - (i / n) * 200 + this._t * 12) % 360;
      ctx.fillStyle = `hsl(${(hue + 360) % 360}, 90%, ${45 + mag * 25}%)`;
      ctx.fillRect(x, mid - bh, bw, bh);        // up
      ctx.fillRect(x, mid, bw, bh);             // mirrored down
      // Peak-hold cap.
      const py = this._peaks[i] * mid * 0.92;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(x, mid - py - 2, bw, 2);
      ctx.fillRect(x, mid + py, bw, 2);
    }
  }

  // ---- Radial spectrum -----------------------------------------------------
  _drawRadial() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const inner = Math.min(w, h) * 0.16;
    const maxLen = Math.min(w, h) * 0.34;
    const n = 96;
    const bands = this._bands(n);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rot * 0.2);
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const mag = bands[i];
      const ang = (i / n) * Math.PI * 2;
      const len = inner + mag * maxLen;
      const hue = (i / n) * 360 + this._t * 20;
      ctx.strokeStyle = `hsl(${hue % 360}, 90%, ${45 + mag * 30}%)`;
      ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * inner) / n - 1);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.stroke();
    }
    // Pulsing core.
    const cr = inner * (0.5 + this.beatEnv * 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cr);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(120,90,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, cr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- Kaleidoscope (mirrored radial wedges) ------------------------------
  _drawKaleidoscope() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.48;
    const segments = 8;
    const n = 40;
    const bands = this._bands(n);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rot * 0.3);
    ctx.globalCompositeOperation = 'lighter';
    for (let s = 0; s < segments; s++) {
      ctx.save();
      ctx.rotate((s / segments) * Math.PI * 2);
      if (s % 2 === 1) ctx.scale(1, -1); // mirror alternate wedges
      const wedge = Math.PI * 2 / segments;
      for (let i = 0; i < n; i++) {
        const mag = bands[i];
        if (mag < 0.02) continue;
        const rr = (i / n) * R;
        const a0 = 0, a1 = wedge * (0.35 + mag * 0.65);
        const hue = (i / n) * 300 + this._t * 30 + s * 8;
        ctx.fillStyle = `hsla(${hue % 360}, 95%, ${40 + mag * 35}%, ${0.35 + mag * 0.5})`;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, rr + mag * R * 0.15, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- Circular waveform ---------------------------------------------------
  _drawRing() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    this.analyser.getByteTimeDomainData(this.time);
    const cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) * 0.24 * (1 + this.beatEnv * 0.15);
    const amp = Math.min(w, h) * 0.16;
    const n = this.time.length;
    ctx.lineWidth = Math.max(2, 2.2 * this._pixelRatio);
    ctx.strokeStyle = `hsl(${(this._t * 30) % 360}, 90%, 60%)`;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 12 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const v = (this.time[idx] - 128) / 128;
      const ang = (i / n) * Math.PI * 2 + this._rot * 0.2;
      const r = base + v * amp;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---- Oscilloscope waveform ----------------------------------------------
  _drawWaveform() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const n = this.time.length;
    ctx.lineWidth = Math.max(2, 2.5 * this._pixelRatio);
    ctx.strokeStyle = 'hsl(168, 90%, 55%)';
    ctx.shadowColor = 'hsl(168, 90%, 55%)';
    ctx.shadowBlur = 14 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (this.time[i] - 128) / 128;
      const x = (i / (n - 1)) * w;
      const y = mid + v * mid * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  // ---- VU meters (two analog gauges) --------------------------------------
  _drawVU() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, w, h);
    const r = Math.min(w / 2, h) * 0.6;
    this._gauge(w * 0.28, h * 0.72, r, this.level, 'LEVEL', 168);
    this._gauge(w * 0.72, h * 0.72, r, this.bass, 'BASS', 30);
  }

  _gauge(cx, cy, r, value, label, hue) {
    const { ctx } = this;
    const a0 = Math.PI * 0.8, a1 = Math.PI * 0.2 + Math.PI * 2; // sweep left->right (top arc)
    const start = Math.PI + Math.PI * 0.15;
    const end = -Math.PI * 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(2, 2 * this._pixelRatio);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end, true);
    ctx.stroke();
    // Ticks.
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = start + (end - start) * t;
      const r1 = r - 10, r2 = r + 2;
      ctx.strokeStyle = t > 0.8 ? 'rgba(255,120,120,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }
    // Needle.
    const v = Math.min(1, value * 1.4);
    const a = start + (end - start) * v;
    ctx.strokeStyle = `hsl(${hue}, 90%, 60%)`;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 10 * this._pixelRatio;
    ctx.lineWidth = Math.max(2, 3 * this._pixelRatio);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(12 * this._pixelRatio)}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + 22 * this._pixelRatio);
  }

  // ---- Phyllotaxis (sunflower spiral) -------------------------------------
  _drawPhyllotaxis() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const count = 340;
    const bands = this._bands(count);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const scale = Math.min(w, h) * 0.028 * (1 + this.level * 0.4);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rot * 0.1);
    for (let i = 0; i < count; i++) {
      const mag = bands[i];
      const a = i * golden;
      const rad = scale * Math.sqrt(i);
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      const size = (1.5 + mag * 6) * this._pixelRatio;
      const hue = (i / count) * 300 + this._t * 30;
      ctx.fillStyle = `hsl(${hue % 360}, 90%, ${40 + mag * 40}%)`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- Scrolling spectrogram ----------------------------------------------
  _drawSpectrogram() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const shift = Math.max(1, Math.round(2 * this._pixelRatio));
    ctx.drawImage(canvas, shift, 0, w - shift, h, 0, 0, w - shift, h);
    const bins = this.freq.length;
    const rows = this._specRows;
    const maxLog = Math.log(bins);
    const data = this._colImage.data;
    for (let p = 0; p < rows; p++) {
      const frac = 1 - p / (rows - 1);
      const bin = Math.min(bins - 1, Math.floor(Math.exp(frac * maxLog)));
      const [r, g, b] = inferno(this.freq[bin] / 255);
      const o = p * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
    this._colCtx.putImageData(this._colImage, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._col, 0, 0, 1, rows, w - shift, 0, shift, h);
  }

  // ---- 3D waterfall (perspective "mountain range") ------------------------
  _drawWaterfall() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    const n = 96;
    const bands = this._bands(n);
    this._history.push(Float32Array.from(bands));
    const HIST = 46;
    if (this._history.length > HIST) this._history.shift();

    const horizon = h * 0.22;
    const rows = this._history.length;
    // Draw back (oldest) to front (newest) so nearer ridges occlude farther.
    for (let j = 0; j < rows; j++) {
      const row = this._history[j];
      const depth = j / (rows - 1 || 1);        // 0 far .. 1 near
      const y0 = horizon + (h - horizon) * Math.pow(depth, 1.6);
      const scaleX = 0.35 + depth * 0.65;
      const amp = (h - horizon) * 0.30 * (0.4 + depth * 0.6);
      const x0 = w / 2 - (w / 2) * scaleX;
      const dx = (w * scaleX) / (n - 1);
      const light = 20 + depth * 45;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - row[0] * amp);
      for (let i = 1; i < n; i++) ctx.lineTo(x0 + i * dx, y0 - row[i] * amp);
      // Fill under the ridge to occlude farther rows.
      ctx.lineTo(x0 + (n - 1) * dx, y0 + 4);
      ctx.lineTo(x0, y0 + 4);
      ctx.closePath();
      ctx.fillStyle = `hsl(${(200 + depth * 80) % 360}, 70%, ${light * 0.35}%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${(200 + depth * 80) % 360}, 90%, ${light}%)`;
      ctx.lineWidth = 1 + depth * this._pixelRatio;
      ctx.stroke();
    }
  }

  // ---- Chroma / note wheel -------------------------------------------------
  _drawChroma() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const sr = (this.analyser.context && this.analyser.context.sampleRate) || 44100;
    const fftSize = this.analyser.fftSize;
    const binHz = sr / fftSize;
    const chroma = new Float32Array(12);
    const bins = this.freq.length;
    for (let b = 1; b < bins; b++) {
      const f = b * binHz;
      if (f < 30 || f > 5000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += this.freq[b] / 255;
    }
    let max = 1e-6;
    for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);

    const cx = w / 2, cy = h / 2;
    const inner = Math.min(w, h) * 0.14;
    const outer = Math.min(w, h) * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      const v = chroma[i] / max;
      const a0 = (i / 12) * Math.PI * 2 - Math.PI / 2 - Math.PI / 12;
      const a1 = a0 + (Math.PI * 2) / 12;
      const rr = inner + v * (outer - inner);
      ctx.fillStyle = `hsla(${(i / 12) * 360}, 85%, ${30 + v * 45}%, ${0.35 + v * 0.6})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, rr, a0, a1);
      ctx.closePath();
      ctx.fill();
      // Label.
      const am = (a0 + a1) / 2;
      const lr = outer + 16 * this._pixelRatio;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `${Math.round(13 * this._pixelRatio)}px Segoe UI, sans-serif`;
      ctx.fillText(NOTE_NAMES[i], Math.cos(am) * lr, Math.sin(am) * lr);
    }
    ctx.restore();
  }

  // ---- Warp tunnel (receding rotating rings) ------------------------------
  _drawTunnel() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.25);
    const cx = w / 2, cy = h / 2;
    const maxR = Math.hypot(w, h) / 2;
    const rings = 18;
    const sides = 6;
    const speed = 0.15 + this.level * 0.6 + this.beatEnv * 0.3;
    const phase = (this._t * speed) % 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rot * 0.4);
    for (let i = 0; i < rings; i++) {
      const frac = ((i + phase) % rings) / rings;
      const r = frac * frac * maxR;                 // ease so rings rush outward
      const hue = (frac * 300 + this._t * 40) % 360;
      const alpha = 0.15 + frac * 0.7;
      ctx.strokeStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;
      ctx.lineWidth = 1 + frac * 4 * this._pixelRatio;
      ctx.beginPath();
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- Beat ripples --------------------------------------------------------
  _drawRipple() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.18);
    if (this.beatEnv > 0.85) {
      this._ripples.push({ r: 0, a: 1, hue: (this._t * 50) % 360 });
    }
    const cx = w / 2, cy = h / 2;
    const speed = Math.max(w, h) * 0.35;
    for (let i = this._ripples.length - 1; i >= 0; i--) {
      const rp = this._ripples[i];
      rp.r += speed * this._dt;
      rp.a -= this._dt * 0.55;
      if (rp.a <= 0) { this._ripples.splice(i, 1); continue; }
      ctx.strokeStyle = `hsla(${rp.hue}, 90%, 60%, ${rp.a})`;
      ctx.lineWidth = (2 + rp.a * 4) * this._pixelRatio;
      ctx.beginPath();
      ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- Beat pulse (reactive polygon) --------------------------------------
  _drawPulse() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const n = 48;
    const bands = this._bands(n);
    const base = Math.min(w, h) * 0.18 * (1 + this.beatEnv * 0.6 + this.level * 0.4);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rot * 0.25);
    const hue = (this._t * 40) % 360;
    ctx.fillStyle = `hsla(${hue}, 90%, 60%, 0.85)`;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 25 * this._pixelRatio * (0.4 + this.beatEnv);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const a = (i / n) * Math.PI * 2;
      const r = base * (1 + bands[idx] * 0.9);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ---- Particles (beat-emitted) -------------------------------------------
  _drawParticles() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.2);
    const cx = w / 2, cy = h / 2;
    if (this.beatEnv > 0.8) {
      const burst = 18 + Math.floor(this.level * 30);
      const hue = (this._t * 60) % 360;
      for (let i = 0; i < burst && this._particles.length < 500; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (0.4 + Math.random() * 0.8) * Math.max(w, h) * 0.35;
        this._particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue });
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.x += p.vx * this._dt;
      p.y += p.vy * this._dt;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life -= this._dt * 0.5;
      if (p.life <= 0) { this._particles.splice(i, 1); continue; }
      const size = (1 + p.life * 3) * this._pixelRatio;
      ctx.fillStyle = `hsla(${p.hue}, 90%, 65%, ${p.life})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- Vectorscope / Lissajous (stereo X-Y) -------------------------------
  _drawVectorscope() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    this._fade(0.12);
    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) * 0.42;

    let xs, ys, n;
    if (this.analyserL && this.analyserR) {
      this.analyserL.getByteTimeDomainData(this.timeL);
      this.analyserR.getByteTimeDomainData(this.timeR);
      xs = this.timeL; ys = this.timeR; n = this.timeL.length;
    } else {
      // Mono fallback: plot signal against a delayed copy -> a phase loop.
      xs = this.time; ys = this.time; n = this.time.length;
    }
    const delay = (this.analyserL && this.analyserR) ? 0 : 24;
    ctx.strokeStyle = `hsla(${(140 + this._t * 10) % 360}, 90%, 60%, 0.9)`;
    ctx.lineWidth = Math.max(1, 1.5 * this._pixelRatio);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const xv = (xs[i] - 128) / 128;
      const yv = (ys[(i + delay) % n] - 128) / 128;
      // Rotate 45° so a mono signal shows as a vertical line (classic scope).
      const px = cx + (xv - yv) * scale * 0.707;
      const py = cy - (xv + yv) * scale * 0.707;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
