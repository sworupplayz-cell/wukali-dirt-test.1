import * as THREE from 'three';
import { TestWorld } from '../world/TestWorld.js';
import { Bike } from '../bike/Bike.js';
import { BikeModel } from '../bike/BikeModel.js';
import { Input } from './Input.js';
import { FollowCamera } from './FollowCamera.js';
import { GameAudio } from './GameAudio.js';
import { RunStats } from './RunStats.js';
import { StuntTracker } from './StuntTracker.js';
import { Settings } from './Settings.js';

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

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    // Cap the render resolution — full DPR on phones costs frames for
    // no visible gain in a low-poly scene.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 800);

    // Horizon Ride Phase 1A: one static test scene — no procedural world.
    this.world = new TestWorld(this.scene);
    this.bike = new Bike(this.world);
    this.bikeModel = new BikeModel(this.scene);
    this.followCam = new FollowCamera(this.camera, this.world);
    this.input = new Input();
    this.settings = new Settings();
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
    this.stats = { fps: 0, frames: 0, last: 0 };

    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._syncModel();
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
    this.renderer.render(this.scene, this.camera);

    this.stats.frames++;
    if (time - this.stats.last >= 1) {
      this.stats.fps = this.stats.frames;
      this.stats.frames = 0;
      this.stats.last = time;
    }
  }
}
