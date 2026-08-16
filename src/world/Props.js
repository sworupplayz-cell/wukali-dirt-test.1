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
 *   - Chapter 5 ground-detail scatter: clustered stones, scree patches
 *     and spires between the landmarks (existing models, no new draws)
 *
 * Cabins, rocks and lookout piers get collision circles (the bike's
 * existing prop-collider system); flags/signs/rest spots are ride-through.
 */

// Footprint half-extent for ground seating (metres, scaled by s).
const FOOT = { flags: 2.2, sign: 0.4, lookout: 1.7, cabin: 1.9, cave: 1.8,
  rest: 1.3, bench: 1.0, bridge: 1.8, arch: 3.4, fence: 3.1, marker: 0.2,
  rocks: 1.6, boulder: 1.2, slab: 1.7, spire: 1.1, scree: 1.3 };

const CAP = { flags: 48, sign: 48, lookout: 24, cabin: 32, cave: 24,
  rest: 48, bench: 32, bridge: 16, arch: 8, fence: 96, marker: 64,
  // Chapter 3B: 5 reusable rock models (sizes/colors), instanced.
  // Chapter 5: raised for the clustered ground-detail scatter — instance
  // capacity is a few hundred bytes of matrix each, and the draw-call
  // count does not move (still one InstancedMesh per model).
  rocks: 96, boulder: 64, slab: 56, spire: 32, scree: 128 };

export class Props {
  constructor(scene, field) {
    this.field = field;
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this.colliders = [];
    this.count = 0; // active instances (debug)

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const matD = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.types = {
      // coll: single-circle radius (legacy). shape: list of LOCAL
      // [x, z, r] circles rotated by yaw & scaled by s — Chapter 3D
      // Engine Beta gives EVERY prop proper collision while keeping
      // rideable openings (arch gate, bridge deck) open.
      flags: { geo: buildFlags(), max: CAP.flags, mat: matD,
        shape: [[-2.2, 0, 0.3], [2.2, 0, 0.3]] },            // the two poles
      sign: { geo: buildSignpost(), max: CAP.sign, mat, shape: [[0, 0, 0.32]] },
      rocks: { geo: buildRocks(), max: CAP.rocks, mat, coll: 2.6 },
      boulder: { geo: buildBoulder(), max: CAP.boulder, mat, coll: 2.2 },
      slab: { geo: buildSlab(), max: CAP.slab, mat, coll: 2.4 },
      spire: { geo: buildSpire(), max: CAP.spire, mat, coll: 1.4 },
      scree: { geo: buildScree(), max: CAP.scree, mat, coll: 0 }, // ride-over gravel
      lookout: { geo: buildLookout(), max: CAP.lookout, mat,
        shape: [[-1.4, -1, 0.35], [1.4, -1, 0.35], [-1.4, 1, 0.35], [1.4, 1, 0.35]] }, // legs
      cabin: { geo: buildCabin(), max: CAP.cabin, mat, coll: 3.2 },
      // Chapter 4R cave collision: the rock jambs are solid walls (two
      // circles each so there is no gap at any scale) but the sculpted
      // mouth between them stays OPEN — the entrance is real, not a
      // painted-on facade behind an invisible wall.
      cave: { geo: buildCave(), max: CAP.cave, mat,
        shape: [[-1.7, -0.3, 0.85], [-2.1, 0.3, 0.7],
                [1.7, -0.3, 0.85], [2.1, 0.3, 0.7]] },
      rest: { geo: buildRest(), max: CAP.rest, mat,
        shape: [[0, -1.1, 0.5], [0, 0.5, 0.8]] },            // log + fire ring
      bench: { geo: buildBench(), max: CAP.bench, mat, shape: [[0, 0, 0.9]] },
      bridge: { geo: buildBridge(), max: CAP.bridge, mat,
        // Chapter 4R: FULL rail runs collide (posts + mid-rail fillers) —
        // the deck stays rideable end-to-end, but the bike can no longer
        // slip sideways through the gap between rail posts.
        shape: [[-1.75, -1.62, 0.3], [-0.85, -1.62, 0.45], [0, -1.62, 0.45],
                [0.85, -1.62, 0.45], [1.75, -1.62, 0.3],
                [-1.75, 1.62, 0.3], [-0.85, 1.62, 0.45], [0, 1.62, 0.45],
                [0.85, 1.62, 0.45], [1.75, 1.62, 0.3]] },
      arch: { geo: buildArch(), max: CAP.arch, mat,
        shape: [[-3.2, 0, 1.15], [3.2, 0, 1.15]] },          // pillars; gate rideable
      fence: { geo: buildFence(), max: CAP.fence, mat,
        shape: [[-2.6, 0, 0.55], [-1.3, 0, 0.55], [0, 0, 0.55],
                [1.3, 0, 0.55], [2.6, 0, 0.55]] },           // solid 6 m run
      marker: { geo: buildMarker(), max: CAP.marker, mat, shape: [[0, 0, 0.22]] },
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

    // Rider's Meadow fixtures (handcrafted: signpost, cabin, flags, benches).
    for (const fx of lf.meadowFixtures) {
      if (fx.x < ox || fx.x >= ox + 500 || fx.z < oz || fx.z >= oz + 500) continue;
      list.push({ t: fx.t, x: fx.x, z: fx.z, y: field.height(fx.x, fx.z), yaw: fx.yaw, s: fx.s });
    }

    // Destination landmarks (Chapter 3A): each named road's reward.
    if (lf.destinations) {
      for (const d of lf.destinations) {
        if (d.x < ox || d.x >= ox + 500 || d.z < oz || d.z >= oz + 500) continue;
        d.props.forEach((t, n) => {
          const a = hash01(d.x | 0, (d.z | 0) + n * 37, 13) * Math.PI * 2;
          const r2 = n === 0 ? 0 : 7 + n * 5;
          let px = d.x + Math.cos(a) * r2, pz = d.z + Math.sin(a) * r2;
          // Keep secondary props off the road bed (primary marks the spot).
          if (n > 0 && lf.roadDist(px, pz) < 7) {
            px = d.x - Math.cos(a) * r2; pz = d.z - Math.sin(a) * r2;
            if (lf.roadDist(px, pz) < 7) return;
          }
          list.push({ t, x: px, z: pz, y: field.height(px, pz), yaw: a + 1.1, s: t === 'arch' ? 1.4 : 1 });
        });
      }
    }

    // Road-side micro details (Chapter 3A): fences on outer curve edges,
    // trail markers on singletrack, spaced along the laid road vertices
    // that fall inside this sector (deterministic per-vertex hash).
    if (lf._rx) {
      for (let i = 0; i < lf._rx.length; i += 6) {
        const rx = lf._rx[i], rz = lf._rz[i];
        if (rx < ox || rx >= ox + 500 || rz < oz || rz >= oz + 500) continue;
        const h = hash01(i, 0, 0x33aa);
        if (h > 0.34) continue; // ~1 per 280 m of road
        const j = Math.min(lf._rx.length - 1, i + 1);
        if (lf._rid[j] !== lf._rid[i]) continue;
        const dx2 = lf._rx[j] - rx, dz2 = lf._rz[j] - rz;
        const l2 = Math.hypot(dx2, dz2);
        if (l2 < 1) continue;
        const nx2 = -dz2 / l2, nz2 = dx2 / l2;
        const side = h < 0.17 ? 1 : -1;
        const off = lf._rw[i] + 2.2;
        const px = rx + nx2 * off * side, pz = rz + nz2 * off * side;
        const t = lf._rt[i] === 4 ? 'marker' : (h * 3) % 1 < 0.6 ? 'fence' : 'marker';
        list.push({ t, x: px, z: pz, y: field.height(px, pz),
          yaw: Math.atan2(dx2, dz2), s: 1 });
      }
    }

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

    // Ambient scatter: 6 candidates, terrain-classified (~1 landmark per
    // 300-500 m of riding).
    const info = this._info;
    for (let i = 0; i < 6; i++) {
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
        // Beside a road/trail: signpost, resting spot, scenic bench or a
        // short wooden bridge deck over the trail dip. Chapter 4 fix:
        // solid roadside items only place where the offset spot is
        // clear of EVERY laid road bed (colliders never block a road).
        const t = r < 0.4 ? 'sign' : r < 0.65 ? 'rest' : r < 0.85 ? 'bench' : 'bridge';
        if (t === 'bridge') {
          list.push({ t, x: px, z: pz, y: field.height(px, pz) - 0.1, yaw, s: 1 });
        } else {
          const qx = px + 9, qz = pz + 4;
          if (lf.roadDist(qx, qz) > 7.5) {
            list.push({ t, x: qx, z: qz, y: field.height(qx, qz), yaw, s: 0.95 + rng() * 0.2 });
          }
        }
      } else if (info.mtn > 0.65 && sl > 0.28 && r < 0.5 && lf.roadDist(px, pz) > 12) {
        list.push({ t: 'cave', x: px, z: pz, y: field.height(px, pz), yaw, s: 1 + rng() * 0.4 });
      } else if (info.mtn > 0.2 && info.mtn < 0.75 && sl < 0.14 && r < 0.5 && lf.roadDist(px, pz) > 14) {
        list.push({ t: 'cabin', x: px, z: pz, y: field.height(px, pz), yaw, s: 0.95 + rng() * 0.15 });
      } else if (sl < 0.3 && lf.roadDist(px, pz) > 12) {
        const rockKind = r < 0.3 ? 'rocks' : r < 0.45 ? 'boulder' : r < 0.6 ? 'slab'
          : r < 0.68 ? 'spire' : r < 0.82 ? 'scree' : 'flags';
        list.push({ t: rockKind, x: px, z: pz, y: field.height(px, pz), yaw, s: 0.8 + rng() * 0.6 });
      }
    }

    // Chapter 5 — GROUND DETAIL scatter. The world felt empty because
    // everything placed so far is a landmark: one object every 300-500 m
    // with nothing in between. This second pass fills the space with the
    // small stuff real terrain is covered in — stone groups, gravel
    // patches, the odd spire — reusing the EXISTING instanced rock
    // models, so it costs zero extra draw calls. Everything is placed in
    // CLUSTERS (a big stone with two or three smaller companions), which
    // is what makes scatter read as natural rather than sprinkled.
    for (let i = 0; i < 9; i++) {
      const px = ox + 25 + rng() * 450, pz = oz + 25 + rng() * 450;
      field.sample(px, pz, info);
      const yaw = rng() * 6.28;
      const r = rng();
      if (info.h < 58) continue;           // beach and seabed stay clean
      if (info.trail > 0.25) continue;     // never on a road bed
      if (lf.roadDist(px, pz) < 6.5) continue;
      const e = 5;
      const sl = Math.hypot(
        field.height(px + e, pz) - field.height(px - e, pz),
        field.height(px, pz + e) - field.height(px, pz - e)
      ) / (2 * e);
      if (sl > 0.62) continue;             // sheer faces keep clean lines
      let t;
      if (info.mtn > 0.45) {
        // Alpine: shattered rock, scree fans, the occasional spire.
        t = r < 0.42 ? 'scree' : r < 0.72 ? 'rocks' : r < 0.9 ? 'slab' : 'spire';
      } else if (sl > 0.22) {
        t = r < 0.5 ? 'rocks' : r < 0.8 ? 'boulder' : 'scree';
      } else {
        t = r < 0.45 ? 'rocks' : r < 0.7 ? 'boulder' : r < 0.85 ? 'scree' : 'slab';
      }
      const s0 = 0.5 + rng() * 0.55;
      list.push({ t, x: px, z: pz, y: field.height(px, pz), yaw, s: s0 });
      const n = rng() < 0.55 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const a = rng() * 6.28, d = 2.4 + rng() * 4.6;
        const qx = px + Math.cos(a) * d, qz = pz + Math.sin(a) * d;
        if (lf.roadDist(qx, qz) < 6) continue;
        list.push({
          t: rng() < 0.45 ? 'scree' : t,
          x: qx, z: qz, y: field.height(qx, qz),
          yaw: rng() * 6.28, s: s0 * (0.42 + rng() * 0.38),
        });
      }
    }

    if (this._sectorCache.size > 60) this._sectorCache.clear(); // bound memory
    this._sectorCache.set(key, list);
    return list;
  }

  /** Ground seating: lowest ground across the footprint, slightly sunk —
   *  a prop can never float off a slope or hover on a bump crest. */
  _groundY(p) {
    const f = this.field;
    const r = (FOOT[p.t] || 1) * (p.s || 1);
    const c = f.height(p.x, p.z);
    let y = Math.min(c,
      f.height(p.x + r, p.z), f.height(p.x - r, p.z),
      f.height(p.x, p.z + r), f.height(p.x, p.z - r));
    // Cliff-side cap: never sink more than 1/3 of the footprint below
    // the center sample — on genuinely steep flanks the prop half-buries
    // uphill instead of dropping into the void downhill.
    if (y < c - r * 0.35) y = c - r * 0.35;
    return y - 0.08;
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
        // Chapter 5: seat height is a pure function of the prop, so cache
        // it on the record — the window rebuild used to re-sample the
        // terrain five times per prop (about 1,400 height queries) every
        // time the player crossed a sector line.
        if (p.gy === undefined) p.gy = this._groundY(p);
        this._p.set(p.x, p.gy, p.z);
        this._e.set(0, p.yaw, 0);
        this._q.setFromEuler(this._e);
        this._s.setScalar(p.s);
        this.meshes[p.t].setMatrixAt(n, this._m.compose(this._p, this._q, this._s));
        counts[p.t] = n + 1;
        total++;
        if (t.shape) {
          const c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
          for (const [lx, lz, lr] of t.shape) {
            // Match the instance transform: rotateY(yaw) then translate.
            const wx = p.x + (lx * c + lz * sn) * p.s;
            const wz = p.z + (-lx * sn + lz * c) * p.s;
            this.colliders.push({ x: wx, z: wz, r: lr * p.s });
          }
        } else if (t.coll > 0) {
          this.colliders.push({ x: p.x, z: p.z, r: t.coll * p.s });
        }
      }
    }
    for (const [k, m] of Object.entries(this.meshes)) {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    }
    this.count = total;
    this.collVersion = (this.collVersion || 0) + 1;
  }
}

// ---- Low-poly geometry builders (merged, vertex-colored) --------------------

function colored(geo, r, g, b) {
  if (geo.index) geo = geo.toNonIndexed(); // icosahedrons are non-indexed
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

/** Boulder: one big rounded granite block, warm grey. */
function buildBoulder() {
  const g = new THREE.IcosahedronGeometry(1.7, 0);
  g.scale(1.15, 0.85, 1.0);
  g.translate(0, 0.95, 0);
  return colored(g, 0.52, 0.48, 0.43);
}

/** Slab: tilted flat sandstone sheets, reddish. */
function buildSlab() {
  const parts = [];
  const spec = [[3.2, 0.6, 2.2, 0, 0.5, 0, 0.18], [2.4, 0.5, 1.8, 0.5, 1.0, 0.3, 0.34], [1.7, 0.4, 1.3, -0.4, 1.45, -0.2, 0.5]];
  for (const [w, h, d, x, y, z, rz] of spec) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateZ(rz);
    g.rotateY(rz * 2.2);
    g.translate(x, y, z);
    parts.push(colored(g, 0.56, 0.44, 0.36));
  }
  return mergeGeometries(parts);
}

/** Spire: tall narrow basalt finger, dark. */
function buildSpire() {
  const g = new THREE.ConeGeometry(0.9, 4.2, 5);
  g.translate(0, 2.0, 0);
  const b = new THREE.CylinderGeometry(1.1, 1.35, 0.9, 5);
  b.translate(0, 0.45, 0);
  return mergeGeometries([colored(g, 0.33, 0.32, 0.34), colored(b, 0.38, 0.37, 0.38)]);
}

/** Scree: low spread of small pale stones (ride-over, no collider). */
function buildScree() {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    const r = 0.18 + ((i * 37) % 10) * 0.03;
    const g = new THREE.IcosahedronGeometry(r, 0);
    const a = i * 0.785;
    g.translate(Math.cos(a) * (0.5 + (i % 3) * 0.5), r * 0.55, Math.sin(a) * (0.5 + ((i + 1) % 3) * 0.5));
    parts.push(colored(g, 0.62, 0.59, 0.53));
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

/** Scenic bench: plank seat + back on two supports. */
function buildBench() {
  const parts = [];
  parts.push(box(1.9, 0.09, 0.5, 0, 0.46, 0, 0.5, 0.38, 0.24));      // seat
  parts.push(box(1.9, 0.42, 0.08, 0, 0.78, -0.24, 0.48, 0.36, 0.23)); // back
  parts.push(box(0.12, 0.46, 0.5, -0.8, 0.23, 0, 0.38, 0.28, 0.18));  // legs
  parts.push(box(0.12, 0.46, 0.5, 0.8, 0.23, 0, 0.38, 0.28, 0.18));
  return mergeGeometries(parts);
}

/** Short wooden bridge deck: planks + two side rails (ride-through). */
function buildBridge() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    parts.push(box(0.52, 0.09, 3.4, -1.7 + 0.55 * i, 0.06, 0, 0.48, 0.36, 0.22));
  }
  parts.push(box(3.9, 0.12, 0.14, 0, 0.5, -1.62, 0.42, 0.31, 0.19)); // rails
  parts.push(box(3.9, 0.12, 0.14, 0, 0.5, 1.62, 0.42, 0.31, 0.19));
  for (const zx of [-1.75, 1.75]) {
    for (const zz of [-1.62, 1.62]) {
      parts.push(box(0.14, 0.52, 0.14, zx, 0.26, zz, 0.4, 0.29, 0.18));
    }
  }
  return mergeGeometries(parts);
}

/** Stone arch: two rough pillars + capstones (wide enough to ride through). */
function buildArch() {
  const parts = [];
  for (const sx of [-3.2, 3.2]) {
    parts.push(box(1.5, 4.6, 1.7, sx, 2.3, 0, 0.46, 0.43, 0.39));
    parts.push(box(1.9, 0.8, 2.1, sx, 4.7, 0, 0.43, 0.40, 0.36));
  }
  parts.push(box(7.6, 1.0, 1.8, 0, 5.4, 0, 0.48, 0.45, 0.41));  // lintel
  parts.push(box(2.6, 0.7, 1.5, 0, 6.1, 0, 0.44, 0.41, 0.37));  // crown
  return mergeGeometries(parts);
}

/** Wooden fence: 3 posts + 2 rails, one 6 m run. */
function buildFence() {
  const parts = [];
  for (const px of [-3, 0, 3]) {
    parts.push(box(0.14, 1.05, 0.14, px, 0.52, 0, 0.4, 0.3, 0.19));
  }
  parts.push(box(6.2, 0.12, 0.09, 0, 0.88, 0, 0.46, 0.35, 0.22));
  parts.push(box(6.2, 0.12, 0.09, 0, 0.5, 0, 0.44, 0.33, 0.21));
  return mergeGeometries(parts);
}

/** Trail marker: short post with a painted top band. */
function buildMarker() {
  const parts = [];
  parts.push(box(0.14, 1.15, 0.14, 0, 0.57, 0, 0.42, 0.32, 0.2));
  parts.push(box(0.16, 0.18, 0.16, 0, 1.2, 0, 0.9, 0.35, 0.15)); // red band
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
