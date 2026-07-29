// classic.js — the "standard" 2D visualizers: frequency bars, oscilloscope
// waveform, and a scrolling spectrogram.
//
// These render to a plain 2D <canvas> (separate from Butterchurn's WebGL
// canvas) and read audio from a shared AnalyserNode owned by the AudioEngine.
// Only one visual system draws at a time — main.js shows/hides the canvases
// and starts/stops the matching render loop when the View mode changes.

/** Inferno-ish colour ramp for the spectrogram: dark -> purple -> orange -> pale. */
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

export const CLASSIC_MODES = ['bars', 'waveform', 'spectrogram'];

export class ClassicVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas 2D canvas to draw on
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.freq = null; // Uint8Array frequency data
    this.time = null; // Uint8Array time-domain data
    this.mode = 'bars';
    this._rafId = null;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    // Offscreen 1px-wide column used to blit each new spectrogram slice.
    this._specRows = 256;
    this._col = document.createElement('canvas');
    this._col.width = 1;
    this._col.height = this._specRows;
    this._colCtx = this._col.getContext('2d');
    this._colImage = this._colCtx.createImageData(1, this._specRows);
  }

  /** Bind the shared analyser and allocate data buffers. */
  init(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    this.resize();
  }

  setMode(mode) {
    this.mode = CLASSIC_MODES.includes(mode) ? mode : 'bars';
    this._clear();
  }

  _clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Match the backing store to the viewport in device pixels. */
  resize() {
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._pixelRatio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._pixelRatio));
    this._clear();
  }

  start() {
    if (this._rafId != null) return;
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

  _draw() {
    if (!this.analyser) return;
    switch (this.mode) {
      case 'waveform':
        this._drawWaveform();
        break;
      case 'spectrogram':
        this._drawSpectrogram();
        break;
      case 'bars':
      default:
        this._drawBars();
        break;
    }
  }

  // ---- Frequency bars ------------------------------------------------------
  // Log-spaced bins so the bars track musical octaves rather than clumping in
  // the low end, coloured across the spectrum with a soft glow.
  _drawBars() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.analyser.getByteFrequencyData(this.freq);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const bins = this.freq.length;
    const barCount = 64;
    const gap = Math.max(1, Math.round(2 * this._pixelRatio));
    const barWidth = (w - gap * (barCount - 1)) / barCount;
    const maxLog = Math.log(bins);

    ctx.shadowBlur = 16 * this._pixelRatio;
    for (let i = 0; i < barCount; i++) {
      // Log-scaled bin window for this bar.
      let b0 = Math.floor(Math.exp((i / barCount) * maxLog));
      let b1 = Math.floor(Math.exp(((i + 1) / barCount) * maxLog));
      b1 = Math.max(b0 + 1, b1);
      let sum = 0;
      for (let b = b0; b < b1 && b < bins; b++) sum += this.freq[b];
      const avg = sum / (b1 - b0);
      const mag = avg / 255;

      const barHeight = Math.max(2, mag * h * 0.92);
      const x = i * (barWidth + gap);
      const hue = 200 - (i / barCount) * 200; // cyan-blue -> red across spectrum
      const color = `hsl(${hue}, 90%, ${35 + mag * 30}%)`;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.fillRect(x, h - barHeight, barWidth, barHeight);
    }
    ctx.shadowBlur = 0;
  }

  // ---- Oscilloscope waveform ----------------------------------------------
  _drawWaveform() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.analyser.getByteTimeDomainData(this.time);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const n = this.time.length;
    const mid = h / 2;
    ctx.lineWidth = Math.max(2, 2.5 * this._pixelRatio);
    ctx.strokeStyle = 'hsl(168, 90%, 55%)';
    ctx.shadowColor = 'hsl(168, 90%, 55%)';
    ctx.shadowBlur = 14 * this._pixelRatio;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (this.time[i] - 128) / 128; // -1..1
      const x = (i / (n - 1)) * w;
      const y = mid + v * mid * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Faint centre line for reference.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  // ---- Scrolling spectrogram ----------------------------------------------
  // Time flows left->right; the newest slice is drawn at the right edge and
  // the existing image is shifted left each frame. Low frequencies at the
  // bottom, highs at the top (log-scaled).
  _drawSpectrogram() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.analyser.getByteFrequencyData(this.freq);

    const shift = Math.max(1, Math.round(2 * this._pixelRatio));

    // Scroll everything left by `shift` px (drawing the canvas onto itself).
    ctx.drawImage(canvas, shift, 0, w - shift, h, 0, 0, w - shift, h);

    // Build the new right-edge column into the offscreen 1xN image.
    const bins = this.freq.length;
    const rows = this._specRows;
    const maxLog = Math.log(bins);
    const data = this._colImage.data;
    for (let p = 0; p < rows; p++) {
      // p = 0 at top (high freq), p = rows-1 at bottom (low freq).
      const frac = 1 - p / (rows - 1); // 1 at top
      const bin = Math.min(bins - 1, Math.floor(Math.exp(frac * maxLog)));
      const [r, g, b] = inferno(this.freq[bin] / 255);
      const o = p * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    this._colCtx.putImageData(this._colImage, 0, 0);

    // Stretch the 1xN column across the new right-edge strip, full height.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._col, 0, 0, 1, rows, w - shift, 0, shift, h);
  }
}
