/**
 * Horizon Ride — Phase 3 (world redesign) end-to-end verification.
 *
 * Drives the real game (dev server on :3000) in headless Chromium and
 * checks the preserved foundation (bike physics, camera, controls, menus,
 * streaming architecture) plus the redesigned roads-first world:
 * 8,000 x 4,000 m / 128 sectors, Rider's Meadow spawn, the Horizon Loop,
 * pass switchbacks, hidden trails, viewpoints and instanced landmarks.
 *
 * Setup once per sandbox:  bash tests/setup-browser.sh
 * Run:                     npm run test:e2e
 */
const { createRequire } = require('module');
const req = createRequire('/tmp/e2e/x.js');
const chromium = req('@sparticuz/chromium').default;
const puppeteer = req('puppeteer-core');

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args],
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023lib/lib' },
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 850, height: 400, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  // CI runs on a software rasterizer: pin the Potato preset (what
  // auto-detect would pick on such a device) so wall-clock ride checks
  // simulate at full speed. The graphics-system checks still exercise
  // every preset explicitly.
  await page.evaluate(() => {
    localStorage.setItem('horizon_graphics', JSON.stringify({
      preset: 'potato', renderScale: 0.6, renderDist: 800, shadows: 0,
      vegetation: 0.25, terrainDetail: 0, fogQuality: 0, antialias: false, fpsLimit: 60,
    }));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1800);

  const state = () => page.evaluate(() => {
    const g = window.__game;
    return {
      state: g.state,
      pos: g.bike.position.toArray().map((n) => +n.toFixed(2)),
      speed: +g.bike.speed.toFixed(2),
      yaw: +g.bike.yaw.toFixed(3),
      grounded: g.bike.grounded, crashed: g.bike.crashed,
      susp: +g.bike.suspension.toFixed(3),
      fps: g.stats.fps,
      camPos: g.camera.position.toArray().map((n) => +n.toFixed(1)),
      debug: { ...g.world.debug },
      groundH: +g.world.getHeight(g.bike.position.x, g.bike.position.z).toFixed(3),
    };
  });

  // ================= World architecture (reduced map) =================
  let s = await state();
  check('Main menu opens', s.state === 'menu');

  const world = await page.evaluate(() => {
    const g = window.__game;
    const W = g.world;
    return {
      isSectorWorld: W.constructor.name === 'SectorWorld',
      corner00: W.sectorAt(1, 1),
      cornerMax: W.sectorAt(7999, 3999),
      clampNeg: W.sectorAt(-50, -50),
      inBounds: W.isInBounds(4000, 2000),
      outBounds: W.isInBounds(-10, 100) || W.isInBounds(8001, 100) || W.isInBounds(100, 4001),
      loaded: W.debug.loaded,
      calls: g.renderer.info.render.calls,
    };
  });
  check('World is the SectorWorld streaming engine', world.isSectorWorld);
  check('Fixed sector grid 16x8 (128 sectors)',
    world.corner00.x === 0 && world.cornerMax.x === 15 && world.cornerMax.z === 7 &&
    world.clampNeg.x === 0);
  check('World bounds 8,000 x 4,000', world.inBounds && !world.outBounds);
  check('3x3 logical sector window active', world.loaded === 9, `loaded=${world.loaded}`);

  // ================= Terrain + roads-first design =================
  const terrain = await page.evaluate(() => {
    const f = window.__game.world.field;
    const lf = f.landforms;
    const deterministic = f.height(1234.5, 987.6) === f.height(1234.5, 987.6);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < 6000; i++) {
      const x = (i * 613) % 8000, z = (i * 271) % 4000;
      const h = f.height(x, z);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    // Kanjiro summit area sample (NE massif).
    for (let dx = -250; dx <= 250; dx += 25) {
      for (let dz = -250; dz <= 250; dz += 25) {
        maxH = Math.max(maxH, f.height(7050 + dx, 560 + dz));
      }
    }
    return { deterministic, minH: +minH.toFixed(0), maxH: +maxH.toFixed(0), stats: lf.stats() };
  });
  const st = terrain.stats;
  check('Height is deterministic', terrain.deterministic);
  check('10 named peaks in 3 ranges (N / NE / E; S-SW-W open)',
    st.peaks === 10 && st.ranges === 3);
  check('Highest peak ~2200 m', terrain.maxH > 2000 && terrain.maxH <= 2300, `${terrain.maxH} m`);
  check('Valley band 80-250 m (no holes)',
    terrain.minH > 70 && terrain.minH < 260, `min=${terrain.minH} m`);
  check('Road network: 6 main roads + 6 passes + 3 named trails, > 30 km',
    st.mainRoads === 6 && st.passes === 6 && st.roadKm > 30,
    `main=${st.mainKm} km passes=${st.passKm} km total=${st.roadKm} km, vp=${st.viewpoints}`);

  // ---- Chapter 3A: named handcrafted roads ---------------------------------
  const ch3a = await page.evaluate(() => {
    const f = window.__game.world.field;
    const lf = f.landforms;
    // Per-named-road worst surface grade.
    const agg = new Map();
    for (const [rid, meta] of lf.roadMeta) {
      let worst = agg.get(meta.name) || 0;
      for (let i = meta.i0; i < meta.i0 + meta.n - 1; i++) {
        if (lf._rid[i + 1] !== rid) break;
        const ds = Math.hypot(lf._rx[i + 1] - lf._rx[i], lf._rz[i + 1] - lf._rz[i]);
        if (ds < 1) continue;
        const g = Math.abs(f.height(lf._rx[i + 1], lf._rz[i + 1]) - f.height(lf._rx[i], lf._rz[i])) / ds;
        if (g > worst) worst = g;
      }
      agg.set(meta.name, worst);
    }
    let worstDeg = 0, worstName = '';
    for (const [n, g] of agg) {
      const deg = Math.atan(g) * 180 / Math.PI;
      if (deg > worstDeg) { worstDeg = deg; worstName = n; }
    }
    // Hairpins: only on pass roads; min curve radius off-pass.
    let hairpinsPass = 0, sharpOffPass = 0;
    for (let i = 2; i < lf._rx.length - 2; i++) {
      if (lf._rid[i - 2] !== lf._rid[i + 2]) continue;
      const v1x = lf._rx[i] - lf._rx[i - 2], v1z = lf._rz[i] - lf._rz[i - 2];
      const v2x = lf._rx[i + 2] - lf._rx[i], v2z = lf._rz[i + 2] - lf._rz[i];
      const d1 = Math.hypot(v1x, v1z), d2 = Math.hypot(v2x, v2z);
      if (d1 < 1 || d2 < 1) continue;
      if ((v1x * v2x + v1z * v2z) / (d1 * d2) < -0.1) {
        if (lf._rt[i] === 2) hairpinsPass++;
        else sharpOffPass++;
      }
    }
    const names = new Set([...lf.roadMeta.values()].map((m) => m.name));
    return {
      worstDeg: +worstDeg.toFixed(1), worstName, hairpinsPass, sharpOffPass,
      hasAll: ['Meadow Loop', 'Eagle Pass Road', 'Canyon Trail', 'Glacier Route', 'Ridge Shortcut']
        .every((n) => names.has(n)),
      eagleLen: lf.passes[0].lengthM,
      destinations: lf.destinations.length,
      roadAtMeadowLoop: lf.roadAt(4000, 1180),
      nearestDest: lf.nearestDestination(3200, 245),
    };
  });
  check('All 5 named roads exist (Meadow Loop / Eagle Pass / Canyon / Glacier / Ridge)',
    ch3a.hasAll);
  check('Every road <= 10 deg', ch3a.worstDeg <= 10.05,
    `worst=${ch3a.worstDeg} deg on ${ch3a.worstName}`);
  check('Hairpins only on mountain passes', ch3a.hairpinsPass >= 8 && ch3a.sharpOffPass === 0,
    `${ch3a.hairpinsPass} pass hairpins, ${ch3a.sharpOffPass} off-pass`);
  check('Eagle Pass Road is a real climb (>= 1.2 km)', ch3a.eagleLen >= 1200,
    `${ch3a.eagleLen} m`);
  check('6 destinations registered', ch3a.destinations === 6);
  check('roadAt() names the Meadow Loop',
    !!ch3a.roadAtMeadowLoop && ch3a.roadAtMeadowLoop.name === 'Meadow Loop',
    JSON.stringify(ch3a.roadAtMeadowLoop));
  check('nearestDestination() finds Eagle Eyrie at the saddle',
    !!ch3a.nearestDest && ch3a.nearestDest.name === 'Eagle Eyrie Lookout',
    JSON.stringify(ch3a.nearestDest && ch3a.nearestDest.name));
  check('Viewpoints computed on roads (>= 8)', st.viewpoints >= 8, `${st.viewpoints}`);

  // Road grades: main <= 10 deg, pass <= 12 deg.
  const roads = await page.evaluate(() => {
    const f = window.__game.world.field;
    const lf = f.landforms;
    let worstMain = 0;
    for (const mr of lf.mainRoads) {
      const i0 = lf._rid.indexOf(mr.roadId);
      for (let i = i0; lf._rid[i] === mr.roadId && lf._rid[i + 1] === mr.roadId; i++) {
        const ds = Math.hypot(lf._rx[i + 1] - lf._rx[i], lf._rz[i + 1] - lf._rz[i]);
        if (ds < 1) continue;
        const g = Math.abs(f.height(lf._rx[i + 1], lf._rz[i + 1]) - f.height(lf._rx[i], lf._rz[i])) / ds;
        if (g > worstMain) worstMain = g;
      }
    }
    let worstPass = 0;
    lf.passes.forEach((p, pi) => {
      for (let n = 0; ; n++) {
        const a = lf.passPoint(pi, n), b = lf.passPoint(pi, n + 1);
        if (!a || !b) break;
        const ds = Math.hypot(b.x - a.x, b.z - a.z);
        if (ds < 1) continue;
        const g = Math.abs(f.height(b.x, b.z) - f.height(a.x, a.z)) / ds;
        if (g > worstPass) worstPass = g;
      }
    });
    return {
      mainDeg: +(Math.atan(worstMain) * 180 / Math.PI).toFixed(1),
      passDeg: +(Math.atan(worstPass) * 180 / Math.PI).toFixed(1),
    };
  });
  check('Main roads <= 10 deg', roads.mainDeg <= 10, `worst=${roads.mainDeg} deg`);
  check('Pass roads <= 10 deg (Chapter 3A cap)', roads.passDeg <= 10.05, `worst=${roads.passDeg} deg`);

  // ================= Seams =================
  await page.click('#btn-play');
  await sleep(1200);
  const seam = await page.evaluate(() => {
    const tiles = window.__game.world.tiles;
    const recs = new Map();
    let RES = 0;
    for (const r of tiles._grid.cells.values()) {
      if (r && r !== true && r.built) {
        recs.set(`${r.cx},${r.cz}`, r);
        if (!RES) RES = Math.sqrt(r.mesh.geometry.attributes.position.count) - 1;
      }
    }
    let pairs = 0, maxDiff = 0;
    for (const r of recs.values()) {
      const right = recs.get(`${r.cx + 1},${r.cz}`);
      if (right) {
        pairs++;
        const pa = r.mesh.geometry.attributes.position;
        const pb = right.mesh.geometry.attributes.position;
        for (let j = 0; j <= RES; j++) {
          const d = Math.abs(pa.getY(j * (RES + 1) + RES) - pb.getY(j * (RES + 1)));
          if (d > maxDiff) maxDiff = d;
        }
      }
      const down = recs.get(`${r.cx},${r.cz + 1}`);
      if (down) {
        pairs++;
        const pa = r.mesh.geometry.attributes.position;
        const pb = down.mesh.geometry.attributes.position;
        for (let i = 0; i <= RES; i++) {
          const d = Math.abs(pa.getY(RES * (RES + 1) + i) - pb.getY(i));
          if (d > maxDiff) maxDiff = d;
        }
      }
    }
    return { pairs, maxDiff };
  });
  check('Tile borders are bit-identical (zero seams)',
    seam.pairs >= 40 && seam.maxDiff === 0, `${seam.pairs} edge pairs, maxDiff=${seam.maxDiff}`);

  // ================= Rider's Meadow spawn =================
  s = await state();
  check('PLAY starts gameplay', s.state === 'playing');
  check('Spawn at Rider\'s Meadow (world center)',
    Math.abs(s.pos[0] - 4000) < 30 && Math.abs(s.pos[2] - 2000) < 60, JSON.stringify(s.pos));
  check('Bike spawns grounded', s.grounded && Math.abs(s.pos[1] - s.groundH) < 0.5);
  const meadow = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.field;
    const e = 8;
    // Spawn flatness + meadow max slope + intersection roads + lake.
    const slopeAt = (x, z) => Math.hypot(
      f.height(x + e, z) - f.height(x - e, z),
      f.height(x, z + e) - f.height(x, z - e)) / (2 * e);
    let worst = 0;
    for (let a = 0; a < 16; a++) {
      for (let r = 50; r < 560; r += 55) {
        const x = 4000 + Math.cos(a / 16 * 6.28) * r, z = 2000 + Math.sin(a / 16 * 6.28) * r;
        const sl = slopeAt(x, z);
        if (sl > worst) worst = sl;
      }
    }
    const sc = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    const roadsAt = [
      f.sample(4000, 1900, sc).roadType, // N
      f.sample(4000, 2100, sc).roadType, // S
      f.sample(3900, 2000, sc).roadType, // W
      f.sample(4100, 2000, sc).roadType, // E
    ];
    const lakeDip = f.height(4230, 2210) < f.height(4230, 2350) - 2;
    const spawnSlope = slopeAt(g.bike.position.x, g.bike.position.z);
    return {
      spawnSlopeDeg: +(Math.atan(spawnSlope) * 180 / Math.PI).toFixed(1),
      meadowWorstDeg: +(Math.atan(worst) * 180 / Math.PI).toFixed(1),
      fourWay: roadsAt.every((t) => t === 1),
      lakeDip,
    };
  });
  check('Spawn is flat', meadow.spawnSlopeDeg < 4, `${meadow.spawnSlopeDeg} deg`);
  check('Meadow gentle everywhere (< 18 deg, no cliffs)', meadow.meadowWorstDeg < 18,
    `worst=${meadow.meadowWorstDeg} deg`);
  check('Four-way main road intersection at spawn', meadow.fourWay);
  check('Small lake dug into the meadow', meadow.lakeDip);

  // ================= Phase 3.1: open valley spawn =================
  const openness = await page.evaluate(() => {
    const f = window.__game.world.field;
    const eye = f.height(4000, 1965) + 1.5;
    let worstNear = -90, visibleFar = 0, nearestSerious = 1e9;
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      let nearAng = -90, farAng = -90;
      for (let r = 50; r <= 4000; r += 25) {
        const x = 4000 + Math.cos(th) * r, z = 2000 + Math.sin(th) * r;
        if (x < 0 || x > 8000 || z < 0 || z > 4000) break;
        const h = f.height(x, z);
        const ang = Math.atan2(h - eye, r) * 180 / Math.PI;
        if (r <= 1000 && ang > nearAng) nearAng = ang;
        if (r > 2000 && ang > farAng) farAng = ang;
        if (h > 600 && r < nearestSerious) nearestSerious = r;
      }
      if (nearAng > worstNear) worstNear = nearAng;
      if (farAng > nearAng + 2) visibleFar++;
    }
    return { worstNear: +worstNear.toFixed(1), visibleFar, nearestSerious };
  });
  check('Spawn is open (no near horizon wall > 6 deg in any direction)',
    openness.worstNear < 6, `worst near-horizon=${openness.worstNear} deg`);
  check('Distant mountains visible above the near horizon',
    openness.visibleFar >= 3, `${openness.visibleFar}/16 bearings`);
  check('No serious mountain within 1 km of spawn',
    openness.nearestSerious > 1000, `nearest=${openness.nearestSerious} m`);

  // ================= Riding basics =================
  await page.keyboard.down('KeyW');
  await sleep(2200);
  s = await state();
  check('Accelerate works', s.speed > 8, `speed=${s.speed}`);
  const yaw0 = s.yaw;
  await page.keyboard.down('KeyA');
  await sleep(800);
  await page.keyboard.up('KeyA');
  s = await state();
  check('Steering works', s.yaw - yaw0 > 0.15, `dYaw=${(s.yaw - yaw0).toFixed(2)}`);
  const camD = Math.hypot(s.camPos[0] - s.pos[0], s.camPos[2] - s.pos[2]);
  check('Camera follows', camD > 3 && camD < 12, `dist=${camD.toFixed(1)}`);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');
  await sleep(1400);
  await page.keyboard.up('KeyS');
  s = await state();
  check('Brake works', s.speed <= 1, `speed=${s.speed}`);

  // ================= Practice jump =================
  // Fixed-step (frame-rate-independent) run at the South Arm kicker —
  // the same real Bike.update the render loop calls.
  const pjump = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.field;
    const input = { throttle: 1, brake: 0, steer: 0, stunt: 0, trick: 0 };
    g.bike._placeAt(4000, f.height(4000, 2040), 2040, 0);
    let air = false, peak = 0, landed = false, crashed = false;
    for (let i = 0; i < 60 * 15; i++) {
      g.bike.update(1 / 60, input);
      g.world.update(g.bike.position);
      if (!g.bike.grounded) { air = true; peak = Math.max(peak, g.bike.heightAboveGround); }
      if (g.bike.crashed) { crashed = true; break; }
      if (air && g.bike.grounded) { landed = true; break; }
    }
    g.bike.reset();
    g.followCam.snapTo(g.bike);
    return { air, peak: +peak.toFixed(2), landed, crashed };
  });
  check('Practice jump works (airborne + stable landing)',
    pjump.air && pjump.peak > 0.5 && pjump.landed && !pjump.crashed,
    `peak=${pjump.peak} m`);

  // ================= Full-physics rides =================
  const rides = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.field;
    const lf = f.landforms;

    function densify(pts, gap) {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.ceil(d / gap);
        for (let k = 1; k <= n; k++) {
          out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
        }
      }
      return out;
    }

    function rideWaypoints(pts, maxSteps) {
      const input = { throttle: 1, brake: 0, steer: 0, stunt: 0, trick: 0 };
      const b = g.bike;
      let wp = 1, maxDev = 0, nan = false, resets = 0;
      let lastWp = 1, sinceProgress = 0, crossings = 0, dist = 0;
      let prevSec = g.world.sectorAt(pts[0].x, pts[0].z);
      let px = pts[0].x, pz = pts[0].z;
      b._placeAt(pts[0].x, f.height(pts[0].x, pts[0].z), pts[0].z,
        Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z));
      for (let i = 0; i < maxSteps && wp < pts.length; i++) {
        const t = pts[wp];
        const dx = t.x - b.position.x, dz = t.z - b.position.z;
        if (Math.hypot(dx, dz) < 16) { wp++; continue; }
        const want = Math.atan2(dx, dz);
        let dy = want - b.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        input.steer = Math.max(-1, Math.min(1, -dy * 2.2));
        input.brake = Math.abs(dy) > 1.1 && Math.abs(b.speed) > 7 ? 0.8 : 0;
        input.throttle = input.brake > 0 ? 0 : (Math.abs(dy) > 0.6 ? 0.55 : 1);
        b.update(1 / 60, input);
        g.world.update(b.position);
        if ((i & 7) === 0) {
          const p = b.position;
          if (!Number.isFinite(p.y) || !Number.isFinite(b.speed)) { nan = true; break; }
          const sec = g.world.sectorAt(p.x, p.z);
          if (sec.x !== prevSec.x || sec.z !== prevSec.z) crossings++;
          prevSec = sec;
          dist += Math.hypot(p.x - px, p.z - pz); px = p.x; pz = p.z;
          if (b.grounded && !b.crashed) {
            const dev = Math.abs(p.y - f.height(p.x, p.z));
            if (dev > maxDev) maxDev = dev;
          }
          if (b.crashed) {
            const prev = pts[wp - 1];
            b._placeAt(prev.x, f.height(prev.x, prev.z), prev.z, want);
            resets++;
          }
          if (wp !== lastWp) { lastWp = wp; sinceProgress = 0; }
          else if (++sinceProgress > 75) {
            const prev = pts[wp - 1];
            b._placeAt(prev.x, f.height(prev.x, prev.z), prev.z, want);
            resets++;
            sinceProgress = 0;
          }
        }
      }
      return { done: wp >= pts.length, wp, of: pts.length, maxDev: +maxDev.toFixed(3),
               nan, resets, crossings, km: +(dist / 1000).toFixed(1) };
    }

    // 1. The Horizon Loop — full circuit (crosses the whole map).
    const loop = lf.mainRoads[0];
    const lPts = [];
    const i0 = lf._rid.indexOf(loop.roadId);
    for (let i = i0; lf._rid[i] === loop.roadId; i += 4) {
      lPts.push({ x: lf._rx[i], z: lf._rz[i] });
    }
    const loopRide = rideWaypoints(lPts, 60 * 1500);

    // 2. Climb 3 mountain passes (the long flanks: N1-N2, N2-N3, K0-K1).
    let passesClimbed = 0;
    for (const pid of [0, 1, 2]) {
      const pts = [];
      for (let n = 0; ; n += 2) {
        const pt = lf.passPoint(pid, n);
        if (!pt) break;
        pts.push(pt);
      }
      if (pts.length < 3) continue;
      const r = rideWaypoints(pts.reverse(), 60 * 300); // climb up to the saddle
      if (r.done && !r.nan && r.resets <= 3) passesClimbed++;
    }

    g.followCam.snapTo(g.bike);
    return { loopRide, passesClimbed };
  });
  check('Rode the full Horizon Loop (world circuit, full physics)',
    rides.loopRide.done && !rides.loopRide.nan && rides.loopRide.resets <= 2,
    `${rides.loopRide.km} km, wp ${rides.loopRide.wp}/${rides.loopRide.of}, resets=${rides.loopRide.resets}`);
  check('Loop ride covered 2+ km with no impossible slopes', rides.loopRide.km >= 2);
  check('Crossed 20+ sector borders riding', rides.loopRide.crossings >= 20,
    `${rides.loopRide.crossings} crossings`);

  // ---- Chapter 3D: stability instrumentation over a long ride --------------
  const stab = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.field;
    const lf = f.landforms;
    const tiles = g.world.tiles;
    // Instrument: count tile builds that happen INSIDE the visible window
    // (that would be visible popping). Steady-state riding must only ever
    // build tiles on the hidden pre-build ring.
    let visibleBuilds = 0, totalBuilds = 0;
    const origBuild = tiles._build.bind(tiles);
    tiles._build = (rec) => {
      totalBuilds++;
      const pcx = Math.floor(g.bike.position.x / 125), pcz = Math.floor(g.bike.position.z / 125);
      if (Math.max(Math.abs(rec.cx - pcx), Math.abs(rec.cz - pcz)) <= 4) visibleBuilds++;
      return origBuild(rec);
    };
    // Ride the West Arm + East Arm + half the loop = > 5 km continuous.
    const input = { throttle: 1, brake: 0, steer: 0, stunt: 0, trick: 0 };
    const wp = [];
    for (const rid of [3, 4]) { // West Arm, East Arm
      const meta = lf.roadMeta.get(rid);
      for (let i = meta.i0; i < meta.i0 + meta.n; i += 5) wp.push({ x: lf._rx[i], z: lf._rz[i] });
    }
    const b = g.bike;
    let k = 1, crossings = 0, dist = 0, resets = 0, lastWp = 1, stall = 0;
    let prev = g.world.sectorAt(wp[0].x, wp[0].z);
    let px = wp[0].x, pz = wp[0].z;
    b._placeAt(wp[0].x, f.height(wp[0].x, wp[0].z), wp[0].z,
      Math.atan2(wp[1].x - wp[0].x, wp[1].z - wp[0].z));
    // settle the pre-build ring after the teleport
    for (let i = 0; i < 300; i++) g.world.update(b.position);
    visibleBuilds = 0; totalBuilds = 0;
    for (let i = 0; i < 60 * 900 && k < wp.length; i++) {
      const t = wp[k];
      const dx = t.x - b.position.x, dz = t.z - b.position.z;
      if (Math.hypot(dx, dz) < 16) { k++; continue; }
      const want = Math.atan2(dx, dz);
      let dy = want - b.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      input.steer = Math.max(-1, Math.min(1, -dy * 2.2));
      input.brake = Math.abs(dy) > 1.1 && Math.abs(b.speed) > 7 ? 0.8 : 0;
      input.throttle = input.brake > 0 ? 0 : (Math.abs(dy) > 0.6 ? 0.55 : 1);
      b.update(1 / 60, input);
      g.world.update(b.position);
      if ((i & 7) === 0) {
        const sec = g.world.sectorAt(b.position.x, b.position.z);
        if (sec.x !== prev.x || sec.z !== prev.z) crossings++;
        prev = sec;
        dist += Math.hypot(b.position.x - px, b.position.z - pz);
        px = b.position.x; pz = b.position.z;
        if (b.crashed) { b.reset(); resets++; }
        if (k !== lastWp) { lastWp = k; stall = 0; }
        else if (++stall > 75) {
          const pw = wp[k - 1];
          b._placeAt(pw.x, f.height(pw.x, pw.z), pw.z, want);
          resets++; stall = 0;
        }
      }
    }
    tiles._build = origBuild;
    g.bike._placeAt(4000, f.height(4000, 1965), 1965, 0);
    g.world.update(g.bike.position);
    g.followCam.snapTo(g.bike);
    return { km: +(dist / 1000).toFixed(1), crossings, resets, visibleBuilds, totalBuilds,
             done: k >= wp.length };
  });
  check('Rode 5+ km continuously (arms across the world)', stab.km >= 5 && stab.done,
    `${stab.km} km, resets=${stab.resets}`);
  check('Crossed 40+ sector boundaries total',
    rides.loopRide.crossings + stab.crossings >= 40,
    `${rides.loopRide.crossings} + ${stab.crossings}`);
  check('Zero visible tile builds while riding (no popping)',
    stab.visibleBuilds === 0 && stab.totalBuilds > 20,
    `${stab.visibleBuilds}/${stab.totalBuilds} builds inside the visible window`);
  check('No wheel sinking during the loop', rides.loopRide.maxDev < 0.15,
    `maxDev=${rides.loopRide.maxDev} m`);
  check('Climbed 3 mountain passes', rides.passesClimbed >= 3, `${rides.passesClimbed}/3`);

  // ================= Reset / POV =================
  s = await state();
  if (s.state === 'crashed') { await page.click('#btn-go-restart'); await sleep(500); }
  await page.keyboard.press('KeyR');
  await sleep(300);
  s = await state();
  check('Reset (R) recovers the bike', s.state === 'playing' && s.grounded);
  const povBefore = await page.evaluate(() => window.__game.followCam.mode);
  await page.keyboard.press('KeyC');
  await sleep(900);
  const povAfter = await page.evaluate(() => window.__game.followCam.mode);
  check('First-person POV toggles', povBefore === 'third' && povAfter === 'first');
  await page.keyboard.press('KeyC');
  await sleep(400);

  // ================= Debug overlay =================
  await page.keyboard.press('F3');
  await sleep(400);
  const dbg = await page.evaluate(() => ({
    hidden: document.getElementById('debug-overlay').classList.contains('hidden'),
    text: document.getElementById('debug-overlay').textContent,
  }));
  check('F3 shows debug overlay', !dbg.hidden);
  check('Overlay shows road name/progress, slope, landmark, sector, loaded',
    /ROAD .+/.test(dbg.text) && /RD SLOPE/.test(dbg.text) &&
    /LANDMARK .+/.test(dbg.text) && /ELEVATION -?[\d.]+ m/.test(dbg.text) &&
    /SECTOR \(\d+,\d+\)/.test(dbg.text) && /LOADED \d+/.test(dbg.text) &&
    /SLOPE [\d.]+%/.test(dbg.text) && /FPS \d+/.test(dbg.text) &&
    /FRAME [\d.]+ ms/.test(dbg.text) && /QUALITY /.test(dbg.text),
    JSON.stringify(dbg.text));
  await page.keyboard.press('F3');
  await sleep(200);

  // ================= Landmarks (props) =================
  const props = await page.evaluate(() => {
    const g = window.__game;
    const P = g.world.props;
    const perType = {};
    for (const [k, m] of Object.entries(P.meshes)) perType[k] = m.count;
    // Meadow fixtures present in the spawn sector list?
    const spawnList = P.sectorProps(8, 4).concat(P.sectorProps(7, 4), P.sectorProps(8, 3), P.sectorProps(7, 3));
    const kinds = new Set(spawnList.map((p) => p.t));
    let totalIn9 = 0;
    for (let cx = 7; cx <= 9; cx++) {
      for (let cz = 3; cz <= 5; cz++) totalIn9 += P.sectorProps(cx, cz).length;
    }
    return { count: P.count, perType, colliders: P.colliders.length, totalIn9,
             spawnKinds: [...kinds] };
  });
  check('Landmark props streamed with sectors', props.count > 10,
    `${props.count} active: ${JSON.stringify(props.perType)}`);
  check('Meadow has signpost + cabin fixtures',
    props.spawnKinds.includes('sign') && props.spawnKinds.includes('cabin'),
    props.spawnKinds.join(','));
  check('Landmark density ~ every 300-500 m', props.totalIn9 >= 18,
    `${props.totalIn9} props in 9 spawn-area sectors`);
  check('Solid props have colliders', props.colliders > 0, `${props.colliders}`);

  // ---- Chapter 3B: vegetation system ----------------------------------------
  const veg = await page.evaluate(() => {
    const g = window.__game;
    const V = g.world.vegetation;
    V.setQuality(1, 4); // full density for this check (CI pins Potato)
    // Move to the forest belt NW of the meadow to count trees there.
    g.bike._placeAt(2900, g.world.getHeight(2900, 1500), 1500, 0);
    g.world.update(g.bike.position);
    const nearTypes = {};
    for (const [k, m] of Object.entries(V._near)) nearTypes[k] = m.count;
    const res = {
      near: V.visibleNear, far: V.visibleFar, nearTypes,
      lodWorks: V.visibleFar > 0 && V.visibleNear > 0,
    };
    // Restore CI density and return the bike to the meadow.
    V.setQuality(g.graphics.current.vegetation, 2);
    g.bike._placeAt(4000, g.world.getHeight(4000, 1965), 1965, 0);
    g.world.update(g.bike.position);
    g.followCam.snapTo(g.bike);
    return res;
  });
  check('Vegetation instanced + streaming (near ring populated)',
    veg.near > 50, `near=${veg.near} far=${veg.far} ${JSON.stringify(veg.nearTypes)}`);
  check('Vegetation LOD works (far impostor ring populated)', veg.lodWorks,
    `near=${veg.near} far=${veg.far}`);

  // ---- Chapter 3C: graphics quality system ----------------------------------
  const gfx = await page.evaluate(async () => {
    const g = window.__game;
    const G = g.graphics;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    G.setPreset('potato');
    await sleep(500);
    out.potato = {
      ratio: +g.renderer.getPixelRatio().toFixed(2),
      far: g.camera.far,
      fog: g.scene.fog.isFogExp2 ? 'exp2' : 'linear',
      shadows: g.renderer.shadowMap.enabled,
      veg: g.world.vegetation._density,
    };
    G.setPreset('ultra');
    await sleep(500);
    out.ultra = {
      ratio: +g.renderer.getPixelRatio().toFixed(2),
      far: g.camera.far,
      fog: g.scene.fog.isFogExp2 ? 'exp2' : 'linear',
      shadows: g.renderer.shadowMap.enabled,
      shadowSize: g.world.sun.shadow.mapSize.x,
      veg: g.world.vegetation._density,
    };
    out.saved = JSON.parse(localStorage.getItem('horizon_graphics')).preset;
    G.set('vegetation', 0.5);
    out.custom = G.preset;
    G.setPreset('potato'); // keep CI fast for the remaining checks
    // Let the fresh GL context finish its first compile+render frames —
    // on the CI software rasterizer this stalls RAF for a while and the
    // physics accumulator caps into slow motion during the stall.
    await sleep(1500);
    return out;
  });
  check('Potato preset applies instantly (0.6x scale, shadows off, linear fog, 25% veg)',
    gfx.potato.ratio <= 0.65 && !gfx.potato.shadows && gfx.potato.fog === 'linear' &&
    gfx.potato.veg === 0.25 && gfx.potato.far === 3200,
    JSON.stringify(gfx.potato));
  check('Ultra preset applies instantly (1.5x scale, 2048 shadows, full veg, max distance)',
    gfx.ultra.ratio >= 1.4 && gfx.ultra.shadows && gfx.ultra.shadowSize === 2048 &&
    gfx.ultra.veg === 1 && gfx.ultra.far === 12000,
    JSON.stringify(gfx.ultra));
  check('Graphics settings persist to localStorage', gfx.saved === 'ultra');
  check('Manual override marks preset as custom', gfx.custom === 'custom');
  const gfxUi = await page.evaluate(() => ({
    panel: !!document.getElementById('graphics-overlay'),
    presets: document.querySelectorAll('#gfx-presets button').length,
    fpsRow: !!document.getElementById('gfx-fps'),
  }));
  check('Graphics UI panel present (5 presets + FPS preview)',
    gfxUi.panel && gfxUi.presets === 5 && gfxUi.fpsRow);

  // ================= Pause =================
  await page.keyboard.press('KeyP');
  await sleep(200);
  s = await state();
  check('Pause works (P key)', s.state === 'paused');
  await page.click('#btn-resume');
  await sleep(200);
  s = await state();
  check('Resume works', s.state === 'playing');

  // ================= Mobile controls =================
  await page.evaluate(() => {
    const g = window.__game;
    g.bike._placeAt(4000, g.world.getHeight(4000, 1700), 1700, 0);
    g.followCam.snapTo(g.bike);
  });
  await sleep(400);
  const gasBtn = await page.$('#btn-gas');
  const box = await gasBtn.boundingBox();
  await page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(2500);
  s = await state();
  const touchSpeed = s.speed;
  await page.touchscreen.touchEnd();
  check('Mobile GAS button works', touchSpeed > 4, `speed=${touchSpeed}`);
  const brakeBtn = await page.$('#btn-brake');
  const bb = await brakeBtn.boundingBox();
  await page.touchscreen.touchStart(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(1400);
  await page.touchscreen.touchEnd();
  s = await state();
  check('Mobile BRAKE button works', Math.abs(s.speed) < touchSpeed * 0.5, `speed=${s.speed}`);

  // ================= Menus =================
  await page.click('#btn-pause');
  await sleep(200);
  await page.click('#btn-main-menu');
  await sleep(300);
  s = await state();
  check('Return to main menu works', s.state === 'menu');
  await page.click('#btn-settings');
  await sleep(200);
  const settingsVisible = await page.evaluate(() =>
    !document.getElementById('settings-overlay').classList.contains('hidden'));
  check('Settings opens', settingsVisible);
  await page.click('#btn-settings-back');
  await sleep(200);

  // ================= Perf + stability =================
  s = await state();
  check('FPS healthy in headless run (CPU rasterizer)', s.fps >= 9, `fps=${s.fps}`);
  const calls = await page.evaluate(() => window.__game.renderer.info.render.calls);
  check('Draw calls bounded', calls < 110, `calls=${calls}`);
  const mem = await page.metrics();
  console.log('HEAP MB', Math.round(mem.JSHeapUsedSize / 1048576));
  check('No console errors or warnings', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
