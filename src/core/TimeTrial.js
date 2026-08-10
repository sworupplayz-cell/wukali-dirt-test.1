import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * TimeTrial (Phase 3K-1) — deterministic mountain time trials on the
 * EXISTING mountain roads. Every curated registry mountain gets one trial:
 * a start gate on its road (frac 0.35), four checkpoints up the same road,
 * finish at the summit. Everything derives from roadPoint() and the world
 * seed — no new terrain, no colliders (markers are pass-through visuals),
 * no per-frame allocations.
 *
 * Rendering cost: ONE merged gate mesh + ONE InstancedMesh for checkpoints
 * (2 draw calls, repositioned — never rebuilt — as the player nears a
 * different mountain).
 */
const GATE_FRAC = 0.35;
const CP_FRACS = [0.44, 0.53, 0.62, 0.71, 0.8, 0.9]; // 6 checkpoints to the top
const GATE_R = 8;        // ride-through radius (m)
const CP_R = 11;
const NEAR_SHOW = 1600;  // gate mesh becomes visible within this range
const NEAR_PROMPT = 90;  // "ride through the gate" prompt range
const AREA_SLACK = 260;  // leaving the mountain area (R + slack) aborts

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class TimeTrial {
  constructor(scene, world, achievements) {
    this.world = world;
    this.ach = achievements;
    this.state = 'idle';   // 'idle' | 'running'
    this.time = 0;
    this.cpIndex = 0;      // next checkpoint to pass
    this.active = null;    // trial being run
    this.onEvent = null;   // (type, payload) — 'near'|'prompt'|'start'|'checkpoint'|'finish'|'abort'
    this._trials = null;   // lazy-built, one per registry mountain (deterministic)
    this._near = null;     // nearest trial (gate shown)
    this._scanT = 0;
    this._sumT = 0;
    this._prevX = 0;
    this._prevZ = 0;
    this._buildMarkers(scene);
  }

  /** One trial per curated mountain; positions all derive from the seed. */
  trials() {
    if (this._trials) return this._trials;
    this._trials = this.world.getMountainRegistry().map((r) => {
      const m = this.world.nearestMountain(r.x, r.z);
      const g = this.world.roadPoint(m, GATE_FRAC, 0);
      return {
        id: r.id,
        name: r.name,
        m,
        gate: { x: g.x, z: g.z, yaw: g.yaw },
        cps: CP_FRACS.map((f) => {
          const p = this.world.roadPoint(m, f, 0);
          return { x: p.x, z: p.z };
        }),
      };
    });
    return this._trials;
  }

  cpTotal() { return CP_FRACS.length; }

  /** Called from the game loop while playing. Idle cost: a 2 Hz scan. */
  update(bike, dt) {
    const bx = bike.position.x, bz = bike.position.z;

    if (this.state === 'running') {
      this.time += dt;
      // Teleport (reset/restart) or crash aborts the run.
      const jump = Math.hypot(bx - this._prevX, bz - this._prevZ);
      if (bike.crashed || jump > 50) { this._abort(bike.crashed ? 'crashed' : 'reset'); return; }
      this._prevX = bx; this._prevZ = bz;

      if (this.cpIndex < CP_FRACS.length) {
        const cp = this.active.cps[this.cpIndex];
        if (Math.hypot(bx - cp.x, bz - cp.z) < CP_R) {
          this.cpIndex++;
          this._paintCheckpoints();
          if (this.onEvent) this.onEvent('checkpoint', { index: this.cpIndex, total: CP_FRACS.length });
        }
      } else {
        // All checkpoints passed: finish by genuinely reaching the summit.
        this._sumT += dt;
        if (this._sumT > 0.25) {
          this._sumT = 0;
          const m = this.world.summitAt(bx, bz);
          if (m && m.id === this.active.id) { this._finish(); return; }
        }
      }
      // The checkpoint SEQUENCE enforces the route (any riding line between
      // checkpoints is fair game); only leaving the mountain area aborts.
      if (Math.hypot(bx - this.active.m.x, bz - this.active.m.z) > this.active.m.R + AREA_SLACK) {
        this._abort('left the mountain');
      }
      return;
    }

    // Idle: cheap scan for the nearest gate.
    this._scanT += dt;
    if (this._scanT < 0.5) return;
    this._scanT = 0;
    let best = null, bestD = 1e9;
    for (const t of this.trials()) {
      const d = Math.hypot(bx - t.gate.x, bz - t.gate.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best !== this._near) {
      this._near = best;
      this._placeGate(best);
    }
    this.gate.visible = !!best && bestD < NEAR_SHOW;
    if (best && bestD < NEAR_PROMPT && this.onEvent) {
      this.onEvent('prompt', { name: best.name });
    }
    if (best && bestD < GATE_R) this._start(best, bx, bz);
  }

  cancel() {
    if (this.state === 'running') this._abort('cancelled', true);
  }

  _start(trial, bx, bz) {
    this.state = 'running';
    this.active = trial;
    this.time = 0;
    this.cpIndex = 0;
    this._sumT = 0;
    this._prevX = bx; this._prevZ = bz;
    this._placeCheckpoints(trial);
    if (this.onEvent) this.onEvent('start', { name: trial.name, total: CP_FRACS.length });
  }

  _finish() {
    const res = this.ach.completeTrial(this.active.id, this.active.name, this.time);
    const payload = { name: this.active.name, time: this.time, ...res };
    this.state = 'idle';
    this.active = null;
    this.cpGroup.visible = false;
    if (this.onEvent) this.onEvent('finish', payload);
  }

  _abort(reason, silent = false) {
    this.state = 'idle';
    this.active = null;
    this.cpGroup.visible = false;
    if (!silent && this.onEvent) this.onEvent('abort', { reason });
  }

  // ---- markers -------------------------------------------------------------

  _buildMarkers(scene) {
    const color = (geo, r, g, b) => {
      const n = geo.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.deleteAttribute('uv');
      return geo;
    };
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    // Start gate: two poles + crossbar + small pennants (one merged mesh).
    const parts = [];
    for (const sx of [-3.4, 3.4]) {
      parts.push(color(new THREE.CylinderGeometry(0.09, 0.12, 3.6, 6)
        .translate(sx, 1.8, 0), 0.85, 0.83, 0.78));
      parts.push(color(new THREE.ConeGeometry(0.28, 0.55, 5)
        .translate(sx, 3.85, 0), 0.78, 0.2, 0.16));
    }
    parts.push(color(new THREE.BoxGeometry(7.2, 0.26, 0.26).translate(0, 3.5, 0), 0.78, 0.2, 0.16));
    parts.push(color(new THREE.BoxGeometry(2.6, 0.5, 0.06).translate(0, 3.05, 0), 0.95, 0.9, 0.8));
    this.gate = new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), mat);
    this.gate.visible = false;
    scene.add(this.gate);

    // Checkpoints: pole + ring, instanced (one draw call for all four).
    const cpParts = [
      color(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6).translate(0, 1.3, 0), 0.9, 0.88, 0.8),
      color(new THREE.TorusGeometry(1.05, 0.1, 6, 14).translate(0, 3.15, 0), 1, 1, 1),
    ];
    const cpGeo = mergeGeometries(cpParts.map((g) => g.toNonIndexed()));
    this.cpMesh = new THREE.InstancedMesh(cpGeo, mat.clone(), CP_FRACS.length);
    this.cpMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(CP_FRACS.length * 3), 3);
    this.cpGroup = new THREE.Group();
    this.cpGroup.add(this.cpMesh);
    this.cpGroup.visible = false;
    scene.add(this.cpGroup);
  }

  _placeGate(trial) {
    if (!trial) return;
    const y = this.world.getHeight(trial.gate.x, trial.gate.z);
    this.gate.position.set(trial.gate.x, y, trial.gate.z);
    this.gate.rotation.y = trial.gate.yaw; // crossbar spans the road
  }

  _placeCheckpoints(trial) {
    for (let i = 0; i < trial.cps.length; i++) {
      const cp = trial.cps[i];
      _p.set(cp.x, this.world.getHeight(cp.x, cp.z), cp.z);
      _q.setFromAxisAngle(_up, Math.atan2(trial.m.x - cp.x, trial.m.z - cp.z));
      _m4.compose(_p, _q, _s.set(1, 1, 1));
      this.cpMesh.setMatrixAt(i, _m4);
    }
    this.cpMesh.instanceMatrix.needsUpdate = true;
    this.cpGroup.visible = true;
    this._paintCheckpoints();
  }

  _paintCheckpoints() {
    for (let i = 0; i < CP_FRACS.length; i++) {
      // Passed: dim green. Next: bright orange. Upcoming: white.
      const c = i < this.cpIndex ? [0.25, 0.6, 0.3]
        : i === this.cpIndex ? [1.0, 0.55, 0.1] : [0.95, 0.95, 0.95];
      this.cpMesh.instanceColor.setXYZ(i, c[0], c[1], c[2]);
    }
    this.cpMesh.instanceColor.needsUpdate = true;
  }
}
