// shaders.js — a GLSL fragment-shader engine (G-Force-style visuals).
//
// A third "preset engine" alongside MilkDrop and AVS. It runs full-screen
// WebGL fragment shaders driven by live audio uniforms (level / bass / mid /
// treble / beat / time). All shaders are original, so there are no licensing
// entanglements. WebGL1 / GLSL ES 1.00 for broad compatibility (incl. the Pi).

const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

// Common header prepended to every fragment shader.
const HEADER = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_beat;
`;

const SHADERS = [
  {
    name: 'Shader · Plasma',
    frag: `
    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
      float t = u_time * 0.4;
      float v = 0.0;
      v += sin(uv.x * 6.0 + t);
      v += sin(uv.y * 6.0 + t * 1.3);
      v += sin((uv.x + uv.y) * 5.0 + t * 0.7);
      v += sin(length(uv) * 10.0 - t * 2.0 - u_bass * 6.0);
      v *= 0.25;
      vec3 col = 0.5 + 0.5 * cos(6.2831 * (v + vec3(0.0, 0.33, 0.67)) + u_time * 0.2);
      col *= 0.55 + 0.8 * u_level + 0.4 * u_beat;
      gl_FragColor = vec4(col, 1.0);
    }`,
  },
  {
    name: 'Shader · Nebula',
    frag: `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float s = 0.0; float a = 0.5;
      for (int k = 0; k < 5; k++) { s += a * noise(p); p *= 2.0; a *= 0.5; }
      return s;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / u_res.y;
      vec2 q = uv * 3.0 + vec2(u_time * 0.05, u_time * 0.03);
      float n = fbm(q + fbm(q * 1.5 + u_time * 0.1));
      n += u_treble * 0.5;
      vec3 col = mix(vec3(0.02, 0.02, 0.08), vec3(0.55, 0.28, 0.9), n);
      col = mix(col, vec3(1.0, 0.7, 0.4), pow(max(n - 0.6, 0.0), 2.0) * (0.5 + u_bass * 1.5));
      col *= 0.7 + 0.6 * u_level;
      gl_FragColor = vec4(col, 1.0);
    }`,
  },
  {
    name: 'Shader · Kaleido Tunnel',
    frag: `
    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
      float a = atan(uv.y, uv.x);
      float r = length(uv);
      float seg = 6.0;
      a = mod(a, 6.2831 / seg);
      a = abs(a - 3.1415 / seg);
      vec2 pp = vec2(cos(a), sin(a)) * r;
      float t = u_time * 0.5;
      float tunnel = sin(1.0 / (r + 0.05) * 3.0 - t * 3.0 - u_bass * 5.0);
      float v = tunnel + sin(pp.x * 8.0 + t) + sin(pp.y * 8.0 + t);
      vec3 col = 0.5 + 0.5 * cos(6.2831 * (v * 0.2 + vec3(0.0, 0.33, 0.67)) + t);
      col *= smoothstep(0.0, 0.12, r);
      col *= 0.55 + 0.8 * u_level + 0.5 * u_beat;
      gl_FragColor = vec4(col, 1.0);
    }`,
  },
  {
    name: 'Shader · Liquid',
    frag: `
    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
      float t = u_time * 0.3;
      for (int i = 1; i < 5; i++) {
        float fi = float(i);
        uv.x += 0.3 / fi * sin(fi * 3.0 * uv.y + t + u_bass * 3.0);
        uv.y += 0.3 / fi * cos(fi * 3.0 * uv.x + t * 1.2);
      }
      vec3 col = 0.5 + 0.5 * cos(6.2831 * vec3(0.0, 0.33, 0.67) + uv.xyx * 3.0 + t);
      col *= 0.6 + 0.8 * u_level + 0.3 * u_beat;
      gl_FragColor = vec4(col, 1.0);
    }`,
  },
];

function isWebGLAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (_) {
    return false;
  }
}

export function isShaderSupported() {
  return isWebGLAvailable();
}

export class ShaderVisualizer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.analyser = null;
    this.freq = null;
    this.time = null;
    this.presets = []; // { name, program, locs }
    this.index = 0;
    this.ready = false;
    this._rafId = null;
    this._t = 0;
    this._lastTs = 0;
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    this.level = 0; this.bass = 0; this.mid = 0; this.treble = 0; this.beatEnv = 0;
    this._bassAvg = null; this._lastBeat = -1;

    this.cycleSeconds = 20;
    this._cycleTimer = null;
    this.onPresetChange = null;
  }

  init(analyser) {
    const gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available for the shader engine.');
    this.gl = gl;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);

    // Full-screen triangle.
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const vs = this._compile(gl.VERTEX_SHADER, VERT);
    for (const s of SHADERS) {
      const fs = this._compile(gl.FRAGMENT_SHADER, HEADER + s.frag);
      if (!vs || !fs) continue;
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('Shader link failed:', s.name, gl.getProgramInfoLog(program));
        continue;
      }
      this.presets.push({
        name: s.name,
        program,
        locs: {
          p: gl.getAttribLocation(program, 'p'),
          res: gl.getUniformLocation(program, 'u_res'),
          time: gl.getUniformLocation(program, 'u_time'),
          level: gl.getUniformLocation(program, 'u_level'),
          bass: gl.getUniformLocation(program, 'u_bass'),
          mid: gl.getUniformLocation(program, 'u_mid'),
          treble: gl.getUniformLocation(program, 'u_treble'),
          beat: gl.getUniformLocation(program, 'u_beat'),
        },
      });
    }
    this.ready = this.presets.length > 0;
    this._sizeCanvas();
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('Shader compile failed:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  _sizeCanvas() {
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._pixelRatio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._pixelRatio));
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  _features() {
    const now = performance.now();
    let dt = (now - this._lastTs) / 1000;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    this._lastTs = now;
    this._t += dt;

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    let sum = 0;
    for (let i = 0; i < this.time.length; i++) { const v = (this.time[i] - 128) / 128; sum += v * v; }
    this.level = Math.sqrt(sum / this.time.length);

    const bins = this.freq.length;
    const avg = (lo, hi) => {
      let s = 0, c = 0;
      for (let b = lo; b < hi && b < bins; b++) { s += this.freq[b]; c++; }
      return c ? s / c / 255 : 0;
    };
    this.bass = avg(0, Math.floor(bins / 16));
    this.mid = avg(Math.floor(bins / 16), Math.floor(bins / 4));
    this.treble = avg(Math.floor(bins / 4), Math.floor(bins / 2));

    if (this._bassAvg == null) this._bassAvg = this.bass;
    if (this.bass > this._bassAvg * 1.35 + 0.02 && this._t - this._lastBeat > 0.22) {
      this.beatEnv = 1; this._lastBeat = this._t;
    }
    this._bassAvg += (this.bass - this._bassAvg) * 0.08;
    this.beatEnv = Math.max(0, this.beatEnv - dt * 2.5);
  }

  _apply(i) {
    if (this.presets.length === 0) return;
    this.index = ((i % this.presets.length) + this.presets.length) % this.presets.length;
    if (this.onPresetChange) this.onPresetChange(this.presets[this.index].name);
  }

  next() { this._apply(this.index + 1); this._restartCycle(); }
  prev() { this._apply(this.index - 1); this._restartCycle(); }

  get currentName() {
    return this.presets[this.index] ? this.presets[this.index].name : '';
  }

  _restartCycle() {
    if (this._cycleTimer) { clearInterval(this._cycleTimer); this._cycleTimer = null; }
    this._cycleTimer = setInterval(() => this._apply(this.index + 1), this.cycleSeconds * 1000);
  }

  start() {
    if (!this.ready || this._rafId != null) return;
    this._sizeCanvas();
    this._lastTs = performance.now();
    if (this.onPresetChange) this.onPresetChange(this.currentName);
    const loop = () => { this._frame(); this._rafId = requestAnimationFrame(loop); };
    this._rafId = requestAnimationFrame(loop);
    this._restartCycle();
  }

  stop() {
    if (this._rafId != null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._cycleTimer) { clearInterval(this._cycleTimer); this._cycleTimer = null; }
  }

  resize() { this._sizeCanvas(); }

  _frame() {
    const gl = this.gl;
    const preset = this.presets[this.index];
    if (!preset) return;
    this._features();
    gl.useProgram(preset.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(preset.locs.p);
    gl.vertexAttribPointer(preset.locs.p, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(preset.locs.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(preset.locs.time, this._t);
    gl.uniform1f(preset.locs.level, this.level);
    gl.uniform1f(preset.locs.bass, this.bass);
    gl.uniform1f(preset.locs.mid, this.mid);
    gl.uniform1f(preset.locs.treble, this.treble);
    gl.uniform1f(preset.locs.beat, this.beatEnv);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
