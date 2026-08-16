import { vnoise, fbm2, hash01, sstep } from './noise.js';
import { Landforms, MEADOW, LAKE, WORLD_W, WORLD_H } from './Landforms.js';

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

// Lowland trail grid (2.5 m hidden shortcuts).
const NS_SPACING = 800, NS_BASE = 400, NS_COUNT = 9;  // x = 400..6800
const EW_SPACING = 700, EW_BASE = 350, EW_COUNT = 5;  // z = 350..3150
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

  /** Base landmass WITHOUT roads/jump: plain + hills + ranges + meadow. */
  _base(x, z) {
    const lf = this.landforms;
    const corr = lf.corridor(x, z);
    // Regional shaping (Phase 3.1): the base plain tilts by compass
    // direction from the spawn — south = low grasslands & lakes, west =
    // wide low valleys, north/east rise gently toward the ranges.
    // 0 at spawn latitude/longitude, +-1 at the world edges.
    const nz = (z - 2000) / 2000;  // -1 north edge .. +1 south edge
    const nx = (x - 4000) / 4000;  // -1 west edge .. +1 east edge
    const regional =
      -26 * Math.max(0, nz) +               // south: grassland shelf drops
      -22 * Math.max(0, -nx) +              // west: wide valleys sit low
      26 * Math.max(0, -nz) +               // north: gentle rise to the wall
      18 * Math.max(0, nx);                 // east: rise toward the passes
    // Valley/plain band: 100-300 m, long wavelength, halved amplitude in
    // the southern grasslands (rolling, never hilly). Inside a road
    // corridor the band relaxes toward its midpoint — the corridor IS
    // the valley (roads first), so roads never face deep cut benches.
    const south = sstep(0.1, 0.7, nz);
    const band = fbm2(x * 0.00055, z * 0.00055, SEED);
    const plain = 115 + band * 210 * (1 - 0.55 * south);
    let h = regional + 175 + (plain - 190) * (1 - 0.6 * corr);

    // Rolling hills — suppressed in road corridors and the meadow;
    // strongest in the SOUTH-WEST (the rolling-countryside region),
    // softened in the southern grasslands.
    const swBoost = 1 + 0.7 * sstep(0.15, 0.7, nz) * sstep(-0.15, -0.7, nx);
    const open = (1 - 0.85 * corr) * (1 - lf.meadowMask(x, z));
    h += (vnoise(x * 0.0028 + 13.7, z * 0.0028 - 7.1, SEED + 5) - 0.5) * 34 *
      open * swBoost * (1 - 0.5 * south * (1 - 0.6 * swBoost));
    h += (vnoise(x * 0.009 + 3.1, z * 0.009 + 9.4, SEED + 7) - 0.5) * 7 * open;

    // Mountain ranges (scenery, corridor- and spawn-basin-suppressed).
    h += lf.mountains(x, z);

    // Rider's Meadow: flatten to the meadow plane, tiny undulation kept.
    const mm = lf.meadowMask(x, z);
    if (mm > 0) {
      const meadowH = MEADOW.e +
        (vnoise(x * 0.006 + 31.7, z * 0.006 - 12.9, SEED + 11) - 0.5) * 3.2;
      h += (meadowH - h) * mm;
    }
    // Lakes carve everywhere they exist (meadow + southern grasslands).
    h -= lf.lakeDepth(x, z);
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

export { MEADOW, LAKE };
