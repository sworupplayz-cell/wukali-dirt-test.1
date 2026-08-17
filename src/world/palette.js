import { sstep, vnoise } from './noise.js';

/**
 * Chapter 6B — the horizon/haze colour, shared by the sky gradient, the
 * scene fog and the far backdrop so all three agree exactly. A single
 * flat pale blue (0xc9dfec) made every distance read the same: it is
 * slightly warmer and lighter now, which is what lets aerial perspective
 * separate a ridge at 400 m from a massif at 3 km.
 */
export const HORIZON = 0xd3e2ea;

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
 * Chapter 6B — the world was drab: every band converged on one olive,
 * so a meadow, a hillside and a mountain flank at 1 km all read as the
 * same khaki. The fix is HUE SEPARATION rather than more noise. Grass
 * variation now swings hue (fresh blue-green to golden straw) instead of
 * just brightness, the dry upland band is gated on moisture so it stops
 * painting every hill the same colour, and the rock band carries warm
 * and cool strata instead of a single grey.
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
  const beach = z > 4300 ? sstep(72, 44, h) : 0;
  const canyon = x < 1300 && z > 1400 && z < 3800 ? sstep(1150, 700, x) : 0;
  const basalt = x > 6900 && z > 1700 && z < 4100 ? sstep(7100, 7500, x) : 0;

  // Grass patchiness (Chapter 5B: three scales instead of two). Broad
  // meadow/sedge patches, a mid-scale sward break-up that matches the
  // size of a vegetation stand, and fine tussock speckle.
  const patch = vnoise(x * 0.008 + 5.2, z * 0.008 - 3.7, 911) - 0.5;
  const stand = vnoise(x * 0.021 - 9.4, z * 0.021 + 2.8, 915) - 0.5;
  const speck = vnoise(x * 0.045 + 1.3, z * 0.045 + 8.6, 913) - 0.5;
  const gv = patch * 0.11 + stand * 0.07 + speck * 0.05;
  // Chapter 6B — MEADOW MOOD. A 300 m field that swings a whole sward
  // between fresh growth and sun-cured straw. This is a HUE rotation, not
  // a brightness change: red climbs while blue falls, so neighbouring
  // meadows read as different grasses rather than the same grass under
  // different light. It is the single change that takes the lowland out
  // of its one flat green.
  const mood = (vnoise(x * 0.0033 + 17.9, z * 0.0033 - 24.1, 951) - 0.5) * 2; // -1..1
  const golden = Math.max(0, mood), fresh = Math.max(0, -mood);

  // Lowland grass (variation shifts hue between lush and straw).
  let r = 0.50 - 0.20 * m + gv * 0.9;
  let g = 0.60 - 0.10 * m + gv * 0.4;
  let b = 0.29 - 0.06 * m - gv * 0.3;
  r += golden * 0.14 - fresh * 0.07;
  g += golden * 0.045 + fresh * 0.045;
  b -= golden * 0.075 - fresh * 0.055;

  // Chapter 6 — the bands follow the rebuilt elevation range (the whole
  // rolling country now lives between ~45 m and ~130 m, so the old
  // 110-1650 m bands would have painted the entire world as scrub).
  // Damp, lush ground in the valley bottoms where water collects...
  const lush = sstep(88, 52, h);
  r += (0.30 - r) * lush * 0.5; g += (0.53 - g) * lush * 0.5; b += (0.24 - b) * lush * 0.5;
  // ...sun-bleached grass along the ridge crests above them. Chapter 6B
  // gates this on MOISTURE as well as altitude. Keyed on height alone it
  // painted every square metre above 145 m the same khaki, which is why
  // the uplands had no colour of their own.
  const dry = sstep(96, 165, h) * (0.45 + 0.55 * sstep(0.62, 0.24, m));
  r += (0.62 - r) * dry * 0.55; g += (0.55 - g) * dry * 0.55; b += (0.31 - b) * dry * 0.55;
  // Chapter 6B — upland pasture. Between the meadows and the rock the
  // ground now keeps a cool green of its own instead of dissolving
  // straight into scrub, so a hillside at 200-400 m reads as grazing
  // country rather than as dust.
  const pasture = sstep(130, 210, h) * (1 - sstep(300, 480, h)) * sstep(0.3, 0.6, m);
  r += (0.34 - r) * pasture * 0.5; g += (0.50 - g) * pasture * 0.5; b += (0.30 - b) * pasture * 0.5;

  // Alpine rock band with strata variation.
  // Chapter 6B: the rock band used to start at 260 m and be fully rock by
  // 720 m — but the conifer belt runs to about 700 m, so every forested
  // hillside was painted as scree with trees standing in it. Moved up to
  // sit ABOVE the tree line; the massifs (800-2,200 m) are unaffected.
  const rock = sstep(360, 860, h);
  if (rock > 0) {
    // Rock colour variation: bedding planes plus a finer grain break-up,
    // so a face is never one flat grey. Chapter 6B splits the bands into
    // WARM (iron-stained) and COOL (slate) strata rather than lightening
    // and darkening a single grey.
    const bed = vnoise(x * 0.006 + h * 0.004, z * 0.006, 917) - 0.5;
    const grain = (vnoise(x * 0.038 + 4.1, z * 0.038 - 6.3, 921) - 0.5) * 0.05;
    const strata = bed * 0.11 + grain;
    const warmBand = Math.max(0, bed) * 0.9, coolBand = Math.max(0, -bed) * 0.9;
    r += (0.47 + 0.05 * m + strata + warmBand * 0.10 - coolBand * 0.04 - r) * rock;
    g += (0.42 + 0.04 * m + strata + warmBand * 0.03 - coolBand * 0.01 - g) * rock;
    b += (0.38 + 0.03 * m + strata * 0.7 - warmBand * 0.05 + coolBand * 0.09 - b) * rock;
  }


  // Snow cap.
  const snow = sstep(950, 1400, h);
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
    const glow = sstep(620, 950, h) * basalt;
    if (glow > 0) {
      const gl = vnoise(x * 0.05, z * 0.05, 941);
      if (gl > 0.82) { r += glow * 0.5; g += glow * 0.12; }
    }
  }

  // Chapter 5B — GROUND TINT BLENDING. Moisture drifts the whole surface
  // between a warm dry cast and a cool damp one, which ties the grass,
  // dirt and stone bands into one landscape instead of three palettes.
  const damp = m - 0.5;
  r -= damp * 0.045;
  g += damp * 0.020;
  b += damp * 0.050;

  // Ambient wash: very large-scale warm/cool tint (readable regions),
  // with a slower hue drift on top so no two valleys read identically.
  const wash = vnoise(x * 0.0009 + 21.5, z * 0.0009 - 14.2, 923) - 0.5;
  const drift = vnoise(x * 0.00035 - 7.7, z * 0.00035 + 12.4, 927) - 0.5;
  r += wash * 0.035 + drift * 0.030;
  g += wash * 0.015 + drift * 0.012;
  b -= wash * 0.030 + drift * 0.022;

  // Chapter 5 — CLOUD SHADOWS. Soft 700 m patches of cooler, darker
  // ground drifting across the whole map (static in world space, so the
  // near tiles and the far backdrop agree exactly and nothing shimmers).
  // Big scenery reads flat when every hillside gets identical light;
  // this is the single cheapest way to give the world depth at range.
  // Chapter 6B deepens them: at 0.13 they were barely legible past
  // 200 m, and cloud shadow is most of what makes a wide valley read as
  // a wide valley rather than a painted backdrop.
  const cloud = vnoise(x * 0.0014 - 6.3, z * 0.0014 + 11.7, 947);
  if (cloud < 0.48) {
    const sh = (0.48 - cloud) * 2.0;      // 0..~0.95
    const k = 1 - 0.19 * sh;
    r *= k; g *= k * 1.006; b *= k * 1.045; // shadows go blue, not grey
  }

  // Chapter 5 — depth of colour. Low-poly ground looks flat when every
  // channel sits in the same narrow band, so push saturation away from
  // the local luminance a touch (a painter's "push the colour" pass).
  // Chapter 6B lifts 0.16 -> 0.26; the whole point of the style is that
  // colour, not texture, carries the surface.
  const lum = r * 0.35 + g * 0.5 + b * 0.15;
  r += (r - lum) * 0.26;
  g += (g - lum) * 0.26;
  b += (b - lum) * 0.26;

  out[0] = r < 0 ? 0 : r;
  out[1] = g < 0 ? 0 : g;
  out[2] = b < 0 ? 0 : b;
  return out;
}
