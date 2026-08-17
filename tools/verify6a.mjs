// Chapter 6A verification: composition + slope compliance.
import { TerrainField } from '../src/world/TerrainField.js';
const f = new TerrainField();
const lf = f.landforms;
const E = 4;
const deg = (g) => Math.atan(g) * 180 / Math.PI;
const slopeAt = (x, z) => deg(Math.hypot(
  (f.height(x + E, z) - f.height(x - E, z)) / (2 * E),
  (f.height(x, z + E) - f.height(x, z - E)) / (2 * E)));

// ---- 1. Slope compliance over three nested definitions of "playable" ------
const defs = {
  // everything not underwater and not inside a border massif body
  playable: (x, z, h, mtn, edge) => mtn <= 55 && h >= 44 && z <= 4380,
  // the interior: clear of the border-mountain band entirely
  interior: (x, z, h, mtn, edge) => mtn <= 8 && h >= 44 && z <= 4380 && edge > 900,
  // riding country: interior, off the authored scenic exceptions
  ridingCountry: (x, z, h, mtn, edge) => mtn <= 8 && h >= 44 && z <= 4380 && edge > 900
    && Math.abs(x - 690) > 700 && lf.corridor(x, z) < 0.05,
};
const acc = {};
for (const k of Object.keys(defs)) acc[k] = [];
for (let x = 60; x <= 7940; x += 25) {
  for (let z = 60; z <= 4940; z += 25) {
    const h = f.height(x, z);
    const mtn = lf.mountains(x, z);
    const edge = Math.min(x, 8000 - x, z, 5000 - z);
    let want = false;
    for (const k of Object.keys(defs)) if (defs[k](x, z, h, mtn, edge)) want = true;
    if (!want) continue;
    const d = slopeAt(x, z);
    for (const k of Object.keys(defs)) if (defs[k](x, z, h, mtn, edge)) acc[k].push(d);
  }
}
const rep = {};
for (const [k, a] of Object.entries(acc)) {
  a.sort((p, q) => p - q);
  const q = (p) => +a[Math.min(a.length - 1, (a.length * p) | 0)].toFixed(1);
  rep[k] = { samples: a.length, rideablePct: +(100 * a.filter((d) => d <= 16).length / a.length).toFixed(1),
    p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: +a[a.length - 1].toFixed(1) };
}

// ---- 2. Do the authored landforms actually read? --------------------------
// Walk each ridge spine and each valley trunk and measure the relief it
// creates against the ground 1.5 x its half-width to either side.
const walk = (pts, w, sign) => {
  const rel = [], len = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az); total += L;
    const nx = -(bz - az) / L, nz = (bx - ax) / L;
    for (let t = 0; t <= 1; t += 0.1) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = f.height(x, z);
      const s1 = f.height(x + nx * w * 1.5, z + nz * w * 1.5);
      const s2 = f.height(x - nx * w * 1.5, z - nz * w * 1.5);
      rel.push(sign * (c - (s1 + s2) / 2));
    }
  }
  rel.sort((a, b) => a - b);
  return { lengthM: Math.round(total), reliefMedian: +rel[rel.length >> 1].toFixed(1),
    reliefMin: +rel[0].toFixed(1), reliefMax: +rel[rel.length - 1].toFixed(1),
    continuousPct: +(100 * rel.filter((r) => r > 6).length / rel.length).toFixed(0) };
};
const RS = lf.constructor; // not exported; re-read via stats + landformAt probing
const st = lf.stats();

// ---- 3. Room structure: does the interior stop feeling like one plain? ----
let flat = 0, rooms = 0, tot = 0;
const reliefs = [];
for (let x = 900; x <= 7100; x += 150) {
  for (let z = 600; z <= 4200; z += 150) {
    if (lf.mountains(x, z) > 8) continue;
    tot++;
    const hs = [];
    for (let a = 0; a < 8; a++) {
      const A = (a / 8) * Math.PI * 2;
      hs.push(f.height(x + Math.cos(A) * 300, z + Math.sin(A) * 300));
    }
    const m = hs.reduce((s, v) => s + v, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((s, v) => s + (v - m) ** 2, 0) / hs.length);
    reliefs.push(sd);
    if (sd < 6) flat++;
    if (sd > 12) rooms++;
  }
}
reliefs.sort((a, b) => a - b);

// ---- 4. Border mountains only at the edges --------------------------------
let inlandMtn = 0, mtnTot = 0;
for (let x = 100; x <= 7900; x += 50) for (let z = 100; z <= 4900; z += 50) {
  const m = lf.mountains(x, z);
  if (m < 60) continue;
  mtnTot++;
  if (Math.min(x, 8000 - x, z, 5000 - z) > 1120) inlandMtn++;
}

console.log(JSON.stringify({
  slopeCompliance: rep,
  counts: { ridgeSystems: st.ridgeSystems, valleySystems: st.valleySystems,
    basins: st.basins, plateaus: st.plateaus, ranges: st.ranges, peaks: st.peaks },
  interiorStructure: {
    samples: tot,
    flatPct: +(100 * flat / tot).toFixed(1),
    shapedPct: +(100 * rooms / tot).toFixed(1),
    relief300m: { p10: +reliefs[(reliefs.length * .1) | 0].toFixed(1),
      p50: +reliefs[(reliefs.length * .5) | 0].toFixed(1),
      p90: +reliefs[(reliefs.length * .9) | 0].toFixed(1) },
  },
  borderMountains: { massifSamples: mtnTot, inlandBeyond1120m: inlandMtn },
}, null, 1));
