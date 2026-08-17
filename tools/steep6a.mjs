// Where is the steep playable ground, and what is causing it?
import { TerrainField } from '../src/world/TerrainField.js';
const f = new TerrainField();
const lf = f.landforms;
const E = 4;
const deg = (g) => Math.atan(g) * 180 / Math.PI;

const buckets = new Map();
const add = (k, d) => {
  let b = buckets.get(k);
  if (!b) { b = { n: 0, max: 0, sum: 0 }; buckets.set(k, b); }
  b.n++; b.sum += d; b.max = Math.max(b.max, d);
};
const hot = [];
let play = 0, over = 0;

for (let x = 60; x <= 7940; x += 25) {
  for (let z = 60; z <= 4940; z += 25) {
    const h = f.height(x, z);
    const mtn = lf.mountains(x, z);
    if (mtn > 55 || h < 44 || z > 4380) continue;
    play++;
    const gx = (f.height(x + E, z) - f.height(x - E, z)) / (2 * E);
    const gz = (f.height(x, z + E) - f.height(x, z - E)) / (2 * E);
    const d = deg(Math.hypot(gx, gz));
    if (d <= 16) continue;
    over++;
    // Attribute the steepness.
    let cause = 'rolling-noise';
    if (mtn > 8) cause = 'mountain-skirt';
    else if (Math.abs(x - 690) < 700) cause = 'red-canyon';
    else if (lf.lakeDepth(x, z) > 0.5) cause = 'lake-bowl';
    else {
      let pl = null;
      for (const p of [[1760, 1660, 460], [6560, 3700, 410]]) {
        if (Math.hypot(x - p[0], z - p[1]) < p[2]) pl = 'plateau-rim';
      }
      if (pl) cause = pl;
      else if (lf.corridor(x, z) > 0.05) cause = 'road-corridor';
      else if (lf.ridgeSystems(x, z, 0) > 8) cause = 'authored-ridge';
      else if (lf.basinDepth(x, z, 0) > 3) cause = 'authored-basin';
    }
    add(cause, d);
    if (d > 34 && hot.length < 4000) hot.push([x, z, +d.toFixed(0), cause]);
  }
}
const rows = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({
  cause: k, samples: v.n, pctOfPlayable: +(100 * v.n / play).toFixed(2),
  pctOfOver: +(100 * v.n / over).toFixed(1),
  meanDeg: +(v.sum / v.n).toFixed(1), maxDeg: +v.max.toFixed(1),
}));
console.log(JSON.stringify({ playable: play, over16: over,
  over16Pct: +(100 * over / play).toFixed(1), byCause: rows }, null, 1));
// A few worst spots per cause.
const seen = {};
console.log('--- worst examples ---');
for (const [x, z, d, c] of hot.sort((a, b) => b[2] - a[2])) {
  seen[c] = (seen[c] || 0) + 1;
  if (seen[c] <= 3) console.log(`${c.padEnd(16)} (${x},${z}) ${d} deg  h=${f.height(x, z).toFixed(0)}`);
}
