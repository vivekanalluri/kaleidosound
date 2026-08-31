// smoke.mjs — headless runtime check for the 2D visualizers.
// Mocks canvas/ctx/document/window, then drives every CLASSIC_MODE for a few
// frames to catch runtime errors that `node --check` cannot (bad property
// access, undefined state, etc.). Run: node scripts/smoke.mjs

function makeCtx(canvas) {
  const store = {
    canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: '#000',
    font: '', textAlign: '', textBaseline: '', lineCap: '', lineJoin: '', filter: '',
    imageSmoothingEnabled: true,
  };
  const grad = () => ({ addColorStop() {} });
  const img = (w, h) => {
    const W = Math.max(1, w | 0), H = Math.max(1, h | 0);
    return { width: W, height: H, data: new Uint8ClampedArray(4 * W * H) };
  };
  const fns = {
    createLinearGradient: grad, createRadialGradient: grad, createConicGradient: grad,
    createImageData: (a, b) => (typeof a === 'object' ? img(a.width, a.height) : img(a, b)),
    getImageData: (x, y, w, h) => img(w, h),
    measureText: () => ({ width: 10 }),
    putImageData() {}, drawImage() {},
  };
  return new Proxy(store, {
    get(t, p) {
      if (p in fns) return fns[p];
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeCanvas() {
  const c = { width: 100, height: 100, style: {} };
  c.getContext = () => makeCtx(c);
  return c;
}

function makeAnalyser() {
  return {
    frequencyBinCount: 1024, fftSize: 2048,
    getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 255) | 0; },
    getByteTimeDomainData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 128 + ((Math.sin(i * 0.1) * 40) | 0); },
  };
}

globalThis.window = { devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720 };
globalThis.document = {
  createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, getContext: () => makeCtx(makeCanvas()) }),
};
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { ClassicVisualizer, CLASSIC_MODES } = await import('../js/classic.js?v=' + Date.now());

const v = new ClassicVisualizer(makeCanvas());
v.init(makeAnalyser(), { left: makeAnalyser(), right: makeAnalyser() });

const failures = [];
for (const m of CLASSIC_MODES) {
  v.setMode(m);
  try {
    for (let f = 0; f < 10; f++) v._draw();
  } catch (e) {
    failures.push(`${m}: ${e.message}`);
  }
}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`SMOKE OK — ${CLASSIC_MODES.length} modes drew cleanly.`);
