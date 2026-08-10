/**
 * HudEditor (Phase 3J) — lightweight HUD layout editor + layout applier.
 *
 * Layout records live in Settings.hud as { cx, cy, s, o } per control
 * (center position in % of viewport, scale, opacity). Controls without a
 * record keep their CSS default position — RESET simply clears records.
 * Applying a layout writes a handful of inline styles; nothing runs per
 * frame during gameplay. Percent-based centers survive orientation and
 * viewport changes (re-clamped to safe bounds on resize).
 */

const CONTROLS = {
  gas:   { els: ['btn-gas'], label: 'GAS' },
  brake: { els: ['btn-brake'], label: 'BRAKE' },
  steer: { els: ['btn-left', 'btn-right'], group: true, extra: ['handlebar', 'swipe-zone'], label: 'STEER' },
  stunt: { els: ['btn-stunt'], label: 'STUNT' },
  trick: { els: ['btn-trick'], label: 'TRICK' },
  pov:   { els: ['btn-pov'], label: 'POV' },
};
const MIN_S = 0.7, MAX_S = 1.6, MIN_O = 0.35;

export class HudEditor {
  constructor(settings) {
    this.settings = settings;
    this.overlay = document.getElementById('hudedit-overlay');
    this.hud = document.getElementById('hud');
    this.nameEl = document.getElementById('he-name');
    this.sizeEl = document.getElementById('he-size');
    this.opacityEl = document.getElementById('he-opacity');
    this.onClose = null;
    this._sel = null;
    this._drag = null;

    this.overlay.addEventListener('pointerdown', (e) => this._down(e));
    this.overlay.addEventListener('pointermove', (e) => this._move(e));
    this.overlay.addEventListener('pointerup', () => (this._drag = null));
    this.overlay.addEventListener('pointercancel', () => (this._drag = null));
    this.sizeEl.addEventListener('input', () => this._slider('s', this.sizeEl.value / 100));
    this.opacityEl.addEventListener('input', () => this._slider('o', this.opacityEl.value / 100));
    document.getElementById('he-reset').addEventListener('click', () => {
      this.settings.resetHud();
      this.applyLayout();
      this._select(null);
    });
    document.getElementById('he-done').addEventListener('click', () => this.close());
    window.addEventListener('resize', () => this.applyLayout());

    this.applyLayout();
  }

  // ---- layout application (also used at startup / on resize) --------------

  _rec(key) {
    return this.settings.data.hud[key] || null;
  }

  applyLayout() {
    for (const key of Object.keys(CONTROLS)) this._applyControl(key);
  }

  _applyControl(key) {
    const def = CONTROLS[key];
    const rec = this._rec(key);
    const all = [...def.els, ...(def.extra || [])];
    if (!rec) {
      for (const id of all) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.style.left = el.style.top = el.style.right = el.style.bottom = '';
        el.style.transform = id === 'handlebar' ? '' : '';
        el.style.opacity = '';
        el.style.scale = '';
      }
      return;
    }
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = rec.s || 1, o = rec.o ?? 1;
    // Safe clamp: keep the control's (scaled) footprint on-screen.
    const half = this._halfSize(key, s);
    const cx = Math.min(Math.max((rec.cx / 100) * vw, half.w + 4), vw - half.w - 4);
    const cy = Math.min(Math.max((rec.cy / 100) * vh, half.h + 4), vh - half.h - 4);
    if (def.group) {
      // Steer pair: two buttons side by side around the group center.
      const bw = this._elSize('btn-left').w * s;
      const gap = bw / 2 + 7 * s;
      this._place('btn-left', cx - gap, cy, s, o);
      this._place('btn-right', cx + gap, cy, s, o);
      for (const id of def.extra || []) this._place(id, cx, cy, s, o, id === 'handlebar');
    } else {
      this._place(def.els[0], cx, cy, s, o);
    }
  }

  _place(id, x, y, s, o, isHandlebar = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    // Scale INSIDE the transform string (after the centering translate) so
    // the center stays put; the standalone `scale` property would compose
    // before the translate and shift the element. The handlebar keeps its
    // steering rotation via a CSS variable so both never fight.
    el.style.transform = isHandlebar
      ? `translate(-50%, -50%) rotate(var(--hbr, 0deg)) scale(${s})`
      : `translate(-50%, -50%) scale(${s})`;
    el.style.opacity = String(o);
  }

  _elSize(id) {
    const el = document.getElementById(id);
    if (!el) return { w: 0, h: 0 };
    // offsetWidth/Height are layout sizes: unaffected by transforms, so
    // repeated applies never compound the scale.
    const w = el.offsetWidth, h = el.offsetHeight;
    return w === 0 && h === 0 ? { w: 80, h: 80 } : { w, h };
  }

  _halfSize(key, s) {
    const def = CONTROLS[key];
    if (def.group) {
      const b = this._elSize('btn-left');
      return { w: (b.w + 7) * s + b.w * s / 2, h: (b.h * s) / 2 };
    }
    const b = this._elSize(def.els[0]);
    return { w: (b.w * s) / 2, h: (b.h * s) / 2 };
  }

  // ---- editor session ------------------------------------------------------

  open() {
    this.overlay.classList.remove('hidden');
    this.hud.classList.remove('hidden');
    this.hud.classList.add('editing');
    this._select(null);
  }

  close() {
    this.settings.save();
    this.hud.classList.add('editing'); // no-op guard
    this.hud.classList.remove('editing');
    this.hud.classList.add('hidden');
    this.overlay.classList.add('hidden');
    if (this.onClose) this.onClose();
  }

  _controlAt(x, y) {
    let best = null, bestD = 1e9;
    for (const key of Object.keys(CONTROLS)) {
      for (const id of CONTROLS[key].els) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const pad = 12;
        if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
          const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
          if (d < bestD) { bestD = d; best = key; }
        }
      }
    }
    return best;
  }

  _ensureRec(key) {
    let rec = this.settings.data.hud[key];
    if (!rec) {
      // Seed from the control's current on-screen center.
      const def = CONTROLS[key];
      const rects = def.els
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((el) => el.getBoundingClientRect());
      const cx = rects.reduce((a, r) => a + (r.left + r.right) / 2, 0) / rects.length;
      const cy = rects.reduce((a, r) => a + (r.top + r.bottom) / 2, 0) / rects.length;
      rec = {
        cx: (cx / window.innerWidth) * 100,
        cy: (cy / window.innerHeight) * 100,
        s: 1, o: 1,
      };
      this.settings.data.hud[key] = rec;
    }
    return rec;
  }

  _down(e) {
    if (e.target.closest('#he-bar')) return; // slider/button area
    const key = this._controlAt(e.clientX, e.clientY);
    this._select(key);
    if (key) {
      const rec = this._ensureRec(key);
      this._drag = { key, dx: e.clientX - (rec.cx / 100) * window.innerWidth,
        dy: e.clientY - (rec.cy / 100) * window.innerHeight };
      this.overlay.setPointerCapture(e.pointerId);
    }
  }

  _move(e) {
    if (!this._drag) return;
    const rec = this.settings.data.hud[this._drag.key];
    rec.cx = ((e.clientX - this._drag.dx) / window.innerWidth) * 100;
    rec.cy = ((e.clientY - this._drag.dy) / window.innerHeight) * 100;
    rec.cx = Math.min(97, Math.max(3, rec.cx));
    rec.cy = Math.min(97, Math.max(3, rec.cy));
    this._applyControl(this._drag.key);
  }

  _slider(prop, value) {
    if (!this._sel) return;
    const rec = this._ensureRec(this._sel);
    rec[prop] = prop === 's'
      ? Math.min(MAX_S, Math.max(MIN_S, value))
      : Math.min(1, Math.max(MIN_O, value));
    this._applyControl(this._sel);
  }

  _select(key) {
    this._sel = key;
    this.nameEl.textContent = key ? CONTROLS[key].label : 'TAP A CONTROL';
    const rec = key ? this._ensureRec(key) : null;
    this.sizeEl.disabled = this.opacityEl.disabled = !key;
    if (rec) {
      this.sizeEl.value = Math.round((rec.s || 1) * 100);
      this.opacityEl.value = Math.round((rec.o ?? 1) * 100);
    }
    for (const k of Object.keys(CONTROLS)) {
      for (const id of CONTROLS[k].els) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('he-sel', k === key);
      }
    }
  }
}
