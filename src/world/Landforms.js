import { vnoise, sstep } from './noise.js';

/**
 * Landforms — Phase 3 WORLD REDESIGN (roads-first).
 *
 * The old mountain height algorithm is GONE. This is a new world plan for
 * the reduced 8,000 x 4,000 m map (128 permanent sectors), built in the
 * order gameplay demands:
 *
 *   1. MAIN DIRT ROADS   — authored first: the Horizon Loop (a 7 m road
 *                          circling the whole map) + four arms meeting in
 *                          a 4-way intersection at Rider's Meadow.
 *   2. VALLEYS           — the road corridors ARE the valleys: a corridor
 *                          mask suppresses all later landforms near every
 *                          main road, so roads always sit in wide, gentle
 *                          valley floors (100-350 m elevation band).
 *   3. ROLLING HILLS     — soft fabric between the corridors.
 *   4. MOUNTAIN RANGES   — scenery, added LAST in height composition and
 *                          only where the corridor mask allows: 4 connected
 *                          perimeter ranges (16 named peaks, highest
 *                          Kanjiro Peak ~2200 m) built from a new
 *                          spine-profile algorithm (cos^2 crest + wide
 *                          quartic skirt, domain-warped flanks).
 *   5. MOUNTAIN PASSES   — 6 switchback pass roads (5 m) laid by the
 *                          contour-aware walker over range saddles.
 *   6. HIDDEN TRAILS     — the lowland trail grid (2.5 m, in TerrainField)
 *                          plus scenic viewpoints computed ON the roads.
 *
 * RIDER'S MEADOW — handcrafted spawn area at the world center (4000,2000):
 * flat grass meadow (r 600), small lake, gentle undulation, the 4-way
 * intersection, signpost, abandoned cabin, one practice jump, and the
 * Northwall range as backdrop. No cliffs, no steep ground.
 *
 * Everything is a deterministic pure function of (x, z); roads are laid
 * once at startup into a spatial hash and blended into every sample.
 */

export const WORLD_W = 8000;
export const WORLD_H = 4000;
export const MEADOW = { x: 4000, z: 2000, r: 600, e: 165 };
export const LAKE = { x: 4230, z: 2210, r: 90, depth: 6 };
// Phase 3.1: the south is grasslands & LAKES — two more water bodies on
// the way down the South Arm (meadow lake first for back-compat).
export const LAKES = [
  LAKE,
  { x: 3620, z: 3120, r: 140, depth: 7 },
  { x: 4780, z: 3380, r: 110, depth: 6 },
];

const S = 733;

// ---- 4. Mountain ranges (scenery): spine nodes [x, z, H, W, name] ----------
// Phase 3.1 redistribution — the spawn bowl is gone:
//   N  : Northwall (major range, pushed to the top edge)
//   NE : Kanjiro Massif (the highest peaks, 2000-2200 m)
//   E  : Eastguard (moderate, carries the mountain passes; the Horizon
//        Loop squeezes between its walls = the canyon region)
//   S  : open grasslands & lakes (NO range)
//   SW : rolling hills only (no range)
//   W  : wide valleys (no range)
// Everything serious sits 2+ km of riding from Rider's Meadow; an open
// spawn basin mask additionally suppresses any massif within ~1.8 km.
const RANGES = [
  {
    id: 'N', name: 'Northwall',
    nodes: [
      [1500, 280, 1000, 500, 'Vetra Peak'],
      [2600, 220, 1300, 620, 'Mistral Horn'],
      [3800, 250, 1150, 560, 'Sorren Dome'],
      [4900, 300, 1400, 640, 'Thornspire'],
    ],
    dips: [0.32, 0.30, 0.33],
  },
  {
    id: 'K', name: 'Kanjiro Massif',
    nodes: [
      [6200, 420, 1700, 800, 'Vel Morra'],
      [7050, 560, 1890, 1000, 'Kanjiro Peak'],
      [7720, 950, 1500, 680, 'Eastwatch'],
    ],
    dips: [0.28, 0.30],
  },
  {
    id: 'E', name: 'Eastguard',
    nodes: [
      [7700, 1500, 1050, 500, 'Fenn Ridge'],
      [7800, 2100, 1300, 580, 'Harrow Peak'],
      [7700, 2700, 1000, 480, 'Ghantir Knab'],
    ],
    dips: [0.33, 0.33],
  },
];

// New profile: cos^2 crest (45% of height, width W) on a wide quartic
// skirt (55%, width 2.6 W). Crest flank tops out ~54 deg on the largest
// peak (scenery); skirts stay ~33 deg. No walls, no spikes.
const CREST_F = 0.45, SKIRT_F = 0.55, SKIRT_W = 2.6;

// ---- 1. Main roads (authored FIRST — gameplay skeleton) --------------------
const MAIN_ROUTES = [
  { name: 'Horizon Loop', pts: [
    [1000, 1200], [2200, 1050], [4000, 980], [5800, 1050], [7000, 1200],
    [7150, 2000], [7000, 2800], [5800, 2950], [4000, 3020], [2200, 2950],
    [1000, 2800], [850, 2000], [1000, 1200]] },
  { name: 'North Arm', calm: true, pts: [[4000, 980], [4000, 1500], [4000, 2000]] },
  { name: 'South Arm', calm: true, pts: [[4000, 2000], [4000, 2500], [4000, 3020]] },
  { name: 'West Arm', calm: true, pts: [[850, 2000], [2400, 2000], [4000, 2000]] },
  { name: 'East Arm', calm: true, pts: [[4000, 2000], [5600, 2000], [7150, 2000]] },
];

// ---- 5. Pass roads: [rangeIdx, gapIdx] saddles carrying switchbacks --------
// East = the pass region (both Eastguard saddles), plus Northwall and the
// Kanjiro Massif approaches.
const PASS_SADDLES = [[0, 1], [0, 2], [1, 0], [1, 1], [2, 0], [2, 1]];

// Road hierarchy geometry. Half-widths of the flat bed:
//   MAIN 3.5 (7 m), PASS 2.5 (5 m); TRAIL (2.5 m) lives in TerrainField.
const W_MAIN = 3.5;
const W_PASS = 2.5;
const MAIN_GRADE = 0.11;   // 6.3 deg — well under the 10 deg main-road cap
const PASS_GRADE = 0.175;  // ~10 deg construction; surface stays <= 12 deg
const ROAD_FADE_MAX = 110;
const PASS_WAVE = 340;
const RD_STEP = 16;
const RD_CELL = 128;

// Practice jump on the South Arm, 140 m from the spawn intersection.
const PJUMP = { x: 4000, z: 2140, h: 1.5, l: 8, w: 6 };

const q4 = (t) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));

export class Landforms {
  constructor() {
    this.peaks = [];
    for (const r of RANGES) {
      r.bbox = rangeBBox(r);
      r.nodes.forEach((n, i) => this.peaks.push({
        id: `${r.id}${i}`, range: r.name, x: n[0], z: n[1], h: n[2], w: n[3], name: n[4],
      }));
    }
    this.passes = [];     // filled by initRoads()
    this.mainRoads = [];  // filled by initRoads()
    this.viewpoints = []; // filled by initViewpoints()
    this.roadKm = 0;

    // Rider's Meadow fixtures (rendered by Props with the spawn sector).
    this.meadowFixtures = [
      { t: 'sign', x: 4016, z: 2016, yaw: -0.7, s: 1.1 },
      { t: 'cabin', x: 3865, z: 2120, yaw: 2.35, s: 1 },
      { t: 'flags', x: 4055, z: 1945, yaw: 0.9, s: 1 },
      { t: 'bench', x: 4152, z: 2148, yaw: -2.4, s: 1 },   // facing the lake
      { t: 'bench', x: 3968, z: 2255, yaw: 0.4, s: 1 },
      { t: 'flags', x: 4290, z: 2148, yaw: 2.1, s: 0.9 },  // lake far shore
    ];
  }

  stats() {
    return {
      peaks: this.peaks.length,
      ranges: RANGES.length,
      passes: this.passes.length,
      mainRoads: this.mainRoads.length,
      roadKm: +this.roadKm.toFixed(1),
      mainKm: +((this._mainM || 0) / 1000).toFixed(1),
      passKm: +((this._passM || 0) / 1000).toFixed(1),
      viewpoints: this.viewpoints.length,
      worldW: WORLD_W, worldH: WORLD_H,
    };
  }

  // ---- 2. Valleys: the road-corridor mask ----------------------------------

  /**
   * Corridor mask in [0,1]: 1 on a main-road line, fading to 0 at 450 m.
   * Mountains and hills are suppressed by it, so the main roads always
   * run through wide gentle valleys — roads first, scenery second.
   */
  corridor(x, z) {
    let m = 0;
    for (const route of MAIN_ROUTES) {
      const pts = route.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const r = segNearest(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (r.d2 < 450 * 450) {
          const v = 1 - sstep(120, 450, Math.sqrt(r.d2));
          if (v > m) m = v;
          if (m >= 1) return 1;
        }
      }
    }
    return m;
  }

  /** Rider's Meadow mask: 1 at the spawn, 0 beyond the meadow rim. */
  meadowMask(x, z) {
    // Phase 3.1: wide outer fade (to 1.4 r) — the meadow plane eases into
    // the surrounding valley over ~500 m, so the rim never reads as a berm.
    const d = Math.hypot(x - MEADOW.x, z - MEADOW.z);
    return 1 - sstep(MEADOW.r * 0.55, MEADOW.r * 1.4, d);
  }

  // ---- 4. Mountains (new spine-profile algorithm) ---------------------------

  /**
   * Range contribution at (x,z). Input coordinates are domain-warped so
   * flanks and foothill lines are naturally irregular; the profile is a
   * cos^2 crest on a wide quartic skirt. Suppressed by the road corridor
   * and the meadow — mountains never swallow a road.
   */
  mountains(x, z) {
    // Domain warp (~90 m) breaks up the analytic spine silhouette.
    const wx = x + 180 * (vnoise(x * 0.0011 + 3.1, z * 0.0011 - 7.7, S + 3) - 0.5);
    const wz = z + 180 * (vnoise(x * 0.0011 - 9.2, z * 0.0011 + 4.4, S + 5) - 0.5);
    let best = 0;
    for (const r of RANGES) {
      const bb = r.bbox;
      if (wx < bb[0] || wx > bb[1] || wz < bb[2] || wz > bb[3]) continue;
      let d2 = Infinity, gi = 0, gu = 0;
      for (let i = 0; i < r.nodes.length - 1; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const s2 = segNearest(wx, wz, a[0], a[1], b[0], b[1]);
        if (s2.d2 < d2) { d2 = s2.d2; gi = i; gu = s2.t; }
      }
      const a = r.nodes[gi], b = r.nodes[gi + 1];
      const fs = gu * gu * (3 - 2 * gu);
      const sad = 1 - r.dips[gi] * Math.sin(Math.PI * gu) ** 2;
      const H = (a[2] + (b[2] - a[2]) * fs) * sad;
      const W = a[3] + (b[3] - a[3]) * fs;
      const d = Math.sqrt(d2);
      let h = SKIRT_F * H * q4(d / (SKIRT_W * W));
      if (d < W) {
        const c = Math.cos((d / W) * Math.PI * 0.5);
        h += CREST_F * H * c * c;
      }
      if (h > best) best = h;
    }
    if (best <= 0) return 0;
    // Alpine texture (multiplicative, never a wall).
    best *= 1 + 0.12 * (vnoise(x * 0.004 + 1.7, z * 0.004 - 2.9, S + 9) - 0.5);
    // Roads first: the corridor pushes the ranges back. Phase 3.1: an
    // OPEN SPAWN BASIN replaces the old tight meadow ring — no massif
    // contribution within 1 km of Rider's Meadow, full height only
    // beyond ~1.8 km, so the spawn reads as an open valley with distant
    // mountains instead of a bowl.
    const sup = (1 - 0.94 * this.corridor(x, z)) *
      sstep(1000, 1800, Math.hypot(x - MEADOW.x, z - MEADOW.z));
    return best * sup;
  }

  /** Practice jump kicker on the South Arm (applied AFTER road blending). */
  practiceJump(x, z) {
    const du = Math.abs(z - PJUMP.z) / PJUMP.l;
    if (du >= 1) return 0;
    const cw = (x - PJUMP.x) / PJUMP.w;
    let w = 1 - cw * cw;
    if (w <= 0) return 0;
    w *= w;
    const t = 1 - du;
    return PJUMP.h * t * t * w;
  }

  /** Combined lake bowl depth (meadow lake + the southern lakes). */
  lakeDepth(x, z) {
    let h = 0;
    for (const l of LAKES) {
      const d = Math.hypot(x - l.x, z - l.z);
      if (d < l.r) h += l.depth * q4(d / l.r);
    }
    return h;
  }

  // ---- Roads (laid once at startup) -----------------------------------------

  initRoads(raw) {
    this._rx = []; this._rz = []; this._re = [];
    this._rid = []; this._rw = []; this._rt = [];
    this._hash = new Map();
    let roadId = 0, totalM = 0;
    this._mainM = 0; this._passM = 0;

    // 1. Main roads: the loop first, then the four meadow arms (arms pin
    // their junction elevations to the already-laid loop / each other).
    for (const route of MAIN_ROUTES) {
      const id = roadId++;
      const lenM = this._layMainRoad(raw, route, id);
      this.mainRoads.push({ name: route.name, roadId: id, lengthM: lenM });
      this._mainM += lenM;
      totalM += lenM;
    }

    // 5. Pass roads over the range saddles (both flanks per pass).
    for (const [ri, gi] of PASS_SADDLES) {
      const r = RANGES[ri];
      const a = r.nodes[gi], b = r.nodes[gi + 1];
      const sx = (a[0] + b[0]) / 2, sz = (a[1] + b[1]) / 2;
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const vx = (b[0] - a[0]) / tl, vz = (b[1] - a[1]) / tl;
      const ux = -vz, uz = vx;
      const saddleE = raw(sx, sz);
      let lenM = 0;
      const flankIds = [];
      for (const side of [1, -1]) {
        flankIds.push(roadId);
        lenM += this._walkSwitchbacks(raw, sx, sz, saddleE,
          ux * side, uz * side, vx, vz, roadId);
        roadId++;
      }
      this.passes.push({
        id: `${r.id}${gi}-${r.id}${gi + 1}`, name: `${a[4]} / ${b[4]} Pass`,
        sx, sz, elev: +saddleE.toFixed(0), lengthM: lenM, roadId: flankIds[0], flankIds,
      });
      this._passM += lenM;
      totalM += lenM;
    }
    this.roadKm = totalM / 1000;
  }

  /**
   * Lay one main road: resample at RD_STEP with a flowing lateral wander
   * (suppressed near Rider's Meadow for the calm arms), grade-clamp the
   * terrain-following elevation both directions, smooth, pin junction
   * endpoints to already-laid roads, and close loops seamlessly.
   */
  _layMainRoad(raw, route, roadId) {
    const pts = route.pts;
    const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const X = [], Z = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const px = -uz, pz = ux;
      const n = Math.max(1, Math.round(L / RD_STEP));
      for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
        const t = k / n;
        let wob = Math.sin((i + t) * 2.4 + roadId) * 26 +
                  Math.sin((i + t) * 5.9 + roadId * 2.7) * 11;
        wob *= Math.sin(Math.PI * t); // stay put at control points
        const bx = a[0] + (b[0] - a[0]) * t, bz = a[1] + (b[1] - a[1]) * t;
        if (route.calm) {
          const dm = Math.hypot(bx - MEADOW.x, bz - MEADOW.z);
          wob *= Math.min(1, Math.max(0, (dm - 450) / 300));
        }
        X.push(bx + px * wob);
        Z.push(bz + pz * wob);
      }
    }
    const E = new Float64Array(X.length);
    for (let i = 0; i < X.length; i++) E[i] = raw(X[i], Z[i]);
    const eStart = this._roadElevNear(X[0], Z[0]);
    if (eStart !== null) E[0] = eStart;
    const eEnd = this._roadElevNear(X[X.length - 1], Z[X.length - 1]);
    if (eEnd !== null) E[E.length - 1] = eEnd;
    for (let i = 1; i < E.length; i++) {
      const ds = Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
      E[i] = Math.max(E[i - 1] - MAIN_GRADE * ds, Math.min(E[i - 1] + MAIN_GRADE * ds, E[i]));
    }
    for (let i = E.length - 2; i >= 0; i--) {
      const ds = Math.hypot(X[i + 1] - X[i], Z[i + 1] - Z[i]);
      E[i] = Math.max(E[i + 1] - MAIN_GRADE * ds, Math.min(E[i + 1] + MAIN_GRADE * ds, E[i]));
    }
    for (let p = 0; p < 2; p++) {
      for (let i = 1; i < E.length - 1; i++) E[i] = (E[i - 1] + 2 * E[i] + E[i + 1]) / 4;
    }
    // Re-pin junction endpoints. The clamp/smooth passes may have drifted
    // them; distribute the correction linearly over ~12 vertices (~190 m)
    // so re-pinning adds at most a few % of grade, never a step.
    if (eStart !== null) {
      const dE = eStart - E[0];
      for (let k = 0; k < Math.min(12, E.length); k++) E[k] += dE * (1 - k / 12);
    }
    if (eEnd !== null) {
      const n = E.length;
      const dE = eEnd - E[n - 1];
      for (let k = 0; k < Math.min(12, n); k++) E[n - 1 - k] += dE * (1 - k / 12);
    }
    if (closed) {
      // Seamless closure: blend both ends to their average over ~15 pts.
      const n = E.length;
      const eJ = (E[0] + E[n - 1]) / 2;
      for (let k = 0; k < 15; k++) {
        const f = 1 - k / 15;
        E[k] += (eJ - E[k]) * f * (1 - k / 15);
        E[n - 1 - k] += (eJ - E[n - 1 - k]) * f * (1 - k / 15);
      }
      E[0] = eJ; E[n - 1] = eJ;
    }
    let len = 0;
    for (let i = 0; i < X.length; i++) {
      this._pushVertex(X[i], Z[i], E[i], roadId, W_MAIN, 1);
      if (i > 0) len += Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
    }
    return len;
  }

  /**
   * Contour-aware switchback walker for one flank of a pass (unchanged
   * proven algorithm): candidate-heading fan follows the contour matching
   * a grade-clamped descent, hairpins on the serpentine clock, stops at
   * conflicts/embankments, tapers its tip into the terrain.
   */
  _walkSwitchbacks(raw, sx, sz, saddleE, ox, oz, vx, vz, roadId) {
    let x = sx, z = sz, e = saddleE;
    let lat = 1, sinceTurn = 0, len = 0;
    let hx = ox, hz = oz;
    this._pushVertex(x, z, e, roadId, W_PASS, 2);
    for (let i = 0; i < 400; i++) {
      let bx = vx * lat + ox * 0.45, bz = vz * lat + oz * 0.45;
      const bl = Math.hypot(bx, bz);
      bx /= bl; bz /= bl;
      const eWant = e - PASS_GRADE * RD_STEP * 0.8;
      let bestS = Infinity, bhx = bx, bhz = bz;
      for (let a = -0.9; a <= 0.9; a += 0.15) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const cx2 = bx * ca - bz * sa, cz2 = bx * sa + bz * ca;
        if (cx2 * hx + cz2 * hz < -0.2) continue;
        const eC = raw(x + cx2 * RD_STEP, z + cz2 * RD_STEP);
        const score = Math.abs(eC - eWant) + Math.abs(a) * 1.6;
        if (score < bestS) { bestS = score; bhx = cx2; bhz = cz2; }
      }
      const turn = Math.max(0, (bhx * hx + bhz * hz + 1) / 2);
      hx = bhx; hz = bhz;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      const eT = raw(nx2, nz2);
      const gStep = PASS_GRADE * RD_STEP * (0.15 + 0.85 * turn * turn);
      let eN = Math.max(e - gStep, Math.min(e + gStep, eT));
      const cur0 = this._rx.length - 1;
      for (let b2 = 4; b2 <= 22; b2++) {
        const i2 = cur0 - b2;
        if (i2 < 0 || this._rid[i2] !== roadId) break;
        const dpx = nx2 - this._rx[i2], dpz = nz2 - this._rz[i2];
        const dp = Math.hypot(dpx, dpz);
        if (dp < 60) {
          const lim = Math.max(1.0, 0.19 * dp);
          const ei = this._re[i2];
          eN = Math.max(ei - lim, Math.min(ei + lim, eN));
        }
      }
      const gCap = Math.max(0.10, PASS_GRADE * (0.3 + 0.7 * turn)) * RD_STEP;
      eN = Math.max(e - gCap, Math.min(e + gCap, eN));
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId, W_PASS, 2);
      len += RD_STEP;
      sinceTurn += RD_STEP;
      if (sinceTurn > PASS_WAVE / 2) { lat = -lat; sinceTurn = 0; }
      if (this.mountains(x, z) < 45 && Math.abs(e - eT) < 3) break;
      if (e - eT > 26) break;
      if (x < 60 || x > WORLD_W - 60 || z < 60 || z > WORLD_H - 60) break;
    }
    // Landing taper.
    for (let i = 0; i < 60; i++) {
      const eT0 = raw(x, z);
      if (Math.abs(e - eT0) < 1) break;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      if (nx2 < 40 || nx2 > WORLD_W - 40 || nz2 < 40 || nz2 > WORLD_H - 40) break;
      const eT = raw(nx2, nz2);
      const eN = Math.max(e - PASS_GRADE * RD_STEP, Math.min(e + PASS_GRADE * RD_STEP, eT));
      if (eN - eT > 26) break;
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId, W_PASS, 2);
      len += RD_STEP;
    }
    // Trim hanging tips.
    let last = this._rx.length - 1;
    while (last >= 0 && this._rid[last] === roadId &&
           this._re[last] - raw(this._rx[last], this._rz[last]) > 22) {
      this._popVertex();
      last--;
      len -= RD_STEP;
    }
    return Math.max(0, len);
  }

  /** Conflict: another road (or own loop-back) nearby at a >30% wall. */
  _conflict(x, z, e, roadId) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    const cur = this._rx.length - 1;
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
            const arc = (cur - i) * RD_STEP;
            if (arc < 8 * RD_STEP || d > 0.35 * arc) continue;
          }
          const dE = Math.abs(e - this._re[i]);
          if (dE > Math.max(3, 0.30 * d)) return true;
        }
      }
    }
    return false;
  }

  /** Distance to the nearest road vertex (prop placement keeps clear). */
  roadDist(x, z) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let best = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - this._rx[i], ddz = z - this._rz[i];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }

  /** Interpolated elevation of the nearest laid road segment within 60 m. */
  _roadElevNear(x, z) {
    let best = null, bd2 = 60 * 60;
    for (let i = 0; i < this._rx.length - 1; i++) {
      if (this._rid[i + 1] !== this._rid[i]) continue;
      const ax = this._rx[i], az = this._rz[i];
      const abx = this._rx[i + 1] - ax, abz = this._rz[i + 1] - az;
      const l2 = abx * abx + abz * abz;
      let t = l2 > 0 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = this._re[i] + (this._re[i + 1] - this._re[i]) * t; }
    }
    return best;
  }

  _pushVertex(x, z, e, roadId, halfW = W_PASS, type = 2) {
    const idx = this._rx.length;
    this._rx.push(x); this._rz.push(z); this._re.push(e); this._rid.push(roadId);
    this._rw.push(halfW); this._rt.push(type);
    const key = `${Math.floor(x / RD_CELL)},${Math.floor(z / RD_CELL)}`;
    let arr = this._hash.get(key);
    if (!arr) this._hash.set(key, (arr = []));
    arr.push(idx);
  }

  _popVertex() {
    const idx = this._rx.length - 1;
    if (idx < 0) return;
    const x = this._rx[idx], z = this._rz[idx];
    const key = `${Math.floor(x / RD_CELL)},${Math.floor(z / RD_CELL)}`;
    const arr = this._hash.get(key);
    if (arr) {
      const k = arr.lastIndexOf(idx);
      if (k >= 0) arr.splice(k, 1);
    }
    this._rx.pop(); this._rz.pop(); this._re.pop();
    this._rid.pop(); this._rw.pop(); this._rt.pop();
  }

  /**
   * Blend all roads into h — weighted average over nearby segments with
   * bed-dominance weighting (a segment whose bed you are ON outweighs
   * distant neighbors ~30x): continuous everywhere, smooth junction
   * handovers, aprons widen 3.2x cut/fill so shoulders stay <= 18 deg.
   */
  roads(x, z, h, L) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let wSum = 0, weSum = 0, dMin2 = Infinity, nearW = W_PASS, nearT = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
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
          const hw = this._rw[i];
          const d = Math.sqrt(d2);
          // Per-segment weight: continuous, 0 at its own fade edge; the
          // apron widens 3.2x cut/fill depth (shoulders <= ~17 deg).
          const fade = Math.min(ROAD_FADE_MAX, hw * 2.3 + Math.abs(E - h) * 3.2);
          if (d >= fade) continue;
          let w = 1 - sstep(0, fade, d);
          w *= w;
          const bd = 1 - sstep(0, hw * 1.6, d);
          w *= 1 + 220 * bd * bd; // bed dominance: on-bed snaps to its road
          wSum += w; weSum += w * E;
          if (d2 < dMin2) { dMin2 = d2; nearW = hw; nearT = this._rt[i]; }
        }
      }
    }
    if (wSum <= 0) return h;
    const roadE = weSum / wSum;
    // SATURATING blend — continuous EVERYWHERE by construction (each
    // weight is continuous, so their sum is too). On a bed wSum >~ 220
    // => blend ~ 0.9995; at any fade edge wSum -> 0 => blend -> 0.
    // (A nearest-eligible-segment pick here is NOT continuous: a wall
    // forms exactly where the nearest segment crosses its own
    // depth-dependent eligibility edge.)
    const blend = wSum / (wSum + 0.12);
    h += (roadE - h) * blend;
    const dMin = Math.sqrt(dMin2);
    const bed = 1 - sstep(nearW * 0.8, nearW * 1.9, dMin);
    if (bed > L.road) { L.road = bed; L.roadType = nearT; }
    return h;
  }

  // ---- 6. Viewpoints (computed ON the road network) --------------------------

  initViewpoints(raw) {
    const best = new Map();
    for (let i = 0; i < this._rx.length; i += 4) {
      const x = this._rx[i], z = this._rz[i], e = this._re[i];
      if (x < 150 || x > WORLD_W - 150 || z < 150 || z > WORLD_H - 150) continue;
      let drop = 0;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const d = e - raw(x + Math.cos(th) * 90, z + Math.sin(th) * 90);
        if (d > drop) drop = d;
      }
      if (drop < 22) continue;
      const key = `${Math.floor(x / 600)},${Math.floor(z / 600)}`;
      const cur = best.get(key);
      if (!cur || drop > cur.score) best.set(key, { score: drop, i });
    }
    const arr = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 14);
    this.viewpoints = arr.map((v, n) => ({
      id: `VP${String(n + 1).padStart(2, '0')}`,
      x: this._rx[v.i], z: this._rz[v.i], e: this._re[v.i],
      drop: +v.score.toFixed(0),
      type: this._rt[v.i] === 1 ? 'main' : 'pass',
    }));
  }

  nearestViewpoint(x, z) {
    let best = null, bd = Infinity;
    for (const v of this.viewpoints) {
      const d = Math.hypot(x - v.x, z - v.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best ? { ...best, dist: +bd.toFixed(0) } : null;
  }

  /** Nth vertex of a pass road's first flank (tests/debug). */
  passPoint(pi, n) {
    const p = this.passes[pi];
    const i0 = this._rid.indexOf(p.roadId);
    const i = Math.min(this._rx.length - 1, i0 + n);
    if (this._rid[i] !== p.roadId) return null;
    return { x: this._rx[i], z: this._rz[i], e: this._re[i] };
  }

  /** Nearest peak whose massif contains (x,z), or null (F3 overlay). */
  peakAt(x, z) {
    let best = null, bestD = Infinity;
    for (const p of this.peaks) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.w * SKIRT_W && d < bestD) { bestD = d; best = p; }
    }
    return best ? { ...best, chain: best.range } : null;
  }
}

// ---- helpers ----------------------------------------------------------------

function segNearest(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return { t, d2: dx * dx + dz * dz };
}

function rangeBBox(r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, m = 0;
  for (const n of r.nodes) {
    x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]);
    z0 = Math.min(z0, n[1]); z1 = Math.max(z1, n[1]);
    m = Math.max(m, n[3] * SKIRT_W + 320);
  }
  return [x0 - m, x1 + m, z0 - m, z1 + m];
}
