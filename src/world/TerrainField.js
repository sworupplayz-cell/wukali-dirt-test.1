import { vnoise, fbm2, hash01, sstep } from './noise.js';

/**
 * TerrainField — Horizon Ride Phase 2 analytic terrain foundation.
 *
 * A pure deterministic function of WORLD coordinates (x, z): every sample
 * anywhere in the 10,000 x 5,000 m world returns the same height forever,
 * regardless of sector load order. Sector meshes only SAMPLE this field on
 * a global 4 m lattice, so sector borders match bit-for-bit — seamless by
 * construction, no stitching, no cracks.
 *
 * Terrain content (this phase only — no mountains, cliffs, rivers, props):
 *   - wide plains & rolling valleys  (λ ~1100 m, ±16 m)
 *   - gentle hills                   (λ ~300 m,  ±7 m)
 *   - soft ridge lines               (λ ~550 m,  +8 m, region-masked)
 *   - small natural bumps            (λ ~30 m,   ±0.5 m, cancelled on trails)
 *   - medium jump mounds             (r ~11 m, 1.2–2.2 m, placed ON trails
 *                                     plus a sparse scatter in open fields)
 *   - a dirt trail network           (wandering north-south + east-west
 *                                     corridors that FOLLOW the terrain —
 *                                     worn 0.2 m into the ground, smoother
 *                                     and grippier than open country)
 */

const SEED = 1214;

// Trail corridors. NS trails run the full 5 km depth, EW trails the full
// 10 km width; both wander with two incommensurate sines so crossings are
// varied but 100% deterministic.
const NS_SPACING = 800, NS_BASE = 400, NS_COUNT = 12; // x = 400..9200
const EW_SPACING = 700, EW_BASE = 350, EW_COUNT = 7;  // z = 350..4550
const TRAIL_HALF = 3.4;   // full-grip core half-width (m)
const TRAIL_FADE = 7.5;   // mask fades to 0 by this distance

// Jump mounds along NS trails.
const JUMP_SPACING = 190; // one candidate every ~190 m of trail
const JUMP_L = 7;         // kicker half-length along the trail (m)
const JUMP_W = 5;         // kicker half-width across the trail (m)

export class TerrainField {
  constructor() {
    this._info = { h: 0, trail: 0, moist: 0 };
  }

  /** Physics height — the single source of truth. */
  height(x, z) {
    return this.sample(x, z, this._info).h;
  }

  /**
   * Full sample: height + trail mask + moisture (for coloring).
   * `out` is caller-provided scratch; no allocations.
   */
  sample(x, z, out) {
    // --- Base landforms -----------------------------------------------------
    // Wide plains / rolling valleys.
    const plains = (fbm2(x * 0.00091, z * 0.00091, SEED) - 0.5) * 32;
    // Gentle hills.
    const hills = (vnoise(x * 0.0033 + 13.7, z * 0.0033 - 7.1, SEED + 5) - 0.5) * 14;
    // Soft ridge lines, only inside ridge regions (~1/3 of the world).
    const region = vnoise(x * 0.00058 + 91.2, z * 0.00058 + 40.6, SEED + 9);
    let ridge = 0;
    const rm = sstep(0.56, 0.78, region);
    if (rm > 0) {
      const rv = vnoise(x * 0.0018 + 55.1, z * 0.0018 - 21.9, SEED + 13);
      const crest = 1 - Math.abs(2 * rv - 1);
      ridge = crest * crest * 8 * rm;
    }

    // --- Trails --------------------------------------------------------------
    const trail = this._trailMask(x, z);

    // Small natural bumps — worn away on the trail surface.
    const bumps = (vnoise(x * 0.034 + 3.3, z * 0.034 - 9.9, SEED + 21) - 0.5) *
      1.1 * (1 - 0.85 * trail);

    // Jump mounds (on trails + sparse field scatter).
    const jump = this._jumpAt(x, z);

    // Worn trail bed sits ~0.2 m into the ground.
    let h = plains + hills + ridge + bumps + jump - 0.22 * trail;

    out.h = h;
    out.trail = trail;
    out.moist = vnoise(x * 0.0024 + 71.3, z * 0.0024 + 17.9, SEED + 33);
    return out;
  }

  /** Dirt-trail mask in [0,1]: 1 = trail core, 0 = open country. */
  _trailMask(x, z) {
    // Nearest north-south corridor.
    let m = 0;
    const k = Math.round((x - NS_BASE) / NS_SPACING);
    if (k >= 0 && k < NS_COUNT) {
      const d = Math.abs(x - this.nsCenter(k, z));
      m = 1 - sstep(TRAIL_HALF, TRAIL_FADE, d);
    }
    // Nearest east-west corridor.
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
   * Combined jump contribution at (x,z).
   *
   * Trail jumps are dirt KICKERS: a quadratic tent along the direction of
   * travel — h = H*(1-|u|)^2 — smooth at the base but with a SHARP crest.
   * The slope discontinuity at the crest is what actually launches the
   * bike (the ground-follow physics never separates from a C1-smooth
   * mound at rideable speeds: its curvature is far too low). Crest slope
   * is 2H/L ≈ 0.35–0.63 — a medium jump, not a cliff.
   *
   * Open-field mounds stay C1-smooth quartic whoops: rhythm, not air.
   */
  _jumpAt(x, z) {
    let h = 0;
    // Trail kickers: candidates along the nearest NS trail.
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
            w *= w; // smooth quartic falloff across the trail
            const H = 1.2 + hash01(k, m, SEED + 43) * 1.0;
            const t = 1 - du;
            h += H * t * t * w;
          }
        }
      }
    }
    // Sparse field mounds on a 160 m cell grid (natural whoops in the open).
    const cx = Math.floor(x / 160), cz = Math.floor(z / 160);
    if (hash01(cx, cz, SEED + 51) < 0.3) {
      const xf = (cx + 0.2 + hash01(cx, cz, SEED + 52) * 0.6) * 160;
      const zf = (cz + 0.2 + hash01(cx, cz, SEED + 53) * 0.6) * 160;
      const H = 0.8 + hash01(cx, cz, SEED + 54) * 0.8;
      h += moundAt(x, z, xf, zf, 13, H);
    }
    return h;
  }

  /**
   * Nearest trail jump mound to (x,z) on NS trail k (tests/debug aid).
   * Returns { x, z, h } or null.
   */
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
