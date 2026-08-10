import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from '../world/noise.js';

/**
 * Challenges (Phase 3K-3) — stunt zones, off-road challenges and
 * checkpoint trails. Deterministic per grid cell from the world seed,
 * validated against the analytic terrain (never inside mountain domes,
 * streams or impossible slopes), rendered through small pooled markers
 * (no colliders, no per-frame allocations).
 *
 * Scoring NEVER duplicates the stunt system: a stunt-zone run simply
 * measures the EXISTING StuntTracker's banked-score delta while active.
 * Off-road/trail runs are point-to-point timers; the route between the
 * markers is the player's to choose (exploration, not a fixed line).
 */
const SZ_CELL = 760, OR_CELL = 1300, CT_CELL = 1000;
const SZ_P = 0.5, OR_P = 0.55, CT_P = 0.5;
const SHOW_R = 460;      // start markers visible within this range
const START_R = 9;       // ride-through radius to start a timed run
const CP_R = 10;
const SZ_TIME = 45;      // stunt-zone window (s)
const SCAN_DT = 0.5;

const SZ_NAMES = ['Bandar Akhada', 'Chara Udaan', 'Hawa Chautari', 'Udne Danda',
  'Jhilke Akhada', 'Phurti Maidan'];
const OR_NAMES = ['Gaida Bato', 'Jangali Daud', 'Dhunga Par', 'Bhir Bato',
  'Kharka Daud', 'Lekali Chunauti'];
const CT_NAMES = ['Ban Bato', 'Kheti Ghumti', 'Salla Sadak', 'Gaun Ghumti',
  'Simal Bato', 'Pahara Ghumti'];

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Challenges {
  constructor(scene, world, stunts, achievements) {
    this.world = world;
    this.gen = world.generator;
    this.stunts = stunts;
    this.ach = achievements;
    this.seed = this.gen.seed | 0;
    this.onEvent = null;      // (type, payload) for the UI
    this.active = null;       // { kind, rec, t, cp, score0 }
    this._cells = { sz: new Map(), or: new Map(), ct: new Map() };
    this._nearby = [];
    this._t = 0;
    this._ckey = '';
    this._prevX = 0;
    this._prevZ = 0;
    this._promptId = '';
    this._buildMarkers(scene);
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 23 + salt); }

  // ---- deterministic placement (cached per cell) ----------------------------

  _cellRec(kind, cx, cz, builder) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let r = this._cells[kind].get(key);
    if (r === undefined) {
      r = builder(cx, cz);
      this._cells[kind].set(key, r);
    }
    return r;
  }

  /** Terrain suitability for a marker: gentle, off domes/streams/roads. */
  _ok(x, z, maxSlope = 1.0, maxTrail = 0.6) {
    const gen = this.gen, info = gen._info;
    gen.masksAt(x, z, info);
    if (info.mtn > 0.02 || info.stream > 0.5 || info.trail > maxTrail) return false;
    const slope = Math.abs(gen.height(x + 4, z) - gen.height(x - 4, z)) +
                  Math.abs(gen.height(x, z + 4) - gen.height(x, z - 4));
    return slope < maxSlope;
  }

  /** Stunt zone: anchored to existing ramp/mound features. */
  szCell(cx, cz) {
    return this._cellRec('sz', cx, cz, () => {
      if (this._h(cx, cz, 11) > SZ_P) return null;
      const f0 = Math.floor(cx * SZ_CELL / 80), f1 = Math.floor((cx + 1) * SZ_CELL / 80);
      const g0 = Math.floor(cz * SZ_CELL / 80), g1 = Math.floor((cz + 1) * SZ_CELL / 80);
      const feats = [];
      for (let fx = f0; fx <= f1; fx++) {
        for (let fz = g0; fz <= g1; fz++) {
          const f = this.gen.cellFeature(fx, fz);
          if (f && (f.type === 'ramp' || f.type === 'mound')) feats.push(f);
        }
      }
      // A zone needs two jump features close together (a real playground).
      for (let i = 0; i < feats.length; i++) {
        for (let j = i + 1; j < feats.length; j++) {
          const a = feats[i], b = feats[j];
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d > 30 && d < 150) {
            const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
            if (!this._ok(x, z, 1.6)) continue;
            const name = SZ_NAMES[Math.floor(this._h(cx, cz, 12) * SZ_NAMES.length)];
            return { kind: 'sz', id: `S${cx},${cz}`, name, x, z,
              r: Math.max(55, d / 2 + 35) };
          }
        }
      }
      return null;
    });
  }

  /** Off-road challenge: start/finish away from roads, line sanity-checked. */
  orCell(cx, cz) {
    return this._cellRec('or', cx, cz, () => {
      if (this._h(cx, cz, 21) > OR_P) return null;
      for (let c = 0; c < 3; c++) {
        const sx = (cx + 0.2 + 0.6 * this._h(cx, cz, 22 + c * 5)) * OR_CELL;
        const sz2 = (cz + 0.2 + 0.6 * this._h(cx, cz, 23 + c * 5)) * OR_CELL;
        if (!this._ok(sx, sz2, 0.9, 0.15)) continue;
        const ang = this._h(cx, cz, 24 + c) * Math.PI * 2;
        const len = 380 + 260 * this._h(cx, cz, 25 + c);
        const fx = sx + Math.cos(ang) * len, fz = sz2 + Math.sin(ang) * len;
        if (!this._ok(fx, fz, 0.9, 0.15)) continue;
        // The straight line must be plausibly rideable (players may detour,
        // but no mountain core or sheer wall directly across it).
        let good = true;
        const steps = Math.max(16, Math.round(len / 16));
        let prev = this.gen.height(sx, sz2);
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const x = sx + (fx - sx) * t, z = sz2 + (fz - sz2) * t;
          const info = this.gen._info;
          this.gen.masksAt(x, z, info);
          if (info.mtn > 0.25) { good = false; break; }
          const h = this.gen.height(x, z);
          // Challenging but honestly rideable: no wall/cliff on the line
          // itself (players may still detour around local rough spots).
          if (Math.abs(h - prev) / (len / steps) > 0.5) { good = false; break; }
          prev = h;
        }
        if (!good) continue;
        const name = OR_NAMES[Math.floor(this._h(cx, cz, 26) * OR_NAMES.length)];
        return { kind: 'or', id: `O${cx},${cz}`, name,
          x: sx, z: sz2, fx, fz, len: Math.round(len) };
      }
      return null;
    });
  }

  /** Checkpoint trail: deterministic waypoint walk through gentle country. */
  ctCell(cx, cz) {
    return this._cellRec('ct', cx, cz, () => {
      if (this._h(cx, cz, 31) > CT_P) return null;
      const sx = (cx + 0.2 + 0.6 * this._h(cx, cz, 32)) * CT_CELL;
      const sz2 = (cz + 0.2 + 0.6 * this._h(cx, cz, 33)) * CT_CELL;
      if (!this._ok(sx, sz2, 0.9)) return null;
      const gen = this.gen, info = gen._info;
      gen.masksAt(sx, sz2, info);
      if (info.wF + info.wFa + info.wH < 0.5) return null; // forest/farm/hills
      const count = 4 + Math.floor(this._h(cx, cz, 34) * 2); // 4-5 checkpoints
      let heading = this._h(cx, cz, 35) * Math.PI * 2;
      let x = sx, z = sz2;
      const cps = [];
      const offs = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, Math.PI];
      for (let i = 0; i < count; i++) {
        const legLen = 95 + 45 * this._h(cx, cz, 36 + i);
        let placed = false;
        for (const off of offs) {
          const a = heading + off + (this._h(cx, cz, 40 + i * 8) - 0.5) * 0.4;
          const nx = x + Math.cos(a) * legLen, nz = z + Math.sin(a) * legLen;
          if (!this._ok(nx, nz, 1.0)) continue;
          cps.push({ x: nx, z: nz });
          x = nx; z = nz; heading = a;
          placed = true;
          break;
        }
        if (!placed) return null; // no gentle continuation: no trail here
      }
      const name = CT_NAMES[Math.floor(this._h(cx, cz, 37) * CT_NAMES.length)];
      return { kind: 'ct', id: `C${cx},${cz}`, name, x: sx, z: sz2, cps };
    });
  }

  // ---- runtime ---------------------------------------------------------------

  update(bike, dt) {
    const bx = bike.position.x, bz = bike.position.z;

    if (this.active) {
      this._runActive(bike, bx, bz, dt);
      return;
    }

    this._t += dt;
    if (this._t < SCAN_DT) return;
    this._t = 0;
    const ck = `${Math.floor(bx / 300)},${Math.floor(bz / 300)}`;
    if (ck !== this._ckey) {
      this._ckey = ck;
      this._refresh(bx, bz);
    }
    // Prompt + activation.
    for (const rec of this._nearby) {
      const d = Math.hypot(bx - rec.x, bz - rec.z);
      if (rec.kind === 'sz') {
        if (d < rec.r) { this._startZone(rec); return; }
        if (d < rec.r + 90 && this._promptId !== rec.id) {
          this._promptId = rec.id;
          if (this.onEvent) this.onEvent('prompt', rec);
        }
      } else {
        if (d < START_R) { this._startRun(rec, bx, bz); return; }
        if (d < 90 && this._promptId !== rec.id) {
          this._promptId = rec.id;
          if (this.onEvent) this.onEvent('prompt', rec);
        }
      }
    }
  }

  _startZone(rec) {
    this.active = { kind: 'sz', rec, t: SZ_TIME, score0: this.stunts.score };
    if (this.onEvent) this.onEvent('start', rec);
  }

  _startRun(rec, bx, bz) {
    this.active = { kind: rec.kind, rec, t: 0, cp: 0 };
    this._prevX = bx; this._prevZ = bz;
    this._placeRunMarkers(rec);
    if (this.onEvent) this.onEvent('start', rec);
  }

  _runActive(bike, bx, bz, dt) {
    const a = this.active;
    if (bike.crashed) { this._fail('crashed'); return; }

    if (a.kind === 'sz') {
      a.t -= dt;
      const delta = this.stunts.score - a.score0;
      const outside = Math.hypot(bx - a.rec.x, bz - a.rec.z) > a.rec.r + 60;
      // A banked score with the bike settled = the clean landing that ends
      // the challenge; otherwise it ends on timeout or when riding away.
      const settled = delta > 0 && bike.grounded && this.stunts.comboLines.length === 0;
      if (settled || a.t <= 0 || outside) {
        this._finishZone(delta);
      }
      return;
    }

    // Timed point-to-point runs.
    a.t += dt;
    const jump = Math.hypot(bx - this._prevX, bz - this._prevZ);
    if (jump > 50) { this._fail('reset'); return; }
    this._prevX = bx; this._prevZ = bz;

    const tgt = this._target(a);
    const d = Math.hypot(bx - tgt.x, bz - tgt.z);
    if (d < (this._isFinal(a) ? CP_R + 2 : CP_R)) {
      if (this._isFinal(a)) { this._finishRun(); return; }
      a.cp++;
      this._paintCps(a);
      if (this.onEvent) this.onEvent('cp', { index: a.cp, total: this._cpTotal(a) });
    } else if (d > 1200) {
      this._fail('wandered off');
    }
  }

  _target(a) {
    if (a.kind === 'or') return { x: a.rec.fx, z: a.rec.fz };
    return a.cp < a.rec.cps.length ? a.rec.cps[a.cp] : a.rec.cps[a.rec.cps.length - 1];
  }

  _isFinal(a) {
    return a.kind === 'or' ? true : a.cp >= a.rec.cps.length - 1;
  }

  _cpTotal(a) { return a.kind === 'or' ? 1 : a.rec.cps.length; }

  _finishZone(delta) {
    const a = this.active;
    this.active = null;
    if (delta > 0) {
      const res = this.ach.completeChallenge(a.rec.id, a.rec.name, 'sz', delta);
      if (this.onEvent) this.onEvent('finish', { rec: a.rec, score: delta, ...res });
    } else if (this.onEvent) {
      this.onEvent('fail', { rec: a.rec, reason: 'no tricks landed' });
    }
    this._promptId = '';
  }

  _finishRun() {
    const a = this.active;
    this.active = null;
    this.cpGroup.visible = false;
    const res = this.ach.completeChallenge(a.rec.id, a.rec.name, a.kind, a.t);
    if (this.onEvent) this.onEvent('finish', { rec: a.rec, time: a.t, ...res });
    this._promptId = '';
  }

  _fail(reason) {
    const a = this.active;
    this.active = null;
    this.cpGroup.visible = false;
    if (this.onEvent) this.onEvent('fail', { rec: a.rec, reason });
    this._promptId = '';
  }

  cancel() {
    if (this.active) {
      this.active = null;
      this.cpGroup.visible = false;
      this._promptId = '';
    }
  }

  // ---- streaming / markers ---------------------------------------------------

  _refresh(px, pz) {
    this._nearby.length = 0;
    const gather = (cell, fn) => {
      const c0x = Math.floor(px / cell), c0z = Math.floor(pz / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const r = fn.call(this, c0x + dx, c0z + dz);
          if (r) this._nearby.push(r);
        }
      }
    };
    gather(SZ_CELL, this.szCell);
    gather(OR_CELL, this.orCell);
    gather(CT_CELL, this.ctCell);
    // Start flags for the nearest few idle challenges.
    const near = this._nearby
      .map((r) => ({ r, d: Math.hypot(px - r.x, pz - r.z) }))
      .filter((e) => e.d < SHOW_R)
      .sort((x, y) => x.d - y.d)
      .slice(0, this.flagPool.length);
    for (let i = 0; i < this.flagPool.length; i++) {
      const m = this.flagPool[i], e = near[i];
      m.visible = !!e;
      if (e) {
        m.position.set(e.r.x, this.world.getHeight(e.r.x, e.r.z), e.r.z);
        m.rotation.y = (e.r.x * 7.3) % 6.28;
      }
    }
  }

  _placeRunMarkers(rec) {
    // Finish flag + checkpoint rings for the active run only.
    const pts = rec.kind === 'or' ? [{ x: rec.fx, z: rec.fz }] : rec.cps;
    const n = Math.min(pts.length, this.cpMesh.count);
    for (let i = 0; i < this.cpMesh.count; i++) {
      if (i < n) {
        const cp = pts[i];
        _p.set(cp.x, this.world.getHeight(cp.x, cp.z), cp.z);
        _q.setFromAxisAngle(_up, (cp.x * 3.7) % 6.28);
        _m4.compose(_p, _q, _s.set(1, 1, 1));
      } else {
        _m4.compose(_p.set(0, -999, 0), _q.identity(), _s.set(0.001, 0.001, 0.001));
      }
      this.cpMesh.setMatrixAt(i, _m4);
    }
    this.cpMesh.instanceMatrix.needsUpdate = true;
    this.cpGroup.visible = true;
    this._paintCps({ kind: rec.kind, rec, cp: 0 });
  }

  _paintCps(a) {
    const total = a.kind === 'or' ? 1 : a.rec.cps.length;
    for (let i = 0; i < this.cpMesh.count; i++) {
      const final = i === total - 1;
      const c = i >= total ? [0, 0, 0]
        : i < a.cp ? [0.25, 0.6, 0.3]
        : i === a.cp ? (final ? [1.0, 0.35, 0.25] : [1.0, 0.55, 0.1])
        : [0.5, 0.75, 0.95];
      this.cpMesh.instanceColor.setXYZ(i, c[0], c[1], c[2]);
    }
    this.cpMesh.instanceColor.needsUpdate = true;
  }

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
    // Challenge start flag: pole + orange pennant + small base stones.
    const flagParts = [
      color(new THREE.CylinderGeometry(0.07, 0.1, 3.4, 6).translate(0, 1.7, 0), 0.9, 0.87, 0.78),
      color(new THREE.BoxGeometry(1.4, 0.65, 0.05).translate(0.75, 2.95, 0), 1.0, 0.55, 0.12),
      color(new THREE.ConeGeometry(0.55, 0.5, 6).translate(0, 0.25, 0), 0.55, 0.53, 0.5),
    ];
    const flagGeo = mergeGeometries(flagParts.map((g) => g.toNonIndexed()));
    this.flagPool = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(flagGeo, mat);
      m.visible = false;
      scene.add(m);
      this.flagPool.push(m);
    }
    // Checkpoint rings (separate instanced set from the mountain trials).
    const cpParts = [
      color(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6).translate(0, 1.3, 0), 0.9, 0.88, 0.8),
      color(new THREE.TorusGeometry(1.05, 0.1, 6, 14).translate(0, 3.15, 0), 1, 1, 1),
    ];
    const cpGeo = mergeGeometries(cpParts.map((g) => g.toNonIndexed()));
    this.cpMesh = new THREE.InstancedMesh(cpGeo, mat.clone(), 6);
    this.cpMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6 * 3), 3);
    this.cpGroup = new THREE.Group();
    this.cpGroup.add(this.cpMesh);
    this.cpGroup.visible = false;
    scene.add(this.cpGroup);
  }
}
