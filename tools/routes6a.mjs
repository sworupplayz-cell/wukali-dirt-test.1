// Walk the exact cross-country routes the e2e rides and report the ground.
import { TerrainField } from '../src/world/TerrainField.js';
const f = new TerrainField();
const lf = f.landforms;
const D = (g) => Math.atan(g) * 180 / Math.PI;
const slope = (x, z, e = 3) => D(Math.hypot(
  (f.height(x + e, z) - f.height(x - e, z)) / (2 * e),
  (f.height(x, z + e) - f.height(x, z - e)) / (2 * e)));

function densify(route, step) {
  const out = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  }
  out.push(route[route.length - 1]);
  return out;
}

// The e2e's hardcoded spawn -> Eagle Approach cross-country line.
const eagleRoute = [
  { x: 4000, z: 2465 }, { x: 4000, z: 1480 }, { x: 3400, z: 1500 },
  { x: 3200, z: 1330 }, { x: 2800, z: 1355 }, { x: 2500, z: 1395 },
];
const report = (name, pts) => {
  let worst = 0, worstAt = null, over16 = 0, over25 = 0;
  const prof = [];
  for (const p of pts) {
    const s = slope(p.x, p.z);
    if (s > worst) { worst = s; worstAt = p; }
    if (s > 16) over16++;
    if (s > 25) over25++;
    prof.push({ x: Math.round(p.x), z: Math.round(p.z), h: +f.height(p.x, p.z).toFixed(0), s: +s.toFixed(1) });
  }
  console.log(`${name}: n=${pts.length} worst=${worst.toFixed(1)} deg at (${Math.round(worstAt.x)},${Math.round(worstAt.z)}) over16=${over16} over25=${over25}`);
  const bad = prof.filter((p) => p.s > 16);
  if (bad.length) console.log('  steep:', JSON.stringify(bad.slice(0, 14)));
  // Also the climb profile along the line.
  const hs = prof.map((p) => p.h);
  console.log(`  h: min=${Math.min(...hs)} max=${Math.max(...hs)} start=${hs[0]} end=${hs[hs.length - 1]}`);
};

report('eagle cross-country', densify(eagleRoute, 20));

// The Eagle Approach road itself + saddle.
const app = [...lf.roadMeta.values()].find((m) => m.name === 'Eagle Approach');
const appPts = [];
for (let i = app.i0; i < app.i0 + app.n; i += 2) appPts.push({ x: lf._rx[i], z: lf._rz[i] });
report('eagle approach road', appPts);
const eagle = lf.passes.find((p) => p.name === 'Eagle Pass Road');
console.log('saddle', eagle.sx, eagle.sz, 'elev', eagle.elev, 'terrainH', f.height(eagle.sx, eagle.sz).toFixed(0));

// The Horizon Loop waypoints (main road) — ride follows the road vertices.
const loop = [...lf.roadMeta.values()].find((m) => /Horizon Loop/.test(m.name));
if (loop) {
  const lp = [];
  for (let i = loop.i0; i < loop.i0 + loop.n; i += 2) lp.push({ x: lf._rx[i], z: lf._rz[i] });
  report('horizon loop road', lp);
}
