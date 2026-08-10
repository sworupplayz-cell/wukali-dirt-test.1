import { hash01 } from './noise.js';
import { makeInfo } from './TerrainGenerator.js';
import { CCELL } from './Cities.js';

/**
 * Industrial (Phase 3L-4) — lightweight procedural Nepali industrial zones
 * and large stadium landmarks, deterministic from the world seed.
 *
 * Every city grows exactly one udhyog kshetra (industrial area) on its
 * OUTSKIRTS: the zone anchor is found by walking ~270 m along the city's
 * own highway (the real, rideable trail), so the ride out of town passes
 * city core → house outskirts → factory gates → rural farmland, exactly
 * like leaving Hetauda or Butwal. The zone itself is a road-front strip:
 * a factory compound with loading bays and parked trucks, a fenced truck /
 * container yard, a fuel & silo storage depot, a construction site with a
 * tower crane, transmission pylons marching off the corridor, and short
 * perpendicular access lanes (prop-surface roadsegs, pitched to terrain,
 * rideable because the ground under them is).
 *
 * Some cities additionally get a LARGE stadium complex (rangasala) on the
 * outskirts perpendicular to the highway — a big oval of tall roofed
 * stands with bus parking, far larger than the small in-town stand ring.
 *
 * Everything renders through the existing chunk scatter / instancing /
 * collider pipeline; zone records join the settlement "clearing" list so
 * trees/crops stay out of the compounds. No NPCs, no traffic — but pads,
 * lanes and bays are laid out so a future traffic system can consume them.
 */
const NAMES = ['Seti Udhyog Kshetra', 'Gandaki Karkhana', 'Trishuli Udhyog Gram',
  'Himal Cement Udhyog', 'Annapurna Godam Kshetra', 'Koshi Karkhana Tole',
  'Laligurans Udhyog', 'Machhindra Udhyog Nagar'];
const SNAMES = ['Janata Rangasala', 'Gandaki Rangasala', 'Himalaya Rangasala',
  'Sagarmatha Rangasala', 'Phewa Rangasala', 'Annapurna Rangasala'];

export class Industrial {
  constructor(generator, cities) {
    this.gen = generator;
    this.cities = cities;
    this.seed = generator.seed | 0;
    this._cells = new Map();
    this._info = makeInfo();
    this._t = 0;
    this._nearby = [];
    this._ckey = '';
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 57 + salt); }

  cell(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let c = this._cells.get(key);
    if (c === undefined) {
      c = this._build(cx, cz);
      this._cells.set(key, c);
    }
    return c;
  }

  _slope(x, z) {
    const g = this.gen;
    return Math.abs(g.height(x + 3, z) - g.height(x - 3, z)) +
           Math.abs(g.height(x, z + 3) - g.height(x, z - 3));
  }

  /** Follow the highway out of the city, re-centering on the trail crest
   *  each step so curves are tracked. Returns the end point + heading. */
  _walkRoad(x0, z0, sign, steps) {
    const gen = this.gen, info = this._info;
    let px = x0, pz = z0, dx = 0, dz = 0;
    for (let i = 0; i < steps; i++) {
      const d = gen._trailDir(px, pz);
      let ddx = d.x * sign, ddz = d.z * sign;
      if (i > 0 && ddx * dx + ddz * dz < 0) { ddx = -ddx; ddz = -ddz; }
      dx = ddx; dz = ddz;
      px += dx * 16; pz += dz * 16;
      let bx = px, bz = pz, bt = -1;
      for (let k = -2; k <= 2; k++) {
        const nx = px - dz * k * 3, nz = pz + dx * k * 3;
        gen.masksAt(nx, nz, info);
        if (info.trail > bt) { bt = info.trail; bx = nx; bz = nz; }
      }
      px = bx; pz = bz;
    }
    gen.masksAt(px, pz, info);
    return { x: px, z: pz, dx, dz, trail: info.trail };
  }

  _zoneAnchorOk(w, city) {
    if (w.trail < 0.5) return false;
    const d = Math.hypot(w.x - city.x, w.z - city.z);
    if (d < city.r + 40 || d > 480) return false; // outskirts, not downtown / not lost
    const info = this._info;
    this.gen.masksAt(w.x, w.z, info);
    if (info.mtn > 0.02 || info.stream > 0.12) return false;
    if (this._slope(w.x, w.z) > 0.9) return false;
    let gentle = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (this._slope(w.x + Math.cos(a) * 45, w.z + Math.sin(a) * 45) < 0.9) gentle++;
    }
    return gentle >= 5;
  }

  _build(ccx, ccz) {
    const city = this.cities.cell(ccx, ccz);
    if (!city) return null;
    const gen = this.gen, info = this._info;
    const recs = [];

    // ---- INDUSTRIAL ZONE: walk the highway out of the city ----------------
    // Try both directions and three walk lengths — every city should get
    // its udhyog kshetra somewhere along the highway (discoverability).
    const sgn0 = this._h(ccx, ccz, 501) < 0.5 ? 1 : -1;
    let w = null;
    outer:
    for (const steps of [17, 12, 22]) {
      for (const sgn of [sgn0, -sgn0]) {
        const cand = this._walkRoad(city.x, city.z, sgn, steps);
        if (this._zoneAnchorOk(cand, city)) { w = cand; break outer; }
      }
    }
    if (w) {
      const x0 = w.x, z0 = w.z;
      const dir = gen._trailDir(x0, z0);
      // Keep the local tangent aligned with the walk direction.
      let rdx = dir.x, rdz = dir.z;
      if (rdx * w.dx + rdz * w.dz < 0) { rdx = -rdx; rdz = -rdz; }
      const pdx = -rdz, pdz = rdx;
      const roadYaw = Math.atan2(rdx, rdz);
      const items = [];
      const add = (typ, x, z, yaw, s, collR, sink, rx) => {
        items.push({ type: typ, x, z, yaw, s: s || 1, collR: collR || 0, sink: sink || 0.2, rx });
      };
      const ok = (x, z, slopeLim = 0.6, trailLim = 0.35) => {
        gen.masksAt(x, z, info);
        return info.trail < trailLim && info.stream < 0.2 && this._slope(x, z) < slopeLim;
      };
      const at = (along, off) => ({ x: x0 + rdx * along + pdx * off, z: z0 + rdz * along + pdz * off });
      const put = (typ, along, off, yaw, s, collR, sink) => {
        const p = at(along, off);
        if (!ok(p.x, p.z, 0.55)) return false;
        add(typ, p.x, p.z, yaw, s, collR, sink);
        return true;
      };
      const faceRoad = (off) => roadYaw + (off > 0 ? -Math.PI / 2 : Math.PI / 2);
      const putAlt = (typ, spots, s, collR, sink) => {
        for (const [along, off] of spots) {
          if (put(typ, along, off, faceRoad(off), s, collR, sink)) return true;
        }
        return false;
      };
      let sheds = 0;

      // ---- factory compound (road side A) ---------------------------------
      if (putAlt('factory', [[-44, 21], [-92, 22], [88, 24]], 1, 4.6, 0.3)) sheds++;
      if (putAlt('warehouse', [[-14, 22], [-118, 20], [112, 22]], 1, 4.6, 0.28)) sheds++;
      put('parklot', -30, 12.5, roadYaw, 1, 0, 0.12);          // loading yard
      put('truck', -25, 12, faceRoad(21) + 0.25, 1, 1.9, 0.1);
      put('truck', -35, 13.5, faceRoad(21) - 0.15, 1, 1.9, 0.1);
      for (let i = 0; i < 3; i++) {
        put('container', -6 + i * 2.4, 16 + i * 2.6, roadYaw + 0.35, 1, 2.0, 0.15);
      }
      for (let i = 0; i < 7; i++) {                            // compound fence
        put('fence', -58 + i * 8.3, 30, roadYaw, 1, 0, 0.15);
      }
      put('fence', -60, 22, roadYaw + Math.PI / 2, 1, 0, 0.15);

      // ---- truck & container yard (road side B) ---------------------------
      put('parklot', 8, -14, roadYaw + Math.PI / 2, 1.15, 0, 0.12);
      const nT = 2 + Math.floor(this._h(ccx, ccz, 510) * 3);   // 2-4 trucks
      for (let i = 0; i < nT; i++) {
        put('truck', 2 + i * 7.5, -13 - this._h(ccx, ccz, 511 + i) * 6,
          faceRoad(-1) + (this._h(ccx, ccz, 515 + i) - 0.5) * 0.5, 1, 1.9, 0.1);
      }
      for (let i = 0; i < 4; i++) {
        put('container', 30 + (i % 2) * 7, -16 - Math.floor(i / 2) * 3.4, roadYaw + Math.PI / 2, 1, 2.0, 0.15);
      }
      if (putAlt('warehouse', [[44, -23], [70, -24], [-44, -24]], 1, 4.6, 0.28)) sheds++;
      put('workshop', 60, -16, faceRoad(-16), 1, 2.4, 0.22);
      for (let i = 0; i < 6; i++) {
        put('fence', -2 + i * 8.3, -28, roadYaw, 1, 0, 0.15);
      }

      // ---- fuel & silo storage depot --------------------------------------
      put('fuel', 58, 11.5, faceRoad(11.5), 1, 1.6, 0.2);
      for (let i = 0; i < 3; i++) {
        put('silo', 68 + i * 5.5, 16 + (i % 2) * 3, 0, 1, 1.6, 0.2);
      }
      put('fence', 72, 24, roadYaw, 1, 0, 0.15);

      // ---- construction site ----------------------------------------------
      put('frame', -72, -19, faceRoad(-19), 1, 3.6, 0.25);
      put('crane', -79, -12, roadYaw + 0.8, 1, 0.7, 0.2);
      put('pile', -66, -12, this._h(ccx, ccz, 520) * 6.28, 1.1, 1.1, 0.1);
      put('pile', -62, -16, this._h(ccx, ccz, 521) * 6.28, 0.85, 0.9, 0.1);
      put('fence', -74, -27, roadYaw, 1, 0, 0.15);
      put('fence', -83, -20, roadYaw + Math.PI / 2, 1, 0, 0.15);

      // ---- power infrastructure: pylon line crossing the corridor ---------
      put('pylon', -20, 40, roadYaw + 0.5, 1, 0.6, 0.3);
      put('pylon', 42, 48, roadYaw + 0.5, 1, 0.6, 0.3);
      for (let i = -4; i <= 4; i++) {                          // roadside poles
        const p = at(i * 21, -6.6);
        if (ok(p.x, p.z, 0.9, 0.5)) add('pole', p.x, p.z, roadYaw, 1, 0.25, 0.25);
      }

      // ---- access lanes: perpendicular prop-road strips (rideable) --------
      for (const [laneAlong, laneSide] of [[-30, 1], [30, -1]]) {
        for (let seg = 1; seg <= 3; seg++) {
          const off = laneSide * (5.5 + seg * 8.2);
          const p = at(laneAlong, off);
          if (!ok(p.x, p.z, 0.55, 0.5)) break;
          const hA = gen.height(p.x - pdx * 4, p.z - pdz * 4);
          const hB = gen.height(p.x + pdx * 4, p.z + pdz * 4);
          add('roadseg', p.x, p.z, roadYaw, 1, 0, 0.02, Math.atan2(hA - hB, 8));
        }
      }

      // ---- gate dressing ---------------------------------------------------
      put('roadsign', -66, 6.5, roadYaw, 1, 0.2, 0.1);
      put('teashop', 24, 8.5, faceRoad(8.5), 1, 2.2, 0.2);     // workers' chiya pasal

      if (sheds >= 2) {
        const name = NAMES[Math.floor(this._h(ccx, ccz, 508) * NAMES.length)];
        recs.push({ id: `I${ccx},${ccz}`, name, kind: 'industry', x: x0, z: z0, r: 105, items });
      }
    }

    // ---- LARGE STADIUM (rangasala) on some city outskirts ------------------
    if (this._h(ccx, ccz, 601) < 0.45) {
      const cdir = gen._trailDir(city.x, city.z);
      const crx = cdir.x, crz = cdir.z, cpx = -crz, cpz = crx;
      let placedRec = null;
      for (let cand = 0; cand < 6 && !placedRec; cand++) {
        const along = ((cand % 3) - 1) * 110;
        const side = cand < 3 ? 1 : -1;
        const sx = city.x + crx * along + cpx * side * 100;
        const sz = city.z + crz * along + cpz * side * 100;
        gen.masksAt(sx, sz, info);
        if (info.mtn > 0.02 || info.stream > 0.12 || info.trail > 0.35) continue;
        if (this._slope(sx, sz) > 0.7) continue;
        const items = [];
        let placed = 0;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const x = sx + Math.cos(a) * 33, z = sz + Math.sin(a) * 27;
          gen.masksAt(x, z, info);
          if (info.trail > 0.5 || info.stream > 0.2 || this._slope(x, z) > 0.55) continue;
          items.push({ type: 'bigstand', x, z, yaw: Math.atan2(sx - x, sz - z) + Math.PI,
            s: 1, collR: 3.0, sink: 0.3 });
          placed++;
        }
        if (placed < 8) continue;
        const dress = (typ, ox, oz, yaw, s, collR) => {
          const x = sx + ox, z = sz + oz;
          gen.masksAt(x, z, info);
          if (info.trail > 0.5 || info.stream > 0.2 || this._slope(x, z) > 0.6) return;
          items.push({ type: typ, x, z, yaw, s: s || 1, collR: collR || 0, sink: 0.15 });
        };
        dress('parklot', 52, 8, Math.atan2(crx, crz), 1.15, 0);
        dress('parklot', 52, -8, Math.atan2(crx, crz), 1.15, 0);
        dress('flagpole', 0, 42, 0, 1, 0.3);
        dress('flagpole', 8, 42, 0, 1, 0.3);
        dress('roadsign', 48, 20, Math.atan2(crx, crz), 1, 0.2);
        const name = SNAMES[Math.floor(this._h(ccx, ccz, 602) * SNAMES.length)];
        placedRec = { id: `S${ccx},${ccz}`, name, kind: 'stadium', x: sx, z: sz, r: 58, items };
      }
      if (placedRec) recs.push(placedRec);
    }

    return recs.length ? recs : null;
  }

  nearest(x, z, cells = 1, kind = null) {
    const c0x = Math.floor(x / CCELL), c0z = Math.floor(z / CCELL);
    let best = null, bd = 1e9;
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dz = -cells; dz <= cells; dz++) {
        const recs = this.cell(c0x + dx, c0z + dz);
        if (!recs) continue;
        for (const t of recs) {
          if (kind && t.kind !== kind) continue;
          const d = Math.hypot(t.x - x, t.z - z);
          if (d < bd) { bd = d; best = t; }
        }
      }
    }
    return best && { v: best, d: bd };
  }

  forChunk(ox, oz, size) {
    const out = [];
    const m = 200;
    // Zones sit up to ~480 m from their city cell anchor; scan one extra cell.
    const c0x = Math.floor((ox - m) / CCELL) - 1, c1x = Math.floor((ox + size + m) / CCELL) + 1;
    const c0z = Math.floor((oz - m) / CCELL) - 1, c1z = Math.floor((oz + size + m) / CCELL) + 1;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const recs = this.cell(cx, cz);
        if (!recs) continue;
        for (const t of recs) {
          if (t.x > ox - m && t.x < ox + size + m && t.z > oz - m && t.z < oz + size + m) {
            out.push(t);
          }
        }
      }
    }
    return out;
  }

  update(px, pz, dt) {
    this._t += dt;
    if (this._t < 0.5) return null;
    this._t = 0;
    const ck = `${Math.floor(px / 500)},${Math.floor(pz / 500)}`;
    if (ck !== this._ckey) {
      this._ckey = ck;
      this._nearby.length = 0;
      const c0x = Math.floor(px / CCELL), c0z = Math.floor(pz / CCELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const recs = this.cell(c0x + dx, c0z + dz);
          if (recs) for (const t of recs) this._nearby.push(t);
        }
      }
    }
    for (const t of this._nearby) {
      if (t.found) continue;
      if (Math.hypot(px - t.x, pz - t.z) < t.r + 70) {
        t.found = true;
        return t;
      }
    }
    return null;
  }
}
