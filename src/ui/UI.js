import { State } from '../core/Game.js';
import { HudEditor } from './HudEditor.js';

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
    this.trialHud = $('trial-hud');
    this.discoveryToast = $('discovery-toast');
    this.summitBanner = $('summit-banner');
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

    // Summit banner (one reused node; event-driven).
    game.onSummit = (res) => {
      // Names carrying a Nepali mountain word need no "Mount" prefix.
      const hasSuffix = /(Shikhar|Chuli|Danda|Himal|Peak|Crown)$/.test(res.name);
      $('sb-name').textContent = hasSuffix ? res.name : `Mount ${res.name}`;
      $('sb-ach').textContent = res.meta.length
        ? `\u{1F3C6} ${res.meta.join(' \u00B7 ')}`
        : `\u{1F3C6} Mountain Conquered (${game.achievements.summitCount})`;
      this.summitBanner.classList.add('show');
      clearTimeout(this._summitTimer);
      this._summitTimer = setTimeout(() => this.summitBanner.classList.remove('show'), 3800);
    };

    // ---- Time trials (Phase 3K-1) -------------------------------------------
    const fmtT = (t) => {
      const m = Math.floor(t / 60), s = t - m * 60;
      return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    };
    this._trialPromptT = 0;
    game.trials.onEvent = (type, p) => {
      clearTimeout(this._trialHideT);
      if (type === 'prompt') {
        // Shown only while idle and near a gate (re-fired by the 2 Hz scan).
        if (game.trials.state === 'idle') {
          this.trialHud.textContent = `\u23F1 ${p.name} TIME TRIAL \u2014 ride through the gate`;
          this.trialHud.classList.add('show');
          this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 1600);
        }
      } else if (type === 'start') {
        this.trialHud.classList.add('show');
      } else if (type === 'checkpoint') {
        this.trialHud.classList.add('show');
      } else if (type === 'finish') {
        const extra = p.meta ? ` \u00B7 \u{1F3C6} ${p.meta}` : (p.first ? '' : p.improved ? ' \u00B7 NEW BEST' : ` \u00B7 best ${fmtT(p.best)}`);
        this.trialHud.textContent = `\u{1F3C1} ${p.name} \u2014 ${fmtT(p.time)}${extra}`;
        this.trialHud.classList.add('show');
        this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 5000);
      } else if (type === 'abort') {
        this.trialHud.textContent = `TRIAL OVER \u2014 ${p.reason}`;
        this.trialHud.classList.add('show');
        this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 2200);
      }
    };

    // Nature discovery toast (Phase 3K-2).
    game.onDiscover = (d) => {
      const icon = d.type === 'lake' ? '\u{1F30A}' : d.type === 'wf' ? '\u{1F4A7}'
        : d.type === 'village' ? '\u{1F3D8}\uFE0F' : d.type === 'town' ? '\u{1F3EA}'
        : d.type === 'city' ? '\u{1F3D9}\uFE0F' : d.type === 'industry' ? '\u{1F3ED}'
        : d.type === 'stadium' ? '\u{1F3DF}\uFE0F' : '\u{1F3D4}\uFE0F';
      this.discoveryToast.textContent =
        `${icon} DISCOVERED \u00B7 ${d.name}${d.meta ? ` \u00B7 \u{1F3C6} ${d.meta}` : ''}`;
      this.discoveryToast.classList.add('show');
      clearTimeout(this._discT);
      this._discT = setTimeout(() => this.discoveryToast.classList.remove('show'), 3500);
    };

    // Challenge events (Phase 3K-3) share the trial pill; a running
    // mountain trial keeps display priority.
    game.challenges.onEvent = (type, p) => {
      if (game.trials.state === 'running') return;
      clearTimeout(this._trialHideT);
      if (type === 'prompt') {
        const label = p.kind === 'sz' ? `\u{1F3AA} STUNT ZONE \u00B7 ${p.name} \u2014 ride in and go big!`
          : p.kind === 'or' ? `\u{1F98F} OFF-ROAD \u00B7 ${p.name} (${p.len} m) \u2014 ride through the flag`
          : `\u{1F332} TRAIL \u00B7 ${p.name} \u2014 ride through the flag`;
        this.trialHud.textContent = label;
        this.trialHud.classList.add('show');
        this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 1800);
      } else if (type === 'start' || type === 'cp') {
        this.trialHud.classList.add('show');
      } else if (type === 'finish') {
        const extra = p.meta ? ` \u00B7 \u{1F3C6} ${p.meta}` : p.improved && !p.first ? ' \u00B7 NEW BEST' : '';
        this.trialHud.textContent = p.score !== undefined
          ? `\u{1F3AA} ${p.rec.name} \u2014 +${p.score} PTS${extra}`
          : `\u{1F3C1} ${p.rec.name} \u2014 ${fmtT(p.time)}${extra}`;
        this.trialHud.classList.add('show');
        this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 5000);
      } else if (type === 'fail') {
        this.trialHud.textContent = `CHALLENGE OVER \u2014 ${p.reason}`;
        this.trialHud.classList.add('show');
        this._trialHideT = setTimeout(() => this.trialHud.classList.remove('show'), 2200);
      }
    };

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
      // Running trial: live timer + checkpoint progress (same 5 Hz tick).
      if (game.trials.state === 'running') {
        const tr = game.trials;
        const cp = Math.min(tr.cpIndex, tr.cpTotal());
        this.trialHud.textContent = tr.cpIndex < tr.cpTotal()
          ? `\u23F1 ${fmtT(tr.time)} \u00B7 CP ${cp}/${tr.cpTotal()}`
          : `\u23F1 ${fmtT(tr.time)} \u00B7 TO THE SUMMIT!`;
      } else if (game.challenges.active) {
        const a = game.challenges.active;
        this.trialHud.textContent = a.kind === 'sz'
          ? `\u{1F3AA} STUNT ZONE ${Math.ceil(a.t)}s \u00B7 +${game.stunts.score - a.score0} PTS`
          : a.kind === 'or'
            ? `\u23F1 ${fmtT(a.t)} \u00B7 TO THE FINISH`
            : `\u23F1 ${fmtT(a.t)} \u00B7 CP ${a.cp}/${a.rec.cps.length}`;
        this.trialHud.classList.add('show');
      }
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
      this.trialHud.classList.remove('show');
    }
    if (s === State.MENU) this.summitBanner.classList.remove('show');
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
