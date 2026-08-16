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

// Per-type instance capacities (near / far pools).
const TYPES = ['pine', 'fir', 'birch', 'oak', 'dead', 'bush', 'fern', 'grass', 'flower', 'shrub'];
const CAP_NEAR = { pine: 340, fir: 260, birch: 200, oak: 160, dead: 90, bush: 260, fern: 220, grass: 420, flower: 260, shrub: 200 };
const CAP_FAR = { pine: 950, fir: 750, birch: 550, oak: 420, dead: 260 };

export class Vegetation {
  constructor(scene, field) {
    this.field = field;
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this.visibleNear = 0;
    this.visibleFar = 0;

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
    if (this._pcx !== null) this._rebuild(this._pcx, this._pcz);
  }

  /** Per-frame: rebuild instance lists when the player crosses a cell. */
  update(px, pz) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    if (cx === this._pcx && cz === this._pcz) return;
    this._pcx = cx; this._pcz = cz;
    this._rebuild(cx, cz);
  }

  /** Deterministic plant list for one 125 m cell. */
  _cellPlants(cx, cz) {
    const key = `${cx},${cz}`;
    let list = this._cellCache.get(key);
    if (list) return list;
    list = [];
    const f = this.field;
    const lf = f.landforms;
    const rng = mulberry32(hashInt(cx, cz, 0x7e93));
    const info = this._info;
    const ox = cx * CELL, oz = cz * CELL;

    // Forest density field: patchy woods, not uniform speckle.
    const forest = vnoise(cx * 0.17 + 3.7, cz * 0.17 - 8.1, 4441);
    const nTrees = forest > 0.38 ? (3 + (forest - 0.38) * 26) | 0 : 0;
    const nGround = 5;

    for (let i = 0; i < nTrees + nGround; i++) {
      const x = ox + 6 + rng() * (CELL - 12), z = oz + 6 + rng() * (CELL - 12);
      if (x < 30 || x > 7970 || z < 30 || z > 3970) continue;
      f.sample(x, z, info);
      const h = info.h;
      // Keep clear of roads/trails and the groomed meadow core, and the lake.
      if (info.trail > 0.02) continue;
      if (lf.roadDist(x, z) < 11) continue;
      const dMeadow = Math.hypot(x - 4000, z - 2000);
      if (dMeadow < 240) continue;
      // Slope: no trees on cliffs.
      const e = 5;
      const sl = Math.hypot(f.height(x + e, z) - f.height(x - e, z),
        f.height(x, z + e) - f.height(x, z - e)) / (2 * e);
      if (sl > 0.55) continue;
      const r = rng(), rr = rng();
      const isTree = i < nTrees;
      let t = null, s = 1;
      if (isTree) {
        if (h > 1500) continue; // above the tree line
        if (h > 320) {
          // Foothill conifer belt.
          t = h > 1100 && r < 0.3 ? 'dead' : r < 0.55 ? 'pine' : 'fir';
        } else {
          // Lowland broadleaf.
          t = r < 0.4 ? 'birch' : r < 0.7 ? 'oak' : rr < 0.5 ? 'pine' : 'bush';
        }
        if (info.moist < 0.25 && rr < 0.35) t = 'dead';
        s = 1.15 + rng() * 0.75;
      } else {
        if (h > 1300 || sl > 0.4) continue;
        // Ground cover: grass/flowers in the open, ferns/shrubs in woods.
        if (forest > 0.5) t = r < 0.5 ? 'fern' : r < 0.8 ? 'bush' : 'shrub';
        else t = r < 0.5 ? 'grass' : r < 0.75 ? 'flower' : 'shrub';
        s = 0.75 + rng() * 0.5;
      }
      if (!t) continue;
      list.push({ t, x, z, y: h, yaw: rng() * 6.283, s });
    }

    if (this._cellCache.size > 300) this._cellCache.clear();
    this._cellCache.set(key, list);
    return list;
  }

  _rebuild(cx, cz) {
    const nearCounts = {}, farCounts = {};
    for (const t of TYPES) nearCounts[t] = 0;
    for (const t of Object.keys(CAP_FAR)) farCounts[t] = 0;

    const R = this._farR;
    const den = this._density;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const nearRing = Math.max(Math.abs(dx), Math.abs(dz)) <= NEAR_R;
        const plants = this._cellPlants(cx + dx, cz + dz);
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
