/**
 * Horizon Ride — Phase 2 end-to-end verification.
 *
 * Drives the real game (dev server on :3000) in headless Chromium and
 * checks the preserved foundation (bike physics, camera, controls, menus,
 * Phase 1B streaming architecture) plus the Phase 2 terrain foundation:
 * seamless analytic heightfield, pooled tile rendering with bit-identical
 * borders, dirt trail network, jump mounds, and the extended F3 overlay.
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

  // ================= World architecture (Phase 1B preserved) =================
  let s = await state();
  check('Main menu opens', s.state === 'menu');

  const world = await page.evaluate(() => {
    const g = window.__game;
    const W = g.world;
    return {
      isSectorWorld: W.constructor.name === 'SectorWorld',
      corner00: W.sectorAt(1, 1),
      cornerMax: W.sectorAt(9999, 4999),
      clampNeg: W.sectorAt(-50, -50),
      inBounds: W.isInBounds(5000, 2500),
      outBounds: W.isInBounds(-10, 100) || W.isInBounds(10001, 100),
      loaded: W.debug.loaded,
      calls: g.renderer.info.render.calls,
    };
  });
  check('World is the SectorWorld streaming engine', world.isSectorWorld);
  check('Fixed sector grid 20x10 preserved',
    world.corner00.x === 0 && world.cornerMax.x === 19 && world.cornerMax.z === 9 &&
    world.clampNeg.x === 0);
  check('World bounds 10,000 x 5,000 preserved', world.inBounds && !world.outBounds);
  check('3x3 logical sector window active', world.loaded === 9, `loaded=${world.loaded}`);

  // ================= Terrain determinism + seams =================
  const terrain = await page.evaluate(() => {
    const f = window.__game.world.field;
    // Determinism: same coordinate, same height, always.
    const deterministic = f.height(1234.5, 987.6) === f.height(1234.5, 987.6);
    // Range scan: no mountains/cliffs — heights stay gentle; slopes sane.
    let minH = Infinity, maxH = -Infinity, maxSlope = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (i * 613) % 10000, z = (i * 271) % 5000;
      const h = f.height(x, z);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      const s = Math.hypot(f.height(x + 2, z) - h, f.height(x, z + 2) - h) / 2;
      if (s > maxSlope) maxSlope = s;
    }
    // Terrain varies (not flat).
    return { deterministic, minH: +minH.toFixed(1), maxH: +maxH.toFixed(1),
             maxSlope: +maxSlope.toFixed(2), varies: maxH - minH > 8 };
  });
  check('Height is deterministic', terrain.deterministic);
  check('Terrain is sculpted (varies > 8 m)', terrain.varies,
    `range ${terrain.minH}..${terrain.maxH} m`);
  check('No mountains/cliffs (bounded heights, sane slopes)',
    terrain.maxH - terrain.minH < 60 && terrain.maxSlope < 1.2,
    `span=${(terrain.maxH - terrain.minH).toFixed(1)} m maxSlope=${terrain.maxSlope}`);

  // Mesh-level seam verification: for built adjacent tiles, compare the
  // actual vertex heights along shared edges — must be bit-identical.
  await page.click('#btn-play');
  await sleep(1200); // let the tile window build out
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

  // ================= Spawn + riding =================
  s = await state();
  check('PLAY starts gameplay', s.state === 'playing');
  check('Bike spawns grounded on terrain',
    s.grounded && Math.abs(s.pos[1] - s.groundH) < 0.5, JSON.stringify(s.pos));
  const spawnTrail = await page.evaluate(() => {
    const g = window.__game;
    const sc = { h: 0, trail: 0, moist: 0 };
    g.world.field.sample(g.bike.position.x, g.bike.position.z, sc);
    return sc.trail;
  });
  check('Spawn is on a dirt trail', spawnTrail > 0.8, `trail=${spawnTrail.toFixed(2)}`);

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

  // ================= Long ride: 20+ sector borders, physics stability ========
  // Fast-forwarded FULL-PHYSICS ride: the real Bike.update + world streaming
  // stepped at 60 Hz across ~14 km of terrain in all four directions. Counts
  // sector-border crossings, watches ground adherence (sinking/floating),
  // NaN failures and crash handling — far more distance than a wall-clock
  // ride could cover in CI.
  const longRide = await page.evaluate(() => {
    const g = window.__game;
    const input = { throttle: 1, brake: 0, steer: 0, stunt: 0, trick: 0 };
    const legs = [
      [700, 650, Math.PI / 2, 9000],    // east across sector columns
      [2200, 400, 0, 9000],             // north across sector rows
      [9300, 4400, -Math.PI / 2, 9000], // west
      [8300, 4600, Math.PI, 8000],      // south
    ];
    let crossings = 0, maxDev = 0, nan = false, crashes = 0, dist = 0;
    for (const [x0, z0, yaw, steps] of legs) {
      g.bike._placeAt(x0, g.world.getHeight(x0, z0), z0, yaw);
      let prev = g.world.sectorAt(x0, z0), px = x0, pz = z0;
      for (let i = 0; i < steps; i++) {
        g.bike.update(1 / 60, input);
        g.world.update(g.bike.position);
        if ((i & 7) === 0) {
          const p = g.bike.position;
          const sec = g.world.sectorAt(p.x, p.z);
          if (sec.x !== prev.x || sec.z !== prev.z) crossings++;
          prev = sec;
          dist += Math.hypot(p.x - px, p.z - pz); px = p.x; pz = p.z;
          if (!Number.isFinite(g.bike.speed) || !Number.isFinite(p.y)) nan = true;
          if (g.bike.grounded && !g.bike.crashed) {
            const dev = Math.abs(p.y - g.world.getHeight(p.x, p.z));
            if (dev > maxDev) maxDev = dev;
          }
          if (g.bike.crashed) { crashes++; g.bike.reset(); }
        }
      }
    }
    g.followCam.snapTo(g.bike);
    return { crossings, maxDev: +maxDev.toFixed(3), nan, crashes, km: +(dist / 1000).toFixed(1) };
  });
  check('Rode across 20+ sector borders (full physics)', longRide.crossings >= 20,
    `${longRide.crossings} crossings over ${longRide.km} km, ${longRide.crashes} crashes`);
  check('No physics failure during long ride', !longRide.nan);
  check('No wheel sinking / floating (grounded dev < 0.15 m)', longRide.maxDev < 0.15,
    `maxDev=${longRide.maxDev} m`);

  // Real-time ride for FPS + suspension behaviour.
  await page.evaluate(() => {
    const g = window.__game;
    g.bike._placeAt(5000, g.world.getHeight(5000, 2000), 2000, 0);
    g.followCam.snapTo(g.bike);
  });
  await sleep(300);
  let minFps = 999, suspMoved = false;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    s = await state();
    if (i > 2 && s.fps < minFps) minFps = s.fps;
    if (Math.abs(s.susp) > 0.005) suspMoved = true;
  }
  await page.keyboard.up('KeyW');
  check('Suspension compresses over terrain', suspMoved);
  check('No FPS drops while streaming', minFps > 20, `min fps=${minFps} (headless CPU rendering)`);

  // Tile pool never exhausts, tiles stay bounded.
  const tileStats = await page.evaluate(() => ({
    tiles: window.__game.world.debug.tiles,
    avail: window.__game.world.tiles._pool.available,
  }));
  check('Tile window bounded (<= 49) with pool headroom',
    tileStats.tiles <= 49 && tileStats.avail >= 0, JSON.stringify(tileStats));

  // ================= Jump over a mound =================
  // Recover if the blind ride ended in a crash state.
  s = await state();
  if (s.state === 'crashed') {
    await page.click('#btn-go-restart');
    await sleep(500);
  }
  const jump = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.field;
    const j = f.jumpNear(g.world.getSpawn().x, 2500);
    if (!j) return null;
    // Line up 55 m before the mound on the trail, facing +z.
    const zStart = j.z - 55;
    const x = f.nsCenter ? g.world.field.nsCenter(5, zStart) : j.x;
    g.bike._placeAt(j.x, g.world.getHeight(j.x, zStart), zStart, 0);
    g.followCam.snapTo(g.bike);
    return j;
  });
  check('Jump mounds exist on trails', !!jump, JSON.stringify(jump));
  let airborne = false, peakAlt = 0, landedStable = false;
  if (jump) {
    await page.keyboard.down('KeyW');
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const a = await page.evaluate(() => ({
        air: !window.__game.bike.grounded,
        alt: window.__game.bike.heightAboveGround,
        crashed: window.__game.bike.crashed,
        speed: window.__game.bike.speed,
      }));
      if (a.air) { airborne = true; peakAlt = Math.max(peakAlt, a.alt); }
      if (airborne && !a.air && !a.crashed) { landedStable = true; break; }
    }
    await page.keyboard.up('KeyW');
  }
  check('Bike jumps off terrain mounds', airborne && peakAlt > 0.4, `peak=${peakAlt.toFixed(2)} m`);
  check('Landing is stable (no crash)', landedStable);

  // ================= Reset / POV / camera clearance =================
  await sleep(400);
  await page.keyboard.press('KeyR');
  await sleep(300);
  s = await state();
  check('Reset (R) recovers the bike', s.state === 'playing' && s.grounded, `speed=${s.speed}`);

  const povBefore = await page.evaluate(() => window.__game.followCam.mode);
  await page.keyboard.press('KeyC');
  await sleep(900);
  const povAfter = await page.evaluate(() => window.__game.followCam.mode);
  check('First-person POV toggles', povBefore === 'third' && povAfter === 'first');
  await page.keyboard.press('KeyC');
  await sleep(500);

  // Camera never clips below terrain (sampled during a short ride).
  let camClip = null;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const c = await page.evaluate(() => {
      const g = window.__game;
      const cp = g.camera.position;
      return { y: cp.y, ground: g.world.getHeight(cp.x, cp.z) };
    });
    if (c.y < c.ground + 0.3) camClip = c;
  }
  await page.keyboard.up('KeyW');
  check('Camera never clips into terrain', !camClip, camClip ? JSON.stringify(camClip) : '');

  // ================= Debug overlay (extended) =================
  await page.keyboard.press('F3');
  await sleep(400);
  const dbg = await page.evaluate(() => ({
    hidden: document.getElementById('debug-overlay').classList.contains('hidden'),
    text: document.getElementById('debug-overlay').textContent,
  }));
  check('F3 shows debug overlay', !dbg.hidden);
  check('Overlay shows terrain height / altitude / slope',
    /TERRAIN H -?[\d.]+ m/.test(dbg.text) && /ALTITUDE [\d.]+ m/.test(dbg.text) &&
    /SLOPE [\d.]+/.test(dbg.text) && /FPS \d+/.test(dbg.text) &&
    /SECTOR \(\d+,\d+\)/.test(dbg.text) && /DRAW CALLS \d+/.test(dbg.text),
    JSON.stringify(dbg.text));
  await page.keyboard.press('F3');
  await sleep(200);

  // ================= Pause =================
  await page.keyboard.press('KeyP');
  await sleep(200);
  s = await state();
  check('Pause works (P key)', s.state === 'paused');
  await page.click('#btn-resume');
  await sleep(200);
  s = await state();
  check('Resume works', s.state === 'playing');

  // ================= Mobile controls (touch) =================
  const gasBtn = await page.$('#btn-gas');
  const box = await gasBtn.boundingBox();
  await page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(1500);
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
  check('FPS healthy in headless run', s.fps > 20, `fps=${s.fps}`);
  const calls = await page.evaluate(() => window.__game.renderer.info.render.calls);
  check('Draw calls bounded', calls < 90, `calls=${calls}`);
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
