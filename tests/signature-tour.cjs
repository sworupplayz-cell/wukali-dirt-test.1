/**
 * Signature-mountain tour: rides every signature route in the live game.
 * For each: teleport to the road, autopilot to the summit, verify the
 * banner shows the right name and the achievement unlocks, then descend.
 * Kind-specific checks: Shreya's bridge, Aakash's whoop jumps.
 *
 * Setup once: bash tests/setup-browser.sh   Run: npm run test:signatures
 */
const { createRequire } = require('module');
const req = createRequire('/tmp/e2e/x.js');
const chromium = req('@sparticuz/chromium').default;
const puppeteer = req('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
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
  await page.setViewport({ width: 850, height: 400 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem('wukali_achievements'));
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await sleep(1800);
  await page.click('#btn-play');
  await sleep(300);

  const sigs = await page.evaluate(() =>
    window.__game.world.getMountainRegistry().filter((m) => m.signature)
      .map((m) => ({ id: m.id, name: m.name, kind: 0, x: m.x, z: m.z, H: m.H })));
  check('Six signature destinations', sigs.length === 6, sigs.map((s) => s.name).join(', '));

  const rides = [];
  for (const sig of sigs) {
    rides.push({ sig, ri: 0 });
    if (sig.name === 'Shreya Shikhar') {
      rides.push({ sig, ri: 1 }); // counter-spiral ridge route
      rides.push({ sig, ri: 2 }); // radial rocky spur
    }
  }
  let summitsBefore = 0;
  for (const { sig, ri } of rides) {
    const startFrac = ri === 2 ? 0.05 : ri === 1 ? 0.3 : sig.name === 'Shreya Shikhar' ? 0.35 : 0.55;
    await page.evaluate(([mx, mz, f, ri2]) => {
      const g = window.__game;
      g.restart();
      const rec = g.world.nearestMountain(mx, mz);
      window.__auto = { m: rec, frac: f, ri: ri2, air: false, scored0: g.stunts.score };
      const p = g.world.roadPoint(rec, f, ri2);
      g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw);
      g.followCam.snapTo(g.bike);
      g.input.update = () => {};
    }, [sig.x, sig.z, startFrac, ri]);
    await sleep(2200);

    let reached = false, crashes = 0, banner = '', midShot = false;
    // Budget sized for slow CI sandboxes: sim falls behind wall time when
    // headless fps dips, so long climbs need wall-clock headroom (the bike
    // itself summits Aakash in ~51 s — verified standalone either build).
    for (let i = 0; i < 2600 && !reached; i++) {
      await sleep(110);
      const st = await page.evaluate(() => {
        const g = window.__game, A = window.__auto;
        if (g.state === 'crashed') return { crashed: true };
        // Unstick (see the descent loop): back off a wedged rock and retry.
        if (A.rev > 0) {
          A.rev--;
          g.input.throttle = 0; g.input.brake = 1; g.input.steer = A.revSteer;
          return { crashed: false, frac: A.frac, dist: 1e9, summits: g.achievements.summitCount,
            banner: document.getElementById('sb-name').textContent };
        }
        g.input.brake = 0;
        A.stuck = g.bike.speed < 1 && g.input.throttle > 0 ? (A.stuck || 0) + 1 : 0;
        if (A.stuck > 6) { A.rev = 10; A.revSteer = Math.random() < 0.5 ? 1 : -1; A.stuck = 0; }
        let p = g.world.roadPoint(A.m, A.frac, A.ri);
        const b = g.bike.position;
        while (Math.hypot(p.x - b.x, p.z - b.z) < 14 && A.frac < 1.02) {
          A.frac += A.ri === 2 ? 0.02 : 0.005;
          p = g.world.roadPoint(A.m, A.frac, A.ri);
        }
        const ty = Math.atan2(p.x - b.x, p.z - b.z);
        let d = ty - g.bike.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        g.input.steer = Math.max(-1, Math.min(1, -d * 2.2));
        g.input.throttle = Math.abs(d) > 1.3 && g.bike.speed > 4 ? 0
          : (A.m.kind === 2 || A.ri === 2 ? 1 : 0.85);
        if (!g.bike.grounded) A.air = true;
        return {
          crashed: false, frac: A.frac,
          dist: Math.hypot(A.m.x - b.x, A.m.z - b.z),
          summits: g.achievements.summitCount,
          banner: document.getElementById('sb-name').textContent,
        };
      });
      if (st.crashed) {
        crashes++;
        if (crashes > 5) break;
        await sleep(300);
        await page.evaluate(() => {
          const g = window.__game, A = window.__auto;
          g.restart();
          A.frac = Math.max(0.05, A.frac - 0.04);
          const p = g.world.roadPoint(A.m, A.frac, A.ri);
          g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw);
          g.followCam.snapTo(g.bike);
          g.input.update = () => {};
        });
        continue;
      }
      if (!midShot && st.frac > (startFrac + 0.18)) {
        midShot = true;
        await page.screenshot({ path: `/tmp/sig-${sig.name.replace(/ /g, '_')}-mid.png` });
      }
      if (ri === 0 ? st.summits > summitsBefore : st.dist < 18) {
        reached = true;
        banner = st.banner;
        await page.screenshot({ path: `/tmp/sig-${sig.name.replace(/ /g, '_')}-r${ri}-summit.png` });
      }
    }
    summitsBefore = await page.evaluate(() => window.__game.achievements.summitCount);
    const label = ri === 0 ? 'main road' : ri === 1 ? 'alternate route' : 'spur shortcut';
    check(`${sig.name} [${label}]: summit reached by riding`, reached,
      `crashes on the way: ${crashes}`);
    if (ri === 0) check(`${sig.name}: banner shows its name`, banner === sig.name, banner);

    if (ri !== 0) continue; // descents/jump checks only for main-road rides
    const extra = await page.evaluate(() => ({
      air: window.__auto.air,
      scored: window.__game.stunts.score - window.__auto.scored0,
    }));
    if (sig.name === 'Aakash Chuli') {
      check('Aakash Chuli: whoop jumps launch the bike on-road',
        extra.air && extra.scored > 0, `air=${extra.air} stuntPts=${extra.scored}`);
    }

    // Descend partway (restart clears any crash state from the summit
    // moment; throttle zeroed so placement is stationary).
    await page.evaluate(() => {
      const g = window.__game, A = window.__auto;
      g.restart();
      A.down = 0.83;
      const p = g.world.roadPoint(A.m, 0.86);
      g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw + Math.PI);
      g.followCam.snapTo(g.bike);
      g.input.update = () => {};
      g.input.throttle = 0; g.input.steer = 0; g.input.brake = 0;
    });
    await sleep(600);
    let y0 = null, y1 = null;
    // Wall-clock headroom for slow CI sandboxes (same reasoning as the
    // climb loop): the descent itself takes a few seconds of game time.
    for (let i = 0; i < 220; i++) {
      await sleep(110);
      const st = await page.evaluate(() => {
        const g = window.__game, A = window.__auto;
        if (g.state === 'crashed') return { crashed: true };
        // Unstick: slow-poll autopilots can wedge against a trailside rock
        // (a human just backs up); reverse briefly, then resume.
        if (A.rev > 0) {
          A.rev--;
          g.input.throttle = 0; g.input.brake = 1; g.input.steer = A.revSteer;
          return { crashed: false, y: g.bike.position.y };
        }
        g.input.brake = 0;
        A.stuck = g.bike.speed < 1 && g.input.throttle > 0 ? (A.stuck || 0) + 1 : 0;
        if (A.stuck > 6) { A.rev = 10; A.revSteer = Math.random() < 0.5 ? 1 : -1; A.stuck = 0; }
        let p = g.world.roadPoint(A.m, A.down);
        const b = g.bike.position;
        while (Math.hypot(p.x - b.x, p.z - b.z) < 12 && A.down > 0.06) {
          A.down -= 0.004;
          p = g.world.roadPoint(A.m, A.down);
        }
        const ty = Math.atan2(p.x - b.x, p.z - b.z);
        let d = ty - g.bike.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        g.input.steer = Math.max(-1, Math.min(1, -d * 2.2));
        // Keep some throttle while slow: steering has no authority at 0 speed.
        g.input.throttle = Math.abs(d) > 1.3 && g.bike.speed > 4 ? 0 : 0.45;
        return { crashed: false, y: b.y };
      });
      if (st.crashed) break;
      if (y0 === null) y0 = st.y;
      y1 = y1 === null ? st.y : Math.min(y1, st.y); // crown roads rise briefly
      if (y1 < y0 - 12) break;
    }
    check(`${sig.name}: rode back down partway`, y0 !== null && y1 < y0 - 6,
      `y ${y0 && y0.toFixed(0)} -> ${y1 && y1.toFixed(0)}`);
  }

  // Shreya-specific: the road bridge exists on the route and is level.
  const bridge = await page.evaluate(() => {
    const g = window.__game;
    const reg = g.world.getMountainRegistry().find((m) => m.name === 'Shreya Shikhar');
    const rec = g.world.nearestMountain(reg.x, reg.z);
    if (!rec.bridgePts || !rec.bridgePts.length) return null;
    const bp = rec.bridgePts[0];
    const deckH = g.world.getHeight(bp.x, bp.z);
    const ravine = g.world.getHeight(bp.x + bp.dz * 8, bp.z - bp.dx * 8); // beside the deck
    return { drop: +(deckH - ravine).toFixed(2) };
  });
  check('Shreya Shikhar: bridge deck spans a real ravine', !!bridge && bridge.drop > 1.5,
    JSON.stringify(bridge));

  const final = await page.evaluate(() => ({
    summits: window.__game.achievements.summitCount,
    meta: window.__game.achievements.list().meta,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    calls: window.__game.renderer.info.render.calls,
    tris: window.__game.renderer.info.render.triangles,
  }));
  check('All six summit achievements recorded', final.summits === 6, JSON.stringify(final.meta));
  check('No runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('perf:', JSON.stringify(final));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} tour checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL', e); process.exit(2); });
