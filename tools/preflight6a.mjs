// Pre-flight: replicate the terrain/road assertions the e2e makes, in Node.
import { TerrainField } from '../src/world/TerrainField.js';
const f = new TerrainField();
const lf = f.landforms;
const D = (g) => Math.atan(g) * 180 / Math.PI;

// ---- Road grades from the laid centreline vertices ------------------------
const worst = { main: { d: 0, name: '' }, pass: { d: 0, name: '' }, any: { d: 0, name: '' } };
const perRoad = [];
for (const [id, m] of lf.roadMeta) {
  let mx = 0;
  for (let i = m.i0; i < m.i0 + m.n - 1; i++) {
    const dx = lf._rx[i + 1] - lf._rx[i], dz = lf._rz[i + 1] - lf._rz[i];
    const dy = lf._re[i + 1] - lf._re[i];
    const run = Math.hypot(dx, dz);
    if (run < 0.5) continue;
    mx = Math.max(mx, D(Math.abs(dy) / run));
  }
  perRoad.push({ name: m.name, type: m.type, deg: +mx.toFixed(2) });
  const bucket = m.type === 1 ? 'main' : m.type === 2 ? 'pass' : null;
  if (bucket && mx > worst[bucket].d) worst[bucket] = { d: +mx.toFixed(2), name: m.name };
  if (mx > worst.any.d) worst.any = { d: +mx.toFixed(2), name: m.name };
}
perRoad.sort((a, b) => b.deg - a.deg);

// ---- Border / peak / floor assertions -------------------------------------
let minH = Infinity, maxH = -Infinity;
for (let x = 0; x <= 8000; x += 40) for (let z = 0; z <= 5000; z += 40) {
  const h = f.height(x, z);
  if (h < minH) minH = h;
  if (h > maxH) maxH = h;
}
// Mirror the e2e exactly: 6000 scattered samples PLUS the Kanjiro box.
let peakH = -Infinity, e2eMin = Infinity;
for (let i = 0; i < 6000; i++) {
  const x = (i * 613) % 8000, z = (i * 271) % 5000;
  const h = f.height(x, z);
  if (h < e2eMin) e2eMin = h;
  if (h > peakH) peakH = h;
}
for (let dx = -250; dx <= 250; dx += 25) for (let dz = -250; dz <= 250; dz += 25) {
  peakH = Math.max(peakH, f.height(7050 + dx, 1060 + dz));
}

// ---- Landmarks reachable ---------------------------------------------------
const bad = [];
for (const d of lf.destinations) {
  const rd = lf.roadDist(d.x, d.z), h = f.height(d.x, d.z);
  if (!(rd < 120 && h > 43)) bad.push({ name: d.name, roadDist: +rd.toFixed(0), h: +h.toFixed(0) });
}

// ---- Spawn flatness --------------------------------------------------------
const sl = (x, z, e = 3) => D(Math.hypot(
  (f.height(x + e, z) - f.height(x - e, z)) / (2 * e),
  (f.height(x, z + e) - f.height(x, z - e)) / (2 * e)));

console.log(JSON.stringify({
  roads: {
    worstMain: worst.main, worstPass: worst.pass, worstAny: worst.any,
    mainsOk: worst.main.d <= 10, allOk: worst.any.d <= 12,
    top5: perRoad.slice(0, 5),
  },
  eaglePassLen: lf.passes.find((p) => /Eagle/.test(p.name || ''))
    ? +lf.passes.find((p) => /Eagle/.test(p.name || '')).lengthM.toFixed(0) : null,
  e2eMaxH: +peakH.toFixed(0), peakOk: peakH > 2000 && peakH <= 2300,
  e2eMinH: +e2eMin.toFixed(0), e2eFloorOk: e2eMin > -80 && e2eMin < 260,
  worldMin: +minH.toFixed(0), worldMax: +maxH.toFixed(0),
  floorOk: minH > -80 && minH < 260,
  borders: {
    seaBed: +f.height(4000, 4960).toFixed(1),
    northWall: +f.height(3300, 620).toFixed(0),
    eastWall: +f.height(7860, 2850).toFixed(0),
    westWall: +f.height(185, 2500).toFixed(0),
  },
  bordersOk: f.height(4000, 4960) < 42 && f.height(3300, 620) > 800 &&
    f.height(7860, 2850) > 800 && f.height(185, 2500) > 600,
  landmarksBad: bad,
  spawnSlopeDeg: +sl(4026, 2464).toFixed(2),
  practiceJumpSlope: +sl(4000, 2540).toFixed(2),
  viewpoints: lf.viewpoints.length,
}, null, 1));
