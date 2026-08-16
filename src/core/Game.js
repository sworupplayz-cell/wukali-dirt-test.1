import * as THREE from 'three';
import { SectorWorld } from '../world/SectorWorld.js';
import { Bike } from '../bike/Bike.js';
import { BikeModel } from '../bike/BikeModel.js';
import { Input } from './Input.js';
import { FollowCamera } from './FollowCamera.js';
import { GameAudio } from './GameAudio.js';
import { RunStats } from './RunStats.js';
import { StuntTracker } from './StuntTracker.js';
import { Settings } from './Settings.js';
import { Graphics } from './Graphics.js';

export const State = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  CRASHED: 'crashed',
};

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5; // avoid spiral-of-death after a stall/tab switch

export class Game {
  constructor(canvas) {
    this.state = State.MENU;
    this.onStateChange = null; // UI listens

    this._canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    // Cap the render resolution — full DPR on phones costs frames for
    // no visible gain in a low-poly scene. (Chapter 3C: the Graphics
    // system overrides this with the render-scale setting.)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this._fpsInterval = 0; // 0 = uncapped (vsync); else min seconds/frame
    this._lastRender = 0;

    this.scene = new THREE.Scene();
    // Far plane covers the Phase 3 continent backdrop (fog ends ~7 km).
    // Chapter 3D: near plane 0.45 (was 0.1) — with km-scale far planes the
    // tiny near plane wasted nearly all depth precision and distant
    // meshes shimmered. Nothing renders closer than ~0.6 m anyway.
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.45, 12000);

    // Horizon Ride Phase 1B: fixed 10,000 x 5,000 m world, 200 permanent
    // 500 m sectors, 3x3 streaming window around the bike.
    this.world = new SectorWorld(this.scene);
    this.bike = new Bike(this.world);
    this.bikeModel = new BikeModel(this.scene);
    this.followCam = new FollowCamera(this.camera, this.world);
    this.input = new Input();
    this.settings = new Settings();
    this.graphics = new Graphics();
    this.input.attachSettings(this.settings);
    this.audio = new GameAudio();
    this.run = new RunStats();
    this.stunts = new StuntTracker();
    this.newBest = false; // set when the run that just ended beat the best

    this.bike.onCrash = () => {
      // Defer the transition to the end of the physics step so the stunt
      // tracker can award partial points for the crashed jump first —
      // otherwise the game-over overlay shows a stale score.
      this._crashPending = true;
    };
    this.input.onPause = () => this.togglePause();
    this.input.onReset = () => this.resetBike();
    this.input.onPov = () => this.togglePov();

    this._accumulator = 0;
    this._lastTime = 0;
    this._elapsed = 0;

    // Simple perf counters, exposed for verification/tuning.
    this.stats = { fps: 0, frames: 0, last: 0, frameMs: 0, _accMs: 0 };

    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._syncModel();
    // Chapter 3C: restore saved graphics settings (or auto-detected tier).
    this.graphics.attach(this);
    requestAnimationFrame((t) => this._loop(t));
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.input.clear();
    if (this.onStateChange) this.onStateChange(s);
  }

  // ---- Flow --------------------------------------------------------------

  play() {
    this.audio.init();
    this.audio.resume();
    this.bike.fullReset();
    this.followCam.snapTo(this.bike);
    this._startRun();
    this._setState(State.PLAYING);
  }

  togglePause() {
    if (this.state === State.PLAYING) this._setState(State.PAUSED);
    else if (this.state === State.PAUSED) this.resume();
  }

  resume() {
    if (this.state !== State.PAUSED) return;
    this.audio.resume();
    this._setState(State.PLAYING);
  }

  restart() {
    this.run.endRun(); // quitting mid-run still records a best
    this.bike.fullReset();
    this.followCam.snapTo(this.bike);
    this._startRun();
    this._setState(State.PLAYING);
  }

  toMenu() {
    this.run.endRun();
    this.audio.setEngine(0, 0, false);
    this._setState(State.MENU);
  }

  /** Switch first/third person (HUD POV button or the C key). */
  togglePov() {
    if (this.state !== State.PLAYING && this.state !== State.PAUSED) return;
    return this.followCam.toggle();
  }

  /** Recovery for a stuck (not crashed) bike; crash = run over. */
  resetBike() {
    if (this.state !== State.PLAYING) return;
    this.bike.reset();
    this.followCam.snapTo(this.bike);
    this.stunts.cancel(); // teleport invalidates any in-flight stunt/combo
  }

  _startRun() {
    this.run.reset(this.bike.position.x, this.bike.position.z);
    this.stunts.reset();
    this.newBest = false;
  }

  // ---- Loop --------------------------------------------------------------

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- Graphics quality plumbing (Chapter 3C) -----------------------------

  /** Frame-rate cap: 0/undefined = vsync-uncapped. */
  setFpsLimit(fps) {
    this._fpsInterval = fps && fps < 240 ? 1 / fps : 0;
  }

  /**
   * Swap the canvas for a fresh one with different context attributes
   * (anti-aliasing cannot be toggled on a live WebGL context). All
   * scene resources re-upload automatically on the next render.
   */
  recreateRenderer(antialias) {
    const old = this._canvas;
    const fresh = old.cloneNode(false);
    old.parentNode.replaceChild(fresh, old);
    this._canvas = fresh;
    const prevShadows = this.renderer.shadowMap.enabled;
    const prevRatio = this.renderer.getPixelRatio();
    this.renderer.dispose();
    this.renderer = new THREE.WebGLRenderer({
      canvas: fresh,
      antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = prevShadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(prevRatio);
    this._resize();
  }

  _syncModel(dt = 1 / 60) {
    // Rider rides in third person; hidden once the POV blend passes helmet
    // distance so the camera never clips through him.
    this.bikeModel.setRiderVisible(this.followCam.blend < 0.45);
    const p = this.bike.position;
    this.bikeModel.sync(
      this.bike,
      this.world.getHeight(p.x, p.z),
      this.world.getNormal(p.x, p.z, this._groundNormal),
      this.world,
      dt
    );
  }

  _loop(timeMs) {
    requestAnimationFrame((t) => this._loop(t));
    const time = timeMs * 0.001;
    let frameDt = Math.min(time - this._lastTime, 0.1);
    if (frameDt < 0) frameDt = 0;
    this._lastTime = time;
    this._elapsed += frameDt;

    const simulating = this.state === State.PLAYING || this.state === State.CRASHED;
    this.input.enabled = this.state === State.PLAYING;
    this.input.update();

    // Stream sectors around the bike (also in the menu, for the backdrop).
    this.world.update(this.bike.position);

    if (simulating) {
      this._accumulator = Math.min(this._accumulator + frameDt, FIXED_DT * MAX_STEPS);
      while (this._accumulator >= FIXED_DT) {
        this.bike.update(FIXED_DT, this.input);
        this.run.step(
          this.bike.position.x,
          this.bike.position.z,
          this.state === State.PLAYING && !this.bike.crashed
        );
        this.stunts.step(this.bike, FIXED_DT);
        this._accumulator -= FIXED_DT;
      }
      if (this._crashPending) {
        // A genuine crash ends the run (minor bumps never reach here).
        this._crashPending = false;
        this.newBest = this.run.endRun();
        this._setState(State.CRASHED);
      }
      this.followCam.update(this.bike, frameDt);
      this.audio.setEngine(
        Math.abs(this.bike.speed) / 26,
        this.input.throttle,
        true
      );
    } else if (this.state === State.MENU) {
      this.followCam.menuOrbit(this.bike, this._elapsed);
      this.audio.setEngine(0, 0, false);
    } else {
      this.audio.setEngine(0, 0, false);
    }

    this._syncModel(frameDt);
    // FPS limit (Chapter 3C): skip the RENDER when the frame budget says
    // so — simulation above already ran, so physics stays exact.
    if (this._fpsInterval > 0) {
      if (time - this._lastRender < this._fpsInterval * 0.96) return;
      this._lastRender = time;
    }
    this.renderer.render(this.scene, this.camera);

    this.stats.frames++;
    this.stats._accMs += frameDt * 1000;
    if (time - this.stats.last >= 1) {
      this.stats.fps = this.stats.frames;
      this.stats.frameMs = +(this.stats._accMs / Math.max(1, this.stats.frames)).toFixed(1);
      this.stats.frames = 0;
      this.stats._accMs = 0;
      this.stats.last = time;
    }
  }
}
