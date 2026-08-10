/**
 * GameAudio — tiny WebAudio setup: a synthesized engine tone tied to
 * speed/throttle and an optional generative music loop. No audio assets,
 * no allocations during gameplay.
 */
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.musicOn = (localStorage.getItem('wukali_music') ?? 'on') === 'on';
    this._engine = null;
    this._engineGain = null;
    this._musicGain = null;
    this._musicTimer = null;
    this._step = 0;
  }

  /** Must be called from a user gesture (PLAY button). */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    // Engine: sawtooth -> lowpass -> gain.
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    osc.connect(lp).connect(gain).connect(this.ctx.destination);
    osc.start();
    this._engine = osc;
    this._engineGain = gain;

    this._musicGain = this.ctx.createGain();
    this._musicGain.gain.value = 0.05;
    this._musicGain.connect(this.ctx.destination);
    if (this.musicOn) this._startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEngine(speedNorm, throttle, active) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const target = active ? 0.028 + speedNorm * 0.02 : 0;
    this._engineGain.gain.setTargetAtTime(target, now, 0.08);
    this._engine.frequency.setTargetAtTime(50 + speedNorm * 130 + throttle * 25, now, 0.06);
  }

  setMusic(on) {
    this.musicOn = on;
    localStorage.setItem('wukali_music', on ? 'on' : 'off');
    if (!this.ctx) return;
    if (on) this._startMusic();
    else this._stopMusic();
  }

  _startMusic() {
    if (this._musicTimer || !this.ctx) return;
    const scale = [220, 261.6, 293.7, 329.6, 392, 440]; // A minor pentatonic-ish
    this._musicTimer = setInterval(() => {
      if (this.ctx.state !== 'running') return;
      const t = this.ctx.currentTime;
      const note = scale[[0, 2, 4, 3, 5, 2, 1, 3][this._step % 8]];
      this._step++;
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = note;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.6, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g).connect(this._musicGain);
      o.start(t);
      o.stop(t + 0.45);
    }, 460);
  }

  _stopMusic() {
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
  }
}
