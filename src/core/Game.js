import * as THREE from 'three';
import { WorldManager } from '../world/WorldManager.js';
import { Bike } from '../bike/Bike.js';
import { BikeModel } from '../bike/BikeModel.js';
import { Input } from './Input.js';
import { FollowCamera } from './FollowCamera.js';
import { GameAudio } from './GameAudio.js';
import { RunStats } from './RunStats.js';
import { StuntTracker } from './StuntTracker.js';
import { Achievements } from './Achievements.js';
import { Settings } from './Settings.js';
import { TimeTrial } from './TimeTrial.js';
import { NatureSpots } from '../world/NatureSpots.js';
import { Challenges } from './Challenges.js';

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
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 5200); // far covers the ridge backdrop

    // Deterministic world; ?seed=N in the URL selects a different one.
    const seed = Number(new URLSearchParams(location.search).get('seed')) || 20;
    this.world = new WorldManager(this.scene, seed);
    this.bike = new Bike(this.world);
    this.bikeModel = new BikeModel(this.scene);
    this.followCam = new FollowCamera(this.camera, this.world);
    this.input = new Input();
    this.settings = new Settings();
    this.input.attachSettings(this.settings);
    this.audio = new GameAudio();
    this.run = new RunStats();
    this.stunts = new StuntTracker();
    this.achievements = new Achievements();
    this.trials = new TimeTrial(this.scene, this.world, this.achievements);
    this.nature = new NatureSpots(this.scene, this.world.generator, seed);
    this.challenges = new Challenges(this.scene, this.world, this.stunts, this.achievements);
    this.onDiscover = null; // UI shows the discovery toast
    this.onSummit = null; // UI shows the summit banner
    this.newBest = false; // set when the run that just ended beat the best
    this._summitT = 0;

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
    this.trials.cancel();
    this.challenges.cancel();
    this._startRun();
    this._setState(State.PLAYING);
  }

  toMenu() {
    this.run.endRun();
    this.audio.setEngine(0, 0, false);
    this.trials.cancel();
    this.challenges.cancel();
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
    this.trials.cancel();
    this.challenges.cancel();
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

    // Stream chunks around the bike (also in the menu, for the backdrop).
    this.world.update(this.bike.position, frameDt);

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
        this.trials.cancel(); // a crashed run forfeits the trial
        this.challenges.cancel();
        this._setState(State.CRASHED);
      }
      // Summit detection: cheap check at 4 Hz, never per frame.
      this._summitT += frameDt;
      if (this._summitT > 0.25) {
        this._summitT = 0;
        if (this.state === State.PLAYING && this.bike.grounded && !this.bike.crashed) {
          const m = this.world.summitAt(this.bike.position.x, this.bike.position.z);
          if (m) {
            const res = this.achievements.reachSummit(m); // null if already conquered
            if (res && this.onSummit) this.onSummit(res);
          }
        }
      }
      // Time trials (Phase 3K-1): 2 Hz gate scan when idle, one distance
      // check per frame while running.
      if (this.state === State.PLAYING) this.trials.update(this.bike, frameDt);
      // Nature discoveries (Phase 3K-2): 2 Hz proximity scan.
      if (this.state === State.PLAYING) {
        const rec = this.nature.update(this.bike.position.x, this.bike.position.z, frameDt);
        if (rec) {
          const res = this.achievements.discover(rec.id, rec.name);
          if (res && this.onDiscover) this.onDiscover({ ...res, type: rec.type });
        }
      }
      // Stunt/off-road/trail challenges (Phase 3K-3).
      if (this.state === State.PLAYING) this.challenges.update(this.bike, frameDt);
      // Village + town discoveries (Phase 3L-1/2).
      if (this.state === State.PLAYING) {
        const v = this.world.villages.update(this.bike.position.x, this.bike.position.z, frameDt);
        if (v) {
          const res = this.achievements.discover(v.id, v.name);
          if (res && this.onDiscover) this.onDiscover({ ...res, type: 'village' });
        }
        const t = this.world.towns.update(this.bike.position.x, this.bike.position.z, frameDt);
        if (t) {
          const res = this.achievements.discover(t.id, t.name);
          if (res && this.onDiscover) this.onDiscover({ ...res, type: 'town' });
        }
        const cy = this.world.cities.update(this.bike.position.x, this.bike.position.z, frameDt);
        if (cy) {
          const res = this.achievements.discover(cy.id, cy.name);
          if (res && this.onDiscover) this.onDiscover({ ...res, type: 'city' });
        }
        // Industrial zones + large stadiums (Phase 3L-4).
        const iz = this.world.industry.update(this.bike.position.x, this.bike.position.z, frameDt);
        if (iz) {
          const res = this.achievements.discover(iz.id, iz.name);
          if (res && this.onDiscover) this.onDiscover({ ...res, type: iz.kind });
        }
        // Ambient NPCs + traffic (Phase 3N): pooled, no colliders, no physics.
        this.world.population.update(this.bike.position.x, this.bike.position.z, frameDt);
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
