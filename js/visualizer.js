// visualizer.js — MilkDrop rendering engine wrapper around Butterchurn.
//
// Butterchurn is a WebGL2 reimplementation of Winamp's MilkDrop. It runs the
// original preset format (per-pixel + per-frame equations, waveforms, warps)
// on the GPU and reacts to a Web Audio node. This module wraps it with:
//   - resilient UMD global resolution (script-tag builds vary)
//   - a preset library with next / prev / random + auto-cycle (shuffle)
//   - a render loop and high-DPI / TV resize handling
//
// The three "classic" visuals the user asked about — frequency bars, an
// oscilloscope waveform, and a scrolling spectrum — all exist *inside* the
// MilkDrop preset language, so the community preset pack covers them and far
// more expressive variations.

/** Resolve a UMD global that may or may not be wrapped in `.default`. */
function resolveGlobal(name) {
  const g = window[name];
  if (!g) return null;
  return g.default ?? g;
}

/** True if the browser can run Butterchurn (needs WebGL2). */
export function isSupported() {
  const fn = resolveGlobal('isButterchurnSupported');
  if (typeof fn === 'function') {
    try { return !!fn(); } catch (_) { /* fall through */ }
  }
  // Fallback: probe for a WebGL2 context directly.
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch (_) {
    return false;
  }
}

export class MilkdropVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.visualizer = null;
    this.presetMap = {};      // name -> preset object
    this.presetNames = [];    // ordered names
    this.playOrder = [];      // indices, possibly shuffled
    this.orderPos = 0;
    this.currentName = '';

    this.blendTime = 2.7;     // seconds to morph between presets
    this.cycleSeconds = 20;   // auto-cycle interval
    this.shuffle = true;
    this.autoCycle = true;

    this._rafId = null;
    this._cycleTimer = null;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    /** Optional callback(presetName) fired when the preset changes. */
    this.onPresetChange = null;
  }

  // Signature keywords for the "Popular picks" group, in priority order. The
  // first entry is Butterchurn's iconic demo/default preset; the rest are
  // celebrated MilkDrop authors (Ryan Geiss created MilkDrop itself).
  static POPULAR_KEYWORDS = [
    'dedicated to the sherwin',
    'Geiss',
    'Flexi',
    'Rovastar',
    'cope',
    'Aderrasi',
    'Unchained',
    'martin',
    'Royal',
  ];

  /**
   * Create the Butterchurn visualizer bound to an AudioContext + audio node.
   * @param {AudioContext} audioContext
   * @param {AudioNode} audioNode
   */
  init(audioContext, audioNode) {
    const Butterchurn = resolveGlobal('butterchurn');
    if (!Butterchurn || typeof Butterchurn.createVisualizer !== 'function') {
      throw new Error(
        'The MilkDrop engine (Butterchurn) failed to load. Check your internet ' +
          'connection — the visuals are fetched from a CDN.'
      );
    }

    const { width, height } = this._computeSize();
    this.visualizer = Butterchurn.createVisualizer(audioContext, this.canvas, {
      width,
      height,
      pixelRatio: this._pixelRatio,
      textureRatio: 1,
    });
    this.visualizer.connectAudio(audioNode);
    this.canvas.width = width;
    this.canvas.height = height;

    this._loadPresetLibrary();
  }

  /** Point the visualizer at a different audio node (e.g. after switching input). */
  connectAudio(audioNode) {
    if (this.visualizer) this.visualizer.connectAudio(audioNode);
  }

  /** Pull presets out of the butterchurn-presets UMD bundle. */
  _loadPresetLibrary() {
    const Presets = resolveGlobal('butterchurnPresets');
    let map = {};
    if (Presets && typeof Presets.getPresets === 'function') {
      map = Presets.getPresets() || {};
    }
    this.presetMap = map;
    this.presetNames = Object.keys(map);

    if (this.presetNames.length === 0) {
      throw new Error('No MilkDrop presets were available to load.');
    }

    this._rebuildPlayOrder();
    // Start somewhere pleasant rather than always the first alphabetically.
    this.orderPos = 0;
    this._applyPresetAtOrderPos(0.0);
  }

  /** Build (and optionally shuffle) the sequence presets play in. */
  _rebuildPlayOrder() {
    const n = this.presetNames.length;
    this.playOrder = Array.from({ length: n }, (_, i) => i);
    if (this.shuffle) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.playOrder[i], this.playOrder[j]] = [this.playOrder[j], this.playOrder[i]];
      }
    }
  }

  _applyPresetAtOrderPos(blend = this.blendTime) {
    const nameIndex = this.playOrder[this.orderPos];
    const name = this.presetNames[nameIndex];
    const preset = this.presetMap[name];
    if (!preset) return;
    this.visualizer.loadPreset(preset, blend);
    this.currentName = name;
    if (typeof this.onPresetChange === 'function') this.onPresetChange(name);
  }

  nextPreset(blend = this.blendTime) {
    if (this.presetNames.length === 0) return;
    this.orderPos = (this.orderPos + 1) % this.playOrder.length;
    this._applyPresetAtOrderPos(blend);
    this._restartCycleTimer();
  }

  prevPreset(blend = this.blendTime) {
    if (this.presetNames.length === 0) return;
    this.orderPos = (this.orderPos - 1 + this.playOrder.length) % this.playOrder.length;
    this._applyPresetAtOrderPos(blend);
    this._restartCycleTimer();
  }

  randomPreset(blend = this.blendTime) {
    if (this.presetNames.length === 0) return;
    this.orderPos = Math.floor(Math.random() * this.playOrder.length);
    this._applyPresetAtOrderPos(blend);
    this._restartCycleTimer();
  }

  get currentPresetName() {
    return this.currentName;
  }

  /** All preset names, alphabetically (as provided by the pack). */
  getPresetNames() {
    return this.presetNames.slice();
  }

  /**
   * A short, curated list of well-known / crowd-favourite presets that are
   * actually present in the loaded pack. Matched by author/signature keyword
   * so it stays correct even if exact names shift between pack versions.
   * @param {number} [limit]
   * @returns {string[]}
   */
  getPopularPresetNames(limit = 14) {
    const picked = [];
    const seen = new Set();
    for (const kw of MilkdropVisualizer.POPULAR_KEYWORDS) {
      const needle = kw.toLowerCase();
      for (const name of this.presetNames) {
        if (picked.length >= limit) break;
        if (seen.has(name)) continue;
        if (name.toLowerCase().includes(needle)) {
          picked.push(name);
          seen.add(name);
        }
      }
      if (picked.length >= limit) break;
    }
    return picked;
  }

  /**
   * Jump straight to a preset by its exact name (from the dropdown).
   * @param {string} name
   * @param {number} [blend]
   */
  loadPresetByName(name, blend = this.blendTime) {
    const nameIndex = this.presetNames.indexOf(name);
    if (nameIndex < 0) return;
    const pos = this.playOrder.indexOf(nameIndex);
    this.orderPos = pos >= 0 ? pos : 0;
    this._applyPresetAtOrderPos(blend);
    this._restartCycleTimer();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    // Preserve the currently-showing preset as the new anchor point.
    const currentIndex = this.presetNames.indexOf(this.currentName);
    this._rebuildPlayOrder();
    const posInOrder = this.playOrder.indexOf(currentIndex);
    this.orderPos = posInOrder >= 0 ? posInOrder : 0;
  }

  setAutoCycle(on) {
    this.autoCycle = !!on;
    this._restartCycleTimer();
  }

  setCycleSeconds(seconds) {
    this.cycleSeconds = Math.max(3, seconds);
    this._restartCycleTimer();
  }

  _restartCycleTimer() {
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }
    if (this.autoCycle) {
      this._cycleTimer = setInterval(() => {
        this.orderPos = (this.orderPos + 1) % this.playOrder.length;
        this._applyPresetAtOrderPos(this.blendTime);
      }, this.cycleSeconds * 1000);
    }
  }

  /** Compute the render size in device pixels for the current viewport. */
  _computeSize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    return {
      width: Math.floor(w * this._pixelRatio),
      height: Math.floor(h * this._pixelRatio),
    };
  }

  /** Resize the renderer + canvas backing store to match the viewport. */
  resize() {
    if (!this.visualizer) return;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this._computeSize();
    this.visualizer.setRendererSize(width, height);
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** Begin the render loop. */
  start() {
    if (this._rafId != null) return;
    const loop = () => {
      this.visualizer.render();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
    this._restartCycleTimer();
  }

  /** Stop rendering and auto-cycling. */
  stop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }
  }
}
