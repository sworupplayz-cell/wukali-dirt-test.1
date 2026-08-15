/**
 * Horizon Ride — Phase 1B end-to-end verification.
 *
 * Drives the real game (dev server on :3000) in headless Chromium and
 * checks the preserved foundation (bike physics, camera, controls, menus)
 * plus the fixed-world streaming engine: 10,000 x 5,000 m, 200 permanent
 * 500 m sectors, 3x3 streaming window, per-sector debug tints, F3 overlay.
 *
 * Setup once per sandbox:  bash tests/setup-browser.sh
 * Run:                     npm run test:e2e
 * (Browser binaries live in /tmp so they never enter the repo.)
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
  await sleep(1500);

  const state = () => page.evaluate(() => {
    const g = window.__game;
    return {
      state: g.state,
      pos: g.bike.position.toArray().map((n) => +n.toFixed(2)),
      speed: +g.bike.speed.toFixed(2),
      yaw: +g.bike.yaw.toFixed(3),
      grounded: g.bike.grounded, crashed: g.bike.crashed,
      fps: g.stats.fps,
      camPos: g.camera.position.toArray().map((n) => +n.toFixed(1)),
      debug: { ...g.world.debug },
      groundH: +g.world.getHeight(g.bike.position.x, g.bike.position.z).toFixed(2),
    };
  });

  // ================= Menu + world architecture =================
  let s = await state();
  check('Main menu opens', s.state === 'menu');

  const world = await page.evaluate(() => {
    const g = window.__game;
    const W = g.world;
    let meshes = 0, visible = 0;
    g.scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) visible++; } });
    return {
      isSectorWorld: W.constructor.name === 'SectorWorld',
      spawn: W.getSpawn(),
      corner00: W.sectorAt(1, 1),
      cornerMax: W.sectorAt(9999, 4999),
      clampNeg: W.sectorAt(-50, -50),
      clampOver: W.sectorAt(20000, 20000),
      inBounds: W.isInBounds(5000, 2500),
      outBounds: W.isInBounds(-10, 100) || W.isInBounds(10001, 100),
      meshes, visible,
      calls: g.renderer.info.render.calls,
      loaded: W.debug.loaded,
      noOldSystems: !W.chunks && !W.population && !W.villages && !W.generator,
    };
  });
  check('World is the SectorWorld streaming engine', world.isSectorWorld);
  check('Spawn at world center (5000, 2500)',
    world.spawn.x === 5000 && world.spawn.z === 2500, JSON.stringify(world.spawn));
  check('Fixed sector grid 20x10',
    world.corner00.x === 0 && world.corner00.z === 0 &&
    world.cornerMax.x === 19 && world.cornerMax.z === 9,
    `(0,0)=${JSON.stringify(world.corner00)} max=${JSON.stringify(world.cornerMax)}`);
  check('Sector IDs clamp to the permanent grid (no infinite coords)',
    world.clampNeg.x === 0 && world.clampNeg.z === 0 &&
    world.clampOver.x === 19 && world.clampOver.z === 9);
  check('World bounds are 10,000 x 5,000', world.inBounds && !world.outBounds);
  check('3x3 window loaded at spawn (9 sectors)', world.loaded === 9, `loaded=${world.loaded}`);
  check('No legacy world systems', world.noOldSystems);
  check('Tiny scene (low draw calls)', world.calls <= 45,
    `meshes=${world.meshes} visible=${world.visible} calls=${world.calls}`);

  // ================= Riding =================
  await page.click('#btn-play');
  await sleep(400);
  s = await state();
  check('PLAY starts gameplay', s.state === 'playing');
  check('Bike spawns grounded', s.grounded && Math.abs(s.pos[1] - s.groundH) < 0.5, JSON.stringify(s.pos));
  check('Debug reports spawn sector (10,5)', s.debug.sectorX === 10 && s.debug.sectorZ === 5,
    JSON.stringify(s.debug));

  await page.keyboard.down('KeyW');
  await sleep(2000);
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

  // ================= Streaming while riding =================
  // Teleport near a sector edge, then ride across it: the active window
  // must recentre (load new column, unload old) without a hitch or error.
  await page.evaluate(() => {
    const g = window.__game;
    g.bike._placeAt(5480, 0, 2750, Math.PI / 2); // facing +X, 20 m from x=5500 boundary
    g.followCam.snapTo(g.bike);
  });
  await sleep(300);
  const before = (await state()).debug;
  await page.keyboard.down('KeyW');
  await sleep(4000);
  await page.keyboard.up('KeyW');
  s = await state();
  check('Crossed into a new sector while riding',
    s.debug.sectorX > before.sectorX, `(${before.sectorX},${before.sectorZ}) -> (${s.debug.sectorX},${s.debug.sectorZ})`);
  check('Streaming keeps exactly 9 sectors interior', s.debug.loaded === 9, `loaded=${s.debug.loaded}`);
  check('No stall while streaming (fps healthy)', s.fps > 20, `fps=${s.fps}`);

  const tints = await page.evaluate(() => {
    const g = window.__game;
    const colors = new Set();
    for (const m of g.world._grid.cells.values()) {
      if (m) colors.add(m.material.color.getHexString());
    }
    return { unique: colors.size, sample: [...colors].slice(0, 3) };
  });
  check('Per-sector debug tints differ', tints.unique >= 6, `${tints.unique} unique tints`);

  // Edge of the world: window shrinks (outside cells skipped), never errors.
  await page.evaluate(() => {
    const g = window.__game;
    g.bike._placeAt(30, 0, 30, 0); // sector (0,0) corner
    g.followCam.snapTo(g.bike);
  });
  await sleep(400);
  s = await state();
  check('World-corner window clips to 4 sectors', s.debug.loaded === 4,
    `loaded=${s.debug.loaded} at sector (${s.debug.sectorX},${s.debug.sectorZ})`);
  const poolOk = await page.evaluate(() => window.__game.world._pool.available >= 6);
  check('Sector meshes returned to the pool at the corner', poolOk);

  // Back to the middle: window refills to 9.
  await page.evaluate(() => {
    const g = window.__game;
    g.bike._placeAt(5000, 0, 2500, 0);
    g.followCam.snapTo(g.bike);
  });
  await sleep(400);
  s = await state();
  check('Window refills to 9 sectors mid-world', s.debug.loaded === 9, `loaded=${s.debug.loaded}`);

  // ================= HUD / distance =================
  const hud = await page.evaluate(() => ({
    dist: document.getElementById('distance').textContent,
    speed: document.getElementById('speedo').textContent,
  }));
  check('HUD shows distance + speed', /m|km/.test(hud.dist) && /km\/h/.test(hud.speed), JSON.stringify(hud));

  // ================= Reset =================
  await page.keyboard.press('KeyR');
  await sleep(300);
  s = await state();
  check('Reset (R) recovers the bike', s.state === 'playing' && s.grounded && Math.abs(s.speed) < 0.5,
    `speed=${s.speed}`);

  // ================= POV toggle =================
  const povBefore = await page.evaluate(() => window.__game.followCam.mode);
  await page.keyboard.press('KeyC');
  await sleep(900);
  const povAfter = await page.evaluate(() => window.__game.followCam.mode);
  check('First-person POV toggles', povBefore === 'third' && povAfter === 'first');
  await page.keyboard.press('KeyC');
  await sleep(400);

  // ================= Debug overlay (F3 + mobile button) =================
  let dbgHidden = await page.evaluate(() =>
    document.getElementById('debug-overlay').classList.contains('hidden'));
  check('Debug overlay hidden by default', dbgHidden);
  await page.keyboard.press('F3');
  await sleep(400);
  const dbg = await page.evaluate(() => ({
    hidden: document.getElementById('debug-overlay').classList.contains('hidden'),
    text: document.getElementById('debug-overlay').textContent,
  }));
  check('F3 shows debug overlay', !dbg.hidden);
  check('Overlay shows FPS / position / sector / loaded / draw calls',
    /FPS \d+/.test(dbg.text) && /X [\d.]+ {2}Z [\d.]+/.test(dbg.text) &&
    /SECTOR \(\d+,\d+\)/.test(dbg.text) && /LOADED \d+/.test(dbg.text) &&
    /DRAW CALLS \d+/.test(dbg.text),
    JSON.stringify(dbg.text));
  await page.keyboard.press('F3');
  await sleep(200);
  dbgHidden = await page.evaluate(() =>
    document.getElementById('debug-overlay').classList.contains('hidden'));
  check('F3 hides debug overlay again', dbgHidden);
  await page.click('#btn-debug');
  await sleep(200);
  const dbgBtn = await page.evaluate(() =>
    !document.getElementById('debug-overlay').classList.contains('hidden'));
  check('Mobile DBG button toggles overlay', dbgBtn);
  await page.click('#btn-debug');
  await sleep(200);

  // ================= Pause =================
  await page.keyboard.press('KeyP');
  await sleep(200);
  s = await state();
  check('Pause works (P key)', s.state === 'paused');
  const pauseVisible = await page.evaluate(() =>
    !document.getElementById('pause-overlay').classList.contains('hidden'));
  check('Pause overlay shows', pauseVisible);
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

  // ================= Pause menu -> main menu =================
  await page.click('#btn-pause');
  await sleep(200);
  await page.click('#btn-main-menu');
  await sleep(300);
  s = await state();
  check('Return to main menu works', s.state === 'menu');

  // ================= Settings overlay =================
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
