// main.js — application orchestrator for Kaleidosound.
//
// Ties together the three concerns:
//   AudioEngine        (input capture + gain)
//   MilkdropVisualizer (Butterchurn / MilkDrop rendering + presets)
//   UI                 (TV control bar, toast, keyboard/remote)
//
// Flow: user picks an input on the landing overlay -> we capture audio, spin
// up Butterchurn, hide the overlay, and start rendering fullscreen.

import { AudioEngine } from './audio.js';
import { MilkdropVisualizer, isSupported } from './visualizer.js';
import { ClassicVisualizer, CLASSIC_MODES } from './classic.js';
import { AvsVisualizer, isAvsSupported } from './avs.js';
import { ShaderVisualizer, isShaderSupported } from './shaders.js';
import { UI } from './ui.js';
import { enterImmersive } from './native.js';

// View modes: the preset engines (MilkDrop, AVS, Shaders) first, then the
// classic 2D visualizers.
const VIEW_ORDER = ['milkdrop', 'avs', 'shaders', ...CLASSIC_MODES];

// Engines that have browsable presets (so the ◀ ▶ nav applies).
const PRESET_ENGINES = ['milkdrop', 'avs', 'shaders'];

const MODE_LABELS = {
  milkdrop: 'MilkDrop',
  avs: 'AVS (Winamp)',
  shaders: 'Shaders (G-Force style)',
  // Ambient
  orb: 'Orb',
  aurora: 'Aurora',
  fluid: 'Fluid ink',
  metaballs: 'Metaballs',
  cymatics: 'Cymatics',
  // Reactive
  bars: 'Frequency bars',
  mirror: 'Mirror bars',
  radial: 'Radial spectrum',
  kaleidoscope: 'Kaleidoscope',
  ring: 'Circular waveform',
  waveform: 'Waveform',
  tunnel: 'Warp tunnel',
  ripple: 'Beat ripples',
  pulse: 'Beat pulse',
  particles: 'Particles',
  phyllotaxis: 'Phyllotaxis',
  // Analytic
  spectrogram: 'Spectrogram',
  waterfall: '3D waterfall',
  polarspectro: 'Polar spectrogram',
  chroma: 'Note wheel',
  vu: 'VU meters',
  vectorscope: 'Vectorscope',
  stereofield: 'Stereo field',
  dome: 'Spatial dome',
  ribbons: 'Band ribbons',
  hpss: 'Harmonic / percussive',
  constellation: 'Harmonic constellation',
  // Generative
  attractor: 'Strange attractor',
  voronoi: 'Voronoi cells',
  network: 'Line network',
  harmonograph: 'Harmonograph',
  depthfield: 'Depth field',
  ribbon3d: '3D ribbon',
  flythrough: 'Terrain flythrough',
};

class App {
  constructor() {
    this.canvas = document.getElementById('viz');
    this.canvas2d = document.getElementById('viz2d');
    this.canvasAvs = document.getElementById('vizavs');
    this.audio = new AudioEngine();
    this.viz = new MilkdropVisualizer(this.canvas);
    this.classic = new ClassicVisualizer(this.canvas2d);
    this.avs = new AvsVisualizer(this.canvasAvs);
    this.canvasShader = document.getElementById('vizshader');
    this.shaders = new ShaderVisualizer(this.canvasShader);
    this.ui = new UI();
    this.started = false;
    this.sensitivity = 1;
    this.mode = 'milkdrop';
    this._wakeLock = null;
  }

  init() {
    // Bail early with a clear message if the TV browser lacks WebGL2.
    if (!isSupported()) {
      this.ui.showError(
        'This browser can’t run the MilkDrop engine (WebGL2 is required). ' +
          'Try a newer browser, or cast from a phone/laptop to the TV instead.'
      );
      return;
    }

    this.viz.onPresetChange = (name) => this.ui.setPresetName(name);
    this.avs.onPresetChange = (name) => this.ui.setPresetName(name);
    this.shaders.onPresetChange = (name) => this.ui.setPresetName(name);

    this.ui.bind({
      onChooseSource: (type) => this.startWithSource(type),
      onRetry: () => this.ui.showChooser(),
      onSourceChange: (type) => this.switchInput({ sourceType: type }),
      onDeviceChange: (deviceId) => this.switchInput({ deviceId }),
      onModeChange: (mode) => this.setMode(mode),
      onCycleMode: () => this.cycleMode(),
      onPrev: () => {
        if (this.mode === 'milkdrop') this.viz.prevPreset();
        else if (this.mode === 'avs') this.avs.prev();
        else if (this.mode === 'shaders') this.shaders.prev();
      },
      onNext: () => {
        if (this.mode === 'milkdrop') this.viz.nextPreset();
        else if (this.mode === 'avs') this.avs.next();
        else if (this.mode === 'shaders') this.shaders.next();
      },
      onPresetSelect: (name) => this.viz.loadPresetByName(name),
      onToggleShuffle: () => this.toggleShuffle(),
      onToggleCycle: () => this.toggleCycle(),
      onSensitivity: (v) => this.setSensitivity(v),
    });

    // Keep both renderers matched to the window / TV resolution.
    window.addEventListener('resize', () => {
      this.viz.resize();
      this.classic.resize();
      this.avs.resize();
      this.shaders.resize();
    });

    // Re-acquire the screen wake lock when returning to the app (the OS drops
    // it when the app is backgrounded).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.started) {
        this._acquireWakeLock();
      }
    });

    this.ui.showChooser();
  }

  /** First-run entry: capture the chosen input and boot the visualizer. */
  async startWithSource(sourceType) {
    this.ui.showLoading('Requesting audio access…');
    try {
      const node = await this.audio.start({ sourceType });

      if (!this.started) {
        this.ui.showLoading('Loading MilkDrop presets…');
        this.viz.init(this.audio.audioContext, node);
        this.viz.start();
        this.started = true;

        // The classic visualizers read from the shared analyser (plus the
        // per-channel analysers for the stereo vectorscope).
        this.classic.init(this.audio.analyser, {
          left: this.audio.analyserL,
          right: this.audio.analyserR,
        });

        // The Winamp AVS engine (webvs) — optional; guarded so a load failure
        // never blocks the rest of the app. Initialized but not started until
        // the AVS view is selected.
        if (isAvsSupported()) {
          try {
            this.avs.init(this.audio.audioContext, node);
            this.avs.stop();
          } catch (e) {
            console.warn('AVS engine unavailable:', e);
          }
        }

        // The GLSL shader engine (G-Force-style). Reads the shared analyser.
        if (isShaderSupported()) {
          try {
            this.shaders.init(this.audio.analyser);
            this.shaders.stop();
          } catch (e) {
            console.warn('Shader engine unavailable:', e);
          }
        }

        // Populate the browse dropdown once presets are loaded.
        this.ui.setPresetList(
          this.viz.getPresetNames(),
          this.viz.getPopularPresetNames()
        );
        this.ui.setCurrentPresetInList(this.viz.currentPresetName);
        this.ui.setViewMode(this.mode);
        this.ui.setMilkdropControlsEnabled(this.mode === 'milkdrop');
      } else {
        this.viz.connectAudio(node);
      }

      // Now that permission is granted, device labels are available.
      await this.refreshDevices();
      this.ui.setSourceType(sourceType);
      this.ui.setSensitivityValue(this.sensitivity);
      this.ui.setShuffleState(this.viz.shuffle);
      this.ui.setCycleState(this.viz.autoCycle);

      this.ui.hideOverlay();
      this.ui.showControls();
      this._acquireWakeLock();
      enterImmersive(); // clean, chrome-free display for TV mirroring
      this.ui.toast(
        sourceType === 'mic'
          ? 'Microphone live — sing, play, or point it at the birds 🐦'
          : 'Line-in live — play your music 🎵',
        3200
      );
    } catch (err) {
      console.error(err);
      this.ui.showError(err.message || 'Something went wrong starting audio.');
    }
  }

  /** Switch input source or device after the app is already running. */
  async switchInput({ sourceType, deviceId } = {}) {
    if (!this.started) return;
    try {
      const opts = {};
      opts.sourceType = sourceType ?? this.audio.sourceType;
      if (deviceId !== undefined) opts.deviceId = deviceId || null;
      const node = await this.audio.start(opts);
      this.viz.connectAudio(node);
      this.audio.setSensitivity(this.sensitivity);
      await this.refreshDevices();
      this.ui.setSourceType(this.audio.sourceType);
      this.ui.toast('Input switched', 1600);
    } catch (err) {
      console.error(err);
      this.ui.toast(err.message || 'Could not switch input.', 3200);
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

  /** Switch between the MilkDrop / AVS engines and the classic 2D views. */
  setMode(mode) {
    if (!VIEW_ORDER.includes(mode)) return;
    if (mode === 'avs' && !this.avs.ready) {
      this.ui.toast('AVS engine is unavailable in this browser', 2200);
      return;
    }
    if (mode === 'shaders' && !this.shaders.ready) {
      this.ui.toast('Shader engine is unavailable in this browser', 2200);
      return;
    }
    this.mode = mode;
    const isMilk = mode === 'milkdrop';
    const isAvs = mode === 'avs';
    const isShaders = mode === 'shaders';
    const isClassic = !isMilk && !isAvs && !isShaders;

    // Show only the active canvas.
    this.canvas.classList.toggle('canvas-hidden', !isMilk);
    this.canvasAvs.classList.toggle('canvas-hidden', !isAvs);
    this.canvasShader.classList.toggle('canvas-hidden', !isShaders);
    this.canvas2d.classList.toggle('canvas-hidden', !isClassic);

    // Only one render loop runs at a time (saves GPU/CPU).
    this.viz.stop();
    this.avs.stop();
    this.shaders.stop();
    this.classic.stop();
    if (isMilk) {
      this.viz.resize();
      this.viz.start();
    } else if (isAvs) {
      this.avs.start();
    } else if (isShaders) {
      this.shaders.start();
    } else {
      this.classic.setMode(mode);
      this.classic.resize();
      this.classic.start();
    }

    this.ui.setViewMode(mode);
    // Preset nav (◀ ▶) applies to any preset engine; the browse dropdown is
    // MilkDrop-specific but harmless when idle.
    this.ui.setMilkdropControlsEnabled(PRESET_ENGINES.includes(mode));
    this.ui.toast(MODE_LABELS[mode] || mode, 1600);
  }

  cycleMode() {
    const i = VIEW_ORDER.indexOf(this.mode);
    const next = VIEW_ORDER[(i + 1) % VIEW_ORDER.length];
    this.setMode(next);
  }

  toggleShuffle() {
    const next = !this.viz.shuffle;
    this.viz.setShuffle(next);
    this.ui.setShuffleState(next);
    this.ui.toast(next ? 'Shuffle on' : 'Shuffle off', 1400);
  }

  toggleCycle() {
    const next = !this.viz.autoCycle;
    this.viz.setAutoCycle(next);
    this.ui.setCycleState(next);
    this.ui.toast(next ? 'Auto-cycle on' : 'Auto-cycle off', 1400);
  }

  setSensitivity(value) {
    this.sensitivity = value;
    this.audio.setSensitivity(value);
  }

  /** Keep the screen awake during a show (no-op if the API is unavailable). */
  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => {
          this._wakeLock = null;
        });
      }
    } catch (_) {
      // Wake lock can be rejected (e.g. low battery); the visuals still run.
    }
  }
}

// Boot once the DOM is ready. (Module scripts are deferred, so the DOM and the
// CDN classic scripts above have already parsed/run by now.)
const app = new App();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.init());
} else {
  app.init();
}
