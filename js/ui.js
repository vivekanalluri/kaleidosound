// ui.js — the "10-foot" TV interface layer.
//
// This module owns everything the user sees and touches: the auto-hiding
// control bar, the status toast, fullscreen, and keyboard/remote navigation.
// It knows nothing about audio or WebGL; it just calls back into the app
// controller passed to bind(). That keeps the visual/interaction concerns
// separate from the engine concerns.
//
// TV remote model: most remotes emit arrow keys + Enter. So:
//   ← / →  change preset       ↑ / ↓  adjust sensitivity
//   Enter / Space  toggle the menu      F  fullscreen
//   R  shuffle     C  auto-cycle        H / ?  help toast

const CONTROLS_HIDE_MS = 4000;

export class UI {
  constructor() {
    this.el = {
      overlay: document.getElementById('overlay'),
      chooser: document.getElementById('chooser'),
      loading: document.getElementById('loading'),
      loadingText: document.getElementById('loading-text'),
      error: document.getElementById('error'),
      errorText: document.getElementById('error-text'),
      retry: document.getElementById('btn-retry'),
      btnLineIn: document.getElementById('btn-linein'),
      btnMic: document.getElementById('btn-mic'),

      controls: document.getElementById('controls'),
      viewSelect: document.getElementById('view-select'),
      sourceSelect: document.getElementById('source-select'),
      deviceSelect: document.getElementById('device-select'),
      presetSelect: document.getElementById('preset-select'),
      presetBrowseGroup: document.querySelector('.control-group.preset-browse'),
      presetNavGroup: document.querySelector('.control-group.preset-nav'),
      prev: document.getElementById('btn-prev'),
      next: document.getElementById('btn-next'),
      shuffle: document.getElementById('btn-shuffle'),
      cycle: document.getElementById('btn-cycle'),
      sensitivity: document.getElementById('sensitivity'),
      fullscreen: document.getElementById('btn-fullscreen'),
      currentPreset: document.getElementById('current-preset'),

      toast: document.getElementById('toast'),
    };

    this._hideTimer = null;
    this._toastTimer = null;
    this._controlsVisible = false;
    this.handlers = {};
  }

  /**
   * Wire DOM events to app callbacks.
   * @param {Object} handlers
   */
  bind(handlers) {
    this.handlers = handlers || {};
    const h = this.handlers;

    // Landing chooser -> pick an input source.
    this.el.btnLineIn.addEventListener('click', () => h.onChooseSource?.('linein'));
    this.el.btnMic.addEventListener('click', () => h.onChooseSource?.('mic'));
    this.el.retry.addEventListener('click', () => h.onRetry?.());

    // Control bar.
    this.el.viewSelect.addEventListener('change', (e) =>
      h.onModeChange?.(e.target.value)
    );
    this.el.sourceSelect.addEventListener('change', (e) =>
      h.onSourceChange?.(e.target.value)
    );
    this.el.deviceSelect.addEventListener('change', (e) =>
      h.onDeviceChange?.(e.target.value)
    );
    this.el.presetSelect.addEventListener('change', (e) => {
      if (e.target.value) h.onPresetSelect?.(e.target.value);
    });
    this.el.prev.addEventListener('click', () => h.onPrev?.());
    this.el.next.addEventListener('click', () => h.onNext?.());
    this.el.shuffle.addEventListener('click', () => h.onToggleShuffle?.());
    this.el.cycle.addEventListener('click', () => h.onToggleCycle?.());
    this.el.sensitivity.addEventListener('input', (e) =>
      h.onSensitivity?.(parseFloat(e.target.value))
    );
    this.el.fullscreen.addEventListener('click', () => this.toggleFullscreen());

    // Any pointer activity reveals the controls and resets the hide timer.
    ['mousemove', 'pointerdown', 'touchstart'].forEach((evt) =>
      window.addEventListener(evt, () => this.showControls(), { passive: true })
    );

    // Keyboard / remote.
    window.addEventListener('keydown', (e) => this._onKey(e));

    // Keep fullscreen button label in sync.
    document.addEventListener('fullscreenchange', () => this._syncFullscreenLabel());
  }

  _onKey(e) {
    // Ignore typing inside form fields (e.g. a focused select being navigated).
    const tag = (e.target && e.target.tagName) || '';
    const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    const h = this.handlers;

    switch (e.key) {
      case 'ArrowRight':
        if (inField) return;
        e.preventDefault();
        h.onNext?.();
        this.showControls();
        break;
      case 'ArrowLeft':
        if (inField) return;
        e.preventDefault();
        h.onPrev?.();
        this.showControls();
        break;
      case 'ArrowUp':
        if (inField) return;
        e.preventDefault();
        this._nudgeSensitivity(+0.1);
        break;
      case 'ArrowDown':
        if (inField) return;
        e.preventDefault();
        this._nudgeSensitivity(-0.1);
        break;
      case 'Enter':
      case ' ':
        if (inField) return;
        e.preventDefault();
        this.toggleControls();
        break;
      case 'f':
      case 'F':
        this.toggleFullscreen();
        break;
      case 'r':
      case 'R':
        h.onToggleShuffle?.();
        break;
      case 'c':
      case 'C':
        h.onToggleCycle?.();
        break;
      case 'v':
      case 'V':
        h.onCycleMode?.();
        this.showControls();
        break;
      case 'h':
      case 'H':
      case '?':
        this.toast(
          '← → preset  ·  ↑ ↓ sensitivity  ·  Enter menu  ·  F fullscreen  ·  R shuffle  ·  C cycle',
          4000
        );
        break;
      default:
        break;
    }
  }

  _nudgeSensitivity(delta) {
    const input = this.el.sensitivity;
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const next = Math.min(max, Math.max(min, parseFloat(input.value) + delta));
    input.value = String(next);
    this.handlers.onSensitivity?.(next);
    this.toast(`Sensitivity ${next.toFixed(1)}×`, 1200);
    this.showControls();
  }

  // ---- Landing overlay states ---------------------------------------------

  showChooser() {
    this.el.overlay.classList.remove('hidden');
    this.el.chooser.classList.remove('hidden');
    this.el.loading.classList.add('hidden');
    this.el.error.classList.add('hidden');
  }

  showLoading(text = 'Starting up…') {
    this.el.overlay.classList.remove('hidden');
    this.el.chooser.classList.add('hidden');
    this.el.error.classList.add('hidden');
    this.el.loading.classList.remove('hidden');
    this.el.loadingText.textContent = text;
  }

  showError(message) {
    this.el.overlay.classList.remove('hidden');
    this.el.chooser.classList.add('hidden');
    this.el.loading.classList.add('hidden');
    this.el.error.classList.remove('hidden');
    this.el.errorText.textContent = message;
  }

  hideOverlay() {
    this.el.overlay.classList.add('hidden');
  }

  // ---- Control bar ---------------------------------------------------------

  /** Populate the device dropdown and select the active device. */
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

  setViewMode(mode) {
    this.el.viewSelect.value = mode;
  }

  /** Dim the MilkDrop-only preset controls when a classic view is active. */
  setMilkdropControlsEnabled(enabled) {
    [this.el.presetBrowseGroup, this.el.presetNavGroup].forEach((g) => {
      if (g) g.classList.toggle('disabled', !enabled);
    });
  }

  /**
   * Fill the preset dropdown: a "Popular picks" group up top, then every
   * preset alphabetically.
   * @param {string[]} allNames
   * @param {string[]} popularNames
   */
  setPresetList(allNames, popularNames = []) {
    const sel = this.el.presetSelect;
    sel.innerHTML = '';

    if (popularNames.length) {
      const grp = document.createElement('optgroup');
      grp.label = '⭐ Popular picks';
      for (const name of popularNames) {
        grp.appendChild(this._presetOption(name));
      }
      sel.appendChild(grp);
    }

    const allGrp = document.createElement('optgroup');
    allGrp.label = `All presets (${allNames.length})`;
    for (const name of allNames) {
      allGrp.appendChild(this._presetOption(name));
    }
    sel.appendChild(allGrp);
  }

  _presetOption(name) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    return opt;
  }

  /** Reflect the active preset in the dropdown without firing a change event. */
  setCurrentPresetInList(name) {
    const sel = this.el.presetSelect;
    if (sel && sel.value !== name) sel.value = name;
  }

  setSensitivityValue(value) {
    this.el.sensitivity.value = String(value);
  }

  setShuffleState(on) {
    this.el.shuffle.classList.toggle('active', !!on);
  }

  setCycleState(on) {
    this.el.cycle.classList.toggle('active', !!on);
  }

  setPresetName(name) {
    this.el.currentPreset.textContent = name;
    this.setCurrentPresetInList(name);
    this.toast(name, 2600);
  }

  showControls() {
    if (this.el.controls.hidden) this.el.controls.hidden = false;
    // Force reflow-free class toggle for the fade.
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
    this.el.fullscreen.textContent = inFs ? '⛶ Exit' : '⛶ Fullscreen';
  }
}
