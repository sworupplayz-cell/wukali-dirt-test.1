/**
 * Settings (Phase 3J) — control preferences + custom HUD layout, persisted
 * to localStorage like the rest of the game state. One JSON blob, loaded
 * once, saved on change; nothing here runs per-frame.
 */
const KEY = 'wukali_settings';

const DEFAULTS = {
  steerMode: 'buttons',  // 'handlebar' | 'buttons' | 'tilt' | 'swipe'
  steerSens: 1.0,        // 0.5 .. 1.5 (all modes)
  tiltSens: 1.0,         // 0.5 .. 2.0 (tilt only)
  tiltZero: 0,           // calibration offset, degrees
  hud: {},               // per-control { cx, cy, s, o } — % center, scale, opacity
};

export class Settings {
  constructor() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY)); } catch { /* corrupt -> defaults */ }
    this.data = { ...DEFAULTS, ...(stored || {}) };
    if (!this.data.hud || typeof this.data.hud !== 'object') this.data.hud = {};
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    this.data[k] = v;
    this.save();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  resetHud() {
    this.data.hud = {};
    this.save();
  }
}
