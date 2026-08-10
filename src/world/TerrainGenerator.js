import { vnoise, fbm2, hash01, hashInt, mulberry32, sstep } from './noise.js';

/**
 * TerrainGenerator — the analytic heart of the endless world.
 *
 * Height, biome weights, trails, streams, terraces and jump features are all
 * pure functions of (x, z, seed). Chunk meshes merely SAMPLE this function,
 * which guarantees:
 *   - identical values on shared chunk edges (no seams),
 *   - physics that works even before a chunk mesh is built,
 *   - full determinism for a given seed.
 *
 * Biomes (blended smoothly, never square borders):
 *   green mid-hills / pine foothill forest / rural farm (terraces) /
 *   rocky hills / high mountain (ridged, snow-capped)
 * driven by two low-frequency fields: "mountainness" and "humidity".
 *
 * Trails and streams are level-sets of low-frequency noise: |n| < width.
 * Two independent trail channels cross each other, giving natural junctions,
 * splits and reconnections without any path-plotting.
 *
 * Jump features (dirt mounds, built kicker ramps) and bridges live on an
 * 80 m feature-cell grid; each cell decides its own content from its
 * coordinates alone, so any chunk can be generated in any order.
 *
 * MOUNTAIN DESTINATIONS (Phase 3B) live on a sparse 1200 m cell grid: rare,
 * named, climbable peaks added as an analytic radial dome with a spiral
 * dirt road that cancels the dome's cross-slope, so the route stays
 * rideable while the face remains steep. Generic trails/streams/terraces
 * fade out under a dome; the road takes over. Being part of the same
 * analytic height function, they stream through the normal chunk system
 * and cost nothing when far away.
 */

const CELL = 80; // feature-cell size (m)
const MCELL = 1200;           // mountain-destination cell size (m)
const ROAD_END_R = 10;        // spiral road ends this close to the summit
const REGISTRY_SIZE = 16;     // named destinations curated around the origin
const SIGNATURE_COUNT = 6;
const MOUNTAIN_NAMES = [
  'Suryodaya', 'Ratnagiri', 'Megharaj', 'Seto Shikhar',
  'Bhalu Danda', 'Kalika Danda', 'Juneli Chuli', 'Indra Shikhar',
  'Phul Danda', 'Tara Chuli', 'Hariyo Danda', 'Chirbire Shikhar',
  'Sunkhani Peak', 'Dhunge Chuli', 'Bataas Danda', 'Kuhiro Shikhar',
];
// Signature destinations: distinct names + one fixed hero peak.
const SIGNATURE_NAMES = [
  'Shreya Shikhar', 'Aakash Chuli', 'Rajkanya Himal',
  'Basanta Shikhar', 'Ganga Devi Peak', 'Mukti Himal',
];
const SIGNATURE_TYPES = [
  'snow crown', 'twin ridge', 'cliff head',
  'sacred dome', 'terraced peak', 'storm spur',
];
const NORMAL_TYPES = ['green dome', 'pine ridge', 'rocky spur', 'grass crest'];
// Signature route personalities (kind 1..6, same order as SIGNATURE_NAMES).
// All values feed the existing analytic dome/road pipeline — no new systems.
const SIG_PARAMS = [
  { // 1 Shreya Shikhar: forest approach, long climb, bridge, narrow ridge top
    H: 128, R: 360, turns: 3.1, roadW: 3.2, narrowTop: 0.36, crown: 10,
    bridges: [0.55], forestMul: 1.35,
    alt: { turns: 1.1, w: 2.4, narrowTop: 0.3 }, spur: { bearingOff: 2.4, w: 3.4 },
  },
  { // 2 Aakash Chuli: open, fast, wide flowing road with big whoop jumps
    H: 105, R: 340, turns: 2.4, roadW: 6.5, crown: 0,
    whoopAmp: 1.7, whoopFreq: 45, forestMul: 0.25, // ~20-35 m kicker wavelength
    alt: { turns: 1.0, w: 4.5 },
  },
  { // 3 Rajkanya Himal: steep technical rock, tight switchbacks, narrow road
    H: 118, R: 330, turns: 3.6, roadW: 2.9, crown: 8, rockBig: true, forestMul: 0.45,
    alt: { turns: 1.3, w: 2.6 }, spur: { bearingOff: 3.4, w: 3.0 },
  },
  { // 4 Basanta Shikhar: deep forest, streams run down the dome, two bridges
    H: 100, R: 350, turns: 2.9, roadW: 4.2, crown: 4,
    bridges: [0.35, 0.62], streamKeep: true, mud: true, forestMul: 1.5,
    alt: { turns: 1.2, w: 3.4 },
  },
  { // 5 Ganga Devi Peak: terraced village lower slopes, forest, exposed top
    H: 110, R: 360, turns: 2.8, roadW: 4.6, crown: 6,
    terraceLow: true, village: true, forestMul: 0.9,
    alt: { turns: 1.15, w: 3.2 },
  },
  { // 6 Mukti Himal: the hardest — highest, narrow, uneven, brutal final climb
    H: 148, R: 380, turns: 3.4, roadW: 2.7, narrowTop: 0.3, crown: 14,
    whoopAmp: 0.55, whoopFreq: 55, barren: true, forestMul: 0.1, // uneven chatter
    alt: { turns: 1.4, w: 2.3, narrowTop: 0.25 },
  },
];

export class TerrainGenerator {
  constructor(seed = 20) {
    this.seed = seed | 0;
    const s = this.seed * 13;
    // Channel salts (one per noise field).
    this.SM = s + 1;  // mountainness
    this.SU = s + 2;  // humidity
    this.SH = s + 3;  // height octaves
    this.SR = s + 7;  // ridges
    this.ST1 = s + 8; // trail channel A
    this.ST2 = s + 9; // trail channel B
    this.SW = s + 10; // trail width
    this.SS = s + 11; // streams
    this.STE = s + 12; // terrace mask
    this.SJ = s + 13; // color jitter
    this.SF = s + 14; // feature cells
    this.SMt = s + 15; // mountain destinations
    this._cells = new Map();
    this._mcells = new Map();
    this._mtnD = 0; // distance to the mountain returned by _mountainNear
    this._registryMeta = null; // cell key -> destination metadata (never pruned)
    this._registryList = null;
    this._roadCut = { dr: 1e9, w: 3.6, fade: 0 }; // scratch: nearest route band
    this._info = makeInfo(); // scratch for height-only sampling
  }

  // ---- Public sampling API ------------------------------------------------

  /** Height only (physics / camera / shadow hot path). */
  height(x, z) {
    const h = this._sample(x, z, this._info, true, true);
    return Number.isFinite(h) ? h : 0; // world-recovery guard
  }

  /** Full sample: height + biome weights + masks (mesh building, scatter). */
  sampleInfo(x, z, info) {
    info.h = this._sample(x, z, info, true, true);
    if (!Number.isFinite(info.h)) info.h = 0;
    return info;
  }

  /** Vertex color for a sampled point; written into out = [r, g, b]. */
  colorFor(info, out) {
    const j = info.jit;
    const h = info.h;
    // Large-scale dry/lush ground patches (adds life to open ground).
    const dry = info.dry;
    // Biome base colors (kept saturated — distance fog desaturates plenty).
    // Rocky hills read brown (exposed dirt), high mountains read grey stone.
    let r = (0.31 + 0.10 * j) * info.wH + (0.19 + 0.05 * j) * info.wF +
            (0.44 + 0.06 * j) * info.wRk;
    let g = (0.47 + 0.08 * j) * info.wH + (0.31 + 0.06 * j) * info.wF +
            (0.36 + 0.05 * j) * info.wRk;
    let b = (0.17 + 0.04 * j) * info.wH + 0.13 * info.wF + (0.28 + 0.04 * j) * info.wRk;
    if (info.wFa > 0.001) {
      // Terraced field palette alternates with terrace level.
      const lvl = Math.floor((h + 40) / 1.1) & 3;
      const p = FARM_PALETTE[lvl];
      r += (p[0] + 0.05 * j) * info.wFa;
      g += (p[1] + 0.05 * j) * info.wFa;
      b += (p[2] + 0.03 * j) * info.wFa;
    }
    if (info.wMnt > 0.001) {
      const sn = sstep(13, 17, h + j * 3 - 1.5); // snow line with dithered edge
      r += (0.40 + (0.93 - 0.40) * sn) * info.wMnt;
      g += (0.41 + (0.94 - 0.41) * sn) * info.wMnt;
      b += (0.46 + (0.97 - 0.46) * sn) * info.wMnt;
    }
    // Dry-patch tint on open ground (hills/farm), fading under forest.
    const dryM = dry * (info.wH + info.wFa * 0.7) * 0.5;
    r += (0.55 - r) * dryM; g += (0.50 - g) * dryM; b += (0.30 - b) * dryM;
    // Mountain destination bands: forest low, rock mid, grey/snow top.
    if (info.mtn > 0.02) {
      const t = info.mtn;
      const forest = sstep(0.05, 0.16, t) * (1 - sstep(0.42, 0.58, t)) * 0.8;
      r += (0.21 - r) * forest; g += (0.34 - g) * forest; b += (0.15 - b) * forest;
      const rock = sstep(0.42, 0.62, t);
      r += (0.45 - r) * rock; g += (0.41 - g) * rock; b += (0.37 - b) * rock;
      const high = sstep(0.72, 0.9, t) * 0.75;
      r += (0.51 - r) * high; g += (0.51 - g) * high; b += (0.54 - b) * high;
      const snow = sstep(0.85, 0.95, t + (j - 0.5) * 0.06) * sstep(66, 78, info.mtnH);
      r += (0.93 - r) * snow; g += (0.94 - g) * snow; b += (0.97 - b) * snow;
    }
    // Kind-5 signature: terraced village fields colored on the lower dome.
    if (info.mtnKind === 5 && info.terr > 0.05 && info.mtn > 0.02) {
      const lvl = Math.floor((h + 40) / 1.1) & 3;
      const p = FARM_PALETTE[lvl];
      const tm = Math.min(1, info.terr * 1.2);
      r += (p[0] + 0.04 * j - r) * tm;
      g += (p[1] + 0.04 * j - g) * tm;
      b += (p[2] - b) * tm;
    }
    // Dirt trail overlay (bright sandy — reads clearly against every biome).
    // Kind-4 signature roads read muddy under the forest canopy.
    const t = info.trail * 0.88;
    const mud = info.mtnKind === 4 && info.mtn > 0.02;
    r += ((mud ? 0.40 : 0.56) + 0.07 * j - r) * t;
    g += ((mud ? 0.32 : 0.44) + 0.05 * j - g) * t;
    b += ((mud ? 0.22 : 0.26) - b) * t;
    // Edge wear: slightly darker, rougher dirt along trail borders.
    const wear = sstep(0.3, 0.5, info.trail) * (1 - sstep(0.78, 0.95, info.trail)) * 0.35;
    r -= r * 0.10 * wear; g -= g * 0.11 * wear; b -= b * 0.08 * wear;
    // Stream bed: wet stones, watery center.
    const sm = info.stream;
    if (sm > 0.01) {
      r += (0.32 - r) * sm; g += (0.35 - g) * sm; b += (0.34 - b) * sm;
      const wet = sstep(0.72, 0.95, sm);
      r += (0.22 - r) * wet; g += (0.32 - g) * wet; b += (0.42 - b) * wet;
    }
    out[0] = r; out[1] = g; out[2] = b;
  }

  /** Cheap trail/stream/biome masks without feature pass (spawn search etc). */
  masksAt(x, z, out) {
    this._sample(x, z, out, false, true);
    return out;
  }

  // ---- Feature access (chunk manager places deck props on these) ----------

  /** Feature record of a cell, or null. Cached; computed deterministically. */
  cellFeature(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let f = this._cells.get(key);
    if (f === undefined) {
      f = this._computeCell(cx, cz);
      this._cells.set(key, f);
    }
    return f;
  }

  /** Iterate features of the cells overlapping a world-space rectangle. */
  featuresInRect(x0, z0, x1, z1, cb) {
    const ca = Math.floor(x0 / CELL), cb2 = Math.floor(x1 / CELL);
    const cc = Math.floor(z0 / CELL), cd = Math.floor(z1 / CELL);
    for (let cx = ca; cx <= cb2; cx++) {
      for (let cz = cc; cz <= cd; cz++) {
        const f = this.cellFeature(cx, cz);
        if (f) cb(f);
      }
    }
  }

  /** True if (x,z) is inside a feature's footprint or its landing zone. */
  nearFeature(x, z) {
    const ccx = Math.floor(x / CELL), ccz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const f = this.cellFeature(ccx + dx, ccz + dz);
        if (!f) continue;
        const rx = x - f.x, rz = z - f.z;
        if (f.type === 'mound') {
          if (rx * rx + rz * rz < 196) return true;
        } else if (f.type === 'ramp') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (u > -5 && u < 38 && Math.abs(v) < 9) return true; // incl. landing
        } else if (rx * rx + rz * rz < 100) {
          return true; // bridge
        }
      }
    }
    return false;
  }

  // ---- Mountain destinations (Phase 3B) -----------------------------------

  /** Mountain record of a 1200 m cell, or null. Deterministic; cached. */
  mountainCell(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let mn = this._mcells.get(key);
    if (mn === undefined) {
      if (hash01(cx, cz, this.SMt) > 0.52) {
        mn = null;
      } else {
        const R = 260 + 80 * hash01(cx, cz, this.SMt + 3);
        const H = 55 + 32 * hash01(cx, cz, this.SMt + 4);
        const turns = 1.5 + 0.8 * hash01(cx, cz, this.SMt + 5);
        const rStart = R + 100;
        const uMax = turns * 2 * Math.PI;
        mn = {
          id: `${this.seed}:${cx},${cz}`,
          name: MOUNTAIN_NAMES[(hashInt(cx, cz, this.SMt + 7) >>> 4) % MOUNTAIN_NAMES.length],
          x: (cx + 0.3 + 0.4 * hash01(cx, cz, this.SMt + 1)) * MCELL,
          z: (cz + 0.3 + 0.4 * hash01(cx, cz, this.SMt + 2)) * MCELL,
          R, H, uMax,
          phi: hash01(cx, cz, this.SMt + 6) * 2 * Math.PI,
          rStart,
          k: (rStart - ROAD_END_R) / uMax,
          // Fixed modulation used along the road so the spiral never
          // inherits the flank shape-noise as sudden pitch changes.
          modC: 0.85 + 0.34 * hash01(cx, cz, this.SMt + 9),
        };
      }
      if (mn && this._registryMeta) {
        const meta = this._registryMeta.get(key);
        if (meta) Object.assign(mn, meta);
      }
      if (mn && mn.signature && !mn.altRoutes) mn.altRoutes = buildAltRoutes(mn);
      this._mcells.set(key, mn);
    }
    return mn;
  }

  /**
   * Destination registry: the REGISTRY_SIZE mountains nearest the origin
   * (deterministic spiral cell order), decorated with unique curated names,
   * signature status, type and difficulty. Pure metadata — geometry only
   * ever materializes through the normal chunk/impostor systems.
   */
  getRegistry() {
    if (this._registryList) return this._registryList;

    // Collect candidate cells in a deterministic spiral around (0,0).
    const cells = [];
    for (let r = 0; r <= 8 && cells.length < REGISTRY_SIZE; r++) {
      const ring = [];
      for (let cx = -r; cx <= r; cx++) {
        for (let cz = -r; cz <= r; cz++) {
          if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
          ring.push([cx, cz]);
        }
      }
      // Fixed order within the ring (already deterministic by construction).
      for (const [cx, cz] of ring) {
        if (cells.length >= REGISTRY_SIZE) break;
        const key = (cx + 8192) * 16384 + (cz + 8192);
        // Query the raw cell without registry decoration (not built yet).
        const mn = this.mountainCell(cx, cz);
        if (mn) cells.push({ key, cx, cz });
      }
    }

    // Seeded assignment: which registry slots are signature, which names.
    const rng = mulberry32((this.seed | 0) * 2654435761 + 13);
    const slotOrder = cells.map((_, i) => i);
    for (let i = slotOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [slotOrder[i], slotOrder[j]] = [slotOrder[j], slotOrder[i]];
    }
    const signatureSlots = new Set(slotOrder.slice(0, SIGNATURE_COUNT));
    const normalNames = [...MOUNTAIN_NAMES];
    for (let i = normalNames.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [normalNames[i], normalNames[j]] = [normalNames[j], normalNames[i]];
    }

    this._registryMeta = new Map();
    let sigIdx = 0, normIdx = 0;
    const list = [];
    cells.forEach((c, i) => {
      const signature = signatureSlots.has(i);
      const meta = signature
        ? {
            name: SIGNATURE_NAMES[sigIdx],
            type: SIGNATURE_TYPES[sigIdx],
            signature: true,
            kind: sigIdx + 1,
            ...this._signatureGeometry(sigIdx),
          }
        : {
            name: normalNames[normIdx++],
            type: NORMAL_TYPES[hashInt(c.cx, c.cz, this.SMt + 11) >>> 4 & 3],
            signature: false,
          };
      if (signature) sigIdx++;
      meta.registryIndex = i;
      this._registryMeta.set(c.key, meta);
      const rec = this._mcells.get(c.key);
      Object.assign(rec, meta);
      if (rec.signature && !rec.altRoutes) rec.altRoutes = buildAltRoutes(rec);
    });

    // Second pass (all overrides active): road bridges + public entries.
    cells.forEach((c, i) => {
      const meta = this._registryMeta.get(c.key);
      const mn = this._mcells.get(c.key);
      if (meta.bridgeFracs === undefined && SIG_PARAMS[meta.kind - 1] &&
          SIG_PARAMS[meta.kind - 1].bridges) {
        // Ravine + wooden deck cut across the road at fixed route fractions.
        meta.bridgePts = SIG_PARAMS[meta.kind - 1].bridges.map((f) => {
          const p = this.roadPoint(mn, f);
          return {
            x: p.x, z: p.z,
            dx: Math.sin(p.yaw), dz: Math.cos(p.yaw),
            h0: this.height(p.x, p.z) + 0.1, // pre-ravine road level
          };
        });
        mn.bridgePts = meta.bridgePts;
      }
      const summitY = this.height(mn.x, mn.z);
      list.push({
        id: mn.id,
        achievementId: mn.id, // achievements already key on this
        name: mn.name,
        type: mn.type,
        signature: mn.signature,
        difficulty: Math.max(1, Math.min(5, Math.round(1 + (mn.H - 55) / 8))),
        x: mn.x,
        z: mn.z,
        R: mn.R,
        H: mn.H,
        summit: { x: mn.x, y: summitY, z: mn.z },
      });
    });
    this._registryList = list;
    return list;
  }

  /** Geometry overrides for signature kind (0-based index into SIG_PARAMS). */
  _signatureGeometry(sigIdx) {
    const p = SIG_PARAMS[sigIdx];
    const rStart = p.R + 100;
    const uMax = p.turns * 2 * Math.PI;
    return {
      H: p.H, R: p.R, rStart, uMax,
      k: (rStart - ROAD_END_R) / uMax,
      roadW: p.roadW, narrowTop: p.narrowTop || 0, crown: p.crown || 0,
      whoopAmp: p.whoopAmp || 0, whoopFreq: p.whoopFreq || 0,
      streamKeep: !!p.streamKeep, terraceLow: !!p.terraceLow,
      village: !!p.village, mud: !!p.mud, rockBig: !!p.rockBig,
      barren: !!p.barren, forestMul: p.forestMul !== undefined ? p.forestMul : 1,
      alt: p.alt || null, spur: p.spur || null,
    };
  }

  /** Dome profile (0..1) of any mountain at a point; 0 = off-dome. */
  _domeProf(x, z) {
    const mn = this._mountainNear(x, z);
    if (!mn) return 0;
    const t = this._mtnD / mn.R;
    if (t >= 1) return 0;
    const q = 1 - t * t;
    return q * q;
  }

  /** Mountain whose influence covers (x,z), or null; distance in _mtnD. */
  _mountainNear(x, z) {
    const ccx = Math.floor(x / MCELL), ccz = Math.floor(z / MCELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const mn = this.mountainCell(ccx + dx, ccz + dz);
        if (!mn) continue;
        const d = Math.hypot(x - mn.x, z - mn.z);
        if (d < mn.rStart + 30) {
          this._mtnD = d;
          return mn;
        }
      }
    }
    return null;
  }

  /** The mountain whose summit is at (x,z), within `radius` m; else null. */
  summitAt(x, z, radius = 18) {
    const mn = this._mountainNear(x, z);
    return mn && this._mtnD < radius ? mn : null;
  }

  /** Nearest mountain record via spiral cell search (UI/debug/tests). */
  nearestMountain(x, z, maxCells = 4) {
    const c0x = Math.floor(x / MCELL), c0z = Math.floor(z / MCELL);
    let best = null, bd = Infinity;
    for (let r = 0; r <= maxCells; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const mn = this.mountainCell(c0x + dx, c0z + dz);
          if (!mn) continue;
          const d = Math.hypot(x - mn.x, z - mn.z);
          if (d < bd) { bd = d; best = mn; }
        }
      }
      if (best && r > 0) break; // one extra ring is enough for "nearest"
    }
    return best;
  }

  /**
   * Point + uphill heading on a mountain route; frac 0 = base, 1 = summit.
   * routeIdx 0 = main spiral; 1+ index into altRoutes (signatures).
   */
  roadPoint(mn, frac, routeIdx = 0) {
    const pos = (f) => this._routePos(mn, f, routeIdx);
    const p0 = pos(frac), p1 = pos(Math.min(1.02, frac + 0.004));
    return { x: p0.x, z: p0.z, yaw: Math.atan2(p1.x - p0.x, p1.z - p0.z) };
  }

  _routePos(mn, frac, routeIdx) {
    if (routeIdx > 0 && mn.altRoutes && mn.altRoutes[routeIdx - 1]) {
      const rt = mn.altRoutes[routeIdx - 1];
      if (rt.type === 'spur') {
        const d = (mn.R + 28) * (1 - frac) + 18 * frac;
        return { x: mn.x + Math.cos(rt.phi) * d, z: mn.z + Math.sin(rt.phi) * d };
      }
      const u = frac * rt.uMax;
      const r = rt.rStart - rt.k * u;
      const a = rt.phi + rt.dir * u;
      return { x: mn.x + Math.cos(a) * r, z: mn.z + Math.sin(a) * r };
    }
    const u = frac * mn.uMax;
    const r = mn.rStart - mn.k * u;
    const a = mn.phi + u;
    return { x: mn.x + Math.cos(a) * r, z: mn.z + Math.sin(a) * r };
  }

  /** Drop far-away cached cells; called occasionally to bound memory. */
  pruneCells(x, z) {
    if (this._mcells.size > 64) {
      const mcx = Math.floor(x / MCELL), mcz = Math.floor(z / MCELL);
      for (const key of this._mcells.keys()) {
        const cx = Math.floor(key / 16384) - 8192;
        const cz = (key % 16384) - 8192;
        if (Math.abs(cx - mcx) > 4 || Math.abs(cz - mcz) > 4) this._mcells.delete(key);
      }
    }
    if (this._cells.size < 320) return;
    const pcx = Math.floor(x / CELL), pcz = Math.floor(z / CELL);
    for (const key of this._cells.keys()) {
      const cx = Math.floor(key / 16384) - 8192;
      const cz = (key % 16384) - 8192;
      if (Math.abs(cx - pcx) > 7 || Math.abs(cz - pcz) > 7) this._cells.delete(key);
    }
  }

  // ---- Internals -----------------------------------------------------------

  /**
   * The single sampling pipeline. `info` receives biome weights and masks.
   * `withFeatures`/`withStream` allow feature cells to query "plain" terrain
   * without recursing into themselves.
   */
  _sample(x, z, info, withFeatures, withStream) {
    // Mountain destination influence (computed first: it attenuates the
    // generic masks and damps high-frequency detail under the dome).
    const mtn = this._mountainNear(x, z);
    const mtnD = this._mtnD;
    let mProf = 0, mMod = 1, mCore = 0;
    let roadMask = 0, roadDelta = 0, modBlend = 0;
    const roadCut = this._roadCut;
    roadCut.dr = 1e9; roadCut.w = 3.6; roadCut.fade = 0;
    if (mtn) {
      const t = mtnD / mtn.R;
      if (t < 1) {
        const q = 1 - t * t;
        mProf = q * q;
      }
      mMod = 0.85 + 0.34 * vnoise(x * 0.0045 + 3.3, z * 0.0045 - 7.7, this.SMt + 8);
      // The summit cap uses the per-mountain constant modulation: near the
      // center, arc lengths shrink toward zero, so any winding-gated blend
      // there would concentrate tens of metres of bench shift into a
      // couple of metres of arc (a cliff). A radial blend makes the cap
      // rotationally uniform and the bench math a no-op where it matters.
      if (mtn.modC !== undefined) mMod += (mtn.modC - mMod) * sstep(80, 25, mtnD);
      mCore = sstep(0.02, 0.22, mProf);

      // Spiral road: nearest winding at this angle. The narrow band cancels
      // the dome's radial slope; a wider shoulder blends the flank shape-
      // modulation toward a per-mountain constant so the road itself climbs
      // steadily (bench-cut look on strong flanks).
      const ang = Math.atan2(z - mtn.z, x - mtn.x);
      // Bench shoulder width scales with the modulation delta so the cut
      // beside the road can never exceed ~30 deg.
      const benchW = 26 + Math.min(70, Math.abs(mtn.modC - mMod) * mtn.H * mProf * 1.6);
      // Route contributions are mask-weight blended (never hard-switched):
      // crossings become junction saddles, and every winding fades out at
      // the spiral's start/end (a terminating band used to leave a sheer
      // angular wall of bench offset — the "invisible wall" pop-up bug).
      let wSum = 0, dSum = 0;
      const spiralBand = (phi, dir, rStart, k, uMax, wIn) => {
        let ub = dir * (ang - phi);
        ub -= Math.floor(ub / (2 * Math.PI)) * 2 * Math.PI;
        let mask = 0, delta = 0, bench = 0, bu = 0, drB = 1e9, fadeB = 0;
        // Enumerate windings PAST uMax as virtual continuations: the
        // candidate set is then continuous across the wrap bearing, and the
        // route dissolves by winding RADIUS (angular end-fades concentrated
        // a 40 m bench shift into ~10 m of arc near the summit — the last
        // remaining terrain wall).
        for (; rStart - k * ub > -benchW; ub += 2 * Math.PI) {
          const rk = rStart - k * ub;
          const dr = Math.abs(mtnD - rk);
          if (dr > benchW) continue;
          const fade = sstep(0, 0.5, ub) * sstep(1.5, 6, rk);
          const m2 = sstep(wIn + 2.6, wIn, dr) * fade;
          const b2 = sstep(benchW, 7, dr) * fade;
          if (b2 > bench) bench = b2;
          if (fade > 0.02 && dr < drB) { drB = dr; fadeB = fade; }
          if (m2 > mask) {
            mask = m2;
            bu = ub;
            const tk = rk / mtn.R;
            const qk = tk < 1 ? 1 - tk * tk : 0;
            delta = (qk * qk - mProf) * mtn.H;
            if (mtn.crown) {
              delta += mtn.crown * (sstep(0.72, 0.98, qk * qk) - sstep(0.72, 0.98, mProf));
            }
          }
        }
        return { mask, delta, bench, bu, drB, fadeB, wIn };
      };

      const wMain = (mtn.roadW || 3.6) * (1 - (mtn.narrowTop || 0) * mProf);
      const main = spiralBand(mtn.phi, 1, mtn.rStart, mtn.k, mtn.uMax, wMain);
      roadCut.dr = main.drB; roadCut.w = main.wIn; roadCut.fade = main.fadeB;
      if (mtn.whoopAmp && main.mask > 0) {
        const w2 = Math.max(0, Math.sin(main.bu * mtn.whoopFreq));
        main.delta += mtn.whoopAmp * w2 * w2 * w2 * sstep(0.92, 0.7, mProf);
      }
      roadMask = main.mask;
      modBlend = main.bench;
      wSum += main.mask * main.mask;
      dSum += main.delta * main.mask * main.mask;

      if (mtn.altRoutes) {
        for (let ri = 0; ri < mtn.altRoutes.length; ri++) {
          const rt = mtn.altRoutes[ri];
          if (rt.type === 'spiral') {
            const alt = spiralBand(rt.phi, rt.dir, rt.rStart, rt.k, rt.uMax,
              rt.w * (1 - (rt.narrowTop || 0) * mProf));
            if (alt.drB - alt.wIn < roadCut.dr - roadCut.w) {
              roadCut.dr = alt.drB; roadCut.w = alt.wIn; roadCut.fade = alt.fadeB;
            }
            if (alt.mask > roadMask) roadMask = alt.mask;
            if (alt.bench > modBlend) modBlend = alt.bench;
            wSum += alt.mask * alt.mask;
            dSum += alt.delta * alt.mask * alt.mask;
          } else { // radial spur: rides the dome's own slope (the hard way up)
            let da = ang - rt.phi;
            da = Math.atan2(Math.sin(da), Math.cos(da));
            const arc = Math.abs(da) * mtnD;
            const gate = sstep(mtn.R + 50, mtn.R + 15, mtnD) * sstep(10, 20, mtnD);
            const mask = sstep(rt.w + 2.6, rt.w, arc) * gate;
            if (gate > 0.02 && arc - rt.w < roadCut.dr - roadCut.w) {
              roadCut.dr = arc; roadCut.w = rt.w; roadCut.fade = gate;
            }
            if (mask > roadMask) roadMask = mask;
            wSum += mask * mask; // delta 0: contributes toward no-op flatten
            if (arc < benchW) modBlend = Math.max(modBlend, sstep(benchW, 7, arc) * gate);
          }
        }
      }
      if (wSum > 1e-5) roadDelta = dSum / wSum;
      if (modBlend > 0) mMod += (mtn.modC - mMod) * modBlend;
    }

    // Biome fields.
    const m = fbm2(x * 0.0016, z * 0.0016, this.SM);
    const u = fbm2(x * 0.0020 + 7.3, z * 0.0020 - 3.1, this.SU);
    const a = sstep(0.50, 0.62, m);
    const mnt = sstep(0.64, 0.76, m);
    const lo = 1 - a;
    const wMnt = mnt;
    const wRk = a * (1 - mnt);
    const wF = lo * sstep(0.57, 0.67, u);
    const wFa = lo * (1 - sstep(0.33, 0.43, u));
    const wH = Math.max(0, lo - wF - wFa);

    // Height octaves (manual so a "gentle" 2-octave version is free —
    // trails flatten toward it).
    const n1 = vnoise(x * 0.008, z * 0.008, this.SH) - 0.5;
    const n2 = vnoise(x * 0.016 + 13.7, z * 0.016 - 8.1, this.SH + 1) - 0.5;
    const n3 = vnoise(x * 0.034 - 5.2, z * 0.034 + 19.3, this.SH + 2) - 0.5;
    const n4 = vnoise(x * 0.07 + 27.9, z * 0.07 + 6.6, this.SH + 3) - 0.5;
    const amp = 7 * wH + 9 * wF + 4.4 * wFa + 13 * wRk + 17 * wMnt;
    // Damp high-frequency detail under destination domes: the 2 m mesh
    // cannot represent it, and the visual/collision gap it causes is far
    // more noticeable on steep slopes than the detail itself.
    const rockDetail = (wRk + wMnt * 1.5 + 0.3) * (1 - 0.75 * mCore);
    const hSmooth = n1 * amp; // single-octave base: mountain roads ride this
    let hGentle = (n1 + 0.5 * n2) * amp;
    let h = hGentle + (0.25 * n3 * (rockDetail + 0.4) + 0.11 * n4 * rockDetail) * amp;

    // Ridged mountains.
    if (wMnt + wRk > 0.001) {
      let rr = 1 - Math.abs(2 * vnoise(x * 0.0055 + 3.1, z * 0.0055 - 12.7, this.SR) - 1);
      rr *= rr;
      const ridge = rr * (20 * wMnt + 3.5 * wRk) * (1 - mCore);
      h += ridge;
      hGentle += ridge * 0.8;
    }

    // Terraced farmland (quantize height on masked farm slopes). Kind-5
    // signature mountains carry terraced village fields on their lower dome.
    let terr = wFa * sstep(0.35, 0.50, vnoise(x * 0.006 + 31, z * 0.006 - 17, this.STE)) *
      (1 - mCore);
    if (mtn && mtn.terraceLow) {
      terr = Math.max(terr, sstep(0.04, 0.12, mProf) * (1 - sstep(0.3, 0.45, mProf)) * 0.8);
    }
    if (terr > 0.01) {
      const q = h / 1.1;
      const fq = q - Math.floor(q);
      const hq = (Math.floor(q) + sstep(0.55, 1, fq)) * 1.1;
      h += (hq - h) * Math.min(1, terr * 1.15);
    }

    // Streams (lowland level-set carve; rideable dip, crossable).
    let streamM = 0;
    if (withStream && lo > 0.05) {
      const sN = vnoise(x * 0.004 - 11.3, z * 0.004 + 23.7, this.SS) - 0.5;
      const streamAttn = mtn && mtn.streamKeep ? 1 - 0.35 * mCore : 1 - mCore;
      streamM = sstep(0.034, 0.011, Math.abs(sN)) * lo * streamAttn;
      h -= 1.35 * streamM;
      hGentle -= 1.35 * streamM;
    }

    // Trails: two crossing level-set networks with varying width.
    const t1 = vnoise(x * 0.0033 + 5.1, z * 0.0033 - 9.7, this.ST1) - 0.5;
    const t2 = vnoise(x * 0.0046 - 21.4, z * 0.0046 + 13.9, this.ST2) - 0.5;
    const wV = 0.013 + 0.009 * vnoise(x * 0.02, z * 0.02, this.SW);
    let trailM = Math.max(
      sstep(wV, wV * 0.4, Math.abs(t1)),
      sstep(wV * 0.85, wV * 0.35, Math.abs(t2))
    ) * (1 - mCore);
    // The mountain road flattens base-terrain detail along its band both on
    // and off the dome (the dome's own slope is cancelled separately below);
    // on the dome it references the smoothest single-octave base so the
    // climb never inherits base bumps as sudden pitch changes.
    const hRef = (hGentle + (hSmooth - hGentle) * mCore) * 0.92;
    const pull = (hRef - h) * 0.85;
    let roadFlat = 0;
    if (roadCut.dr < 80) {
      // Widen the cut's falloff with its depth: deep cuts get long, gentle
      // banks instead of 2.6 m trench walls.
      const widen = Math.min(36, Math.abs(pull) * 2.2);
      roadFlat = sstep(roadCut.w + 2.6 + widen, roadCut.w, roadCut.dr) * roadCut.fade;
    }
    const flattenM = Math.max(trailM, roadFlat);
    h += pull * flattenM;

    // Mountain dome + rideable spiral road.
    if (mtn) {
      h += mtn.H * mProf * mMod;
      // Summit crown: an extra cone — the final ascent steepens and the
      // peak reads bigger (the road band cancels its cross-slope like the
      // dome's, so the last stretch is steep but never a wall).
      if (mtn.crown) h += mtn.crown * sstep(0.72, 0.98, mProf);
      if (roadMask > 0) {
        h += roadDelta * mMod * roadMask;
        if (roadMask * 0.95 > trailM) trailM = roadMask * 0.95; // dirt color
      }
      // Road bridges: a ravine cut across the route, spanned by a level deck
      // (the wooden deck prop is placed by the chunk scatter).
      if (mtn.bridgePts) {
        for (let bi = 0; bi < mtn.bridgePts.length; bi++) {
          const bp = mtn.bridgePts[bi];
          const rbx = x - bp.x, rbz = z - bp.z;
          if (rbx * rbx + rbz * rbz > 2500) continue;
          const bu = rbx * bp.dx + rbz * bp.dz;   // along the road
          const bv = -rbx * bp.dz + rbz * bp.dx;  // across the road
          if (Math.abs(bu) < 15 && Math.abs(bv) < 30) {
            const deck = sstep(9, 6.5, Math.abs(bu)) * sstep(2.6, 1.9, Math.abs(bv));
            const gully = Math.cos((bu / 30) * Math.PI);
            h -= 3.4 * gully * gully * sstep(30, 8, Math.abs(bv)) * (1 - deck);
            if (bp.h0 > h) h += (bp.h0 - h) * deck;
          }
        }
      }
    }

    if (info) {
      info.wH = wH; info.wF = wF; info.wFa = wFa; info.wRk = wRk; info.wMnt = wMnt;
      info.lo = lo; info.trail = trailM; info.stream = streamM; info.terr = terr;
      info.jit = vnoise(x * 0.13, z * 0.13, this.SJ);
      info.dry = sstep(0.55, 0.8, vnoise(x * 0.03 + 17.3, z * 0.03 - 9.9, this.SJ + 5));
      info.mtn = mProf;
      info.mtnH = mtn ? mtn.H : 0;
      info.mtnKind = mtn && mtn.kind ? mtn.kind : 0;
      info.mtnRef = mtn || null;
    }

    if (withFeatures) h = this._features(x, z, h);
    return h;
  }

  /** Apply mound/ramp/bridge height contributions from the 3x3 nearby cells. */
  _features(x, z, h) {
    const ccx = Math.floor(x / CELL), ccz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const f = this.cellFeature(ccx + dx, ccz + dz);
        if (!f) continue;
        const rx = x - f.x, rz = z - f.z;
        if (f.type === 'mound') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (u > -11 && u < 11 && v > -7 && v < 7) {
            const cu = Math.cos((u / 22) * Math.PI), cv = Math.cos((v / 14) * Math.PI);
            h += 1.8 * cu * cu * cv * cv;
          }
        } else if (f.type === 'ramp') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          // Kicker: rises to 2.9 m over 9 m, sharp drop past the lip.
          if (u > -1.5 && u < 9.4 && Math.abs(v) < 3.4) {
            const t = Math.min(1, Math.max(0, u / 9));
            const prof = 2.9 * Math.pow(t, 1.8);
            const w = sstep(-1.5, 0.5, u) * sstep(3.4, 2.2, Math.abs(v));
            const target = f.h0 + prof;
            if (target > h) h += (target - h) * w;
          }
        } else { // bridge: flat deck over the stream, ends blend into banks
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (Math.abs(u) < 6.5 && Math.abs(v) < 2.6) {
            const e = sstep(6.5, 5.0, Math.abs(u)) * sstep(2.6, 1.8, Math.abs(v));
            if (f.h0 > h) h += (f.h0 - h) * e;
          }
        }
      }
    }
    return h;
  }

  _computeCell(cx, cz) {
    const r0 = hash01(cx, cz, this.SF);
    const px = (cx + 0.2 + 0.6 * hash01(cx, cz, this.SF + 1)) * CELL;
    const pz = (cz + 0.2 + 0.6 * hash01(cx, cz, this.SF + 2)) * CELL;
    const info = makeInfo();

    // Bridge: scan the cell coarsely for a trail/stream crossing.
    if (r0 < 0.55) {
      for (let gi = 0; gi < 5; gi++) {
        for (let gj = 0; gj < 5; gj++) {
          const bx = (cx + (gi + 0.5) / 5) * CELL;
          const bz = (cz + (gj + 0.5) / 5) * CELL;
          this._sample(bx, bz, info, false, true);
          if (info.trail > 0.5 && info.stream > 0.62 && this._domeProf(bx, bz) < 0.03) {
            const d = this._trailDir(bx, bz);
            const h0 = this._sample(bx, bz, null, false, false) + 0.12; // bank height (no carve)
            return { type: 'bridge', x: bx, z: bz, dx: d.x, dz: d.z, h0 };
          }
        }
      }
    }

    if (r0 < 0.05) {
      // Built kicker ramp: only on trails, gentle ground, with a safe landing.
      this._sample(px, pz, info, false, true);
      if (info.trail > 0.45 && info.lo > 0.35 && this._domeProf(px, pz) < 0.03) {
        const d = this._trailDir(px, pz);
        if (hash01(cx, cz, this.SF + 3) < 0.5) { d.x = -d.x; d.z = -d.z; }
        const h0 = this._sample(px, pz, null, false, true);
        const hLand = this._sample(px + d.x * 18, pz + d.z * 18, null, false, true);
        if (hLand < h0 + 1.8 && hLand > h0 - 9) {
          return { type: 'ramp', x: px, z: pz, dx: d.x, dz: d.z, h0 };
        }
      }
      return null;
    }
    if (r0 < 0.30) {
      // Natural dirt mound (jumpable from both sides).
      this._sample(px, pz, info, false, true);
      if (info.lo > 0.3 && info.stream < 0.1 && this._domeProf(px, pz) < 0.03) {
        const ang = hash01(cx, cz, this.SF + 4) * Math.PI * 2;
        return { type: 'mound', x: px, z: pz, dx: Math.sin(ang), dz: Math.cos(ang), h0: 0 };
      }
    }
    return null;
  }

  /** Unit direction along the locally dominant trail (perpendicular to its gradient). */
  _trailDir(x, z) {
    const e = 1.5;
    const c1 = Math.abs(vnoise(x * 0.0033 + 5.1, z * 0.0033 - 9.7, this.ST1) - 0.5);
    const c2 = Math.abs(vnoise(x * 0.0046 - 21.4, z * 0.0046 + 13.9, this.ST2) - 0.5);
    const sc = c1 < c2 ? 0.0033 : 0.0046;
    const ox = c1 < c2 ? 5.1 : -21.4, oz = c1 < c2 ? -9.7 : 13.9;
    const salt = c1 < c2 ? this.ST1 : this.ST2;
    const gx = vnoise((x + e) * sc + ox, z * sc + oz, salt) - vnoise((x - e) * sc + ox, z * sc + oz, salt);
    const gz = vnoise(x * sc + ox, (z + e) * sc + oz, salt) - vnoise(x * sc + ox, (z - e) * sc + oz, salt);
    const len = Math.hypot(gz, gx) || 1;
    return { x: -gz / len, z: gx / len };
  }
}

const FARM_PALETTE = [
  [0.47, 0.52, 0.22],
  [0.68, 0.58, 0.26], // ripe mustard/paddy gold
  [0.36, 0.48, 0.20],
  [0.58, 0.53, 0.24],
];

/** Materialize alternate route definitions from signature specs. */
function buildAltRoutes(mn) {
  const routes = [];
  if (mn.alt) {
    const uMax = mn.alt.turns * 2 * Math.PI;
    routes.push({
      type: 'spiral', dir: -1,
      phi: mn.phi + 2.1,
      rStart: mn.rStart,
      k: (mn.rStart - ROAD_END_R) / uMax,
      uMax,
      w: mn.alt.w,
      narrowTop: mn.alt.narrowTop || 0,
    });
  }
  if (mn.spur) {
    routes.push({ type: 'spur', phi: mn.phi + mn.spur.bearingOff, w: mn.spur.w });
  }
  return routes;
}

export function makeInfo() {
  return {
    h: 0, wH: 0, wF: 0, wFa: 0, wRk: 0, wMnt: 0, lo: 0,
    trail: 0, stream: 0, terr: 0, jit: 0, dry: 0, mtn: 0, mtnH: 0, mtnKind: 0, mtnRef: null,
  };
}
