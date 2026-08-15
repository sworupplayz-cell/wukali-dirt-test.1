/**
 * Horizon Ride — Phase 1A end-to-end verification.
 *
 * Drives the real game (dev server on :3000) in headless Chromium and
 * checks the preserved foundation: bike physics, camera, controls, menus
 * and the clean static test scene (no procedural world, no NPCs).
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
      groundH: +g.world.getHeight(g.bike.position.x, g.bike.position.z).toFixed(2),
    };
  });

  // ================= Menu + scene sanity =================
  let s = await state();
  check('Main menu opens', s.state === 'menu');

  const scene = await page.evaluate(() => {
    const g = window.__game;
    let meshes = 0, lights = 0, total = 0;
    g.scene.traverse((o) => {
      total++;
      if (o.isMesh) meshes++;
      if (o.isLight) lights++;
    });
    return {
      meshes, lights, total,
      calls: g.renderer.info.render.calls,
      tris: g.renderer.info.render.triangles,
      geoms: g.renderer.info.memory.geometries,
      isTestWorld: g.world.constructor.name === 'TestWorld',
      noChunks: !g.world.chunks,
      noPopulation: !g.world.population,
      noVillages: !g.world.villages && !g.world.towns && !g.world.cities && !g.world.industry,
    };
  });
  check('World is the clean TestWorld', scene.isTestWorld);
  check('No chunk streaming system', scene.noChunks);
  check('No NPC/traffic population system', scene.noPopulation);
  check('No village/town/city/industry systems', scene.noVillages);
  // Budget: ~27 meshes belong to the bike/rider model (preserved as-is);
  // the test scene itself adds only ground + road + ramp.
  check('Tiny scene (few meshes, low draw calls)',
    scene.meshes <= 35 && scene.calls <= 35,
    `meshes=${scene.meshes} calls=${scene.calls} tris=${scene.tris}`);
  console.log('SCENE METRICS', JSON.stringify(scene));

  // ================= Riding =================
  await page.click('#btn-play');
  await sleep(400);
  s = await state();
  check('PLAY starts gameplay', s.state === 'playing');
  check('Bike spawns grounded', s.grounded && Math.abs(s.pos[1] - s.groundH) < 0.5, JSON.stringify(s.pos));

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

  const d0 = await page.evaluate(() => window.__game.run.distance);
  check('Distance tracked while riding', d0 > 15, `${d0.toFixed(1)} m`);
  const hud = await page.evaluate(() => ({
    dist: document.getElementById('distance').textContent,
    speed: document.getElementById('speedo').textContent,
  }));
  check('HUD shows distance + speed', /m|km/.test(hud.dist) && /km\/h/.test(hud.speed), JSON.stringify(hud));

  // ================= Ramp jump =================
  await page.evaluate(() => {
    const g = window.__game;
    // Line up on the road facing the ramp with a run-up.
    g.bike._placeAt(0, g.world.getHeight(0, 20), 20, 0);
    g.followCam.snapTo(g.bike);
  });
  let peakAir = 0, wasAirborne = false;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const a = await page.evaluate(() => ({
      air: !window.__game.bike.grounded,
      h: window.__game.bike.heightAboveGround,
    }));
    if (a.air) { wasAirborne = true; peakAir = Math.max(peakAir, a.h); }
  }
  await page.keyboard.up('KeyW');
  check('Ramp jump works (bike gets airborne)', wasAirborne && peakAir > 0.8, `peak=${peakAir.toFixed(2)} m`);

  // ================= Reset =================
  await sleep(600);
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
  const t = await page.touchscreen;
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
