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
const GROUND_R = 1; // 3x3 cells for grass/flowers (~190 m) — Chapter 5B
                    // distance culling: sward is invisible clutter at
                    // 300 m but costs instances, matrix writes and fill.
const FAR_R = 4;    // 9x9 cells impostors    (~562 m)
const CKEY = 65536;        // integer cell-cache key stride
const CELL_BUDGET_MS = 0.8; // Chapter 5: per-frame plant-generation budget
const VEG_STAGGER = 5;      // frames to wait behind the terrain tile fill
const nowMs = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() : () => Date.now();

// ---- Chapter 5B ecosystem ---------------------------------------------------
// 20 plant models in five families, one InstancedMesh each, all sharing
// two materials. A mesh with zero instances costs no draw call (three.js
// skips instanceCount 0), so biome gating keeps the visible set small:
// reeds only appear near water, alpine grass only high up, and so on.
const TREES = ['pine', 'fir', 'oak', 'birch', 'dead'];
const BUSHES = ['bush', 'shrub', 'fern', 'juniper'];
const GRASSES = ['grass', 'grassTall', 'sedge', 'tussock', 'reed', 'alpineGrass'];
const FLOWERS = ['flowerY', 'flowerP', 'flowerW'];
const LOGS = ['logFallen', 'logMossy'];
// Small ground cover: culled to the inner ring (see GROUND_R).
const SWARD = {};
for (const t of ['grass', 'grassTall', 'sedge', 'tussock', 'reed', 'alpineGrass',
  'flowerY', 'flowerP', 'flowerW']) SWARD[t] = true;
const TYPES = [...TREES, ...BUSHES, ...GRASSES, ...FLOWERS, ...LOGS];
// Trunk collision radius per type (0 = ride-through ground cover; fallen
// logs stay ride-over so they never block a line through a forest).
const COLL = { pine: 0.42, fir: 0.36, birch: 0.34, oak: 0.55, dead: 0.38 };
for (const t of [...BUSHES, ...GRASSES, ...FLOWERS, ...LOGS]) COLL[t] = 0;
const CAP_NEAR = {
  pine: 340, fir: 280, birch: 200, oak: 160, dead: 90,
  bush: 240, shrub: 200, fern: 220, juniper: 160,
  grass: 420, grassTall: 300, sedge: 220, tussock: 240, reed: 140, alpineGrass: 200,
  flowerY: 200, flowerP: 170, flowerW: 150,
  logFallen: 70, logMossy: 60,
};
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
      const card = GRASSES.includes(t) || FLOWERS.includes(t) || t === 'fern';
      const m = new THREE.InstancedMesh(geo, card ? matD : mat, CAP_NEAR[t]);
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
      this._write(mesh, g.slot, g.p, 0.25 + 0.75 * k);
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
    const f = this.field;
    const ox = cx * CELL, oz = cz * CELL;
    const rng = mulberry32(hashInt(cx, cz, 0x7e93));
    // Cell-representative ground: drives how much grows here and what.
    const hCell = f.height(ox + CELL * 0.5, oz + CELL * 0.5);
    // Chapter 5B: TREES GET DENSER WITH ELEVATION. The lowland meadows
    // are open grass, the flanks above ~150 m carry real forest, and it
    // thins out again at the tree line. Elevation biases the forest
    // FIELD itself (not just the count), so whole hillsides turn wooded
    // rather than a few cells getting more trees.
    const elev = sstep(55, 300, hCell) * (1 - sstep(900, 1200, hCell));
    // Forest density field: patchy woods, not uniform speckle.
    const forest = vnoise(cx * 0.17 + 3.7, cz * 0.17 - 8.1, 4441) + 0.24 * elev;
    const woods = Math.max(0, forest - 0.32) * (0.5 + 1.7 * elev);
    const nTrees = woods > 0 ? Math.min(22, (3 + woods * 34) | 0) : 0;
    const nGround = 10 + (rng() * 5 | 0);

    // CLUSTERED placement (never a grid): a handful of clumps per cell,
    // each with its own radius, and every plant is scattered inside one
    // of them with a sqrt-distributed radius. Between the clumps the
    // ground stays open, which is what makes scatter read as an
    // ecosystem instead of confetti.
    const nc = 2 + (rng() * 3 | 0);
    const clusters = [];
    for (let i = 0; i < nc; i++) {
      clusters.push({
        x: ox + 10 + rng() * (CELL - 20),
        z: oz + 10 + rng() * (CELL - 20),
        r: 11 + rng() * 34,
        seed: rng(),
      });
    }
    return {
      cx, cz, key: cx * CKEY + cz,
      ox, oz, rng, forest, elev, nTrees, clusters,
      total: nTrees + nGround, i: 0, list: [],
    };
  }

  /** Evaluate ONE placement candidate. Returns true when the cell is done. */
  _stepCell(job) {
    const f = this.field;
    const lf = f.landforms;
    const info = this._info;
    const rng = job.rng;
    const { forest, nTrees, clusters } = job;
    const i = job.i++;
    // Scatter inside a clump: uniform-in-disc offset from its centre.
    const c = clusters[(rng() * clusters.length) | 0];
    const ang = rng() * 6.283, rad = c.r * Math.sqrt(rng());
    const x = c.x + Math.cos(ang) * rad, z = c.z + Math.sin(ang) * rad;
    // Guards are ordered CHEAPEST FIRST: two squared distances and a
    // road lookup cost a fraction of a terrain sample, and they reject
    // most candidates before the expensive work starts.
    const dmx = x - 4000, dmz = z - 2500;
    if (x >= 30 && x <= 7970 && z >= 30 && z <= 4970 &&
        dmx * dmx + dmz * dmz >= 240 * 240 &&
        !nearViewpoint(lf, x, z) && !lf.inWater(x, z) &&
        lf.roadDist(x, z) >= 11) {
      f.sample(x, z, info);
      const h = info.h;
      // Clear of the sea and the beach strip as well.
      const shore = z > 4420 && h < 66;
      if (h >= 47 && !shore && info.trail <= 0.02) {
        const e = 5;
        // One-sided differences: the slope test costs two samples
        // instead of four (the centre height is already in `info`).
        const sl = Math.hypot(f.height(x + e, z) - h, f.height(x, z + e) - h) / e;
        // Conifers hold ground the rest of the ecosystem cannot: the
        // slope gate opens up in the belt above 150 m, which is what
        // lets the forest actually thicken with elevation instead of
        // stopping dead at the first flank.
        const slopeMax = i < nTrees && info.h > 150 ? 0.98 : 0.55;
        if (sl <= slopeMax) {
          const r = rng(), rr = rng();
          const isTree = i < nTrees;
          let t = null, s = 1, ok = true;
          if (isTree) {
            if (h > 1250) ok = false;              // above the tree line
            else if (h > 150) {
              // Conifer belt: pine and fir, with dead snags in dry spots.
              t = h > 620 && r < 0.3 ? 'dead' : r < 0.55 ? 'pine' : 'fir';
            } else {
              // Lowland broadleaf woods.
              t = r < 0.4 ? 'birch' : r < 0.7 ? 'oak' : rr < 0.5 ? 'pine' : 'bush';
            }
            if (info.moist < 0.25 && rr < 0.35) t = 'dead';
            s = 1.15 + rng() * 0.75;
            // Fallen timber only inside real woodland.
            if (forest > 0.55 && rr > 0.93) {
              t = rr > 0.965 ? 'logMossy' : 'logFallen';
              s = 0.85 + rng() * 0.5;
            }
          } else if (h > 900 && sl <= 0.4) {
            // Alpine mat above the forest.
            t = r < 0.6 ? 'alpineGrass' : r < 0.85 ? 'juniper' : 'tussock';
            s = 0.7 + rng() * 0.4;
          } else if (sl > 0.4) {
            ok = false;
          } else if (lakeNear(lf, x, z)) {
            // Lakeshore stand.
            t = r < 0.65 ? 'reed' : 'sedge';
            s = 0.8 + rng() * 0.5;
          } else if (forest > 0.5) {
            // Forest floor: ferns, brush and juniper mats.
            t = r < 0.4 ? 'fern' : r < 0.65 ? 'bush' : r < 0.85 ? 'shrub' : 'juniper';
            s = 0.75 + rng() * 0.5;
          } else if (info.moist < 0.34) {
            // Dry open country: bunch grass and the odd shrub.
            t = r < 0.55 ? 'tussock' : r < 0.8 ? 'grass' : 'shrub';
            s = 0.75 + rng() * 0.5;
          } else {
            // Damp open meadow: mixed sward and wildflower drifts. The
            // clump's own seed picks which flower colour dominates, so
            // drifts come out single-coloured like real ones.
            if (r < 0.34) t = 'grass';
            else if (r < 0.56) t = 'grassTall';
            else if (r < 0.7) t = info.moist > 0.55 ? 'sedge' : 'tussock';
            else if (r < 0.92) {
              t = c.seed < 0.4 ? 'flowerY' : c.seed < 0.75 ? 'flowerP' : 'flowerW';
            } else t = 'shrub';
            s = 0.75 + rng() * 0.5;
          }
          if (ok && t) {
            const isLog = t === 'logFallen' || t === 'logMossy';
            // Seat on the LOWEST nearby ground so trunks never float on a
            // slope. Trees check their whole footprint; ground cover is
            // small enough that two probes are indistinguishable and
            // halve the cost of the commonest case.
            const isBig = (isTree && !isLog) || isLog;
            const rF = isBig ? 0.9 : 0.5;
            const y = (isBig
              ? Math.min(h, f.height(x + rF, z), f.height(x - rF, z),
                f.height(x, z + rF), f.height(x, z - rF))
              : Math.min(h, f.height(x + rF, z), f.height(x, z + rF))) - 0.06 * s;
            job.list.push({ t, x, z, y, yaw: rng() * 6.283, s, tree: isTree && !isLog });
          }
        }
      }
    }
    return job.i >= job.total;
  }

  /** Store a finished cell job in the LRU cache and return its list. */
  _cacheCell(job) {
    // Trees are generated first, so the far ring (which only draws tree
    // impostors) can stop after the tree prefix instead of walking every
    // blade of grass in all 81 cells of the window.
    let treeN = 0;
    for (let i = 0; i < job.list.length; i++) if (job.list[i].tree) treeN = i + 1;
    job.list.treeN = treeN;
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
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const nearRing = ring <= NEAR_R;
        const groundRing = ring <= GROUND_R;
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
        const nPlants = nearRing ? plants.length : (plants.treeN || 0);
        for (let pi = 0; pi < nPlants; pi++) {
          const p = plants[pi];
          // Density thinning: deterministic per-plant keep test.
          if (den < 1 && hash01(pi, p.x | 0, 0x5c1) > den) continue;
          if (nearRing) {
            // Ground cover is culled to the inner ring.
            if (!groundRing && SWARD[p.t]) continue;
            const n = nearCounts[p.t];
            if (n >= CAP_NEAR[p.t]) continue;
            this._write(this._near[p.t], n, p, 1);
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
            this._write(this._far[p.t], n, p, 1);
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

  /**
   * Chapter 5B: write an instance transform STRAIGHT into the instance
   * buffer. Every plant is a yaw rotation plus a uniform scale, so the
   * Vector3 / Euler / Quaternion / Matrix4.compose / setMatrixAt chain
   * (five objects and a copy per plant) reduces to sixteen float stores.
   * With ~2,400 instances rewritten whenever the window moves, this is
   * the difference between a 6 ms hitch and a fraction of a millisecond.
   */
  _write(mesh, slot, p, scale) {
    const a = mesh.instanceMatrix.array;
    const o = slot * 16;
    const S = p.s * scale;
    const c = Math.cos(p.yaw) * S, sn = Math.sin(p.yaw) * S;
    a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = S; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    a[o + 12] = p.x; a[o + 13] = p.y; a[o + 14] = p.z; a[o + 15] = 1;
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
  /** Small shrub: single squashed icosahedron, drier tint. */
  shrub() {
    const a = new THREE.IcosahedronGeometry(0.6, 0);
    a.scale(1.2, 0.65, 1.2);
    a.translate(0, 0.36, 0);
    return colored(a, 0.38, 0.44, 0.22, 0.08);
  },
  /** Juniper: low spreading conifer mat with a dark blue-green tint. */
  juniper() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const a = new THREE.IcosahedronGeometry(0.62 - i * 0.1, 0);
      a.scale(1.5, 0.45, 1.5);
      a.translate(Math.cos(i * 2.1) * 0.45, 0.24 + i * 0.12, Math.sin(i * 2.1) * 0.45);
      parts.push(colored(a, 0.17, 0.32, 0.24, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Tall grass: 5 taller crossed blades, lighter and airier. */
  grassTall() {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const p = new THREE.PlaneGeometry(0.55, 1.05);
      p.rotateZ((i - 2) * 0.12);
      p.rotateY((i / 5) * Math.PI);
      p.translate(0, 0.52, 0);
      parts.push(colored(p, 0.47, 0.6, 0.27, 0.07));
    }
    return mergeGeometries(parts);
  },
  /** Sedge: stiff dark clump for damp ground. */
  sedge() {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.PlaneGeometry(0.4, 0.8);
      p.rotateZ((i - 1.5) * 0.22);
      p.rotateY((i / 4) * Math.PI);
      p.translate(0, 0.4, 0);
      parts.push(colored(p, 0.28, 0.48, 0.24, 0.06));
    }
    return mergeGeometries(parts);
  },
  /** Tussock: dry straw-coloured bunch grass of the open basins. */
  tussock() {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.PlaneGeometry(0.85, 0.42);
      p.rotateY((i / 4) * Math.PI);
      p.translate(0, 0.2, 0);
      parts.push(colored(p, 0.63, 0.58, 0.3, 0.08));
    }
    return mergeGeometries(parts);
  },
  /** Reed: lakeshore stand, tall and narrow. */
  reed() {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const p = new THREE.PlaneGeometry(0.26, 1.35);
      p.rotateZ((i - 2) * 0.09);
      p.rotateY((i / 5) * Math.PI * 1.2);
      p.translate((i - 2) * 0.09, 0.68, 0);
      parts.push(colored(p, 0.4, 0.53, 0.26, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Alpine grass: short, blue-green, hugging the ground up high. */
  alpineGrass() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.PlaneGeometry(0.7, 0.3);
      p.rotateY((i / 3) * Math.PI);
      p.translate(0, 0.15, 0);
      parts.push(colored(p, 0.36, 0.5, 0.33, 0.06));
    }
    return mergeGeometries(parts);
  },
  flowerY() { return flowerOf(0.95, 0.82, 0.22); },
  flowerP() { return flowerOf(0.72, 0.42, 0.85); },
  flowerW() { return flowerOf(0.93, 0.93, 0.95); },
  /** Fallen log: a bare trunk lying in the grass with a broken stub. */
  logFallen() {
    const g = new THREE.CylinderGeometry(0.26, 0.32, 3.4, 6);
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.3, 0);
    const stub = new THREE.CylinderGeometry(0.1, 0.14, 0.7, 5);
    stub.rotateZ(0.9);
    stub.translate(1.3, 0.55, 0.15);
    return mergeGeometries([colored(g, 0.42, 0.33, 0.24, 0.05),
      colored(stub, 0.4, 0.31, 0.22, 0.04)]);
  },
  /** Mossy log: shorter, greener, half sunk into the forest floor. */
  logMossy() {
    const g = new THREE.CylinderGeometry(0.3, 0.34, 2.4, 6);
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.24, 0);
    const moss = new THREE.IcosahedronGeometry(0.33, 0);
    moss.scale(2.6, 0.4, 1.0);
    moss.translate(0, 0.44, 0);
    return mergeGeometries([colored(g, 0.36, 0.3, 0.23, 0.04),
      colored(moss, 0.26, 0.42, 0.22, 0.06)]);
  },
};

/** Wildflower of a given head colour: grass tuft + 6 blossom heads. */
function flowerOf(cr, cg, cb) {
  const parts = [];
  for (let i = 0; i < 2; i++) {
    const p = new THREE.PlaneGeometry(0.7, 0.4);
    p.rotateY((i / 2) * Math.PI);
    p.translate(0, 0.2, 0);
    parts.push(colored(p, 0.4, 0.56, 0.25, 0.06));
  }
  for (let i = 0; i < 6; i++) {
    const b = new THREE.IcosahedronGeometry(0.075, 0);
    b.translate((hash01(i, 3, 9) - 0.5) * 0.72,
      0.34 + hash01(i, 5, 11) * 0.18, (hash01(i, 7, 13) - 0.5) * 0.72);
    parts.push(colored(b, cr, cg, cb, 0.04));
  }
  return mergeGeometries(parts);
}

/** Viewpoints keep their sight lines open — nothing is planted inside. */
function nearViewpoint(lf, x, z) {
  const vps = lf.viewpoints;
  if (!vps) return false;
  for (let i = 0; i < vps.length; i++) {
    const dx = x - vps[i].x, dz = z - vps[i].z;
    if (dx * dx + dz * dz < 46 * 46) return true;
  }
  return false;
}

/** Within a lake's shoreline band (reeds and sedge grow there). */
function lakeNear(lf, x, z) {
  const ls = lf.lakes || [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const d = Math.hypot(x - l.x, z - l.z);
    if (d < l.r * 1.5 && d > l.r * 0.95) return true;
  }
  return false;
}

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
