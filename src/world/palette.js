import { sstep, vnoise } from './noise.js';

/**
 * Shared terrain palette — vertex colors only, no textures.
 * Used by both the near tile builder and the far backdrop mesh so LOD
 * levels always agree on color.
 *
 * Chapter 3A polish (all deterministic functions of world position, so
 * both LOD levels still match):
 *   - grass color variation: two-scale patchiness (meadows vs sedge)
 *   - dirt edge blending: the road tint gets a soft, noise-broken edge
 *     instead of a hard mask cut
 *   - rock color variation: banding on the alpine faces
 *   - slight ambient vertex tint: large-scale warm/cool wash
 *
 * Chapter 5 additions (still pure functions of world position, so both
 * LOD levels stay in lockstep):
 *   - cloud shadows: soft 700 m cool patches across the whole map
 *   - colour push: saturation lifted away from local luminance
 *   - roads: three-scale organic edge, dusty/damp stretches, grass
 *     creeping back over quiet shoulders
 *
 * Bands: moist grass -> dry scrub -> alpine rock -> snow, with the dirt
 * road tint applied last so roads stay readable at any altitude.
 */
export function colorFor(info, out, x = 0, z = 0) {
  const m = info.moist, h = info.h;
  let t = info.trail;

  // Chapter 4 regional tints, computed up front:
  //   beach sand near/below sea level along the south coast
  //   red sandstone strata in the Red Canyon (far west)
  //   dark basalt on the Volcanic Highlands (far east)
  const beach = z > 4300 ? sstep(90, 55, h) : 0;
  const canyon = x < 1300 && z > 1400 && z < 3800 ? sstep(1150, 700, x) : 0;
  const basalt = x > 6900 && z > 1700 && z < 4100 ? sstep(7100, 7500, x) : 0;

  // Grass patchiness: broad meadow/sedge patches + fine tussock speckle.
  const patch = vnoise(x * 0.008 + 5.2, z * 0.008 - 3.7, 911) - 0.5;
  const speck = vnoise(x * 0.045 + 1.3, z * 0.045 + 8.6, 913) - 0.5;
  const gv = patch * 0.10 + speck * 0.05;

  // Lowland grass (variation shifts hue between lush and straw).
  let r = 0.50 - 0.20 * m + gv * 0.9;
  let g = 0.60 - 0.10 * m + gv * 0.4;
  let b = 0.29 - 0.06 * m - gv * 0.3;

  // Dry scrub on the lowest valley floors.
  const dry = sstep(160, 110, h);
  r += (0.58 - r) * dry * 0.5; g += (0.55 - g) * dry * 0.5; b += (0.36 - b) * dry * 0.5;

  // Alpine rock band with strata variation.
  const rock = sstep(420, 1050, h);
  if (rock > 0) {
    const strata = (vnoise(x * 0.006 + h * 0.004, z * 0.006, 917) - 0.5) * 0.09;
    r += (0.46 + 0.05 * m + strata - r) * rock;
    g += (0.42 + 0.04 * m + strata - g) * rock;
    b += (0.38 + 0.03 * m + strata * 0.7 - b) * rock;
  }

  // Snow cap.
  const snow = sstep(1650, 2050, h);
  r += (0.93 - r) * snow; g += (0.95 - g) * snow; b += (0.98 - b) * snow;

  // Dirt road/trail tint with a noise-broken soft edge, worn tire paths,
  // gravel shoulders and scattered small stones (Chapter 3B road wear).
  if (t > 0.003) {
    // Chapter 5 — organic edges. A single 9 m noise octave gave every
    // road the same fuzzy-but-uniform rim, which is what read as
    // "artificial". Three scales now break the bed line: a long 60 m
    // meander (the road wanders inside its own corridor), a 9 m ragged
    // fringe and a 2 m crumble, all applied only near the edge (t small)
    // so the bed you actually ride stays exactly where physics put it.
    const meander = (vnoise(x * 0.017 + 41.3, z * 0.017 - 22.7, 918) - 0.5) * 1.15;
    const edge = (vnoise(x * 0.11, z * 0.11, 919) - 0.5) * 0.5;
    const crumble = (vnoise(x * 0.42 - 5.1, z * 0.42 + 3.3, 921) - 0.5) * 0.35;
    t = Math.min(1, Math.max(0, t + (meander + edge + crumble) * (1 - t) * t * 4));
    const tr = t * (1 - 0.35 * snow);
    // Base dirt bed.
    let dr = 0.55 + patch * 0.04, dg = 0.435, db = 0.285;
    // Worn tire paths: two darker packed strips (t ~ 0.55 either side of
    // center reads as the wheel lines on every road width).
    const lane = sstep(0.35, 0.55, t) * (1 - sstep(0.68, 0.88, t));
    dr -= lane * 0.075; dg -= lane * 0.06; db -= lane * 0.045;
    // Center crown: lighter loose dirt between the wheel lines.
    const crown = sstep(0.88, 1, t);
    dr += crown * 0.035; dg += crown * 0.03; db += crown * 0.02;
    // Gravel shoulders: grey grit fringe where the bed meets the grass.
    const shoulder = sstep(0.03, 0.16, t) * (1 - sstep(0.2, 0.4, t));
    const gv2 = vnoise(x * 0.32, z * 0.32, 929);
    dr += shoulder * (0.1 + gv2 * 0.1);
    dg += shoulder * (0.1 + gv2 * 0.09);
    db += shoulder * (0.11 + gv2 * 0.09);
    // Small stones: sparse bright speckle on the bed.
    const stone = vnoise(x * 0.9 + 3.1, z * 0.9 - 7.7, 931);
    if (stone > 0.78) {
      const sv = (stone - 0.78) * 2.4;
      dr += sv * 0.14; dg += sv * 0.13; db += sv * 0.12;
    }
    // Chapter 5 road wear: long dusty stretches and damp/mud patches,
    // and grass creeping back over the shoulders of quiet roads. No two
    // 50 m stretches of dirt look alike any more.
    const wear = vnoise(x * 0.021 - 13.9, z * 0.021 + 27.4, 933);
    if (wear > 0.62) {
      const dusty = (wear - 0.62) * 2.2; // sun-bleached, blown dust
      dr += dusty * 0.10; dg += dusty * 0.085; db += dusty * 0.06;
    } else if (wear < 0.34) {
      const damp = (0.34 - wear) * 2.0;  // packed damp earth, darker
      dr -= damp * 0.11; dg -= damp * 0.095; db -= damp * 0.06;
    }
    // Grass encroachment: patches where the verge has taken the bed
    // back — the mask itself is softened, not just tinted.
    const creep = vnoise(x * 0.055 + 8.8, z * 0.055 - 4.4, 935);
    const enc = creep > 0.66 ? (creep - 0.66) * 2.6 : 0;
    const trf = tr * (1 - 0.55 * enc * (1 - sstep(0.55, 0.9, t)));
    r += (dr - r) * trf;
    g += (dg - g) * trf;
    b += (db - b) * trf;
  }

  // Chapter 4 region tints (after the altitude bands, before the wash).
  if (beach > 0) {
    r += (0.82 - r) * beach; g += (0.76 - g) * beach; b += (0.58 - b) * beach;
  }
  if (canyon > 0) {
    const strata = (vnoise(h * 0.05, x * 0.002, 937) - 0.5) * 0.12;
    r += (0.62 + strata - r) * canyon * 0.8;
    g += (0.36 + strata * 0.6 - g) * canyon * 0.8;
    b += (0.25 - b) * canyon * 0.8;
  }
  if (basalt > 0) {
    r += (0.26 - r) * basalt * 0.75;
    g += (0.23 - g) * basalt * 0.75;
    b += (0.22 - b) * basalt * 0.75;
    // ember glints high on the volcano
    const glow = sstep(900, 1300, h) * basalt;
    if (glow > 0) {
      const gl = vnoise(x * 0.05, z * 0.05, 941);
      if (gl > 0.82) { r += glow * 0.5; g += glow * 0.12; }
    }
  }

  // Ambient wash: very large-scale warm/cool tint (readable regions).
  const wash = vnoise(x * 0.0009 + 21.5, z * 0.0009 - 14.2, 923) - 0.5;
  r += wash * 0.035;
  g += wash * 0.015;
  b -= wash * 0.03;

  // Chapter 5 — CLOUD SHADOWS. Soft 700 m patches of cooler, darker
  // ground drifting across the whole map (static in world space, so the
  // near tiles and the far backdrop agree exactly and nothing shimmers).
  // Big scenery reads flat when every hillside gets identical light;
  // this is the single cheapest way to give the world depth at range.
  const cloud = vnoise(x * 0.0014 - 6.3, z * 0.0014 + 11.7, 947);
  if (cloud < 0.46) {
    const sh = (0.46 - cloud) * 2.0;      // 0..~0.9
    const k = 1 - 0.13 * sh;
    r *= k; g *= k * 1.004; b *= k * 1.03; // shadows go blue, not grey
  }

  // Chapter 5 — depth of colour. Low-poly ground looks flat when every
  // channel sits in the same narrow band, so push saturation away from
  // the local luminance a touch (a painter's "push the colour" pass).
  const lum = r * 0.35 + g * 0.5 + b * 0.15;
  r += (r - lum) * 0.16;
  g += (g - lum) * 0.16;
  b += (b - lum) * 0.16;

  out[0] = r < 0 ? 0 : r;
  out[1] = g < 0 ? 0 : g;
  out[2] = b < 0 ? 0 : b;
  return out;
}
