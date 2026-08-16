import { State } from '../core/Game.js';
import { HudEditor } from './HudEditor.js';
import { DebugOverlay } from './DebugOverlay.js';

/**
 * UI — wires the HTML overlays (menu / pause / crash / HUD) to the game.
 * Overlays are plain DOM: zero rendering cost for the 3D scene, crisp on
 * any screen density, and full-screen overlays naturally block the HUD
 * buttons underneath them.
 */
export class UI {
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);

    this.menu = $('menu-overlay');
    this.about = $('about-overlay');
    this.pause = $('pause-overlay');
    this.gameover = $('gameover-overlay');
    this.hud = $('hud');
    this.speedo = $('speedo');
    this.distance = $('distance');
    this.score = $('score');
    this.stuntToast = $('stunt-toast');
    this.toast = $('toast');

    // Main menu
    $('btn-play').addEventListener('click', () => game.play());
    $('btn-about').addEventListener('click', () => {
      this.menu.classList.add('hidden');
      this.about.classList.remove('hidden');
    });
    $('btn-about-back').addEventListener('click', () => {
      this.about.classList.add('hidden');
      this.menu.classList.remove('hidden');
    });
    const musicBtn = $('btn-music');
    const musicLabel = () => {
      musicBtn.textContent = `MUSIC: ${game.audio.musicOn ? 'ON' : 'OFF'}`;
    };
    musicLabel();
    musicBtn.addEventListener('click', () => {
      game.audio.init();
      game.audio.setMusic(!game.audio.musicOn);
      musicLabel();
    });
    $('btn-exit').addEventListener('click', () => {
      window.close();
      setTimeout(() => this._toast('Running in a browser — close this tab to exit.'), 150);
    });

    // ---- Settings (Phase 3J) ----------------------------------------------
    this.settingsOv = $('settings-overlay');
    const settings = game.settings;
    const modeBtns = Array.from($('steer-modes').querySelectorAll('button'));
    const paintModes = () => {
      for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === settings.get('steerMode'));
    };
    const applyMode = (mode) => {
      settings.set('steerMode', mode);
      game.input.setSteerMode(mode);
      paintModes();
      this._applySteerWidgets();
    };
    for (const b of modeBtns) b.addEventListener('click', () => applyMode(b.dataset.mode));
    paintModes();

    const sensSteer = $('sens-steer'), sensSteerVal = $('sens-steer-val');
    const sensTilt = $('sens-tilt'), sensTiltVal = $('sens-tilt-val');
    const paintSens = () => {
      sensSteer.value = Math.round(settings.get('steerSens') * 100);
      sensTilt.value = Math.round(settings.get('tiltSens') * 100);
      sensSteerVal.textContent = `${sensSteer.value}%`;
      sensTiltVal.textContent = `${sensTilt.value}%`;
    };
    paintSens();
    sensSteer.addEventListener('input', () => { settings.set('steerSens', sensSteer.value / 100); paintSens(); });
    sensTilt.addEventListener('input', () => { settings.set('tiltSens', sensTilt.value / 100); paintSens(); });
    $('btn-calibrate').addEventListener('click', () => {
      game.input.calibrateTilt();
      this._toast('Tilt center calibrated — hold the device in your neutral position first.');
    });
    $('btn-settings').addEventListener('click', () => {
      this.menu.classList.add('hidden');
      this.settingsOv.classList.remove('hidden');
    });
    $('btn-settings-back').addEventListener('click', () => {
      this.settingsOv.classList.add('hidden');
      this.menu.classList.remove('hidden');
    });

    // ---- Graphics quality (Chapter 3C) --------------------------------------
    this.graphicsOv = $('graphics-overlay');
    const gfx = game.graphics;
    const distSteps = [800, 1200, 1800, 2400, 3200];
    const shadowNames = ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
    const paintGfx = () => {
      const d = gfx.current;
      $('gfx-presets').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.preset === gfx.preset));
      $('gfx-fps-limits').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', +b.dataset.fps === d.fpsLimit));
      $('gfx-scale').value = Math.round(d.renderScale * 100);
      $('gfx-scale-val').textContent = `${Math.round(d.renderScale * 100)}%`;
      $('gfx-dist').value = Math.max(0, distSteps.indexOf(d.renderDist));
      $('gfx-dist-val').textContent = `${d.renderDist} m`;
      $('gfx-shadow').value = d.shadows;
      $('gfx-shadow-val').textContent = shadowNames[d.shadows];
      $('gfx-veg').value = Math.round(d.vegetation * 100);
      $('gfx-veg-val').textContent = `${Math.round(d.vegetation * 100)}%`;
      $('gfx-terrain').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', +b.dataset.v === d.terrainDetail));
      $('gfx-fog').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', +b.dataset.v === (d.fogQuality > 0 ? 1 : 0)));
      $('gfx-aa').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', +b.dataset.v === (d.antialias ? 1 : 0)));
    };
    $('gfx-presets').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { gfx.setPreset(b.dataset.preset); paintGfx(); }));
    $('gfx-fps-limits').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { gfx.set('fpsLimit', +b.dataset.fps); paintGfx(); }));
    $('gfx-scale').addEventListener('input', () => {
      gfx.set('renderScale', +$('gfx-scale').value / 100); paintGfx();
    });
    $('gfx-dist').addEventListener('input', () => {
      gfx.set('renderDist', distSteps[+$('gfx-dist').value]); paintGfx();
    });
    $('gfx-shadow').addEventListener('input', () => {
      gfx.set('shadows', +$('gfx-shadow').value); paintGfx();
    });
    $('gfx-veg').addEventListener('input', () => {
      gfx.set('vegetation', +$('gfx-veg').value / 100); paintGfx();
    });
    $('gfx-terrain').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { gfx.set('terrainDetail', +b.dataset.v); paintGfx(); }));
    $('gfx-fog').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { gfx.set('fogQuality', +b.dataset.v); paintGfx(); }));
    $('gfx-aa').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { gfx.set('antialias', b.dataset.v === '1'); paintGfx(); }));
    $('btn-graphics').addEventListener('click', () => {
      this.settingsOv.classList.add('hidden');
      this.graphicsOv.classList.remove('hidden');
      paintGfx();
    });
    $('btn-graphics-back').addEventListener('click', () => {
      this.graphicsOv.classList.add('hidden');
      this.settingsOv.classList.remove('hidden');
    });
    // Real-time FPS preview while the graphics panel is open (1 Hz).
    setInterval(() => {
      if (this.graphicsOv.classList.contains('hidden')) return;
      $('gfx-fps').textContent =
        `FPS: ${game.stats.fps}  \u00B7  DRAW CALLS: ${game.renderer.info.render.calls}`;
    }, 1000);

    // Tilt gracefully falls back to buttons when no sensor responds.
    game.input.onTiltUnavailable = () => {
      applyMode('buttons');
      this._toast('Tilt sensor unavailable — using button steering.');
    };

    // HUD layout editor.
    this.hudEditor = new HudEditor(settings);
    $('btn-hud-edit').addEventListener('click', () => {
      this.settingsOv.classList.add('hidden');
      this._applySteerWidgets(); // editor shows the active steering widget
      this.hudEditor.open();
    });
    this.hudEditor.onClose = () => {
      if (game.state === State.MENU) this.settingsOv.classList.remove('hidden');
    };

    // Steering widgets (handlebar / swipe zone).
    game.input.bindHandlebar($('handlebar'));
    game.input.bindSwipe($('swipe-zone'));
    this._applySteerWidgets();

    // Pause overlay
    $('btn-resume').addEventListener('click', () => game.resume());
    $('btn-restart').addEventListener('click', () => game.restart());
    $('btn-main-menu').addEventListener('click', () => game.toMenu());

    // Game over overlay
    $('btn-go-restart').addEventListener('click', () => game.restart());
    $('btn-go-menu').addEventListener('click', () => game.toMenu());

    // Stunt notifications (event-driven; one reused DOM node).
    game.stunts.onStunt = (label, pts, combo) => {
      const failed = label === 'COMBO LOST';
      this.stuntToast.textContent = failed ? label : `${label} +${pts}`;
      this.stuntToast.classList.toggle('bad', failed);
      this.stuntToast.classList.add('show');
      clearTimeout(this._stuntTimer);
      this._stuntTimer = setTimeout(() => this.stuntToast.classList.remove('show'), 1500);
    };

    // Live combo panel (Phase 3I-5): header, line items, running total.
    this.comboHud = $('combo-hud');
    game.stunts.onCombo = (count, pending, mult) => {
      if (count > 0 && pending > 0) {
        const lines = game.stunts.comboLines.map((l) => `<div>${l}</div>`).join('');
        this.comboHud.innerHTML = count > 1
          ? `<div class="ch">COMBO x${mult}</div>${lines}<div class="ct">TOTAL +${pending}</div>`
          : lines;
        this.comboHud.classList.add('show');
        // Cheap pop: retrigger the scale transition on every trick.
        this.comboHud.classList.remove('pop');
        void this.comboHud.offsetWidth;
        this.comboHud.classList.add('pop');
        clearTimeout(this._comboPopT);
        this._comboPopT = setTimeout(() => this.comboHud.classList.remove('pop'), 140);
      } else {
        this.comboHud.classList.remove('show');
      }
    };

    // HUD
    $('btn-pause').addEventListener('click', () => game.togglePause());
    $('btn-reset').addEventListener('click', () => game.resetBike());
    $('btn-pov').addEventListener('click', () => game.togglePov());
    document.querySelectorAll('[data-control]').forEach((el) => {
      game.input.bindButton(el, el.dataset.control);
    });

    game.onStateChange = (s) => this._applyState(s);
    this._applyState(game.state);

    // Developer overlay (Phase 1B): F3 or the DBG button.
    this.debugOverlay = new DebugOverlay(game);

    // HUD readouts: update at 5 Hz, not per frame (avoids DOM churn).
    setInterval(() => {
      if (game.state !== State.PLAYING && game.state !== State.CRASHED) return;
      const bike = game.bike;
      // Actual movement speed: scalar on the ground, velocity length in air.
      const ms = bike.grounded
        ? Math.abs(bike.speed)
        : Math.hypot(bike.velocity.x, bike.velocity.y, bike.velocity.z);
      this.speedo.innerHTML = `${Math.round(ms * 3.6)} <span>km/h</span>`;
      this.distance.textContent = fmtDist(game.run.distance);
      this.score.textContent = game.stunts.score > 0 ? `${game.stunts.score} PTS` : '';
    }, 200);
  }

  _applyState(s) {
    this.menu.classList.toggle('hidden', s !== State.MENU);
    this.about.classList.add('hidden');
    this.pause.classList.toggle('hidden', s !== State.PAUSED);
    this.gameover.classList.toggle('hidden', s !== State.CRASHED);
    this.hud.classList.toggle('hidden', s === State.MENU);
    if (s === State.CRASHED) this._fillGameOver();
    if (s === State.PLAYING || s === State.MENU) {
      this.stuntToast.classList.remove('show');
      this.comboHud.classList.remove('show');
    }
  }

  _fillGameOver() {
    const g = this.game;
    document.getElementById('go-distance').textContent = fmtDist(g.run.distance);
    const best = document.getElementById('go-best');
    best.textContent = g.newBest ? `${fmtDist(g.run.best)} — NEW BEST!` : fmtDist(g.run.best);
    best.classList.toggle('best-new', g.newBest);
    document.getElementById('go-score').textContent = String(g.stunts.score);
  }

  _toast(msg) {
    this.toast.textContent = msg;
    this.toast.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (this.toast.style.opacity = '0'), 2500);
  }

  /** Show only the steering widget matching the selected mode. */
  _applySteerWidgets() {
    const mode = this.game.settings.get('steerMode');
    const $ = (id) => document.getElementById(id);
    $('btn-left').classList.toggle('hidden', mode !== 'buttons');
    $('btn-right').classList.toggle('hidden', mode !== 'buttons');
    $('handlebar').classList.toggle('hidden', mode !== 'handlebar');
    $('swipe-zone').classList.toggle('hidden', mode !== 'swipe');
  }
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}
