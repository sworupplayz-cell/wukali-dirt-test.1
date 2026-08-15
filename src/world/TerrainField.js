import { vnoise, fbm2, hash01, sstep } from './noise.js';
import { Landforms } from './Landforms.js';

/**
 * TerrainField — Horizon Ride analytic terrain (Phase 2 foundation +
 * Phase 3 major landforms).
 *
 * A pure deterministic function of WORLD coordinates (x, z): every sample
 * anywhere in the 10,000 x 5,000 m world returns the same height forever,
 * regardless of sector load order. Sector meshes only SAMPLE this field on
 * a global lattice, so sector borders match bit-for-bit — seamless by
 * construction, no stitching, no cracks.
 *
 * Composition (lowlands -> continent):
 *   1. Phase 2 rolling base: plains, valleys, gentle hills, soft local
 *      ridges, bumps, trail kickers — the riding fabric of the lowlands.
 *   2. Phase 3 Landforms: 4 connected ridge chains carrying 18 unique
 *      named peaks (highest ~4600 m), saddles between every neighboring
 *      pair, 12 switchback pass roads, 6 U-valleys + 8 V-valleys, 6
 *      basins (lowest ~-120 m), 5 escarpments, and a spiral summit road.
 *   3. Dirt trail network (Phase 2) masked OFF the mountains — lowland
 *      trails end at the foothills; pass roads take over from there.
 *
 * Roads are blended after valleys/mountains so they always ride ON the
 * final surface; their centerline elevations were sampled from the raw
 * field once at startup and smoothed to a rideable grade.
 */

const SEED = 1214;

// Trail corridors (Phase 2 lowland network).
const NS_SPACING = 800, NS_BASE = 400, NS_COUNT = 12; // x = 400..9200
const EW_SPACING = 700, EW_BASE = 350, EW_COUNT = 7;  // z = 350..4550
const TRAIL_HALF = 3.4;
const TRAIL_FADE = 7.5;

// Jump kickers along NS trails.
const JUMP_SPACING = 190;
const JUMP_L = 7;
const JUMP_W = 5;

// Mountains rise above the rolling base starting at this contribution.
const MTN_TRAIL_CUT0 = 60, MTN_TRAIL_CUT1 = 220; // lowland trails fade out

export class TerrainField {
  constructor() {
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this._lf = { road: 0, vroad: 0, roadType: 0 };
    this.landforms = new Landforms();
    // Cache road centerlines from the ROAD-FREE field once, then find
    // the scenic overlooks along the finished network.
    this.landforms.initRoads((x, z) => this._rawHeight(x, z));
    this.landforms.initViewpoints((x, z) => this._rawHeight(x, z));
  }

  /** Physics height — the single source of truth. */
  height(x, z) {
    return this.sample(x, z, this._info).h;
  }

  /**
   * Full sample: height + trail mask + moisture + mountain factor.
   * `out` is caller-provided scratch; no allocations.
   */
  sample(x, z, out) {
    const L = this._lf;
    L.road = 0; L.vroad = 0; L.roadType = 0;

    // ---- Phase 2 rolling base ----------------------------------------------
    // Rebalance: basin pans flatten the rolling fabric (village-ready).
    const flat = 1 - this.landforms.basinFlat(x, z);
    const plains = (fbm2(x * 0.00091, z * 0.00091, SEED) - 0.5) * 32 * flat;
    const hills = (vnoise(x * 0.0033 + 13.7, z * 0.0033 - 7.1, SEED + 5) - 0.5) * 14 * flat;
    const region = vnoise(x * 0.00058 + 91.2, z * 0.00058 + 40.6, SEED + 9);
    let ridge = 0;
    const rm = sstep(0.56, 0.78, region);
    if (rm > 0) {
      const rv = vnoise(x * 0.0018 + 55.1, z * 0.0018 - 21.9, SEED + 13);
      const crest = 1 - Math.abs(2 * rv - 1);
      ridge = crest * crest * 8 * rm * flat;
    }

    // ---- Phase 3 major landforms ---------------------------------------------
    const mtn = this.landforms.mountains(x, z);
    const mtnN = sstep(MTN_TRAIL_CUT0, MTN_TRAIL_CUT1, mtn); // 0 lowland .. 1 alpine

    // Lowland fabric (trails, kickers, bumps) fades out on the massifs.
    let trail = 0, bumps = 0, jump = 0;
    if (mtnN < 1) {
      trail = this._trailMask(x, z) * (1 - mtnN);
      bumps = (vnoise(x * 0.034 + 3.3, z * 0.034 - 9.9, SEED + 21) - 0.5) *
        1.1 * (1 - 0.85 * trail) * (1 - 0.7 * mtnN) * (0.35 + 0.65 * flat);
      jump = this._jumpAt(x, z) * (1 - mtnN);
    }

    let h = plains + hills + ridge + mtn + bumps + jump;
    h += this.landforms.basins(x, z);
    h += this.landforms.escarpments(x, z);
    h = this.landforms.carveValleys(x, z, h, L);
    h = this.landforms.plateau(x, z, h);
    h = this.landforms.roads(x, z, h, L); // roads ride ON the final surface

    // Roads count as trail surface (grip/color); valley trails too.
    trail = Math.max(trail, L.road, L.vroad * 0.9);
    h -= 0.22 * trail; // worn road bed

    out.h = h;
    out.trail = trail;
    out.moist = vnoise(x * 0.0024 + 71.3, z * 0.0024 + 17.9, SEED + 33);
    out.mtn = mtnN;
    // Road type under this point: 1 main / 2 pass / 3 spiral / 4 trail.
    out.roadType = L.road > 0.15 ? L.roadType : (trail > 0.5 && mtnN < 0.5 ? 4 : 0);
    return out;
  }

  /** Road-free height used ONCE at startup to lay road centerlines. */
  _rawHeight(x, z) {
    const flat = 1 - this.landforms.basinFlat(x, z);
    const plains = (fbm2(x * 0.00091, z * 0.00091, SEED) - 0.5) * 32 * flat;
    const hills = (vnoise(x * 0.0033 + 13.7, z * 0.0033 - 7.1, SEED + 5) - 0.5) * 14 * flat;
    const region = vnoise(x * 0.00058 + 91.2, z * 0.00058 + 40.6, SEED + 9);
    let ridge = 0;
    const rm = sstep(0.56, 0.78, region);
    if (rm > 0) {
      const rv = vnoise(x * 0.0018 + 55.1, z * 0.0018 - 21.9, SEED + 13);
      const crest = 1 - Math.abs(2 * rv - 1);
      ridge = crest * crest * 8 * rm * flat;
    }
    let h = plains + hills + ridge + this.landforms.mountains(x, z);
    h += this.landforms.basins(x, z);
    h += this.landforms.escarpments(x, z);
    const L = { road: 0, vroad: 0, roadType: 0 };
    h = this.landforms.carveValleys(x, z, h, L);
    return this.landforms.plateau(x, z, h);
  }

  /** Dirt-trail mask in [0,1]: 1 = trail core, 0 = open country. */
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

  /** Centerline x of north-south trail k at depth z. */
  nsCenter(k, z) {
    return NS_BASE + k * NS_SPACING +
      92 * Math.sin(z * 0.0021 + k * 2.3) +
      44 * Math.sin(z * 0.0047 + k * 4.1);
  }

  /** Centerline z of east-west trail j at x. */
  ewCenter(j, x) {
    return EW_BASE + j * EW_SPACING +
      84 * Math.sin(x * 0.0019 + j * 1.7) +
      38 * Math.sin(x * 0.0043 + j * 3.3);
  }

  /**
   * Combined jump contribution at (x,z). Trail kickers are quadratic
   * tents (sharp crest -> real launches); field mounds stay C1-smooth.
   */
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
      h += moundAt(x, z, xf, zf, 13, H);
    }
    return h;
  }

  /** Nearest trail jump kicker to (x,z) on the closest NS trail. */
  jumpNear(x, z) {
    const k = Math.round((x - NS_BASE) / NS_SPACING);
    if (k < 0 || k >= NS_COUNT) return null;
    for (let dm = 0; dm < 12; dm++) {
      for (const s of dm === 0 ? [0] : [dm, -dm]) {
        const m = Math.round(z / JUMP_SPACING) + s;
        if (hash01(k, m, SEED + 41) < 0.55) {
          const zj = m * JUMP_SPACING + (hash01(k, m, SEED + 42) - 0.5) * 80;
          if (zj < 80 || zj > 4920) continue;
          return { x: this.nsCenter(k, zj), z: zj, h: 1.2 + hash01(k, m, SEED + 43) * 1.0 };
        }
      }
    }
    return null;
  }
}

/** Quartic mound: H at center, 0 with zero slope at radius r. */
function moundAt(x, z, mx, mz, r, H) {
  const dx = x - mx, dz = z - mz;
  const t = 1 - (dx * dx + dz * dz) / (r * r);
  return t > 0 ? H * t * t : 0;
}
