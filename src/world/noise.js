/**
 * Seeded deterministic noise / hashing utilities.
 * Everything in the procedural world derives from (coordinates + seed),
 * never from generation order — required for seamless infinite chunks.
 */

/** 32-bit integer hash of a 2D lattice point + salt. */
export function hashInt(ix, iz, s) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** Hash to [0, 1). */
export function hash01(ix, iz, s) {
  return (hashInt(ix, iz, s) >>> 0) / 4294967296;
}

/** 2D value noise with quintic interpolation, output [0, 1). */
export function vnoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash01(ix, iz, s);
  const b = hash01(ix + 1, iz, s);
  const c = hash01(ix, iz + 1, s);
  const d = hash01(ix + 1, iz + 1, s);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Two-octave fractal value noise, output roughly [0, 1). */
export function fbm2(x, z, s) {
  return (vnoise(x, z, s) + 0.5 * vnoise(x * 2.13 + 31.7, z * 2.13 - 17.3, s + 77)) / 1.5;
}

/** Small fast seeded PRNG (used for per-chunk prop scatter). */
export function mulberry32(seed) {
  let t = seed | 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
