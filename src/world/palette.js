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
 * Bands: moist grass -> dry scrub -> alpine rock -> snow, with the dirt
 * road tint applied last so roads stay readable at any altitude.
 */
export function colorFor(info, out, x = 0, z = 0) {
  const m = info.moist, h = info.h;
  let t = info.trail;

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
    const edge = (vnoise(x * 0.11, z * 0.11, 919) - 0.5) * 0.5;
    t = Math.min(1, Math.max(0, t + edge * (1 - t) * t * 4));
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
    r += (dr - r) * tr;
    g += (dg - g) * tr;
    b += (db - b) * tr;
  }

  // Ambient wash: very large-scale warm/cool tint (readable regions).
  const wash = vnoise(x * 0.0009 + 21.5, z * 0.0009 - 14.2, 923) - 0.5;
  r += wash * 0.035;
  g += wash * 0.015;
  b -= wash * 0.03;

  out[0] = r; out[1] = g; out[2] = b;
  return out;
}
