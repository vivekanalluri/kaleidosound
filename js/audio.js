// audio.js — audio input engine for Kaleidosound
//
// Responsibilities:
//   - Ask the browser for a microphone / line-in stream (getUserMedia)
//   - Build a Web Audio graph: MediaStreamSource -> GainNode
//   - Expose the GainNode as the "output" node that Butterchurn analyses
//   - Enumerate available input devices so the user can switch between a
//     wired interface and a microphone
//
// Notes on constraints:
//   For a music/line-in signal we want the *raw* audio, so we disable the
//   browser's voice-processing (echo cancellation, noise suppression, auto
//   gain). Those are tuned for speech and would wreck a music spectrum or a
//   birdsong recording. We keep them off for the mic too so the visuals react
//   to the true signal; the user can compensate level with the Sensitivity
//   control, which maps to the GainNode below.

const RAW_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.audioContext = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this.sourceNode = null;
    /** @type {GainNode|null} */
    this.gainNode = null;
    /** @type {AnalyserNode|null} shared FFT node for the classic visualizers */
    this.analyser = null;
    /** current logical source: 'linein' | 'mic' */
    this.sourceType = 'linein';
    /** currently active input deviceId, if known */
    this.deviceId = null;
  }

  /**
   * The node Butterchurn should analyse. Everything upstream (mic/line-in)
   * flows through the gain node so Sensitivity works for any source.
   * @returns {AudioNode|null}
   */
  get outputNode() {
    return this.gainNode;
  }

  /**
   * Start (or restart) capture for the given source type / device.
   * Requires a user gesture on first call so the AudioContext can start and
   * the permission prompt can appear.
   *
   * @param {Object} [opts]
   * @param {'linein'|'mic'} [opts.sourceType]
   * @param {string|null} [opts.deviceId]
   * @returns {Promise<AudioNode>} the analysis node (gain node)
   */
  async start({ sourceType = this.sourceType, deviceId = null } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support audio input capture.');
    }

    // Lazily create the AudioContext, and resume it (autoplay policies).
    if (!this.audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not available in this browser.');
      this.audioContext = new Ctx();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Tear down any previous stream before acquiring a new one.
    this._stopStream();

    const audioConstraints = { ...RAW_AUDIO_CONSTRAINTS };
    if (deviceId) {
      // Pin to a specific device (exact so we fail loudly if it's gone).
      audioConstraints.deviceId = { exact: deviceId };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    } catch (err) {
      throw normalizeGumError(err);
    }

    this.stream = stream;
    this.sourceType = sourceType;
    this.deviceId = deviceId ?? getStreamDeviceId(stream);

    // (Re)build the graph. Source -> Gain. We deliberately DO NOT connect to
    // audioContext.destination: the line-in music is already playing on the
    // speakers, and routing a mic to the speakers would cause feedback.
    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    if (!this.gainNode) {
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1;
    }
    // A shared analyser tap for the classic (bars/waveform/spectrogram)
    // visualizers. It hangs off the persistent gain node, so it survives
    // input switches without needing to be reconnected. Butterchurn keeps its
    // own separate analyser internally via connectAudio().
    if (!this.analyser) {
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;            // 1024 frequency bins
      this.analyser.smoothingTimeConstant = 0.8;
      this.gainNode.connect(this.analyser);
    }
    this.sourceNode.connect(this.gainNode);

    return this.gainNode;
  }

  /**
   * List available audio input devices. Labels are only populated once the
   * user has granted permission at least once, so call this after start().
   * @returns {Promise<Array<{deviceId:string,label:string}>>}
   */
  async listInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Input ${i + 1}`,
      }));
  }

  /**
   * Adjust input sensitivity (linear gain applied before analysis).
   * @param {number} value
   */
  setSensitivity(value) {
    if (this.gainNode) {
      // Smooth the change slightly to avoid clicks in the analysis.
      const now = this.audioContext.currentTime;
      this.gainNode.gain.setTargetAtTime(value, now, 0.05);
    }
  }

  /** Stop the current media stream (keeps AudioContext + gain node alive). */
  _stopStream() {
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (_) { /* noop */ }
      this.sourceNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /** Fully tear down the engine. */
  async dispose() {
    this._stopStream();
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch (_) { /* noop */ }
      this.analyser = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch (_) { /* noop */ }
      this.gainNode = null;
    }
    if (this.audioContext) {
      try { await this.audioContext.close(); } catch (_) { /* noop */ }
      this.audioContext = null;
    }
  }
}

/** Pull the deviceId out of a live stream's audio track, if present. */
function getStreamDeviceId(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return null;
  const settings = track.getSettings ? track.getSettings() : {};
  return settings.deviceId || null;
}

/** Turn cryptic getUserMedia errors into friendly, actionable messages. */
function normalizeGumError(err) {
  const name = err && err.name ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error(
        'Microphone/line-in permission was blocked. Allow audio access for ' +
          'this page and try again. (On a TV, check the browser site settings.)'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error(
        'No matching audio input was found. Plug in your audio interface or ' +
          'select a different device, then try again.'
      );
    case 'NotReadableError':
      return new Error(
        'The audio device is in use by another app or unavailable. Close ' +
          'other apps using it and try again.'
      );
    default:
      return new Error(
        'Could not start audio input' + (err?.message ? `: ${err.message}` : '.')
      );
  }
}
