import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, mulberry32, hashInt, sstep, vnoise } from './noise.js';

/**
 * Vegetation (Chapter 3B) — stylized low-poly trees & ground cover.
 *
 * 10 plant types, ONE InstancedMesh per type per LOD level. Placement is
 * a pure deterministic function of the 125 m cell ID; a ChunkGrid-style
 * window in SectorWorld triggers rebuild() when the player crosses a
 * cell. Instancing only — placement rewrites matrices, never allocates.
 *
 * LOD + distance culling:
 *   near ring (<= 250 m): full models (canopy + trunk)
 *   far ring  (<= 560 m): trees swap to a 2-triangle cone impostor of
 *                         matching color; ground cover culls entirely.
 * Both rings rebuild from the same deterministic lists, so a plant never
 * moves — it only changes representation. New instances always appear
 * at the window edge, deep inside the fog haze (no visible popping).
 *
 * Species by biome (analytic field masks, no new terrain queries beyond
 * one sample per candidate at placement time):
 *   pine/fir     — mountain foothills & the Glacier belt (300-900 m)
 *   birch/oak    — lowland moist meadows
 *   dead tree    — dry scrub and high rocky slopes
 *   bush/fern    — forest floor + road fringes
 *   grass patch / flowers — open lowland (never on roads)
 * Vertex-colored with painted variation; no textures on vegetation.
 */

const CELL = 125;
const NEAR_R = 2;   // 5x5 cells full detail  (~312 m)
const FAR_R = 4;    // 9x9 cells impostors    (~562 m)
const CKEY = 65536;        // integer cell-cache key stride
const CELL_BUDGET_MS = 0.8; // Chapter 5: per-frame plant-generation budget
const VEG_STAGGER = 5;      // frames to wait behind the terrain tile fill
const nowMs = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() : () => Date.now();

// Per-type instance capacities (near / far pools).
const TYPES = ['pine', 'fir', 'birch', 'oak', 'dead', 'bush', 'fern', 'grass', 'flower', 'shrub'];
// Trunk collision radius per type (0 = ride-through ground cover).
const COLL = { pine: 0.42, fir: 0.36, birch: 0.34, oak: 0.55, dead: 0.38,
  bush: 0, fern: 0, grass: 0, flower: 0, shrub: 0 };
const CAP_NEAR = { pine: 340, fir: 260, birch: 200, oak: 160, dead: 90, bush: 260, fern: 220, grass: 420, flower: 260, shrub: 200 };
const CAP_FAR = { pine: 950, fir: 750, birch: 550, oak: 420, dead: 260 };

export class Vegetation {
  constructor(scene, field) {
    this.field = field;
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this.visibleNear = 0;
    this.visibleFar = 0;
    this.colliders = []; // near-ring tree trunks (bike prop-collision)

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const matD = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    this._near = {};
    for (const t of TYPES) {
      const geo = GEO_BUILDERS[t]();
      const m = new THREE.InstancedMesh(geo, t === 'grass' || t === 'flower' || t === 'fern' ? matD : mat, CAP_NEAR[t]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true; // only renders into the map when shadows are on
      scene.add(m);
      this._near[t] = m;
    }
    this._far = {};
    for (const t of Object.keys(CAP_FAR)) {
      const m = new THREE.InstancedMesh(buildImpostor(t), mat, CAP_FAR[t]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
      this._far[t] = m;
    }

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._cellCache = new Map();
    this._pcx = null;
    this._pcz = null;
    this._density = 1;   // Chapter 3C: fraction of plants kept
    this._farR = FAR_R;  // Chapter 3C: impostor ring radius (cells)
  }

  /** Graphics quality hook: density in [0,1] + far ring radius (cells). */
  setQuality(density, farR) {
    if (density === this._density && farR === this._farR) return;
    this._density = density;
    this._farR = Math.max(NEAR_R, Math.min(FAR_R, farR));
    if (this._pcx !== null) this._rebuild(this._pcx, this._pcz, Infinity);
  }

  /** Per-frame: rebuild instance lists when the player crosses a cell;
   *  animate the grow-in scale of plants that just switched to the near
   *  ring (smooth LOD transition instead of an abrupt swap). */
  update(px, pz) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    if (cx !== this._pcx || cz !== this._pcz) {
      // Chapter 5: a boundary crossing used to price ~17 brand-new cell
      // lists (each one terrain-samples ~35 candidates) into ONE frame —
      // a 10-20 ms stall on a phone, right in the middle of riding. The
      // window now fills under a time budget over as many frames as it
      // needs; plants that are not placed yet simply grow in a frame or
      // two later, which the LOD grow-in animation already covers.
      // A TELEPORT (or the first fill) still completes immediately: the
      // screen is behind the loading overlay or the player just moved
      // somewhere entirely new, so nothing must be missing.
      const jump = this._pcx === null ? 99
        : Math.max(Math.abs(cx - this._pcx), Math.abs(cz - this._pcz));
      this._pcx = cx; this._pcz = cz;
      if (jump > 1) {
        this._rebuild(cx, cz, Infinity);
      } else {
        // Terrain tiles use the SAME 125 m grid, so a crossing used to
        // bill new tiles AND new plants to one frame. Plants wait a few
        // frames for the tile ring to finish first — invisible (the LOD
        // grow-in already fades them in) and it halves the worst frame.
        this._pending = true;
        this._delay = VEG_STAGGER;
      }
    } else if (this._pending) {
      if (this._delay > 0) this._delay--;
      else this._rebuild(cx, cz, CELL_BUDGET_MS);
    }
    if (this._growing && this._growing.length > 0) this._stepGrow();
  }

  /** Advance grow-in animations (a few matrix rewrites per frame, no allocs). */
  _stepGrow() {
    const now = performance.now();
    let write = 0;
    for (let i = 0; i < this._growing.length; i++) {
      const g = this._growing[i];
      const t = (now - g.t0) / 450;
      const mesh = this._near[g.type];
      if (g.slot >= mesh.count) continue; // ring rebuilt since; drop
      const k = t >= 1 ? 1 : 1 - (1 - t) * (1 - t); // ease-out
      this._p.set(g.p.x, g.p.y, g.p.z);
      this._e.set(0, g.p.yaw, 0);
      this._q.setFromEuler(this._e);
      this._s.setScalar(g.p.s * (0.25 + 0.75 * k));
      mesh.setMatrixAt(g.slot, this._m.compose(this._p, this._q, this._s));
      mesh.instanceMatrix.needsUpdate = true;
      if (t < 1) this._growing[write++] = g;
    }
    this._growing.length = write;
  }

  /** Cached plant list for one 125 m cell, or null when it has not been
   *  generated yet and `build` is false (the amortized window fill). */
  _cellPlants(cx, cz, build = true) {
    const hit = this._cellCache.get(cx * CKEY + cz);
    if (hit) return hit;
    if (!build) return null;
    const job = this._startCell(cx, cz);
    while (!this._stepCell(job)) { /* generate the whole cell now */ }
    return this._cacheCell(job);
  }

  /**
   * Chapter 5: cell generation is RESUMABLE at candidate granularity.
   * One dense forest cell is ~24 candidates and every candidate costs a
   * terrain sample, a road-distance query and several height probes — on
   * a phone that is several milliseconds, i.e. a visible hitch if it all
   * lands on one frame. `_advanceCell` does as many candidates as the
   * frame budget allows and remembers where it stopped.
   */
  _startCell(cx, cz) {
    // Forest density field: patchy woods, not uniform speckle.
    const forest = vnoise(cx * 0.17 + 3.7, cz * 0.17 - 8.1, 4441);
    const nTrees = forest > 0.38 ? (3 + (forest - 0.38) * 26) | 0 : 0;
    const nGround = 5;
    return {
      cx, cz, key: cx * CKEY + cz,
      ox: cx * CELL, oz: cz * CELL,
      rng: mulberry32(hashInt(cx, cz, 0x7e93)),
      forest, nTrees, total: nTrees + nGround,
      i: 0, list: [],
    };
  }

  /** Evaluate ONE placement candidate. Returns true when the cell is done. */
  _stepCell(job) {
    const f = this.field;
    const lf = f.landforms;
    const info = this._info;
    const rng = job.rng;
    const { ox, oz, forest, nTrees } = job;
    const i = job.i++;
    const x = ox + 6 + rng() * (CELL - 12), z = oz + 6 + rng() * (CELL - 12);
    if (x >= 30 && x <= 7970 && z >= 30 && z <= 4970) {
      f.sample(x, z, info);
      const h = info.h;
      // No vegetation on the beach / under the sea; keep clear of
      // roads/trails, the groomed meadow core and the lake.
      const dMeadow = Math.hypot(x - 4000, z - 2500);
      // Chapter 6 elevation rebuild: the tree line, the conifer belt and
      // the shoreline cut-off all move with the new terrain band. 47 m is
      // just above the inland floor; the beach strip (z > 4420) stays
      // bare sand.
      const shore = z > 4420 && h < 66;
      if (h >= 47 && !shore && info.trail <= 0.02 && dMeadow >= 240 && lf.roadDist(x, z) >= 11) {
        // Slope: no trees on cliffs.
        const e = 5;
        const sl = Math.hypot(f.height(x + e, z) - f.height(x - e, z),
          f.height(x, z + e) - f.height(x, z - e)) / (2 * e);
        if (sl <= 0.55) {
          const r = rng(), rr = rng();
          const isTree = i < nTrees;
          let t = null, s = 1, ok = true;
          if (isTree) {
            if (h > 1250) ok = false; // above the tree line
            else {
              if (h > 150) {
                // Foothill conifer belt (starts at the first rise now).
                t = h > 620 && r < 0.3 ? 'dead' : r < 0.55 ? 'pine' : 'fir';
              } else {
                // Lowland broadleaf.
                t = r < 0.4 ? 'birch' : r < 0.7 ? 'oak' : rr < 0.5 ? 'pine' : 'bush';
              }
              if (info.moist < 0.25 && rr < 0.35) t = 'dead';
              s = 1.15 + rng() * 0.75;
            }
          } else if (h > 900 || sl > 0.4) {
            ok = false;
          } else {
            // Ground cover: grass/flowers in the open, ferns/shrubs in woods.
            if (forest > 0.5) t = r < 0.5 ? 'fern' : r < 0.8 ? 'bush' : 'shrub';
            else t = r < 0.5 ? 'grass' : r < 0.75 ? 'flower' : 'shrub';
            s = 0.75 + rng() * 0.5;
          }
          if (ok && t) {
            // Seat on the LOWEST nearby ground so trunks never float on
            // slopes (the models sink a few cm into the hill instead).
            const rF = isTree ? 0.9 : 0.5;
            const y = Math.min(h,
              f.height(x + rF, z), f.height(x - rF, z),
              f.height(x, z + rF), f.height(x, z - rF)) - 0.06 * s;
            job.list.push({ t, x, z, y, yaw: rng() * 6.283, s, tree: isTree });
          }
        }
      }
    }
    return job.i >= job.total;
  }

  /** Store a finished cell job in the LRU cache and return its list. */
  _cacheCell(job) {
    // LRU-ish bound: drop the OLDEST entries instead of wiping the whole
    // cache (a full clear meant every cell around the player had to be
    // regenerated on the very next crossing).
    if (this._cellCache.size > 420) {
      let drop = 80;
      for (const k of this._cellCache.keys()) {
        this._cellCache.delete(k);
        if (--drop <= 0) break;
      }
    }
    this._cellCache.set(job.key, job.list);
    return job.list;
  }

  /** Resume or start one cell under the frame budget; null if unfinished. */
  _advanceCell(cx, cz, budgetMs, t0) {
    let job = this._job;
    if (!job || job.cx !== cx || job.cz !== cz) {
      if (nowMs() - t0 >= budgetMs) return null;
      job = this._job = this._startCell(cx, cz);
    }
    while (!this._stepCell(job)) {
      if (nowMs() - t0 >= budgetMs) return null;
    }
    this._job = null;
    return this._cacheCell(job);
  }

  _rebuild(cx, cz, budgetMs = Infinity) {
    // Track which near cells are NEW this rebuild: their trees grow in.
    const prevCells = this._nearCells || new Set();
    const nowCells = new Set();
    const t0 = budgetMs === Infinity ? 0 : nowMs();
    if (budgetMs === Infinity) this._job = null; // drop any partial job
    let pending = false;
    if (!this._growing) this._growing = [];
    const nearCounts = {}, farCounts = {};
    for (const t of TYPES) nearCounts[t] = 0;
    for (const t of Object.keys(CAP_FAR)) farCounts[t] = 0;
    this.colliders.length = 0;

    const R = this._farR;
    const den = this._density;
    const growNow = performance.now();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const nearRing = Math.max(Math.abs(dx), Math.abs(dz)) <= NEAR_R;
        const cellKey = (cx + dx) * CKEY + (cz + dz);
        const isNewNear = nearRing && !prevCells.has(cellKey) && prevCells.size > 0;
        // Generate this cell's plant list only while inside the frame
        // budget; skipped cells are picked up on following frames.
        let plants = this._cellPlants(cx + dx, cz + dz, false);
        if (!plants) {
          plants = budgetMs === Infinity
            ? this._cellPlants(cx + dx, cz + dz, true)
            : this._advanceCell(cx + dx, cz + dz, budgetMs, t0);
          if (!plants) { pending = true; continue; }
        }
        if (nearRing) nowCells.add(cellKey);
        for (let pi = 0; pi < plants.length; pi++) {
          const p = plants[pi];
          // Density thinning: deterministic per-plant keep test.
          if (den < 1 && hash01(pi, p.x | 0, 0x5c1) > den) continue;
          if (nearRing) {
            const n = nearCounts[p.t];
            if (n >= CAP_NEAR[p.t]) continue;
            this._compose(p);
            this._near[p.t].setMatrixAt(n, this._m);
            nearCounts[p.t] = n + 1;
            const cr = COLL[p.t];
            if (cr > 0) this.colliders.push({ x: p.x, z: p.z, r: cr * p.s });
            // Smooth LOD swap: plants in cells that just became near
            // grow in over ~0.45 s instead of appearing at full scale.
            if (isNewNear && p.tree && this._growing.length < 220) {
              this._growing.push({ type: p.t, slot: n, p, t0: growNow });
            }
          } else if (CAP_FAR[p.t] !== undefined) {
            const n = farCounts[p.t];
            if (n >= CAP_FAR[p.t]) continue;
            this._compose(p);
            this._far[p.t].setMatrixAt(n, this._m);
            farCounts[p.t] = n + 1;
          }
        }
      }
    }
    this._pending = pending;
    let vn = 0, vf = 0;
    for (const t of TYPES) {
      this._near[t].count = nearCounts[t];
      this._near[t].instanceMatrix.needsUpdate = true;
      vn += nearCounts[t];
    }
    for (const t of Object.keys(CAP_FAR)) {
      this._far[t].count = farCounts[t];
      this._far[t].instanceMatrix.needsUpdate = true;
      vf += farCounts[t];
    }
    this.visibleNear = vn;
    this.visibleFar = vf;
    this.collVersion = (this.collVersion || 0) + 1;
    this._nearCells = nowCells;
  }

  _compose(p) {
    this._p.set(p.x, p.y, p.z);
    this._e.set(0, p.yaw, 0);
    this._q.setFromEuler(this._e);
    this._s.setScalar(p.s);
    this._m.compose(this._p, this._q, this._s);
  }
}

// ---- Low-poly vertex-colored geometry (painted color variation) -------------

function colored(geo, r, g, b, jitter = 0.05) {
  // Normalize: icosahedrons are non-indexed while cones/cylinders/planes
  // are indexed — mergeGeometries needs all-or-none.
  if (geo.index) geo = geo.toNonIndexed();
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = (hash01(i, 17, 71) - 0.5) * jitter * 2;
    col[i * 3] = r + j; col[i * 3 + 1] = g + j; col[i * 3 + 2] = b + j * 0.7;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function trunk(r0, r1, h, cr, cg, cb) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 5);
  g.translate(0, h / 2, 0);
  return colored(g, cr, cg, cb, 0.04);
}

const GEO_BUILDERS = {
  /** Pine: tall trunk + 3 stacked cones. */
  pine() {
    const parts = [trunk(0.22, 0.15, 2.2, 0.36, 0.26, 0.17)];
    for (let i = 0; i < 3; i++) {
      const c = new THREE.ConeGeometry(1.6 - i * 0.42, 2.2, 6);
      c.translate(0, 2.6 + i * 1.5, 0);
      parts.push(colored(c, 0.16, 0.36 + i * 0.03, 0.19, 0.06));
    }
    return mergeGeometries(parts);
  },
  /** Fir: slimmer, bluer, 4 tight cones. */
  fir() {
    const parts = [trunk(0.18, 0.12, 1.6, 0.33, 0.24, 0.16)];
    for (let i = 0; i < 4; i++) {
      const c = new THREE.ConeGeometry(1.15 - i * 0.24, 1.7, 6);
      c.translate(0, 1.9 + i * 1.15, 0);
      parts.push(colored(c, 0.13, 0.3 + i * 0.02, 0.24, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Birch: pale trunk + two bright ellipsoid canopies. */
  birch() {
    const parts = [trunk(0.16, 0.11, 2.6, 0.85, 0.84, 0.78)];
    const c1 = new THREE.IcosahedronGeometry(1.25, 0);
    c1.scale(1, 1.25, 1);
    c1.translate(0, 3.3, 0);
    parts.push(colored(c1, 0.45, 0.62, 0.25, 0.08));
    const c2 = new THREE.IcosahedronGeometry(0.8, 0);
    c2.translate(0.7, 2.6, 0.3);
    parts.push(colored(c2, 0.5, 0.66, 0.28, 0.08));
    return mergeGeometries(parts);
  },
  /** Small oak: thick trunk + broad round canopy. */
  oak() {
    const parts = [trunk(0.3, 0.22, 1.7, 0.34, 0.25, 0.16)];
    const c = new THREE.IcosahedronGeometry(1.7, 0);
    c.scale(1.2, 0.95, 1.2);
    c.translate(0, 2.8, 0);
    parts.push(colored(c, 0.3, 0.45, 0.17, 0.09));
    return mergeGeometries(parts);
  },
  /** Dead tree: bare trunk + 3 branch spikes. */
  dead() {
    const parts = [trunk(0.2, 0.08, 3.2, 0.42, 0.36, 0.3)];
    for (let i = 0; i < 3; i++) {
      const b = new THREE.CylinderGeometry(0.03, 0.07, 1.3, 4);
      b.rotateZ(0.7 + i * 0.5);
      b.rotateY(i * 2.1);
      b.translate(0, 1.7 + i * 0.6, 0);
      parts.push(colored(b, 0.4, 0.34, 0.28, 0.04));
    }
    return mergeGeometries(parts);
  },
  /** Bush: two squashed icosahedrons. */
  bush() {
    const a = new THREE.IcosahedronGeometry(0.85, 0);
    a.scale(1.25, 0.7, 1.25);
    a.translate(0, 0.5, 0);
    const b = new THREE.IcosahedronGeometry(0.55, 0);
    b.scale(1.1, 0.75, 1.1);
    b.translate(0.55, 0.42, 0.3);
    return mergeGeometries([colored(a, 0.24, 0.42, 0.2, 0.07), colored(b, 0.28, 0.46, 0.22, 0.07)]);
  },
  /** Fern: 3 crossed arcs of planes. */
  fern() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.PlaneGeometry(1.1, 0.75);
      p.rotateX(-0.5);
      p.rotateY((i / 3) * Math.PI * 2);
      p.translate(0, 0.35, 0);
      parts.push(colored(p, 0.2, 0.44, 0.22, 0.06));
    }
    return mergeGeometries(parts);
  },
  /** Grass patch: 4 crossed quads (a tuft, never blades). */
  grass() {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.PlaneGeometry(0.9, 0.5);
      p.rotateY((i / 4) * Math.PI);
      p.translate(0, 0.24, 0);
      parts.push(colored(p, 0.42, 0.58, 0.26, 0.08));
    }
    return mergeGeometries(parts);
  },
  /** Flowers: grass tuft + 5 colored heads. */
  flower() {
    const parts = [];
    for (let i = 0; i < 2; i++) {
      const p = new THREE.PlaneGeometry(0.7, 0.4);
      p.rotateY((i / 2) * Math.PI);
      p.translate(0, 0.2, 0);
      parts.push(colored(p, 0.4, 0.56, 0.25, 0.06));
    }
    const cols = [[0.95, 0.75, 0.2], [0.9, 0.4, 0.5], [0.85, 0.85, 0.9], [0.75, 0.45, 0.85], [0.95, 0.55, 0.25]];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.IcosahedronGeometry(0.07, 0);
      b.translate((hash01(i, 3, 9) - 0.5) * 0.7, 0.36 + hash01(i, 5, 11) * 0.14, (hash01(i, 7, 13) - 0.5) * 0.7);
      const c = cols[i];
      parts.push(colored(b, c[0], c[1], c[2], 0.03));
    }
    return mergeGeometries(parts);
  },
  /** Small shrub: single squashed icosahedron, drier tint. */
  shrub() {
    const a = new THREE.IcosahedronGeometry(0.6, 0);
    a.scale(1.2, 0.65, 1.2);
    a.translate(0, 0.36, 0);
    return colored(a, 0.38, 0.44, 0.22, 0.08);
  },
};

/** Far impostor: one 6-face cone+trunk silhouette, species-tinted. */
function buildImpostor(t) {
  const tint = {
    pine: [0.16, 0.35, 0.19], fir: [0.13, 0.3, 0.23],
    birch: [0.45, 0.6, 0.26], oak: [0.3, 0.44, 0.18], dead: [0.42, 0.36, 0.3],
  }[t];
  const h = t === 'dead' ? 3.4 : t === 'birch' ? 4.4 : t === 'oak' ? 3.6 : 6.2;
  const w = t === 'oak' ? 2.1 : t === 'birch' ? 1.6 : 1.5;
  const c = new THREE.ConeGeometry(w * 0.55, h * 0.75, 5);
  c.translate(0, h * 0.55, 0);
  const tr = new THREE.CylinderGeometry(0.14, 0.2, h * 0.3, 4);
  tr.translate(0, h * 0.15, 0);
  return mergeGeometries([colored(c, tint[0], tint[1], tint[2], 0.05),
    colored(tr, 0.35, 0.26, 0.17, 0.03)]);
}
