// ui.js — the interface layer: the auto-hiding bottom control bar, the status
// toast, fullscreen, and keyboard/remote navigation. It knows nothing about
// audio or WebGL; it calls back into the app controller passed to bind().
//
// Remote/keyboard model:
//   ← / →  previous / next preset      ↑ / ↓  sensitivity
//   Enter / Space  show/hide controls  F  fullscreen
//   R  shuffle     T  timer

const CONTROLS_HIDE_MS = 4500;

export class UI {
  constructor() {
    this.el = {
      controls: document.getElementById('controls'),
      presetSelect: document.getElementById('preset-select'),
      sourceSelect: document.getElementById('source-select'),
      deviceSelect: document.getElementById('device-select'),
      shuffle: document.getElementById('btn-shuffle'),
      timer: document.getElementById('btn-timer'),
      sensitivity: document.getElementById('sensitivity'),
      brightness: document.getElementById('brightness'),
      fullscreen: document.getElementById('btn-fullscreen'),
      toast: document.getElementById('toast'),
    };
    this._hideTimer = null;
    this._toastTimer = null;
    this._controlsVisible = false;
    this.handlers = {};
  }

  bind(handlers) {
    this.handlers = handlers || {};
    const h = this.handlers;

    this.el.presetSelect.addEventListener('change', (e) =>
      h.onPresetSelect?.(parseInt(e.target.value, 10))
    );
    this.el.sourceSelect.addEventListener('change', (e) =>
      h.onSourceChange?.(e.target.value)
    );
    this.el.deviceSelect.addEventListener('change', (e) =>
      h.onDeviceChange?.(e.target.value)
    );
    this.el.shuffle.addEventListener('click', () => h.onToggleShuffle?.());
    this.el.timer.addEventListener('click', () => h.onToggleTimer?.());
    this.el.sensitivity.addEventListener('input', (e) =>
      h.onSensitivity?.(parseFloat(e.target.value))
    );
    this.el.brightness.addEventListener('input', (e) =>
      h.onBrightness?.(parseFloat(e.target.value))
    );
    this.el.fullscreen.addEventListener('click', () => this.toggleFullscreen());

    // Any pointer activity reveals the controls and resets the hide timer.
    ['mousemove', 'pointerdown', 'touchstart'].forEach((evt) =>
      window.addEventListener(evt, () => this.showControls(), { passive: true })
    );

    window.addEventListener('keydown', (e) => this._onKey(e));
    document.addEventListener('fullscreenchange', () => this._syncFullscreenLabel());
  }

  _onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    const h = this.handlers;
    switch (e.key) {
      case 'ArrowRight':
        if (inField) return;
        e.preventDefault(); h.onNext?.(); this.showControls();
        break;
      case 'ArrowLeft':
        if (inField) return;
        e.preventDefault(); h.onPrev?.(); this.showControls();
        break;
      case 'ArrowUp':
        if (inField) return;
        e.preventDefault(); this._nudgeSensitivity(+0.1);
        break;
      case 'ArrowDown':
        if (inField) return;
        e.preventDefault(); this._nudgeSensitivity(-0.1);
        break;
      case 'Enter':
      case ' ':
        if (inField) return;
        e.preventDefault(); this.toggleControls();
        break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'r': case 'R': h.onToggleShuffle?.(); break;
      case 't': case 'T': h.onToggleTimer?.(); break;
      default: break;
    }
  }

  _nudgeSensitivity(delta) {
    const input = this.el.sensitivity;
    const min = parseFloat(input.min), max = parseFloat(input.max);
    const next = Math.min(max, Math.max(min, parseFloat(input.value) + delta));
    input.value = String(next);
    this.handlers.onSensitivity?.(next);
    this.toast(`Sensitivity ${next.toFixed(1)}×`, 1200);
    this.showControls();
  }

  // ---- Presets -------------------------------------------------------------

  /** @param {string[]} labels */
  setPresetOptions(labels) {
    const sel = this.el.presetSelect;
    sel.innerHTML = '';
    labels.forEach((label, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  setPresetValue(index) {
    this.el.presetSelect.value = String(index);
  }

  // ---- Audio / device ------------------------------------------------------

  setDevices(devices, activeDeviceId) {
    const sel = this.el.deviceSelect;
    sel.innerHTML = '';
    if (!devices.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Default input';
      opt.value = '';
      sel.appendChild(opt);
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      if (d.deviceId === activeDeviceId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  setSourceType(sourceType) {
    this.el.sourceSelect.value = sourceType;
  }

  // ---- Toggles / sliders ---------------------------------------------------

  setShuffleState(on) { this.el.shuffle.classList.toggle('active', !!on); }
  setTimerState(on) { this.el.timer.classList.toggle('active', !!on); }
  setSensitivityValue(v) { this.el.sensitivity.value = String(v); }
  setBrightnessValue(v) { this.el.brightness.value = String(v); }

  setPresetName(name) {
    this.toast(name, 2400);
  }

  // ---- Control-bar visibility ---------------------------------------------

  showControls() {
    if (this.el.controls.hidden) this.el.controls.hidden = false;
    this.el.controls.classList.add('visible');
    document.body.classList.remove('cursor-hidden');
    this._controlsVisible = true;
    this._resetHideTimer();
  }

  hideControls() {
    this.el.controls.classList.remove('visible');
    document.body.classList.add('cursor-hidden');
    this._controlsVisible = false;
  }

  toggleControls() {
    if (this._controlsVisible) this.hideControls();
    else this.showControls();
  }

  _resetHideTimer() {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hideControls(), CONTROLS_HIDE_MS);
  }

  // ---- Toast ---------------------------------------------------------------

  toast(message, ms = 2200) {
    const t = this.el.toast;
    t.textContent = message;
    t.classList.add('visible');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('visible'), ms);
  }

  // ---- Fullscreen ----------------------------------------------------------

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {
        this.toast('Fullscreen was blocked by the browser.', 2500);
      });
    } else {
      document.exitFullscreen?.();
    }
  }

  _syncFullscreenLabel() {
    const inFs = !!document.fullscreenElement;
    this.el.fullscreen.textContent = inFs ? '⤢' : '⛶';
  }
}
