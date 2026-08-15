import { sstep } from './noise.js';

/**
 * Shared terrain palette (Phase 3) — vertex colors only, no textures.
 * Used by both the near tile builder and the far backdrop mesh so LOD
 * levels always agree on color.
 *
 * Bands: moist grass -> dry basin scrub -> alpine rock -> snow, with the
 * dirt road/trail tint applied last so roads stay readable even through
 * the snow line (a plowed mountain road).
 */
export function colorFor(info, out) {
  const m = info.moist, t = info.trail, h = info.h;

  // Lowland grass.
  let r = 0.52 - 0.20 * m, g = 0.60 - 0.10 * m, b = 0.30 - 0.06 * m;

  // Dry scrub on the lowest valley floors.
  const dry = sstep(160, 110, h);
  r += (0.58 - r) * dry * 0.5; g += (0.55 - g) * dry * 0.5; b += (0.36 - b) * dry * 0.5;

  // Alpine rock band (redesigned world: valleys ~100-350, peaks to ~2200).
  const rock = sstep(420, 1050, h);
  r += (0.46 + 0.05 * m - r) * rock;
  g += (0.42 + 0.04 * m - g) * rock;
  b += (0.38 + 0.03 * m - b) * rock;

  // Snow cap.
  const snow = sstep(1650, 2050, h);
  r += (0.93 - r) * snow; g += (0.95 - g) * snow; b += (0.98 - b) * snow;

  // Dirt trail / road bed (kept visible at any altitude).
  const tr = t * (1 - 0.35 * snow);
  r += (0.56 - r) * tr; g += (0.44 - g) * tr; b += (0.29 - b) * tr;

  out[0] = r; out[1] = g; out[2] = b;
  return out;
}
