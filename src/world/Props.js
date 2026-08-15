import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, mulberry32, hashInt } from './noise.js';

/**
 * Props (Phase 3 rebalance) — lightweight exploration props.
 *
 * Seven low-poly prop types, ONE InstancedMesh per type (7 draw calls
 * total), fixed capacities, DynamicDrawUsage: streaming only rewrites
 * instance matrices, never allocates. Placement is a pure deterministic
 * function of the sector ID: SectorWorld hands the active 3x3 sector set
 * to rebuild() whenever the window moves.
 *
 * Placement rules (target: one landmark every 300-600 m of riding):
 *   - lookout platform + prayer flags at every scenic viewpoint
 *   - prayer flag cluster at every pass saddle
 *   - per-sector scatter (4-6 candidates): signposts & resting spots on
 *     roads/trails, cabins on gentle foothill meadows, cave entrances on
 *     steep massif flanks, rock formations anywhere open
 *
 * Cabins, rocks and lookout piers get collision circles (the bike's
 * existing prop-collider system); flags/signs/rest spots are ride-through.
 */

const CAP = { flags: 48, sign: 48, rocks: 64, lookout: 24, cabin: 32, cave: 24, rest: 48 };

export class Props {
  constructor(scene, field) {
    this.field = field;
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this.colliders = [];
    this.count = 0; // active instances (debug)

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const matD = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.types = {
      flags: { geo: buildFlags(), max: CAP.flags, mat: matD, coll: 0 },
      sign: { geo: buildSignpost(), max: CAP.sign, mat, coll: 0 },
      rocks: { geo: buildRocks(), max: CAP.rocks, mat, coll: 2.6 },
      lookout: { geo: buildLookout(), max: CAP.lookout, mat, coll: 0 },
      cabin: { geo: buildCabin(), max: CAP.cabin, mat, coll: 3.2 },
      cave: { geo: buildCave(), max: CAP.cave, mat, coll: 3.0 },
      rest: { geo: buildRest(), max: CAP.rest, mat, coll: 0 },
    };
    this.meshes = {};
    for (const [k, t] of Object.entries(this.types)) {
      const m = new THREE.InstancedMesh(t.geo, t.mat, t.max);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false; // instances span the whole 1.5 km window
      scene.add(m);
      this.meshes[k] = m;
    }
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._sectorCache = new Map(); // "cx,cz" -> prop list (LRU-ish, small)
  }

  /** Deterministic prop list for one 500 m sector. */
  sectorProps(cx, cz) {
    const key = `${cx},${cz}`;
    let list = this._sectorCache.get(key);
    if (list) return list;
    list = [];
    const field = this.field;
    const lf = field.landforms;
    const rng = mulberry32(hashInt(cx, cz, 0x9d2f));
    const ox = cx * 500, oz = cz * 500;

    // Viewpoints in this sector: lookout platform + flags beside the road.
    for (const v of lf.viewpoints) {
      if (v.x < ox || v.x >= ox + 500 || v.z < oz || v.z >= oz + 500) continue;
      const a = hash01(v.x | 0, v.z | 0, 7) * Math.PI * 2;
      // Offset off the road bed (12 m to the overlook side).
      const px = v.x + Math.cos(a) * 12, pz = v.z + Math.sin(a) * 12;
      list.push({ t: 'lookout', x: px, z: pz, y: field.height(px, pz), yaw: a, s: 1 });
      list.push({ t: 'flags', x: px + 6, z: pz + 3, y: field.height(px + 6, pz + 3), yaw: a + 1.2, s: 1 });
    }
    // Pass saddles: prayer flag cluster.
    for (const p of lf.passes) {
      if (p.sx < ox || p.sx >= ox + 500 || p.sz < oz || p.sz >= oz + 500) continue;
      const px = p.sx + 10, pz = p.sz + 8;
      list.push({ t: 'flags', x: px, z: pz, y: field.height(px, pz), yaw: rng() * 6.28, s: 1.15 });
    }

    // Ambient scatter: 5 candidates, terrain-classified.
    const info = this._info;
    for (let i = 0; i < 5; i++) {
      const px = ox + 40 + rng() * 420, pz = oz + 40 + rng() * 420;
      field.sample(px, pz, info);
      const e = 6;
      const sl = Math.hypot(
        field.height(px + e, pz) - field.height(px - e, pz),
        field.height(px, pz + e) - field.height(px, pz - e)
      ) / (2 * e);
      const yaw = rng() * 6.28;
      const r = rng();
      if (info.trail > 0.4 && sl < 0.2) {
        // Beside a road/trail: signpost or resting spot (shifted off the bed).
        const t = r < 0.55 ? 'sign' : 'rest';
        const qx = px + 9, qz = pz + 4;
        list.push({ t, x: qx, z: qz, y: field.height(qx, qz), yaw, s: 0.95 + rng() * 0.2 });
      } else if (info.mtn > 0.65 && sl > 0.28 && r < 0.5) {
        list.push({ t: 'cave', x: px, z: pz, y: field.height(px, pz), yaw, s: 1 + rng() * 0.4 });
      } else if (info.mtn > 0.2 && info.mtn < 0.75 && sl < 0.14 && r < 0.5) {
        list.push({ t: 'cabin', x: px, z: pz, y: field.height(px, pz), yaw, s: 0.95 + rng() * 0.15 });
      } else if (sl < 0.3) {
        list.push({ t: r < 0.7 ? 'rocks' : 'flags', x: px, z: pz, y: field.height(px, pz), yaw, s: 0.8 + rng() * 0.6 });
      }
    }

    if (this._sectorCache.size > 60) this._sectorCache.clear(); // bound memory
    this._sectorCache.set(key, list);
    return list;
  }

  /** Rewrite all instance matrices from the active sector set. */
  rebuild(sectorIds) {
    const counts = {};
    for (const k of Object.keys(this.types)) counts[k] = 0;
    this.colliders.length = 0;
    let total = 0;
    for (const [cx, cz] of sectorIds) {
      const props = this.sectorProps(cx, cz);
      for (const p of props) {
        const t = this.types[p.t];
        const n = counts[p.t];
        if (n >= t.max) continue;
        this._p.set(p.x, p.y, p.z);
        this._e.set(0, p.yaw, 0);
        this._q.setFromEuler(this._e);
        this._s.setScalar(p.s);
        this.meshes[p.t].setMatrixAt(n, this._m.compose(this._p, this._q, this._s));
        counts[p.t] = n + 1;
        total++;
        if (t.coll > 0) this.colliders.push({ x: p.x, z: p.z, r: t.coll * p.s });
      }
    }
    for (const [k, m] of Object.entries(this.meshes)) {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    }
    this.count = total;
  }
}

// ---- Low-poly geometry builders (merged, vertex-colored) --------------------

function colored(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function box(w, h, d, x, y, z, r, g, b, ry = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (ry) geo.rotateY(ry);
  geo.translate(x, y, z);
  return colored(geo, r, g, b);
}

/** Prayer flag cluster: two poles + a sagging line of 5 colored flags. */
function buildFlags() {
  const parts = [];
  parts.push(box(0.12, 3.4, 0.12, -2.2, 1.7, 0, 0.42, 0.32, 0.22));
  parts.push(box(0.12, 2.9, 0.12, 2.2, 1.45, 0, 0.42, 0.32, 0.22));
  const cols = [[0.2, 0.45, 0.9], [0.9, 0.85, 0.2], [0.85, 0.2, 0.2], [0.95, 0.95, 0.95], [0.2, 0.7, 0.3]];
  for (let i = 0; i < 5; i++) {
    const t = (i + 0.5) / 5;
    const x = -2.2 + t * 4.4;
    const y = 3.1 - Math.sin(Math.PI * t) * 0.5 - t * 0.4;
    const g = new THREE.PlaneGeometry(0.55, 0.42);
    g.translate(x, y, 0);
    const c = cols[i];
    parts.push(colored(g, c[0], c[1], c[2]));
  }
  return mergeGeometries(parts);
}

/** Wooden signpost: post + two arrow boards. */
function buildSignpost() {
  const parts = [];
  parts.push(box(0.16, 2.4, 0.16, 0, 1.2, 0, 0.4, 0.3, 0.2));
  parts.push(box(1.3, 0.3, 0.08, 0.35, 1.95, 0, 0.55, 0.42, 0.28, 0.15));
  parts.push(box(1.1, 0.28, 0.08, -0.3, 1.55, 0, 0.5, 0.38, 0.25, -0.4));
  return mergeGeometries(parts);
}

/** Rock formation: 4 tilted boxes in a cluster. */
function buildRocks() {
  const parts = [];
  const spec = [
    [2.4, 2.0, 1.8, 0, 0.7, 0, 0.35], [1.5, 1.3, 1.4, 1.6, 0.4, 0.7, 1.1],
    [1.1, 0.9, 1.2, -1.4, 0.3, 0.9, 2.2], [0.9, 0.7, 0.8, 0.4, 0.25, -1.3, 0.6],
  ];
  for (const [w, h, d, x, y, z, ry] of spec) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(ry);
    g.rotateZ(0.12 * ry);
    g.translate(x, y, z);
    parts.push(colored(g, 0.47, 0.44, 0.4));
  }
  return mergeGeometries(parts);
}

/** Lookout platform: wooden deck on posts + railing. */
function buildLookout() {
  const parts = [];
  parts.push(box(3.2, 0.18, 2.4, 0, 0.62, 0, 0.5, 0.37, 0.23)); // deck
  for (const [x, z] of [[-1.4, -1], [1.4, -1], [-1.4, 1], [1.4, 1]]) {
    parts.push(box(0.16, 0.65, 0.16, x, 0.31, z, 0.38, 0.28, 0.18));   // legs
    parts.push(box(0.12, 0.95, 0.12, x, 1.15, z, 0.42, 0.31, 0.2));    // rail posts
  }
  parts.push(box(3.2, 0.1, 0.1, 0, 1.6, -1, 0.45, 0.34, 0.22));  // rails
  parts.push(box(3.2, 0.1, 0.1, 0, 1.6, 1, 0.45, 0.34, 0.22));
  parts.push(box(0.1, 0.1, 2.0, -1.55, 1.6, 0, 0.45, 0.34, 0.22));
  parts.push(box(0.1, 0.1, 2.0, 1.55, 1.6, 0, 0.45, 0.34, 0.22));
  return mergeGeometries(parts);
}

/** Small abandoned cabin: walls + gable roof + dark door. */
function buildCabin() {
  const parts = [];
  parts.push(box(3.6, 2.1, 2.8, 0, 1.05, 0, 0.46, 0.35, 0.24)); // walls
  const roof = new THREE.ConeGeometry(2.75, 1.5, 4);
  roof.rotateY(Math.PI / 4);
  roof.scale(1.18, 1, 0.92);
  roof.translate(0, 2.85, 0);
  parts.push(colored(roof, 0.32, 0.24, 0.17));
  parts.push(box(0.75, 1.5, 0.1, 0.7, 0.75, 1.42, 0.12, 0.09, 0.07)); // door
  parts.push(box(0.6, 0.6, 0.1, -0.9, 1.3, 1.42, 0.1, 0.12, 0.15));  // window
  return mergeGeometries(parts);
}

/** Cave entrance: rock lintel + dark opening against the slope. */
function buildCave() {
  const parts = [];
  parts.push(box(3.4, 1.1, 1.6, 0, 2.35, -0.4, 0.4, 0.38, 0.34));  // lintel
  parts.push(box(1.2, 2.2, 1.4, -1.7, 1.1, -0.3, 0.42, 0.4, 0.36)); // jambs
  parts.push(box(1.2, 2.2, 1.4, 1.7, 1.1, -0.3, 0.42, 0.4, 0.36));
  const mouth = new THREE.CircleGeometry(1.15, 10, 0, Math.PI);
  mouth.translate(0, 0.85, 0.42);
  parts.push(colored(mouth, 0.03, 0.03, 0.045)); // dark opening
  return mergeGeometries(parts);
}

/** Resting spot: log bench + stone fire ring. */
function buildRest() {
  const parts = [];
  const log = new THREE.CylinderGeometry(0.24, 0.24, 2.6, 7);
  log.rotateZ(Math.PI / 2);
  log.translate(0, 0.26, -1.1);
  parts.push(colored(log, 0.44, 0.33, 0.22));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(box(0.34, 0.26, 0.3, Math.cos(a) * 0.7, 0.13, Math.sin(a) * 0.7 + 0.5,
      0.42, 0.4, 0.38, a));
  }
  return mergeGeometries(parts);
}
