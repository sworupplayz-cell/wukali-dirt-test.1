import { vnoise, fbm2, hash01, sstep } from './noise.js';
import { Landforms, MEADOW, LAKE, LAKES, SEA_LEVEL, WORLD_W, WORLD_H } from './Landforms.js';

/**
 * TerrainField — Horizon Ride analytic terrain (Phase 3 world redesign,
 * roads-first).
 *
 * A pure deterministic function of WORLD coordinates (x, z) over the
 * 8,000 x 4,000 m map. Composition follows the design order:
 *
 *   base plain (valley band 100-350 m)
 *   -> rolling hills (corridor- and meadow-suppressed)
 *   -> mountain ranges (scenery; corridor-suppressed inside Landforms)
 *   -> Rider's Meadow flattening + lake bowl
 *   -> ROADS blended onto the final surface
 *   -> practice jump + lowland trail grid + kickers
 *
 * Tiles only sample this field on a global lattice => bit-identical
 * borders, zero seams, physics never waits for meshes.
 */

const SEED = 733;

// ---- Chapter 6 lowland shaping ---------------------------------------------
// 80% of the map has to live in the 0-120 m band, so the lowland is built
// around a mean of ~86 m with +-35 m of relief on top of it.
const LOW_BASE = 59;      // mean lowland elevation (m)
const DRAIN = 18;         // drop from the interior to the southern shore
const WEST_RISE = 12;     // west canyon plateau lift
const EAST_RISE = 14;     // east rise toward the volcanic passes
const LOW_FLOOR = 44;     // soft inland floor (above SEA_LEVEL 42)
// Ridge system. Value noise has one period per 1/F metres and the folded
// ridge transform puts a crest line at every half period, so F = 0.00095
// lays a scenic crest every ~530 m — inside the 500-800 m target.
const RIDGE_F = 0.0026;
const RIDGE_H = 32;       // crest height above the trough line
const FINE_F = 0.0062;    // fine crests (~190 m) for surface interest
const FINE_H = 6;
// Drainage: main valleys every ~900 m with tributaries inside them.
const VALLEY_F = 0.00055;
const VALLEY_H = 29;
const TRIB_F = 0.0016;
const TRIB_H = 11;
const CORR_VALE = 9;      // vale carved along every main road corridor

/**
 * Ridged noise: 1 along a crest LINE, 0 in the flats between. Value
 * noise gives blobs; the folded absolute value gives connected lines,
 * which is what makes ridges and drainage networks read as continuous.
 */
function ridgeLine(x, z, s) {
  return 1 - Math.abs(2 * vnoise(x, z, s) - 1);
}

/** Smooth maximum (quadratic blend) — a floor with no crease. */
function smax(a, b, k) {
  const d = Math.max(0, k - Math.abs(a - b));
  return Math.max(a, b) + (d * d) / (4 * k);
}

// Lowland trail grid (2.5 m hidden shortcuts).
const NS_SPACING = 800, NS_BASE = 400, NS_COUNT = 9;  // x = 400..6800
const EW_SPACING = 700, EW_BASE = 350, EW_COUNT = 6;  // z = 350..3850
const TRAIL_HALF = 1.25;
const TRAIL_FADE = 4.4;

// Trail kickers.
const JUMP_SPACING = 190;
const JUMP_L = 7;
const JUMP_W = 5;

const MTN_TRAIL_CUT0 = 60, MTN_TRAIL_CUT1 = 220;

export class TerrainField {
  constructor() {
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this._lf = { road: 0, roadType: 0 };
    this.landforms = new Landforms();
    this.landforms.initRoads((x, z) => this._rawHeight(x, z));
    this.landforms.initViewpoints((x, z) => this._rawHeight(x, z));
  }

  /** Physics height — the single source of truth. */
  height(x, z) {
    return this.sample(x, z, this._info).h;
  }

  /**
   * Base landmass WITHOUT roads/jump — Chapter 6 terrain rebuild.
   *
   * The old field was a wide fBM "plain band" (115-325 m) with the
   * mountain skirts spilling far inland: 9% of the map sat in the 0-120 m
   * band, the mean elevation was 489 m and an interior transect crossed
   * ZERO ridge crests — flat plains punctuated by giant isolated hills.
   *
   * The rebuild is an erosion-shaped landscape instead of a noise field:
   *
   *   1. DRAINAGE     a gentle continental tilt from the northern
   *                   foothills down to the southern ocean; everything
   *                   the water does follows this slope.
   *   2. RELIEF MASK  broad regions (~2.4 km) of hill country and
   *                   flat-pan BASINS, so the world has open plains AND
   *                   busy ground instead of one uniform texture.
   *   3. RIDGES       ridged noise (crest LINES, not blobs) at ~620 m and
   *                   ~290 m wavelengths, domain-warped so the crests
   *                   meander: a scenic ridge every 500-800 m.
   *   4. VALLEYS      a dendritic drainage network carved into that
   *                   surface — main valleys (~900 m spacing) with
   *                   tributaries that only exist inside them, deepening
   *                   downstream toward the coast.
   *   5. BENCHES      short escarpment steps on hill flanks (~30 deg) —
   *                   cliffs to ride along, never vertical walls.
   *   6. CORRIDORS    main roads sit in the valley floor: relief is
   *                   suppressed and a shallow vale is carved along every
   *                   main route, so roads FOLLOW valleys.
   *
   * Mountains stay border-only (Landforms confines and narrows them).
   */
  _base(x, z) {
    const lf = this.landforms;
    const corr = lf.corridor(x, z);
    const nz = (z - 2500) / 2500;  // -1 north edge .. +1 south edge
    const nx = (x - 4000) / 4000;  // -1 west edge .. +1 east edge

    // ---- 1. Drainage tilt: northern foothills -> southern shore -------
    let h = LOW_BASE - DRAIN * Math.max(0, nz) * Math.max(0, nz) +
      10 * Math.max(0, -nz) +
      WEST_RISE * Math.max(0, -nx) + EAST_RISE * Math.max(0, nx);

    // ---- 2. Relief regions: hill country vs flat-pan basins -----------
    // (0.35 = pan-flat basin floor, 1.4 = busiest hill country)
    const relief = 0.55 + 0.85 * vnoise(x * 0.00042 + 11.3, z * 0.00042 - 5.9, SEED + 9);
    // Domain warp so crest lines meander instead of running dead straight.
    const wx = x + 140 * (vnoise(x * 0.00055 + 4.2, z * 0.00055 - 1.7, SEED + 3) - 0.5);
    const wz = z + 140 * (vnoise(x * 0.00055 - 6.1, z * 0.00055 + 8.3, SEED + 4) - 0.5);

    // Open country factor: corridors and the meadow keep their floor.
    const mm = lf.meadowMask(x, z);
    const open = (1 - 0.7 * corr) * (1 - mm);

    // ---- 3. Ridges (crest lines every ~530 m + fine surface relief) ---
    // Contrast stretch: interpolated value noise only swings about a
    // third of its nominal range, so the raw ridge field reads as a
    // gentle swell. Stretching it turns the crest lines into actual
    // ridges with defined troughs between them.
    const r1 = sstep(0.36, 0.99, ridgeLine(wx * RIDGE_F, wz * RIDGE_F, SEED + 13));
    const r2 = sstep(0.45, 0.95, ridgeLine(wx * FINE_F + 3.3, wz * FINE_F - 2.7, SEED + 17));
    h += (RIDGE_H * r1 * relief + FINE_H * r2) * open;

    // ---- 4. Erosion: dendritic valley network -------------------------
    // Tributaries only exist where a main valley already runs, which is
    // what makes the network read as water-carved rather than noisy.
    const v1 = sstep(0.44, 0.98, ridgeLine(wx * VALLEY_F - 8.8, wz * VALLEY_F + 5.5, SEED + 23));
    const v2 = sstep(0.5, 0.97, ridgeLine(wx * TRIB_F + 2.2, wz * TRIB_F - 9.4, SEED + 29));
    const main = v1;
    const flow = 0.55 + 0.45 * sstep(-1, 0.9, nz);   // deeper downstream
    h -= (VALLEY_H * main + TRIB_H * v2 * v2 * sstep(0.35, 0.75, v1)) *
      flow * (0.5 + 0.5 * relief) * open;

    // ---- 5. Benches: short escarpments on the hill flanks -------------
    h += 7 * sstep(0.44, 0.66, r1) * sstep(0.55, 0.85, relief) * open;

    // ---- 5b. Chapter 5A authored macro-landforms ----------------------
    // Named structure on top of the eroded grain: four ridge systems,
    // three large basins and the plateaus. All corridor-aware, all
    // smooth blobs, so they add shape without adding a single wall.
    h += lf.ridgeSystems(x, z, corr) * (1 - mm);
    h += lf.plateauLift(x, z, corr) * (1 - mm);
    h -= lf.basinDepth(x, z, corr) * (1 - mm);

    // ---- 6. Roads follow valleys --------------------------------------
    // Every main corridor carries a shallow vale of its own, so a road
    // laid down the corridor is a road running along a valley floor.
    h -= CORR_VALE * corr * corr;

    // COASTAL CLIFFS + ocean: past z~4380 the shelf steps down an eased
    // cliff band onto a beach that slides under SEA_LEVEL (42). The
    // ocean IS the south border — water, not an invisible wall.
    const coast = sstep(4380, 4660, z);
    h += (50 - h) * coast * (1 - 0.55 * corr);
    // Shallow shelf rather than a trench: the sea floor slides just under
    // the waterline (SEA_LEVEL 42) and stays there, which is both what a
    // sand coast looks like and one less slab of terrain outside the
    // 0-120 m band.
    h -= sstep(4700, 5000, z) * 46;

    // Soft floor: inland ground never sinks to the waterline (landmarks,
    // props and vegetation all live above it). Smooth, so it cannot
    // create a crease where it engages.
    if (z < 4300) h = smax(h, LOW_FLOOR, 14);

    // Mountain ranges (border-confined scenery).
    h += lf.mountains(x, z);
    // Red Canyon trench (west region).
    h = lf.canyonCarve(x, z, h);

    // Rider's Meadow: flatten to the meadow plane, tiny undulation kept.
    if (mm > 0) {
      const meadowH = MEADOW.e +
        (vnoise(x * 0.006 + 31.7, z * 0.006 - 12.9, SEED + 11) - 0.5) * 3.2;
      h += (meadowH - h) * mm;
    }
    // Lakes carve everywhere they exist (meadow + southern grasslands).
    h -= lf.lakeDepth(x, z);
    // Chapter 5A crystal lakes sit in a levelled pan of their own.
    h = lf.lakeShape(x, z, h);
    return h;
  }

  /** Road-free height used once at startup to lay road centerlines. */
  _rawHeight(x, z) {
    return this._base(x, z);
  }

  /**
   * Full sample: height + trail mask + moisture + mountain factor + road
   * type. `out` is caller-provided scratch; no allocations.
   */
  sample(x, z, out) {
    const L = this._lf;
    L.road = 0; L.roadType = 0;
    const lf = this.landforms;

    let h = this._base(x, z);
    const mtn = lf.mountains(x, z);
    const mtnN = sstep(MTN_TRAIL_CUT0, MTN_TRAIL_CUT1, mtn);

    // Lowland fabric: hidden trails + bumps + kickers, off the massifs
    // and outside the groomed meadow center.
    let trail = 0;
    if (mtnN < 1) {
      const mm = lf.meadowMask(x, z);
      trail = this._trailMask(x, z) * (1 - mtnN) * (1 - mm);
      const bumps = (vnoise(x * 0.034 + 3.3, z * 0.034 - 9.9, SEED + 21) - 0.5) *
        0.9 * (1 - 0.85 * trail) * (1 - 0.7 * mtnN) * (1 - mm);
      let jump = this._jumpAt(x, z) * (1 - mtnN) * (1 - mm);
      if (jump > 0.01) {
        // A trail kicker crossing a MAIN/PASS road bed would leave a
        // wall on the road apron — fade kickers out within 30 m of any
        // laid road centerline (only costs a hash scan when jump > 0).
        jump *= sstep(14, 30, lf.roadDist(x, z));
      }
      h += bumps + jump;
    }

    // Roads ride ON the final surface.
    h = lf.roads(x, z, h, L);
    // Practice jump sits ON the South Arm road bed.
    h += lf.practiceJump(x, z);

    trail = Math.max(trail, L.road);
    h -= 0.22 * trail; // worn bed
    // Chapter 3B: slight surface variation on the bed — wheel ruts a few
    // cm deep + gentle washboard. Visual character only; far below the
    // suspension's bump scale, so the ride stays smooth.
    if (trail > 0.3) {
      h -= 0.05 * trail * (0.5 + 0.5 * Math.sin(x * 0.9 + z * 1.7));
      h -= 0.03 * trail * vnoise(x * 0.23, z * 0.23, SEED + 61);
    }

    out.h = h;
    out.trail = trail;
    out.moist = vnoise(x * 0.0024 + 71.3, z * 0.0024 + 17.9, SEED + 33);
    out.mtn = mtnN;
    out.roadType = L.road > 0.15 ? L.roadType : (trail > 0.5 && mtnN < 0.5 ? 4 : 0);
    return out;
  }

  /** Hidden-trail mask in [0,1]. */
  _trailMask(x, z) {
    let m = 0;
    const k = Math.round((x - NS_BASE) / NS_SPACING);
    if (k >= 0 && k < NS_COUNT) {
      const d = Math.abs(x - this.nsCenter(k, z));
      m = 1 - sstep(TRAIL_HALF, TRAIL_FADE, d);
    }
    const j = Math.round((z - EW_BASE) / EW_SPACING);
    if (j >= 0 && j < EW_COUNT) {
      const d = Math.abs(z - this.ewCenter(j, x));
      const m2 = 1 - sstep(TRAIL_HALF, TRAIL_FADE, d);
      if (m2 > m) m = m2;
    }
    return m;
  }

  nsCenter(k, z) {
    return NS_BASE + k * NS_SPACING +
      92 * Math.sin(z * 0.0021 + k * 2.3) +
      44 * Math.sin(z * 0.0047 + k * 4.1);
  }

  ewCenter(j, x) {
    return EW_BASE + j * EW_SPACING +
      84 * Math.sin(x * 0.0019 + j * 1.7) +
      38 * Math.sin(x * 0.0043 + j * 3.3);
  }

  /** Trail kickers (sharp-crest tents) + open-field whoops. */
  _jumpAt(x, z) {
    let h = 0;
    const k = Math.round((x - NS_BASE) / NS_SPACING);
    if (k >= 0 && k < NS_COUNT) {
      const m = Math.round(z / JUMP_SPACING);
      if (hash01(k, m, SEED + 41) < 0.55) {
        const zj = m * JUMP_SPACING + (hash01(k, m, SEED + 42) - 0.5) * 80;
        const du = Math.abs(z - zj) / JUMP_L;
        if (du < 1) {
          const xj = this.nsCenter(k, zj);
          const cw = (x - xj) / JUMP_W;
          let w = 1 - cw * cw;
          if (w > 0) {
            w *= w;
            const H = 1.2 + hash01(k, m, SEED + 43) * 1.0;
            const t = 1 - du;
            h += H * t * t * w;
          }
        }
      }
    }
    const cx = Math.floor(x / 160), cz = Math.floor(z / 160);
    if (hash01(cx, cz, SEED + 51) < 0.3) {
      const xf = (cx + 0.2 + hash01(cx, cz, SEED + 52) * 0.6) * 160;
      const zf = (cz + 0.2 + hash01(cx, cz, SEED + 53) * 0.6) * 160;
      const H = 0.8 + hash01(cx, cz, SEED + 54) * 0.8;
      const dx = x - xf, dz = z - zf;
      const t = 1 - (dx * dx + dz * dz) / (13 * 13);
      if (t > 0) h += H * t * t;
    }
    return h;
  }

  /** Nearest trail kicker to (x,z) on the closest NS trail (tests). */
  jumpNear(x, z) {
    const k = Math.round((x - NS_BASE) / NS_SPACING);
    if (k < 0 || k >= NS_COUNT) return null;
    for (let dm = 0; dm < 12; dm++) {
      for (const s of dm === 0 ? [0] : [dm, -dm]) {
        const m = Math.round(z / JUMP_SPACING) + s;
        if (hash01(k, m, SEED + 41) < 0.55) {
          const zj = m * JUMP_SPACING + (hash01(k, m, SEED + 42) - 0.5) * 80;
          if (zj < 80 || zj > WORLD_H - 80) continue;
          return { x: this.nsCenter(k, zj), z: zj, h: 1.2 + hash01(k, m, SEED + 43) * 1.0 };
        }
      }
    }
    return null;
  }
}

export { MEADOW, LAKE, LAKES, SEA_LEVEL };
