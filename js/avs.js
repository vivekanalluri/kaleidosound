// avs.js — Winamp AVS engine wrapper around webvs (open-source AVS port).
//
// A second "preset engine" alongside MilkDrop/Butterchurn. It renders to its
// own WebGL canvas and reads our live audio via webvs's WebAudioAnalyser, which
// can attach to any existing Web Audio node (connectToNode). Everything is
// guarded so that if webvs fails to load, the rest of the app is unaffected.

import { AVS_PRESETS } from './avs-presets.js';

function resolveGlobal(name) {
  const g = window[name];
  return g ? (g.default ?? g) : null;
}

/** True if the webvs global loaded and WebGL is available. */
export function isAvsSupported() {
  const W = resolveGlobal('Webvs');
  if (!(W && W.Main && W.WebAudioAnalyser)) return false;
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl');
  } catch (_) {
    return false;
  }
}

export class AvsVisualizer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.webvs = null;
    this.analyser = null;
    this.index = 0;
    this.ready = false;
    this.cycleSeconds = 20;
    this._cycleTimer = null;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    /** Optional callback(name) when the preset changes. */
    this.onPresetChange = null;
  }

  /**
   * Create the webvs visualizer bound to our AudioContext + audio node.
   * Must share the SAME AudioContext as the source node (cross-context
   * WebAudio connections are illegal).
   */
  init(audioContext, sourceNode) {
    const W = resolveGlobal('Webvs');
    if (!W || !W.Main) throw new Error('The AVS engine (webvs) failed to load.');
    this.analyser = new W.WebAudioAnalyser({ context: audioContext, fftSize: 512 });
    this.analyser.connectToNode(sourceNode);
    this._sizeCanvas();
    this.webvs = new W.Main({ canvas: this.canvas, analyser: this.analyser, showStat: false });
    this.ready = true;
    this._apply(0);
  }

  _sizeCanvas() {
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._pixelRatio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._pixelRatio));
  }

  _apply(i) {
    if (!this.webvs || AVS_PRESETS.length === 0) return;
    this.index = ((i % AVS_PRESETS.length) + AVS_PRESETS.length) % AVS_PRESETS.length;
    try {
      this.webvs.loadPreset(AVS_PRESETS[this.index].preset);
      if (this.onPresetChange) this.onPresetChange(AVS_PRESETS[this.index].name);
    } catch (e) {
      console.warn('AVS preset failed to load:', AVS_PRESETS[this.index].name, e);
    }
  }

  next() { this._apply(this.index + 1); this._restartCycle(); }
  prev() { this._apply(this.index - 1); this._restartCycle(); }

  get currentName() {
    return AVS_PRESETS[this.index] ? AVS_PRESETS[this.index].name : '';
  }

  _restartCycle() {
    if (this._cycleTimer) { clearInterval(this._cycleTimer); this._cycleTimer = null; }
    this._cycleTimer = setInterval(() => this._apply(this.index + 1), this.cycleSeconds * 1000);
  }

  start() {
    if (!this.webvs) return;
    this._sizeCanvas();
    if (this.webvs.notifyResize) this.webvs.notifyResize();
    this.webvs.start();
    this._restartCycle();
  }

  stop() {
    if (this.webvs) {
      try { this.webvs.stop(); } catch (_) { /* noop */ }
    }
    if (this._cycleTimer) { clearInterval(this._cycleTimer); this._cycleTimer = null; }
  }

  resize() {
    if (!this.webvs) return;
    this._sizeCanvas();
    if (this.webvs.notifyResize) this.webvs.notifyResize();
  }
}
