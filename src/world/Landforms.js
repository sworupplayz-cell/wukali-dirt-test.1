import { vnoise, sstep } from './noise.js';

/**
 * Landforms (Phase 3) — the authored major-landform skeleton of the
 * Horizon Ride continent, evaluated analytically per world coordinate.
 *
 * NOT random isolated cones: mountains are nodes on 4 RIDGE CHAINS
 * (polylines). Between consecutive peaks the ridge dips into a SADDLE;
 * 12 saddles carry PASS ROADS (serpentine switchback corridors blended
 * into the terrain). Each chain contributes a broad pedestal (massif
 * base) plus a narrower upper ridge, so ranges read as connected
 * mountain systems with foothills, not spikes.
 *
 *   - 18 named peaks on 4 chains (each unique height/radius/name)
 *   - 14 saddles, 12 of them road-crossed mountain passes
 *   - 6 U-shaped (glacial trough) + 8 V-shaped (gorge) valleys
 *   - 6 basins (lowest ~ -120 m) and 5 escarpments
 *   - a 5-turn spiral switchback road to the highest summit
 *     (Rajadhara Summit, ~4600 m)
 *
 * Everything is a deterministic pure function of (x, z): the streamed
 * tiles only sample it, so borders stay bit-identical. Road centerline
 * elevations are cached ONCE at startup from the raw (road-free) field,
 * then smoothed — so roads climb at rideable grades (~20%) while the
 * flanks around them stay steep.
 */

const S = 1214;

// ---- Ridge chains: nodes = peaks [x, z, height, radius, name] -------------
const CHAINS = [
  {
    id: 'A', name: 'Crown Range',
    nodes: [
      [600, 800, 1800, 550, 'Vandra Peak'],
      [2100, 950, 2600, 700, 'Mount Sorren'],
      [3600, 750, 3150, 800, 'Kalveri Spire'],
      [5300, 1000, 2900, 750, 'Ashfell Crown'],
      [7000, 1000, 4540, 1050, 'Rajadhara Summit'],
      [8700, 1100, 3350, 850, 'Ghantir Horn'],
      [9700, 900, 2200, 600, 'Eastwatch Peak'],
    ],
    dips: [0.34, 0.30, 0.36, 0.32, 0.30, 0.38],
  },
  {
    id: 'B', name: 'Mistral Wall',
    nodes: [
      [1100, 1900, 2300, 650, 'Mistral Tor'],
      [900, 2900, 2850, 750, 'Vel Morra'],
      [1300, 3800, 2500, 650, 'Thornspire'],
      [1900, 4500, 1900, 550, 'Lowen Knab'],
    ],
    dips: [0.35, 0.33, 0.37],
  },
  {
    id: 'C', name: 'Southern Teeth',
    nodes: [
      [3800, 4400, 2100, 600, 'Serpent Dome'],
      [5300, 4600, 2700, 700, 'Umberfang'],
      [6900, 4300, 3050, 800, 'Dravok Peak'],
      [8500, 4550, 2400, 650, 'Suntooth'],
    ],
    dips: [0.36, 0.32, 0.35],
  },
  {
    id: 'D', name: 'Grey Spur',
    nodes: [
      [6100, 1900, 1400, 420, 'Fenn Ridge'],
      [6900, 2300, 1700, 480, 'Harrow Knoll'],
      [7700, 2700, 1300, 400, 'Grey Sentinel'],
    ],
    dips: [0.40, 0.42],
  },
];

const PED_W = 2.2;   // pedestal half-width = PED_W * radius
const PED_F = 0.42;  // pedestal fraction of peak height
const UP_W = 0.85;   // upper-ridge half-width factor
const UP_F = 0.58;

// Highest summit: flattened top + spiral road (chain A node 4).
const SUMMIT = { cx: 7000, cz: 1000, top: 4590, plateauR: 150 };
const SPIRAL = { r0: 800, r1: 110, w: 15, grade: 0.21 };

// ---- Valleys [type, pts(3), headE, mouthE, floorW] ------------------------
const VALLEYS = [
  ['U', [[2900, 1250], [3100, 1900], [3300, 2600]], 300, 30, 70],
  ['U', [[5900, 1350], [5700, 2000], [5400, 2600]], 330, 25, 75],
  ['U', [[1600, 2450], [2300, 2600], [3000, 2700]], 260, 20, 65],
  ['U', [[7900, 1500], [8100, 2200], [8300, 2900]], 340, 30, 80],
  ['U', [[4700, 4150], [4500, 3400], [4300, 2950]], 300, 25, 70],
  ['U', [[7600, 4050], [7300, 3500], [7000, 3100]], 320, 30, 65],
  ['V', [[1500, 1300], [2000, 1600], [2600, 1750]], 280, 40, 5],
  ['V', [[4300, 1400], [4500, 1800], [4600, 2200]], 320, 35, 5],
  ['V', [[9200, 1300], [9000, 1900], [8800, 2500]], 300, 45, 5],
  ['V', [[1500, 4200], [2200, 4000], [2900, 3900]], 260, 30, 5],
  ['V', [[6200, 4150], [6000, 3800], [5800, 3450]], 290, 40, 5],
  ['V', [[9100, 4200], [9000, 3700], [8900, 3300]], 280, 35, 5],
  ['V', [[700, 3300], [1600, 3200], [2400, 3100]], 320, 25, 5],
  ['V', [[2600, 1050], [2700, 1500], [2800, 1950]], 300, 40, 5],
];

// ---- Basins [cx, cz, rx, rz, depth] ---------------------------------------
const BASINS = [
  [2500, 2200, 700, 450, -70],
  [4800, 3300, 800, 500, -125], // lowest point of the world
  [8600, 3300, 550, 400, -90],
  [2900, 3600, 500, 380, -55],
  [6300, 3100, 500, 350, -45],
  [9500, 2300, 500, 400, -75],
];

// ---- Escarpments [x1,z1, x2,z2, drop, rampW] ------------------------------
const ESCARPMENTS = [
  [3000, 3000, 4200, 3600, 45, 70],
  [5900, 2900, 6800, 3300, 35, 60],
  [1800, 1500, 2600, 1900, 40, 70],
  [7600, 3700, 8400, 4000, 50, 80],
  [2200, 3300, 2900, 3700, 30, 60],
];

// Passes: [chainIdx, gapIdx] — 12 of the 14 saddles carry roads.
// (The two saddles flanking Rajadhara Summit sit inside its spiral road's
// disc — that crossing is served by the spiral itself; the Grey Spur
// saddles carry roads instead.)
const PASS_GAPS = [
  [0, 0], [0, 1], [0, 2], [0, 5],
  [1, 0], [1, 1], [1, 2],
  [2, 0], [2, 1], [2, 2],
  [3, 0], [3, 1],
];

const ROAD_HALF = 7;      // full road-bed half width (m)
const ROAD_FADE_MIN = 16; // apron reaches 0 here on flat ground...
const ROAD_FADE_MAX = 110; // ...and widens with cut/fill depth (bench cuts)
const PASS_WAVE = 340;    // switchback wavelength along the pass axis (m)
const PASS_GRADE = 0.20;  // max climbing grade of any road, by construction
const RD_STEP = 16;       // road polyline vertex spacing (m of arc)
const RD_CELL = 128;      // spatial-hash cell size (m)

const q4 = (t) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));
const smin = (a, b, k) => {
  const h = Math.max(0, k - Math.abs(a - b));
  return Math.min(a, b) - (h * h) / (4 * k);
};

export class Landforms {
  constructor() {
    this.peaks = [];
    for (const c of CHAINS) {
      c.bbox = chainBBox(c);
      c.nodes.forEach((n, i) => this.peaks.push({
        id: `${c.id}${i}`, chain: c.name, x: n[0], z: n[1], h: n[2], r: n[3], name: n[4],
      }));
    }
    this.valleys = VALLEYS.map(([type, pts, headE, mouthE, floorW]) => ({
      type, pts, headE, mouthE, floorW, bbox: ptsBBox(pts, type === 'U' ? 760 : 480),
    }));
    this.passes = [];   // filled by initRoads()
    this.spiral = null; // filled by initRoads()
    this.roadKm = 0;
  }

  stats() {
    return {
      peaks: this.peaks.length,
      chains: CHAINS.length,
      saddles: CHAINS.reduce((n, c) => n + c.nodes.length - 1, 0),
      passes: this.passes.length,
      valleysU: this.valleys.filter((v) => v.type === 'U').length,
      valleysV: this.valleys.filter((v) => v.type === 'V').length,
      basins: BASINS.length,
      escarpments: ESCARPMENTS.length,
      roadKm: +this.roadKm.toFixed(1),
      highest: SUMMIT.top + 6,
    };
  }

  // ---- Mountains (chains) --------------------------------------------------

  /** Ridge-chain contribution (pedestal + upper ridge + ruggedness). */
  mountains(x, z) {
    let best = 0, up = 0;
    for (const c of CHAINS) {
      const bb = c.bbox;
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      // Nearest point on the chain polyline.
      let d2 = Infinity, gi = 0, gu = 0;
      for (let i = 0; i < c.nodes.length - 1; i++) {
        const a = c.nodes[i], b = c.nodes[i + 1];
        const r = segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (r.d2 < d2) { d2 = r.d2; gi = i; gu = r.t; }
      }
      const a = c.nodes[gi], b = c.nodes[gi + 1];
      const fs = gu * gu * (3 - 2 * gu);
      const H = a[2] + (b[2] - a[2]) * fs;
      const R = a[3] + (b[3] - a[3]) * fs;
      const sad = 1 - c.dips[gi] * Math.sin(Math.PI * gu) ** 2;
      const Hs = H * sad;
      const d = Math.sqrt(d2);
      const pu = q4(d / (UP_W * R));
      const h = PED_F * Hs * q4(d / (PED_W * R)) + UP_F * Hs * pu;
      if (h > best) { best = h; up = pu; }
    }
    if (best <= 0) return 0;
    // Alpine ruggedness on the massif (roads/plateau override it later).
    const rug = (vnoise(x * 0.0045, z * 0.0045, S + 61) - 0.5) * 150 * Math.min(1, best / 700);
    return best + rug * (0.35 + 0.65 * up);
  }

  /** Summit plateau: flatten the top of the highest peak (rideable). */
  plateau(x, z, h) {
    const dx = x - SUMMIT.cx, dz = z - SUMMIT.cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > SUMMIT.plateauR * SUMMIT.plateauR) return h;
    const m = q4(Math.sqrt(d2) / SUMMIT.plateauR);
    return h + (SUMMIT.top + 6 * m - h) * m;
  }

  basins(x, z) {
    let h = 0;
    for (const [cx, cz, rx, rz, depth] of BASINS) {
      const dx = (x - cx) / rx, dz = (z - cz) / rz;
      const p2 = dx * dx + dz * dz;
      if (p2 < 1) h += depth * q4(Math.sqrt(p2));
    }
    return h;
  }

  escarpments(x, z) {
    let h = 0;
    for (const [x1, z1, x2, z2, drop, W] of ESCARPMENTS) {
      const tx = x2 - x1, tz = z2 - z1;
      const len = Math.hypot(tx, tz);
      const ux = tx / len, uz = tz / len;
      const px = x - x1, pz = z - z1;
      const along = (px * ux + pz * uz) / len;
      if (along < -0.2 || along > 1.2) continue;
      const side = px * -uz + pz * ux; // signed distance across the line
      if (Math.abs(side) > W * 3) continue;
      const f = sstep(-0.15, 0.1, along) * sstep(1.15, 0.9, along);
      h += drop * f * (0.5 - sstep(-W / 2, W / 2, side));
    }
    return h;
  }

  /** Carve U/V valleys into h. Sets L.vroad (U-valley floor trail mask). */
  carveValleys(x, z, h, L) {
    for (const v of this.valleys) {
      const bb = v.bbox;
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      let d2 = Infinity, gt = 0;
      const n = v.pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = v.pts[i], b = v.pts[i + 1];
        const r = segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (r.d2 < d2) { d2 = r.d2; gt = (i + r.t) / n; }
      }
      const d = Math.sqrt(d2);
      const ts = gt * gt * (3 - 2 * gt);
      const floorE = v.headE + (v.mouthE - v.headE) * ts;
      let prof;
      if (v.type === 'U') {
        const dw = Math.max(0, d - v.floorW);
        prof = floorE + 0.0055 * dw * dw + Math.pow(d / 700, 8) * 5000;
      } else {
        prof = floorE + 0.42 * Math.max(0, d - v.floorW) + Math.pow(d / 420, 8) * 3500;
      }
      if (prof < h + 16) {
        const carved = smin(h, prof, 16);
        // Trail along U-valley floors (only where the valley actually cuts).
        if (v.type === 'U' && d < 12 && carved < h - 1) {
          const m = 1 - sstep(4, 11, d);
          if (m > L.vroad) L.vroad = m;
        }
        h = carved;
      }
    }
    return h;
  }

  // ---- Roads ----------------------------------------------------------------

  /**
   * Build all mountain roads ONCE at startup (deterministic):
   *
   *   PASS ROADS — for each of the 12 road-carrying saddles, a switchback
   *   walker starts at the saddle and descends BOTH flanks: it moves
   *   mostly along-chain (traversing the slope), drifts outward, and
   *   hairpins every ~PASS_WAVE/2 m of arc — classic scenic switchbacks.
   *   Vertex elevations follow the raw terrain but are GRADE-CLAMPED to
   *   ±PASS_GRADE per metre of arc from the saddle outward, so the road
   *   is rideable BY CONSTRUCTION; where the mountainside is steeper the
   *   road benches into the flank (cut/fill apron widens automatically).
   *
   *   SPIRAL ROAD — a 5-loop spiral to the Rajadhara Summit plateau with
   *   arc-linear elevation at ~21% grade.
   *
   * All roads become one polyline soup in a spatial hash; the per-sample
   * roads() query only inspects nearby segments.
   */
  initRoads(raw) {
    this._rx = [];   // vertex x
    this._rz = [];   // vertex z
    this._re = [];   // vertex elevation
    this._rid = [];  // road id per vertex (segments never span two roads)
    this._hash = new Map();
    let roadId = 0, totalM = 0;

    for (const [ci, gi] of PASS_GAPS) {
      const c = CHAINS[ci];
      const a = c.nodes[gi], b = c.nodes[gi + 1];
      const sx = (a[0] + b[0]) / 2, sz = (a[1] + b[1]) / 2; // saddle
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const vx = (b[0] - a[0]) / tl, vz = (b[1] - a[1]) / tl; // along-chain
      const ux = -vz, uz = vx;                                // across-chain
      const saddleE = raw(sx, sz);
      let lenM = 0;
      const flankIds = [];
      // Each flank is its OWN polyline id — otherwise the second flank's
      // first vertex would form a phantom segment from the end of the
      // first flank back to the saddle, cutting across the massif.
      for (const side of [1, -1]) {
        flankIds.push(roadId);
        lenM += this._walkSwitchbacks(raw, sx, sz, saddleE,
          ux * side, uz * side, vx, vz, roadId);
        roadId++;
      }
      this.passes.push({
        id: `${c.id}${gi}-${c.id}${gi + 1}`, name: `${a[4]} / ${b[4]} Pass`,
        sx, sz, elev: +saddleE.toFixed(0), lengthM: lenM, roadId: flankIds[0], flankIds,
      });
      totalM += lenM;
    }

    // Spiral summit road (arc-linear elevation, ~21% grade).
    const { cx, cz } = SUMMIT;
    const { r0, r1 } = SPIRAL;
    const Eb = raw(cx + r0 * Math.cos(1.5 * Math.PI), cz + r0 * Math.sin(1.5 * Math.PI));
    const Et = SUMMIT.top + 2;
    const sTot = (Et - Eb) / SPIRAL.grade;
    const TH = (2 * sTot) / (r0 + r1); // s = ∫ r dθ for linear r(θ)
    this.spiral = { cx, cz, r0, r1, TH, Eb, Et, sTot, phi0: 1.5 * Math.PI, roadId };
    let th = 0;
    while (th <= TH) {
      const p = this.spiralPoint(th);
      this._pushVertex(p.x, p.z, p.h, roadId);
      const r = r0 + ((r1 - r0) * th) / TH;
      th += RD_STEP / r;
    }
    const top = this.spiralPoint(TH);
    this._pushVertex(top.x, top.z, Et, roadId);
    this._pushVertex(cx, cz, SUMMIT.top + 6, roadId); // onto the plateau
    totalM += sTot + Math.hypot(top.x - cx, top.z - cz);
    roadId++;

    // U-valley floor trails (carved by the valleys themselves).
    for (const v of this.valleys) {
      if (v.type !== 'U') continue;
      for (let i = 0; i < v.pts.length - 1; i++) {
        totalM += Math.hypot(v.pts[i + 1][0] - v.pts[i][0], v.pts[i + 1][1] - v.pts[i][1]);
      }
    }
    this.roadKm = totalM / 1000;
  }

  /**
   * Switchback walker for one flank of a pass — CONTOUR-AWARE: at every
   * step it tries several headings around the traverse direction and
   * follows the one whose ground elevation best matches the target
   * descent profile (e - grade*step). The result hugs the mountainside
   * like a real engineered road: it traverses, wraps around noses, and
   * hairpins on the serpentine clock instead of boring into rising rock.
   * Returns metres of road.
   */
  _walkSwitchbacks(raw, sx, sz, saddleE, ox, oz, vx, vz, roadId) {
    let x = sx, z = sz, e = saddleE;
    let lat = 1;            // along-chain direction, flips at hairpins
    let sinceTurn = 0;
    let len = 0;
    let hx = ox, hz = oz;   // leave the saddle outward
    this._pushVertex(x, z, e, roadId);
    for (let i = 0; i < 400; i++) {
      // Base traverse direction for this switchback leg (0.45 outward
      // drift keeps adjacent legs ~70 m apart so their beds never merge).
      let bx = vx * lat + ox * 0.45, bz = vz * lat + oz * 0.45;
      const bl = Math.hypot(bx, bz);
      bx /= bl; bz /= bl;
      // Candidate fan: pick the heading whose ground best matches the
      // descending road elevation; mild penalty for sharp turns.
      const eWant = e - PASS_GRADE * RD_STEP * 0.8;
      let bestS = Infinity, bhx = bx, bhz = bz;
      for (let a = -0.9; a <= 0.9; a += 0.15) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const cx2 = bx * ca - bz * sa, cz2 = bx * sa + bz * ca;
        // Keep continuity with the previous heading (no instant U-turns).
        if (cx2 * hx + cz2 * hz < -0.2) continue;
        const eC = raw(x + cx2 * RD_STEP, z + cz2 * RD_STEP);
        const score = Math.abs(eC - eWant) + Math.abs(a) * 1.6;
        if (score < bestS) { bestS = score; bhx = cx2; bhz = cz2; }
      }
      // Hairpins ride nearly level: the steeper the turn, the flatter the
      // step (real switchback curves are built flat — and it stops two
      // folded-back legs from stacking a wall between them).
      const turn = Math.max(0, (bhx * hx + bhz * hz + 1) / 2); // 1 straight .. 0 U-turn
      hx = bhx; hz = bhz;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      const eT = raw(nx2, nz2);
      // Grade-clamped: follow ground where gentle, bench where steeper.
      const gStep = PASS_GRADE * RD_STEP * (0.15 + 0.85 * turn * turn);
      let eN = Math.max(e - gStep, Math.min(e + gStep, eT));
      // Around a hairpin elbow the new leg runs close to the previous
      // one: keep the elevation gap to any nearby own vertex below a 30%
      // wall so folded legs never stack a cliff between their beds.
      const cur0 = this._rx.length - 1;
      for (let b2 = 4; b2 <= 22; b2++) {
        const i2 = cur0 - b2;
        if (i2 < 0 || this._rid[i2] !== roadId) break;
        const dpx = nx2 - this._rx[i2], dpz = nz2 - this._rz[i2];
        const dp = Math.hypot(dpx, dpz);
        if (dp < 60) {
          const lim = Math.max(1.5, 0.3 * dp);
          const ei = this._re[i2];
          eN = Math.max(ei - lim, Math.min(ei + lim, eN));
        }
      }
      // Stop BEFORE the step if it would cross another road (or this
      // road's own distant past) at a conflicting elevation — same-level
      // meetings become natural junctions and are kept.
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      // Never enter the summit spiral's disc.
      const dsx = nx2 - SUMMIT.cx, dsz = nz2 - SUMMIT.cz;
      if (dsx * dsx + dsz * dsz < (SPIRAL.r0 + 130) * (SPIRAL.r0 + 130)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId);
      len += RD_STEP;
      sinceTurn += RD_STEP;
      if (sinceTurn > PASS_WAVE / 2) { lat = -lat; sinceTurn = 0; }
      // Done when the road has rejoined the terrain in the lowlands.
      if (this.mountains(x, z) < 45 && Math.abs(e - eT) < 3) break;
      // No mega-embankments: if the ground has fallen >26 m below the
      // bench (a gorge crossing — that would be a bridge, and Phase 3
      // has no bridges) stop and tie off on this side.
      if (e - eT > 26) break;
      if (x < 60 || x > 9940 || z < 60 || z > 4940) break;
    }
    // Landing taper: wherever the walk stopped, ease the road elevation
    // into the terrain over extra steps (grade-capped at 28%) so a road
    // tip never leaves a step/cliff in the surface.
    for (let i = 0; i < 60; i++) {
      const eT0 = raw(x, z);
      if (Math.abs(e - eT0) < 1) break;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      if (nx2 < 40 || nx2 > 9960 || nz2 < 40 || nz2 > 4960) break;
      const eT = raw(nx2, nz2);
      const eN = Math.max(e - 0.28 * RD_STEP, Math.min(e + 0.28 * RD_STEP, eT));
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId);
      len += RD_STEP;
    }
    return len;
  }

  /**
   * True if a road passes near (x,z) at a very different height — either
   * ANOTHER road, or THIS road's own distant past (a contour walker that
   * loops around a peak must not cross its own earlier bench).
   */
  _conflict(x, z, e, roadId) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    const cur = this._rx.length - 1; // index of the vertex just pushed
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - this._rx[i], ddz = z - this._rz[i];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > 110 * 110) continue;
          const d = Math.sqrt(d2);
          if (this._rid[i] === roadId) {
            // Own path: only a LOOP-BACK is a conflict — the walked arc
            // to vertex i is much longer than the straight-line gap.
            // (Consecutive switchback legs diverge at >120°, so their
            // euclid/arc ratio stays >0.7 and never triggers this.)
            const arc = (cur - i) * RD_STEP;
            if (arc < 8 * RD_STEP || d > 0.35 * arc) continue;
          }
          // Slope criterion: if the wall between the two benches would
          // exceed ~30%, the roads conflict (junctions at matching
          // elevations remain allowed).
          const dE = Math.abs(e - this._re[i]);
          if (dE > Math.max(3, 0.30 * d)) return true;
        }
      }
    }
    return false;
  }

  _pushVertex(x, z, e, roadId) {
    const idx = this._rx.length;
    this._rx.push(x); this._rz.push(z); this._re.push(e); this._rid.push(roadId);
    const key = `${Math.floor(x / RD_CELL)},${Math.floor(z / RD_CELL)}`;
    let arr = this._hash.get(key);
    if (!arr) this._hash.set(key, (arr = []));
    arr.push(idx);
  }

  /**
   * Blend all mountain roads into h — a WEIGHTED AVERAGE over every
   * nearby road segment (spatial hash, 3x3 cells). Unlike a
   * nearest-segment pick, the weighted blend is continuous everywhere:
   * between two switchback legs the influence hands over smoothly, so
   * there is never a step on the Voronoi midline. The apron of each
   * segment widens with its cut/fill depth (bench cuts into steep
   * flanks stay smooth). Sets L.road.
   */
  roads(x, z, h, L) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let wSum = 0, weSum = 0, dMin2 = Infinity, nearE = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          // Segment i -> i+1 (same road only).
          const j = i + 1 < this._rx.length && this._rid[i + 1] === this._rid[i] ? i + 1 : i;
          const ax = this._rx[i], az = this._rz[i];
          const abx = this._rx[j] - ax, abz = this._rz[j] - az;
          const l2 = abx * abx + abz * abz;
          let t = l2 > 0 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = x - (ax + abx * t), pz = z - (az + abz * t);
          const d2 = px * px + pz * pz;
          if (d2 > ROAD_FADE_MAX * ROAD_FADE_MAX) continue;
          const E = this._re[i] + (this._re[j] - this._re[i]) * t;
          const d = Math.sqrt(d2);
          const fade = Math.min(ROAD_FADE_MAX, ROAD_FADE_MIN + Math.abs(E - h) * 1.9);
          if (d >= fade) continue;
          let w = 1 - sstep(0, fade, d);
          w *= w;
          wSum += w; weSum += w * E;
          if (d2 < dMin2) { dMin2 = d2; nearE = E; }
        }
      }
    }
    if (wSum <= 0) return h;
    const dMin = Math.sqrt(dMin2);
    // ON the bed the road must follow ITS OWN centerline elevation (the
    // weighted average would let a neighboring switchback leg bend it);
    // outside the bed the weighted average keeps everything continuous.
    const bedSnap = 1 - sstep(ROAD_HALF * 0.9, ROAD_FADE_MIN, dMin);
    const roadE = (weSum / wSum) * (1 - bedSnap) + nearE * bedSnap;
    const mask = 1 - sstep(ROAD_HALF, ROAD_FADE_MIN, dMin);
    const blend = Math.max(mask, Math.min(0.92, wSum));
    h += (roadE - h) * blend;
    const bed = 1 - sstep(ROAD_HALF * 0.8, ROAD_HALF * 1.9, dMin);
    if (bed > L.road) L.road = bed;
    return h;
  }

  /** Point + tangent heading on the spiral (tests / debug). */
  spiralPoint(th) {
    const sp = this.spiral;
    const r = sp.r0 + ((sp.r1 - sp.r0) * th) / sp.TH;
    const phi = sp.phi0 + th;
    const x = sp.cx + r * Math.cos(phi), z = sp.cz + r * Math.sin(phi);
    const s = sp.r0 * th + ((sp.r1 - sp.r0) * th * th) / (2 * sp.TH);
    const drdth = (sp.r1 - sp.r0) / sp.TH;
    const tx = -r * Math.sin(phi) + drdth * Math.cos(phi);
    const tz = r * Math.cos(phi) + drdth * Math.sin(phi);
    return {
      x, z,
      h: sp.Eb + (sp.Et - sp.Eb) * (s / sp.sTot),
      yaw: Math.atan2(tx, tz),
    };
  }

  /** A point on a pass road: n-th vertex of the pass's polyline. */
  passPoint(pi, n) {
    const p = this.passes[pi];
    let i0 = this._rid.indexOf(p.roadId);
    const i = Math.min(this._rx.length - 1, i0 + n);
    if (this._rid[i] !== p.roadId) return null;
    return { x: this._rx[i], z: this._rz[i], e: this._re[i] };
  }

  /** Nearest peak whose massif contains (x,z), or null. */
  peakAt(x, z) {
    let best = null, bestD = Infinity;
    for (const p of this.peaks) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r * PED_W && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
}

// ---- helpers ----------------------------------------------------------------

function segNearest(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = ((px - ax) * abx + (pz - az) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return { t, d2: dx * dx + dz * dz };
}

function chainBBox(c) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, m = 0;
  for (const n of c.nodes) {
    x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]);
    z0 = Math.min(z0, n[1]); z1 = Math.max(z1, n[1]);
    m = Math.max(m, n[3] * PED_W + 120);
  }
  return [x0 - m, x1 + m, z0 - m, z1 + m];
}

function ptsBBox(pts, margin) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
  }
  return [x0 - margin, x1 + margin, z0 - margin, z1 + margin];
}


