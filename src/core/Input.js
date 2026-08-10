/**
 * Input — single abstraction for keyboard + touch HUD buttons + selectable
 * steering modes (Phase 3J: buttons / virtual handlebar / tilt / swipe).
 * Gameplay code only reads { throttle, brake, steer, stunt, trick }; it
 * never touches DOM events or key codes directly.
 *
 * Steering modes produce an analog value in [-1, 1]. Keyboard steering
 * always works and overrides the mode value (desktop testing). The tilt
 * sensor listener exists ONLY while tilt mode is selected — zero sensor
 * processing otherwise.
 */
export class Input {
  constructor() {
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.stunt = 0;  // hold: context stunt — wheelie/balance (ground), stabilize (air)
    this.trick = 0;  // hold: committed air rotation (flips/spins)
    this.enabled = true;

    this.onPause = null;
    this.onReset = null;
    this.onPov = null;
    this.onTiltUnavailable = null; // UI falls back to button steering + toast

    this.settings = null;   // attached once by Game (Settings instance)
    this._mode = 'buttons';
    this._modeSteer = 0;    // analog value from handlebar / swipe
    this._tiltRaw = 0;
    this._tiltOk = false;
    this._tiltHandler = null;
    this._tiltWatch = 0;

    this._keys = new Set();
    this._touch = { gas: false, brake: false, left: false, right: false, stunt: false, trick: false };

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this._keys.add(e.code);
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.onPause) this.onPause();
      if (e.code === 'KeyR' && this.onReset) this.onReset();
      if (e.code === 'KeyC' && this.onPov) this.onPov();
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
  }

  /** Wire the persisted settings and activate the stored steering mode. */
  attachSettings(settings) {
    this.settings = settings;
    this.setSteerMode(settings.get('steerMode'));
  }

  setSteerMode(mode) {
    this._mode = mode;
    this._modeSteer = 0;
    if (mode === 'tilt') this._enableTilt();
    else this._disableTilt();
  }

  /** Attach a HUD element as a hold-button for a named control. */
  bindButton(el, control) {
    const set = (on) => {
      this._touch[control] = on;
      el.classList.toggle('active', on);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic/odd pointers */ }
      set(true);
    });
    const off = (e) => { e.preventDefault(); set(false); };
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Virtual handlebar: drag left/right to steer; springs back on release. */
  bindHandlebar(el) {
    let active = false, cx = 0;
    const setVal = (v) => {
      this._modeSteer = Math.max(-1, Math.min(1, v));
      el.style.setProperty('--hbr', `${this._modeSteer * 26}deg`);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic/odd pointers */ }
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      active = true;
      el.classList.add('active');
      setVal((e.clientX - cx) / 80);
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      setVal((e.clientX - cx) / 80);
    });
    const up = (e) => {
      if (e) e.preventDefault();
      active = false;
      el.classList.remove('active');
      setVal(0); // auto-center; the bike's own steer smoothing eases it in
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Swipe steering: horizontal drag inside the zone maps to steer. */
  bindSwipe(el) {
    let x0 = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic/odd pointers */ }
      x0 = e.clientX;
      el.classList.add('active');
    });
    el.addEventListener('pointermove', (e) => {
      if (x0 === null) return;
      this._modeSteer = Math.max(-1, Math.min(1, (e.clientX - x0) / 90));
    });
    const up = (e) => {
      if (e) e.preventDefault();
      x0 = null;
      el.classList.remove('active');
      this._modeSteer = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Store the current resting angle as tilt center. */
  calibrateTilt() {
    if (this.settings) this.settings.set('tiltZero', this._tiltRaw || 0);
  }

  _enableTilt() {
    if (this._tiltHandler) return;
    this._tiltOk = false;
    this._tiltHandler = (e) => {
      // Browsers without a real sensor still fire one event with null
      // values — only real numbers count as a working sensor.
      if (e.gamma === null && e.beta === null) return;
      // Portrait uses gamma (left/right tilt); landscape uses beta with a
      // sign that follows which way the device was rotated.
      const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
      let v;
      if (angle === 90) v = e.beta ?? 0;
      else if (angle === -90 || angle === 270) v = -(e.beta ?? 0);
      else v = e.gamma ?? 0;
      this._tiltRaw = v;
      this._tiltOk = true;
    };
    const DOE = window.DeviceOrientationEvent;
    const add = () => window.addEventListener('deviceorientation', this._tiltHandler);
    if (DOE && typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then((s) => { if (s === 'granted') add(); }).catch(() => {});
    } else if (DOE) {
      add();
    }
    // Graceful fallback: no sensor events shortly after enabling => the
    // device can't tilt-steer; tell the UI to drop back to buttons.
    clearTimeout(this._tiltWatch);
    this._tiltWatch = setTimeout(() => {
      if (!this._tiltOk && this.onTiltUnavailable) this.onTiltUnavailable();
    }, 1500);
  }

  _disableTilt() {
    if (this._tiltHandler) {
      window.removeEventListener('deviceorientation', this._tiltHandler);
      this._tiltHandler = null;
    }
    clearTimeout(this._tiltWatch);
    this._tiltOk = false;
  }

  clear() {
    this._keys.clear();
    for (const k in this._touch) this._touch[k] = false;
    this._modeSteer = 0;
    document.querySelectorAll('.ctl.active').forEach((el) => el.classList.remove('active'));
  }

  /** Recompute the control state; called once per rendered frame. */
  update() {
    if (!this.enabled) {
      this.throttle = this.brake = this.steer = this.stunt = this.trick = 0;
      return;
    }
    const k = this._keys, t = this._touch;
    this.throttle = k.has('KeyW') || k.has('ArrowUp') || t.gas ? 1 : 0;
    this.brake = k.has('KeyS') || k.has('ArrowDown') || t.brake ? 1 : 0;
    this.stunt = k.has('ShiftLeft') || k.has('ShiftRight') || t.stunt ? 1 : 0;
    this.trick = k.has('Space') || t.trick ? 1 : 0;

    // Steering: keyboard always wins (desktop); otherwise the active mode.
    const kb = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) -
               (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let ms;
    if (this._mode === 'handlebar' || this._mode === 'swipe') {
      ms = this._modeSteer;
    } else if (this._mode === 'tilt' && this._tiltOk) {
      const zero = this.settings ? this.settings.get('tiltZero') : 0;
      const sens = this.settings ? this.settings.get('tiltSens') : 1;
      ms = Math.max(-1, Math.min(1, ((this._tiltRaw - zero) / 28) * sens));
    } else {
      ms = (t.right ? 1 : 0) - (t.left ? 1 : 0); // buttons (also tilt fallback)
    }
    const sens = this.settings ? this.settings.get('steerSens') : 1;
    this.steer = Math.max(-1, Math.min(1, (kb !== 0 ? kb : ms) * sens));
  }
}
