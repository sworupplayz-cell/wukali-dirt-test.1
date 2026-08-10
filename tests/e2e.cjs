/**
 * Wukali Dirt — end-to-end gameplay verification.
 *
 * Drives the real game (dev server on :3000) in headless Chromium and
 * checks Phase 1 (bike/UI), Phase 2 (endless world), Phase 3A (distance/
 * stunts/game over) and Phase 3B (mountain destinations + achievements).
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
const SHOT = (n) => `/tmp/shot-${n}.png`;
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
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem('wukali_achievements'));
  await sleep(1800);

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
      debug: g.world.debugInfo(),
      groundH: +g.world.getHeight(g.bike.position.x, g.bike.position.z).toFixed(2),
    };
  });

  // ================= Phase 1 regression =================
  let s = await state();
  check('Main menu opens', s.state === 'menu');

  const heights1 = await page.evaluate(() =>
    [[0, 0], [123.4, -567.8], [-901.2, 345.6], [77, 77], [-1500, 1500]]
      .map(([x, z]) => window.__game.world.getHeight(x, z)));

  await page.click('#btn-play');
  await sleep(400);
  s = await state();
  check('PLAY starts gameplay', s.state === 'playing');
  check('Bike spawns grounded', s.grounded && Math.abs(s.pos[1] - s.groundH) < 0.5, JSON.stringify(s.pos));
  const spawn1 = await page.evaluate(() => window.__game.world.getSpawn());

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

  // ================= Phase 3A: distance / speed / difficulty =================
  const d0 = await page.evaluate(() => window.__game.run.distance);
  check('Distance tracked while riding', d0 > 15, `${d0.toFixed(1)} m`);
  const hud = await page.evaluate(() => ({
    dist: document.getElementById('distance').textContent,
    speed: document.getElementById('speedo').textContent,
  }));
  check('HUD shows distance + speed', /m|km/.test(hud.dist) && /km\/h/.test(hud.speed), JSON.stringify(hud));
  await page.evaluate(() => {
    const g = window.__game;
    const p = g.bike.position;
    g.bike._placeAt(p.x + 500, g.world.getHeight(p.x + 500, p.z), p.z, g.bike.yaw);
    g.followCam.snapTo(g.bike);
  });
  await sleep(700);
  const d1 = await page.evaluate(() => window.__game.run.distance);
  check('Teleport does not inflate distance', d1 - d0 < 5, `delta=${(d1 - d0).toFixed(1)} m`);
  const diff = await page.evaluate(() => window.__game.run.difficulty);
  check('Difficulty value exposed', diff >= 0 && diff <= 1, `difficulty=${diff.toFixed(3)}`);

  // ================= Phase 2: streaming ride across regions =================
  const tour = await page.evaluate(() => {
    const gen = window.__game.world.generator;
    const found = {};
    for (let x = -1600; x <= 1600; x += 50) {
      for (let z = -1600; z <= 1600; z += 50) {
        const i = gen.sampleInfo(x, z, {});
        if (!found.forest && i.wF > 0.9) found.forest = [x, z];
        if (!found.farm && i.wFa > 0.9) found.farm = [x, z];
        if (!found.mountain && i.wMnt > 0.9) found.mountain = [x, z];
      }
    }
    return found;
  });
  const legs = [
    ['east', 0.5 * Math.PI, null], ['north', 0, null], ['west', -0.5 * Math.PI, null],
    ['farm-region', 0, tour.farm], ['forest-region', Math.PI / 2, tour.forest],
    ['mountain-region', Math.PI, tour.mountain],
  ];
  const heap = [];
  let maxInstances = 0, maxColliders = 0, maxChunks = 0, worst = null;
  let crashes = 0, totalDist = 0, prevPos = null;
  const biomesSeen = new Set();

  for (const [name, yaw, tp] of legs) {
    await page.evaluate(([yaw2, tp2]) => {
      const g = window.__game;
      if (tp2) {
        g.bike._placeAt(tp2[0], g.world.getHeight(tp2[0], tp2[1]), tp2[1], yaw2);
        g.followCam.snapTo(g.bike);
      } else {
        g.bike.yaw = yaw2;
      }
    }, [yaw, tp]);
    prevPos = null;
    await page.keyboard.down('KeyW');
    // 95 ticks/leg: the Phase 3L-1 world is denser (village obstacles), so
    // the blind rider needs a little more wall time to cover distance.
    for (let i = 0; i < 95; i++) {
      await sleep(100);
      if (i % 30 === 10) await page.keyboard.down(i % 60 < 30 ? 'KeyA' : 'KeyD');
      if (i % 30 === 20) { await page.keyboard.up('KeyA'); await page.keyboard.up('KeyD'); }
      s = await state();
      if (prevPos) {
        const d = Math.hypot(s.pos[0] - prevPos[0], s.pos[2] - prevPos[2]);
        if (d < 8) totalDist += d;
      }
      prevPos = s.pos;
      maxInstances = Math.max(maxInstances, s.debug.instances);
      maxColliders = Math.max(maxColliders, s.debug.colliders);
      maxChunks = Math.max(maxChunks, s.debug.chunks);
      if (Math.abs(s.speed) > 35 || Number.isNaN(s.pos[0]) ||
          (s.grounded && Math.abs(s.pos[1] - s.groundH) > 1.5)) worst = { leg: name, s };
      if (s.state === 'crashed') {
        crashes++;
        await sleep(300);
        await page.click('#btn-go-restart');
        prevPos = null;
        await page.evaluate((y2) => { window.__game.bike.yaw = y2; }, yaw);
      }
      const b = await page.evaluate(() => {
        const g = window.__game;
        const i = {};
        g.world.generator.sampleInfo(g.bike.position.x, g.bike.position.z, i);
        const arr = [['hills', i.wH], ['forest', i.wF], ['farm', i.wFa], ['rocky', i.wRk], ['mountain', i.wMnt]];
        arr.sort((p, q) => q[1] - p[1]);
        return arr[0][1] > 0.5 ? arr[0][0] : null;
      });
      if (b) biomesSeen.add(b);
    }
    await page.keyboard.up('KeyW');
    const m = await page.metrics();
    heap.push(Math.round(m.JSHeapUsedSize / 1048576));
  }

  check('Rode a long distance in all directions', totalDist > 350, `${Math.round(totalDist)} m, ${crashes} crashes`); // blind rider variance; streaming stress also covered by teleport legs
  check('Chunk count stays bounded', maxChunks <= 25, `max=${maxChunks}`);
  check('Instance count stays bounded', maxInstances < 1700, `max=${maxInstances}`); // micro-prop budget added in 3C-1
  check('Collider count stays bounded', maxColliders < 320, `max=${maxColliders}`); // Phase 3L-1 villages/mills add bounded collidable structures
  await sleep(2500); // teleport at the last leg enqueues a full ring; let it drain
  s = await state();
  check('Queue drains after riding', s.debug.queued <= 4, `queued=${s.debug.queued}`);
  check('No physics/streaming failure during ride', !worst, worst ? JSON.stringify(worst) : '');
  check('Heap growth bounded over ride', heap[heap.length - 1] - heap[0] < 25,
    `heap ${heap[0]}MB -> ${heap[heap.length - 1]}MB`);
  check('Rode inside 3+ biome regions', biomesSeen.size >= 3, [...biomesSeen].join(','));

  const buildMs = await page.evaluate(() => {
    const cm = window.__game.world.chunks;
    const cs = [...cm.chunks.values()].filter((c) => c.built).slice(0, 6);
    const t0 = performance.now();
    for (const c of cs) cm._build(c);
    return +((performance.now() - t0) / cs.length).toFixed(2);
  });
  check('Chunk build fast enough for streaming', buildMs < 14, `${buildMs} ms avg`);

  const seam = await page.evaluate(() => {
    const g = window.__game;
    const cm = g.world.chunks;
    const cx = Math.floor(g.bike.position.x / 64), cz = Math.floor(g.bike.position.z / 64);
    const a = cm.chunks.get(cx + ',' + cz), b = cm.chunks.get((cx + 1) + ',' + cz);
    if (!a || !b || !a.mesh || !b.mesh || a.role !== 'inner' || b.role !== 'inner') return { skip: true };
    const pa = a.mesh.geometry.attributes.position, pb = b.mesh.geometry.attributes.position;
    const N = 32;
    let maxDiff = 0;
    for (let j = 0; j <= N; j++) {
      maxDiff = Math.max(maxDiff, Math.abs(pa.getY(j * (N + 1) + N) - pb.getY(j * (N + 1))));
    }
    return { maxDiff };
  });
  check('Chunk edges match exactly (no seams)', seam.skip || seam.maxDiff < 1e-4,
    seam.skip ? 'skipped' : `maxDiff=${seam.maxDiff}`);

  // ================= Phase 2/3A: features + stunts =================
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1500);
  await page.click('#btn-play');
  await sleep(400);
  const ramp = await page.evaluate(() => {
    const g = window.__game;
    const sp = g.world.getSpawn(); // deterministic reference point
    const f = g.world.findFeature('ramp', sp.x, sp.z, 60); // spawn tiers (3L-3) can sit in farm regions; ramps stay rare by design
    return f && { x: f.x, z: f.z, dx: f.dx, dz: f.dz };
  });
  check('Stunt ramps generate (controlled rarity)', !!ramp);
  if (ramp) {
    await page.evaluate((r) => {
      const g = window.__game;
      g.restart(); // guarantee PLAYING state whatever the legs ended in
      const sx = r.x - r.dx * 35, sz = r.z - r.dz * 35;
      g.bike._placeAt(sx, g.world.getHeight(sx, sz), sz, Math.atan2(r.dx, r.dz));
      g.followCam.snapTo(g.bike);
    }, ramp);
    await sleep(2000);
    // In-page recorder: samples every 50 ms (external polling is too slow
    // under load) and cuts the throttle once the stunt lands, so the bike
    // never drives on into scenery after the measurement.
    await page.evaluate(() => {
      const g = window.__game;
      g.input.update = () => { g.input.throttle = 1; g.input.brake = 0; g.input.steer = 0; };
      window.__jump = { scored: 0, combo: 0, crashed: false, air: false, toast: '', base: 0 };
      const iv = setInterval(() => {
        const J = window.__jump;
        if (!g.bike.grounded && !J.air) { J.air = true; J.base = g.stunts.score; }
        if (g.bike.crashed) J.crashed = true;
        // Phase 3I-1: the full-throttle approach may already bank a wheelie,
        // so only score gained after takeoff counts as the jump's payout.
        if (J.air && g.stunts.score > J.base && !J.scored) {
          J.scored = g.stunts.score - J.base;
          J.combo = g.stunts.combo;
          J.toast = document.getElementById('stunt-toast').textContent;
        }
        if (J.scored || J.crashed) {
          delete g.input.update;
          g.input.throttle = 0;
          clearInterval(iv);
        }
      }, 50);
    });
    let jump = null;
    for (let i = 0; i < 140; i++) {
      await sleep(120);
      jump = await page.evaluate(() => window.__jump);
      if (jump.scored || jump.crashed) break;
    }
    check('Ramp jump: launch + clean landing awards points',
      jump.air && jump.scored > 0 && !jump.crashed, JSON.stringify(jump));
    check('Stunt notification shown', /(AIR|COMBO x\d+) \+\d+/.test(jump.toast), jump.toast);
    check('Combo increments after stunt', jump.combo >= 2, `combo=${jump.combo}`);
  }
  await page.keyboard.up('KeyW');

  const mound = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.findFeature('mound', g.bike.position.x, g.bike.position.z, 30);
    if (!f) return null;
    return { rise: +(g.world.getHeight(f.x, f.z) - g.world.getHeight(f.x + f.dx * 14, f.z + f.dz * 14)).toFixed(2) };
  });
  check('Natural jump mounds generate', !!mound && mound.rise > 0.8, JSON.stringify(mound));
  const bridge = await page.evaluate(() => {
    const g = window.__game;
    const f = g.world.findFeature('bridge', g.bike.position.x, g.bike.position.z, 40);
    if (!f) return null;
    const deck = g.world.getHeight(f.x, f.z);
    const bed = g.world.getHeight(f.x + f.dz * 3.5, f.z - f.dx * 3.5);
    return { deckOverBed: +(deck - bed).toFixed(2) };
  });
  check('Bridges generate over streams', !!bridge, JSON.stringify(bridge));
  const terr = await page.evaluate(() => {
    const gen = window.__game.world.generator;
    for (let x = -1600; x <= 1600; x += 40) {
      for (let z = -1600; z <= 1600; z += 40) {
        const i = gen.sampleInfo(x, z, {});
        if (i.wFa > 0.9 && i.terr > 0.6) return [x, z];
      }
    }
    return null;
  });
  check('Terraced farmland generates', !!terr, JSON.stringify(terr));

  // ================= Phase 3A: crash => game over =================
  await page.evaluate(() => {
    const g = window.__game;
    g.restart();
    const sp = g.world.getSpawn();
    g.bike._placeAt(sp.x, sp.y, sp.z, sp.yaw);
    g.followCam.snapTo(g.bike);
  });
  await sleep(1500); // let chunks + colliders stream in around spawn
  const tree = await page.evaluate(() => {
    const g = window.__game;
    const n = { set(x, y, z) { this.y = y; }, normalize() { return this; } };
    for (const c of g.world.getColliders()) {
      if (c.r < 0.5) continue; // want a solid tree/rock, not a pole
      const ax = c.x, az = c.z - 15; // approach run-up (houses have fat colliders)
      const e = 3;
      const dh = Math.abs(g.world.getHeight(ax, az + e) - g.world.getHeight(ax, az - e)) +
                 Math.abs(g.world.getHeight(ax + e, az) - g.world.getHeight(ax - e, az));
      if (dh < 1.2) return c; // flat enough approach to reach crash speed
    }
    return null;
  });
  if (tree) {
    await page.evaluate((c) => {
      const g = window.__game;
      const sx = c.x, sz = c.z - 15;
      g.bike._placeAt(sx, g.world.getHeight(sx, sz), sz, Math.atan2(c.x - sx, c.z - sz));
      g.followCam.snapTo(g.bike);
    }, tree);
    await sleep(1500);
    await page.keyboard.down('KeyW');
    let crashed = false;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      s = await state();
      if (s.state === 'crashed') { crashed = true; break; }
    }
    await page.keyboard.up('KeyW');
    check('Crash detection still works', crashed);
    await sleep(500);
    const go = await page.evaluate(() => ({
      overlay: !document.getElementById('gameover-overlay').classList.contains('hidden'),
      dist: document.getElementById('go-distance').textContent,
      score: document.getElementById('go-score').textContent,
      actual: String(window.__game.stunts.score),
    }));
    check('Game over overlay shows stats', go.overlay && /m|km/.test(go.dist), JSON.stringify(go));
    check('Game over score is current', go.score === go.actual, `${go.score} vs ${go.actual}`);
    await page.click('#btn-go-restart');
    await sleep(400);
    s = await state();
    const fresh = await page.evaluate(() => ({ d: window.__game.run.distance, sc: window.__game.stunts.score }));
    check('Restart after game over resets run', s.state === 'playing' && fresh.d < 1 && fresh.sc === 0,
      JSON.stringify(fresh));
  }

  // Failed vs clean landing of the IDENTICAL drop: crash must pay far less.
  const drop = async (airPitch) => {
    const before = await page.evaluate((ap) => {
      const g = window.__game;
      g.stunts.cancel();
      const p = g.bike.position;
      g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, g.bike.yaw);
      g.bike.position.y += 14;
      g.bike.grounded = false;
      g.bike.velocity.set(0, -14, 8);
      g.bike.airPitch = ap;
      return g.stunts.score;
    }, airPitch);
    let end = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      end = await page.evaluate(() => ({
        grounded: window.__game.bike.grounded, crashed: window.__game.bike.crashed,
        score: window.__game.stunts.score, combo: window.__game.stunts.combo,
      }));
      if (end.grounded) break;
    }
    return { pts: end.score - before, crashed: end.crashed, combo: end.combo };
  };
  const clean = await drop(0);
  check('Identical clean drop lands + pays full', !clean.crashed && clean.pts > 0, JSON.stringify(clean));
  const failedDrop = await drop(1.0);
  check('Failed jump crashes and awards only partial points',
    failedDrop.crashed && failedDrop.pts >= 0 && failedDrop.pts < clean.pts * 0.35 && failedDrop.combo === 1,
    `failPts=${failedDrop.pts} cleanPts=${clean.pts}`);
  await sleep(600);
  await page.evaluate(() => window.__game.restart()); // DOM-independent recovery
  await sleep(400);

  // ================= Phase 3D-1: destination registry =================
  const reg = await page.evaluate(() => window.__game.world.getMountainRegistry()
    .map((m) => ({ id: m.id, name: m.name, sig: m.signature, type: m.type,
      diff: m.difficulty, x: Math.round(m.x), z: Math.round(m.z),
      sy: +m.summit.y.toFixed(1), ach: m.achievementId })));
  check('Registry has 15+ destinations', reg.length >= 15, `${reg.length}`);
  const names = reg.map((m) => m.name);
  check('All registry names unique', new Set(names).size === names.length, names.join(', '));
  check('Shreya Shikhar exists exactly once', names.filter((n) => n === 'Shreya Shikhar').length === 1);
  const sigs = reg.filter((m) => m.sig);
  check('5-6 signature destinations', sigs.length >= 5 && sigs.length <= 6,
    sigs.map((m) => m.name).join(', '));
  check('Signature types are distinct', new Set(sigs.map((m) => m.type)).size === sigs.length);
  let minSep = Infinity;
  for (let i = 0; i < reg.length; i++) {
    for (let j2 = i + 1; j2 < reg.length; j2++) {
      minSep = Math.min(minSep, Math.hypot(reg[i].x - reg[j2].x, reg[i].z - reg[j2].z));
    }
  }
  check('Destinations sufficiently separated', minSep > 600, `min ${Math.round(minSep)} m`);
  check('Difficulties within 1..5', reg.every((m) => m.diff >= 1 && m.diff <= 5));
  check('Every destination has an achievement id', reg.every((m) => m.ach && m.ach.length > 3));
  const summitNameMatches = await page.evaluate(() => {
    const w = window.__game.world;
    const r = w.getMountainRegistry()[0];
    const cell = w.summitAt(r.x, r.z, 20);
    return cell && cell.name === r.name;
  });
  check('Cell records carry registry names (summit banner integration)', summitNameMatches);

  // ================= Phase 3B: mountain destinations =================
  const mlist = await page.evaluate(() => {
    const gen = window.__game.world.generator;
    const out = [];
    for (let cx = -3; cx <= 2; cx++) {
      for (let cz = -3; cz <= 2; cz++) {
        const m = gen.mountainCell(cx, cz);
        if (m) out.push([Math.round(m.x), Math.round(m.z), m.name, Math.round(m.H)]);
      }
    }
    return out;
  });
  check('Mountains generate', mlist.length > 0, `${mlist.length} in 7.2x7.2 km`);
  check('Mountains are rare, not everywhere', mlist.length >= 6 && mlist.length <= 30,
    `${mlist.length} of 36 cells`);

  const nearM = await page.evaluate(() => {
    const g = window.__game;
    const m = g.world.nearestMountain(g.bike.position.x, g.bike.position.z);
    return m && { id: m.id, name: m.name, x: m.x, z: m.z, R: m.R, H: Math.round(m.H) };
  });
  check('Nearest mountain discoverable from anywhere', !!nearM, JSON.stringify(nearM));

  // Road quality at 1% sampling: rideable grade, bounded dips, flat band.
  const road = await page.evaluate(() => {
    const g = window.__game;
    const m = g.world.nearestMountain(g.bike.position.x, g.bike.position.z);
    let maxGrade = 0, dip = 0, maxDip = 0, cross = 0, prev = null, prevP = null;
    let first = null, last = null;
    for (let f = 0.05; f <= 1.0; f += 0.01) {
      const p = g.world.roadPoint(m, f);
      const h = g.world.getHeight(p.x, p.z);
      if (first === null) first = h;
      last = h;
      if (prev !== null) {
        const len = Math.hypot(p.x - prevP.x, p.z - prevP.z);
        maxGrade = Math.max(maxGrade, Math.abs(h - prev) / len);
        if (f > 0.4) { if (h < prev) dip += prev - h; else { maxDip = Math.max(maxDip, dip); dip = 0; } }
      }
      prev = h; prevP = p;
      if (f > 0.5 && f < 0.95) {
        const px = Math.sin(p.yaw + Math.PI / 2), pz2 = Math.cos(p.yaw + Math.PI / 2);
        cross = Math.max(cross, Math.abs(g.world.getHeight(p.x + px * 2.5, p.z + pz2 * 2.5) -
          g.world.getHeight(p.x - px * 2.5, p.z - pz2 * 2.5)));
      }
    }
    maxDip = Math.max(maxDip, dip);
    return { climb: +(last - first).toFixed(1), maxDip: +maxDip.toFixed(1),
      maxGrade: +maxGrade.toFixed(3), cross: +cross.toFixed(2) };
  });
  check('Road climbs to the summit', road.climb > 30, `+${road.climb} m`);
  check('Road grade stays rideable (1% sampling)', road.maxGrade < 0.42, `maxGrade=${road.maxGrade}`); // signature mains peak ~0.36 by design
  check('Road dips stay bounded on the dome', road.maxDip < 12, `maxDip=${road.maxDip} m`);
  check('Road is flat across its width', road.cross < 1.6, `cross=${road.cross} m`);

  // THE CLIMB: autopilot follows the road from mid-mountain to the summit.
  await page.evaluate(() => {
    const g = window.__game;
    g.restart();
    const m = g.world.nearestMountain(g.bike.position.x, g.bike.position.z);
    window.__auto = { m, frac: 0.5 };
    const p = g.world.roadPoint(m, 0.5);
    g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw);
    g.followCam.snapTo(g.bike);
    g.input.update = () => {}; // autopilot owns the input now
  });
  await sleep(2200);
  await page.screenshot({ path: SHOT('climb-start') });
  const startY = (await state()).pos[1];
  let reached = false, climbCrashes = 0, shotMid = false;
  for (let i = 0; i < 900 && !reached; i++) {
    await sleep(120);
    const st = await page.evaluate(() => {
      const g = window.__game, A = window.__auto;
      if (g.state === 'crashed') return { crashed: true };
      let p = g.world.roadPoint(A.m, A.frac);
      const b = g.bike.position;
      while (Math.hypot(p.x - b.x, p.z - b.z) < 14 && A.frac < 1.02) {
        A.frac += 0.005;
        p = g.world.roadPoint(A.m, A.frac);
      }
      const ty = Math.atan2(p.x - b.x, p.z - b.z);
      let d = ty - g.bike.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.input.steer = Math.max(-1, Math.min(1, -d * 2.2)); // +steer turns right (yaw -)
      g.input.throttle = Math.abs(d) > 1.3 ? 0.35 : 1;
      g.input.brake = 0;
      return {
        crashed: false,
        y: b.y,
        frac: A.frac,
        dist: Math.hypot(A.m.x - b.x, A.m.z - b.z),
        summits: g.achievements.summitCount,
        banner: document.getElementById('summit-banner').classList.contains('show'),
        name: document.getElementById('sb-name').textContent,
      };
    });
    if (st.crashed) {
      climbCrashes++;
      if (climbCrashes > 3) break;
      await sleep(300);
      await page.click('#btn-go-restart');
      await page.evaluate(() => {
        const g = window.__game, A = window.__auto;
        A.frac = Math.max(0.5, A.frac - 0.05);
        const p = g.world.roadPoint(A.m, A.frac);
        g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw);
        g.followCam.snapTo(g.bike);
        g.input.update = () => {};
      });
      continue;
    }
    if (st.frac > 0.72 && !shotMid) { shotMid = true; await page.screenshot({ path: SHOT('climb-mid') }); }
    if (st.summits >= 1) {
      reached = true;
      await page.screenshot({ path: SHOT('summit') });
      check('Summit reached by riding the road', true,
        `y ${startY.toFixed(0)} -> ${st.y.toFixed(0)}, ${climbCrashes} crashes on the way`);
      check('Summit banner shown with mountain name', st.banner && st.name.length > 3, st.name);
      break;
    }
  }
  if (!reached) check('Summit reached by riding the road', false, `crashes=${climbCrashes}`);

  // One-time unlock: linger on the summit, count must stay 1.
  await sleep(1500);
  const dedup = await page.evaluate(() => window.__game.achievements.summitCount);
  check('Achievement unlocks exactly once', dedup === 1, `count=${dedup}`);
  const achList = await page.evaluate(() => window.__game.achievements.list());
  check('First Summit meta achievement unlocked', achList.meta.includes('First Summit'),
    JSON.stringify(achList.meta));

  // Ride back down: start on the upper road facing downhill and follow it.
  await page.evaluate(() => {
    const g = window.__game, A = window.__auto;
    A.down = 0.84;
    const p = g.world.roadPoint(A.m, 0.9);
    g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw + Math.PI);
    g.followCam.snapTo(g.bike);
    g.input.update = () => {};
  });
  await sleep(800);
  const yTop = (await state()).pos[1];
  // Budget sized for slow CI sandboxes (same reasoning as the tour's climb
  // loop): the descent itself takes ~15 s — verified standalone — but a
  // late-session page under degraded fps needs wall-clock headroom.
  for (let i = 0; i < 300; i++) { // crown rollers can climb briefly before the drop
    await sleep(120);
    const st = await page.evaluate(() => {
      const g = window.__game, A = window.__auto;
      if (g.state === 'crashed') return { crashed: true };
      let p = g.world.roadPoint(A.m, A.down);
      const b = g.bike.position;
      while (Math.hypot(p.x - b.x, p.z - b.z) < 12 && A.down > 0.06) {
        A.down -= 0.004;
        p = g.world.roadPoint(A.m, A.down);
      }
      const ty = Math.atan2(p.x - b.x, p.z - b.z);
      let d = ty - g.bike.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.input.steer = Math.max(-1, Math.min(1, -d * 2.2)); // +steer turns right (yaw -)
      // Keep some throttle while slow: steering has no authority at 0 speed.
      g.input.throttle = Math.abs(d) > 1.3 && g.bike.speed > 4 ? 0 : 0.5;
      g.input.brake = 0;
      return { crashed: false, y: b.y };
    });
    if (st.crashed) {
      // Narrow upper roads: recover and continue the descent.
      await sleep(300);
      await page.evaluate(() => {
        const g = window.__game, A = window.__auto;
        g.restart();
        const p = g.world.roadPoint(A.m, A.down);
        g.bike._placeAt(p.x, g.world.getHeight(p.x, p.z), p.z, p.yaw + Math.PI);
        g.followCam.snapTo(g.bike);
        g.input.update = () => {};
      });
      continue;
    }
    if (st.y < yTop - 12) break;
  }
  const yDown = (await state()).pos[1];
  check('Can ride back down after the summit', yDown < yTop - 8, `y ${yTop.toFixed(0)} -> ${yDown.toFixed(0)}`);
  await page.evaluate(() => { delete window.__game.input.update; }); // restore real input

  // ================= Persistence + determinism =================
  const bestStored = await page.evaluate(() => Number(localStorage.getItem('wukali_best_m')) || 0);
  check('Best distance persisted to storage', bestStored > 0, `${bestStored} m`);

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);
  const persist = await page.evaluate(() => ({
    summits: window.__game.achievements.summitCount,
    meta: window.__game.achievements.list().meta,
    best: window.__game.run.best,
  }));
  check('Achievement persists after restart', persist.summits === 1 && persist.meta.includes('First Summit'),
    JSON.stringify(persist));
  check('Best distance survives reload', Math.abs(persist.best - bestStored) < 2, `${persist.best}`);

  const heights2 = await page.evaluate(() =>
    [[0, 0], [123.4, -567.8], [-901.2, 345.6], [77, 77], [-1500, 1500]]
      .map(([x, z]) => window.__game.world.getHeight(x, z)));
  const mlist2 = await page.evaluate(() => {
    const gen = window.__game.world.generator;
    const out = [];
    for (let cx = -3; cx <= 2; cx++) {
      for (let cz = -3; cz <= 2; cz++) {
        const m = gen.mountainCell(cx, cz);
        if (m) out.push([Math.round(m.x), Math.round(m.z), m.name, Math.round(m.H)]);
      }
    }
    return out;
  });
  check('Same seed => identical world', JSON.stringify(heights1) === JSON.stringify(heights2));
  check('Same seed => identical mountains', JSON.stringify(mlist) === JSON.stringify(mlist2));
  const reg2 = await page.evaluate(() => window.__game.world.getMountainRegistry()
    .map((m) => ({ id: m.id, name: m.name, sig: m.signature, x: Math.round(m.x), z: Math.round(m.z) })));
  const regNow = reg.map((m) => ({ id: m.id, name: m.name, sig: m.sig, x: m.x, z: m.z }));
  check('Same seed => identical registry', JSON.stringify(reg2) === JSON.stringify(regNow));

  await page.goto(URL + '/?seed=99', { waitUntil: 'networkidle0' });
  await sleep(1200);
  const alt = await page.evaluate(() => {
    const gen = window.__game.world.generator;
    const out = [];
    for (let cx = -3; cx <= 2; cx++) {
      for (let cz = -3; cz <= 2; cz++) {
        const m = gen.mountainCell(cx, cz);
        if (m) out.push([Math.round(m.x), Math.round(m.z), m.name, Math.round(m.H)]);
      }
    }
    return { mlist: out, h: window.__game.world.getHeight(0, 0) };
  });
  check('Different seed => different world', alt.h !== heights1[0]);
  check('Different seed => different mountains', JSON.stringify(alt.mlist) !== JSON.stringify(mlist),
    `${alt.mlist.length} mountains for seed 99`);
  const reg99 = await page.evaluate(() => window.__game.world.getMountainRegistry()
    .map((m) => [Math.round(m.x), Math.round(m.z)]));
  check('Different seed => different registry positions',
    JSON.stringify(reg99) !== JSON.stringify(reg.map((m) => [m.x, m.z])),
    `seed99 first: ${JSON.stringify(reg99[0])}`);
  const reg99names = await page.evaluate(() => {
    const names2 = window.__game.world.getMountainRegistry().map((m) => m.name);
    return { unique: new Set(names2).size === names2.length,
      shreya: names2.filter((n) => n === 'Shreya Shikhar').length };
  });
  check('Seed 99 registry also valid (unique names, one Shreya Shikhar)',
    reg99names.unique && reg99names.shreya === 1, JSON.stringify(reg99names));

  // ================= Pause / menu / touch regression =================
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.click('#btn-play');
  await sleep(300);
  await page.keyboard.down('KeyW');
  await sleep(600);
  await page.keyboard.press('Escape');
  await page.keyboard.up('KeyW');
  await sleep(200);
  s = await state();
  const pausedPos = s.pos;
  await sleep(700);
  s = await state();
  check('Pause freezes simulation', s.state === 'paused' &&
    Math.hypot(s.pos[0] - pausedPos[0], s.pos[2] - pausedPos[2]) < 0.01);
  await page.click('#btn-resume');
  await sleep(200);
  check('Resume works', (await state()).state === 'playing');
  await page.keyboard.press('Escape');
  await sleep(150);
  await page.click('#btn-restart');
  await sleep(300);
  s = await state();
  check('Restart returns to spawn', Math.hypot(s.pos[0] - spawn1.x, s.pos[2] - spawn1.z) < 3);
  await page.keyboard.press('Escape');
  await sleep(150);
  await page.click('#btn-main-menu');
  await sleep(250);
  check('Main menu works', (await state()).state === 'menu');
  await page.tap('#btn-play');
  await sleep(300);
  const gasBox = await (await page.$('#btn-gas')).boundingBox();
  const t1 = await page.touchscreen.touchStart(gasBox.x + gasBox.width / 2, gasBox.y + gasBox.height / 2);
  await sleep(1400);
  s = await state();
  await t1.end();
  check('Touch GAS accelerates', s.speed > 6, `speed=${s.speed}`);

  const rinfo = await page.evaluate(() => {
    const r = window.__game.renderer.info;
    return { calls: r.render.calls, tris: r.render.triangles };
  });
  console.log('RENDERER', JSON.stringify(rinfo), '| FPS', (await state()).fps);

  check('No runtime errors during entire session', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL', e); process.exit(2); });
