// main.js — application orchestrator for Kaleidosound.
//
// A single curated list of "Visual Presets" spanning two engines:
//   MilkDrop (Butterchurn)  — for the two named MilkDrop presets
//   Classic (2D canvas)     — for the bars / spectrum / constellation / etc.
//
// The app jumps straight into the visuals (no landing page). The audio graph
// is built at load so visuals render immediately; the microphone starts on the
// first user gesture (a browser requirement). Timer + Shuffle auto-advance
// through the presets; Sensitivity maps to input gain; Brightness dims output.

import { AudioEngine } from './audio.js';
import { MilkdropVisualizer, isSupported } from './visualizer.js';
import { ClassicVisualizer } from './classic.js';
import { UI } from './ui.js';
import { enterImmersive } from './native.js';

// The curated preset list (the only visuals exposed).
const PRESETS = [
  { label: 'Chains', engine: 'milkdrop', preset: 'martin - chain breaker' },
  { label: 'Cubes', engine: 'milkdrop', preset: 'Eo.S. + Phat - cubetrace - v2' },
  { label: 'V Bars', engine: 'classic', mode: 'bars' },
  { label: 'H Bars', engine: 'classic', mode: 'mirror' },
  { label: 'Spectrum', engine: 'classic', mode: 'spectrum' },
  { label: 'Constellation', engine: 'classic', mode: 'constellation' },
  { label: 'Percussion', engine: 'classic', mode: 'hpss' },
];

const CYCLE_SECONDS = 20;

class App {
  constructor() {
    this.canvas = document.getElementById('viz');
    this.canvas2d = document.getElementById('viz2d');
    this.audio = new AudioEngine();
    this.viz = new MilkdropVisualizer(this.canvas);
    this.classic = new ClassicVisualizer(this.canvas2d);
    this.ui = new UI();

    this.presetIndex = 0;
    this.sourceType = 'mic';
    this.sensitivity = 1;
    this.brightness = 1;
    this.shuffle = false;
    this.timerOn = true;
    this.audioStarted = false;
    this.milkReady = false;
    this._timer = null;
    this._wakeLock = null;
  }

  init() {
    // Build the audio graph now so the visuals can render immediately.
    try {
      this.audio.prepare();
    } catch (e) {
      this.ui.toast(e.message || 'Web Audio is unavailable in this browser.', 5000);
      return;
    }

    // MilkDrop needs WebGL2; if unavailable we still run the classic presets.
    this.milkReady = isSupported();
    if (this.milkReady) {
      try {
        this.viz.init(this.audio.audioContext, this.audio.outputNode);
        this.viz.setAutoCycle(false); // the app manages advancing, not the engine
        this.viz.stop();
      } catch (e) {
        console.warn('MilkDrop unavailable:', e);
        this.milkReady = false;
      }
    }

    this.classic.init(this.audio.analyser, {
      left: this.audio.analyserL,
      right: this.audio.analyserR,
    });

    this.viz.onPresetChange = null; // preset names come from our labels

    this.ui.bind({
      onPresetSelect: (i) => this.setPreset(i),
      onPrev: () => this.step(-1),
      onNext: () => this.step(+1),
      onSourceChange: (type) => this.switchInput({ sourceType: type }),
      onDeviceChange: (id) => this.switchInput({ deviceId: id }),
      onToggleShuffle: () => this.toggleShuffle(),
      onToggleTimer: () => this.toggleTimer(),
      onSensitivity: (v) => this.setSensitivity(v),
      onBrightness: (v) => this.setBrightness(v),
    });

    this.ui.setPresetOptions(PRESETS.map((p) => p.label));
    this.ui.setSourceType(this.sourceType);
    this.ui.setSensitivityValue(this.sensitivity);
    this.ui.setBrightnessValue(this.brightness);
    this.ui.setShuffleState(this.shuffle);
    this.ui.setTimerState(this.timerOn);
    this.setBrightness(this.brightness);

    window.addEventListener('resize', () => {
      this.viz.resize();
      this.classic.resize();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.audioStarted) {
        this._acquireWakeLock();
      }
    });

    // Jump straight in: show the default preset rendering immediately.
    const playable = this._playable();
    const first = playable.includes(0) ? 0 : playable[0];
    this.setPreset(first, { toast: false });
    this.ui.showControls();

    // Start audio on the first user gesture (browser requirement).
    const enable = () => this.enableAudio();
    window.addEventListener('pointerdown', enable, { once: true });
    window.addEventListener('keydown', enable, { once: true });
    window.addEventListener('touchstart', enable, { once: true, passive: true });
    this.ui.toast('Tap anywhere to start the microphone 🎤', 4000);
  }

  /** Indices of presets that can actually play in this browser. */
  _playable() {
    return PRESETS.map((_, i) => i).filter(
      (i) => this.milkReady || PRESETS[i].engine !== 'milkdrop'
    );
  }

  /** Switch to a preset by index; starts the matching engine. */
  setPreset(index, { toast = true, resetTimer = true } = {}) {
    const n = PRESETS.length;
    index = ((index % n) + n) % n;
    const p = PRESETS[index];
    if (p.engine === 'milkdrop' && !this.milkReady) {
      this.ui.toast('“' + p.label + '” needs WebGL2 (unavailable here)', 2400);
      return;
    }
    this.presetIndex = index;
    const useMilk = p.engine === 'milkdrop';

    this.canvas.classList.toggle('canvas-hidden', !useMilk);
    this.canvas2d.classList.toggle('canvas-hidden', useMilk);

    if (useMilk) {
      this.classic.stop();
      this.viz.resize();
      this.viz.start();
      this.viz.loadPresetByName(p.preset, 2.7);
    } else {
      this.viz.stop();
      this.classic.setMode(p.mode);
      this.classic.resize();
      this.classic.start();
    }

    this.ui.setPresetValue(index);
    if (toast) this.ui.toast(p.label, 1600);
    if (resetTimer) this._restartTimer();
  }

  /** Step through playable presets (arrow keys / manual). */
  step(dir) {
    const pl = this._playable();
    const pos = pl.indexOf(this.presetIndex);
    const next = pl[(pos + dir + pl.length) % pl.length];
    this.setPreset(next);
  }

  /** Timer tick: advance sequentially, or randomly when shuffle is on. */
  advance() {
    const pl = this._playable();
    if (pl.length <= 1) return;
    let next;
    if (this.shuffle) {
      do {
        next = pl[Math.floor(Math.random() * pl.length)];
      } while (next === this.presetIndex);
    } else {
      const pos = pl.indexOf(this.presetIndex);
      next = pl[(pos + 1) % pl.length];
    }
    this.setPreset(next, { resetTimer: false });
  }

  _restartTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.timerOn) this._timer = setInterval(() => this.advance(), CYCLE_SECONDS * 1000);
  }

  // ---- Audio ---------------------------------------------------------------

  async enableAudio() {
    if (this.audioStarted) return;
    await this.switchInput({});
  }

  async switchInput({ sourceType, deviceId } = {}) {
    try {
      const opts = { sourceType: sourceType ?? this.sourceType };
      if (deviceId !== undefined) opts.deviceId = deviceId || null;
      await this.audio.start(opts);
      this.audioStarted = true;
      this.sourceType = this.audio.sourceType;
      this.audio.setSensitivity(this.sensitivity);
      await this.refreshDevices();
      this.ui.setSourceType(this.sourceType);
      this._acquireWakeLock();
      enterImmersive();
    } catch (err) {
      console.error(err);
      this.ui.toast(err.message || 'Could not start audio.', 3200);
    }
  }

  async refreshDevices() {
    try {
      const devices = await this.audio.listInputDevices();
      this.ui.setDevices(devices, this.audio.deviceId);
    } catch (_) {
      this.ui.setDevices([], null);
    }
  }

  // ---- Controls ------------------------------------------------------------

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.ui.setShuffleState(this.shuffle);
    this.ui.toast(this.shuffle ? 'Shuffle on' : 'Shuffle off', 1400);
  }

  toggleTimer() {
    this.timerOn = !this.timerOn;
    this.ui.setTimerState(this.timerOn);
    this._restartTimer();
    this.ui.toast(this.timerOn ? 'Auto-advance on' : 'Auto-advance off', 1400);
  }

  setSensitivity(value) {
    this.sensitivity = value;
    this.audio.setSensitivity(value);
  }

  setBrightness(value) {
    this.brightness = value;
    document.documentElement.style.setProperty('--dim', String(value));
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      }
    } catch (_) { /* non-fatal */ }
  }
}

const app = new App();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.init());
} else {
  app.init();
}
