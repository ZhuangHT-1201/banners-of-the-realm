export class AudioDirector {
  constructor() {
    this.context = null;
    this.master = null;
    this.ambientGain = null;
    this.muted = false;
    this.ambientStarted = false;
    this.lastGatherAt = 0;
    this.noiseBuffer = null;
  }

  ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
      return this.context;
    }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    this.context = new Context();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.context.destination);
    const length = this.context.sampleRate * 2;
    this.noiseBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return this.context;
  }

  startAmbient() {
    const context = this.ensureContext();
    if (!context || this.ambientStarted) return;
    this.ambientStarted = true;
    this.ambientGain = context.createGain();
    this.ambientGain.gain.value = 0;
    this.ambientGain.gain.linearRampToValueAtTime(0.09, context.currentTime + 4);
    this.ambientGain.connect(this.master);

    const droneFilter = context.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 280;
    droneFilter.Q.value = 0.8;
    droneFilter.connect(this.ambientGain);

    const frequencies = [55, 82.4, 110, 164.8];
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index < 2 ? "sine" : "triangle";
      oscillator.frequency.value = frequency;
      oscillator.detune.value = (index - 1.5) * 3;
      gain.gain.value = index < 2 ? 0.09 : 0.025;
      oscillator.connect(gain);
      gain.connect(droneFilter);
      oscillator.start();
    });

    const wind = context.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 480;
    windFilter.Q.value = 0.35;
    const windGain = context.createGain();
    windGain.gain.value = 0.06;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambientGain);
    wind.start();

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(windGain.gain);
    lfo.start();

    const drumTimer = window.setInterval(() => {
      if (!this.muted && document.visibilityState === "visible") this.playDrum();
    }, 19000);
    this.drumTimer = drumTimer;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.master || !this.context) return;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.55, this.context.currentTime + 0.18);
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  tone(frequency, duration = 0.12, options = {}) {
    const context = this.ensureContext();
    if (!context || this.muted) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    if (options.sweep) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.sweep), context.currentTime + duration);
    }
    filter.type = options.filter ?? "lowpass";
    filter.frequency.value = options.filterFrequency ?? 2200;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(options.volume ?? 0.08, context.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscillator.start();
    oscillator.stop(context.currentTime + duration + 0.03);
  }

  noise(duration = 0.08, options = {}) {
    const context = this.ensureContext();
    if (!context || this.muted) return;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = options.filter ?? "bandpass";
    filter.frequency.value = options.frequency ?? 900;
    filter.Q.value = options.q ?? 0.65;
    const gain = context.createGain();
    gain.gain.setValueAtTime(options.volume ?? 0.055, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start();
    source.stop(context.currentTime + duration);
  }

  playDrum() {
    this.tone(74, 0.32, { type: "sine", sweep: 44, volume: 0.045, filterFrequency: 390 });
    this.noise(0.08, { frequency: 220, volume: 0.015 });
  }

  play(name) {
    if (this.muted) return;
    switch (name) {
      case "click":
        this.tone(520, 0.045, { type: "triangle", volume: 0.025, filterFrequency: 1500 });
        break;
      case "select":
        this.tone(420, 0.07, { type: "triangle", volume: 0.035 });
        this.tone(640, 0.085, { type: "sine", volume: 0.02 });
        break;
      case "command":
        this.tone(260, 0.08, { type: "triangle", sweep: 330, volume: 0.05 });
        this.noise(0.06, { frequency: 700, volume: 0.02 });
        break;
      case "attack":
        this.noise(0.11, { filter: "lowpass", frequency: 1100, volume: 0.035 });
        this.tone(110, 0.07, { type: "sawtooth", sweep: 75, volume: 0.035 });
        break;
      case "train":
        this.tone(330, 0.12, { type: "triangle", volume: 0.04 });
        window.setTimeout(() => this.tone(440, 0.12, { type: "triangle", volume: 0.035 }), 90);
        break;
      case "build":
        this.noise(0.14, { filter: "bandpass", frequency: 550, q: 1.1, volume: 0.05 });
        this.tone(125, 0.08, { type: "sine", sweep: 90, volume: 0.05 });
        break;
      case "complete":
        this.tone(392, 0.22, { type: "sine", volume: 0.045 });
        window.setTimeout(() => this.tone(523, 0.32, { type: "sine", volume: 0.04 }), 105);
        window.setTimeout(() => this.tone(784, 0.45, { type: "triangle", volume: 0.018 }), 205);
        break;
      case "age":
        [220, 277.2, 329.6, 440].forEach((frequency, index) => {
          window.setTimeout(() => this.tone(frequency, 1.2, { type: "sine", volume: 0.04 }), index * 100);
        });
        break;
      case "gather":
        if (performance.now() - this.lastGatherAt < 240) return;
        this.lastGatherAt = performance.now();
        this.noise(0.045, { frequency: 1200, volume: 0.014 });
        break;
      case "warning":
        this.tone(180, 0.26, { type: "sawtooth", sweep: 142, volume: 0.04 });
        this.tone(130, 0.32, { type: "sine", volume: 0.04 });
        break;
      case "victory":
        [261.6, 329.6, 392, 523.2].forEach((frequency, index) => {
          window.setTimeout(() => this.tone(frequency, 1.5, { type: "sine", volume: 0.05 }), index * 130);
        });
        this.playDrum();
        break;
      case "defeat":
        this.tone(160, 1.2, { type: "sine", sweep: 72, volume: 0.06 });
        window.setTimeout(() => this.tone(110, 1.5, { type: "triangle", sweep: 55, volume: 0.04 }), 280);
        break;
      default:
        this.tone(500, 0.05, { volume: 0.02 });
    }
  }
}
