import { hash01 } from './noise.js';
import { makeInfo } from './TerrainGenerator.js';

/**
 * Cities (Phase 3L-3) — lightweight fictional Nepali city areas,
 * deterministic from the world seed. Cities anchor ON an existing trail
 * (the main road through the city is the real, rideable, terrain-following
 * road) and lay out as gradient rings: dense multi-storey core with
 * prop-surface SIDE STREETS at right angles to the main road, a commercial
 * ring of shops/markets/services, then house outskirts that fade into the
 * countryside. The whole city renders through the existing chunk scatter /
 * instancing / collider pipeline; side streets are collider-free strips
 * pitched to the terrain (rideable because the ground under them is).
 *
 * City TYPE comes from the terrain itself:
 *   'terai'    flat low plain            (densest grid, most side streets)
 *   'lakeside' low wet valley floor      (Pokhara-flavoured, stalls & water)
 *   'midhill'  rolling hill shelf        (looser, terraced feel)
 *   'valley'   everything else           (Kathmandu-flavoured dense core)
 *
 * Population prep: side streets have edge margins (sidewalks), the main
 * road is lane-width, parking pads exist — a future NPC/traffic system can
 * consume these without relayout.
 */
const CCELL = 3600;   // a city within riding range of anywhere
export { CCELL };
const CP = 0.95;
const NAMES = ['Sajha Nagar', 'Seti City', 'Suryodaya Nagar', 'Phewa Valley',
  'Janajyoti City', 'Machhindra Nagar', 'Buddha Nagar', 'Himalaya Nagar',
  'Gandaki Nagar', 'Koshi Nagar'];

export class Cities {
  constructor(generator, villages, towns) {
    this.gen = generator;
    this.villages = villages;
    this.towns = towns;
    this.seed = generator.seed | 0;
    this._cells = new Map();
    this._info = makeInfo();
    this._t = 0;
    this._nearby = [];
    this._ckey = '';
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 43 + salt); }

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

  _build(ccx, ccz) {
    if (this._h(ccx, ccz, 1) > CP) return null;
    const gen = this.gen, info = this._info;
    for (let c = 0; c < 6; c++) {
      let x0 = (ccx + 0.12 + 0.76 * this._h(ccx, ccz, 2 + c * 13)) * CCELL;
      let z0 = (ccz + 0.12 + 0.76 * this._h(ccx, ccz, 3 + c * 13)) * CCELL;
      // Walk onto the nearest road (cities grow on highways).
      let onRoad = false;
      for (let step = 0; step < 4 && !onRoad; step++) {
        gen.masksAt(x0, z0, info);
        if (info.trail > 0.55) { onRoad = true; break; }
        let bx = x0, bz = z0, bt = info.trail;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const nx = x0 + Math.cos(a) * 40, nz = z0 + Math.sin(a) * 40;
          gen.masksAt(nx, nz, info);
          if (info.trail > bt) { bt = info.trail; bx = nx; bz = nz; }
        }
        x0 = bx; z0 = bz;
        if (bt > 0.55) onRoad = true;
      }
      if (!onRoad) continue;
      gen.masksAt(x0, z0, info);
      if (info.mtn > 0.02 || info.stream > 0.12 || info.lo < 0.55) continue;
      if (this._slope(x0, z0) > 0.8) continue;
      // Cities need broadly gentle ground: probe a wide ring.
      let gentle = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (this._slope(x0 + Math.cos(a) * 70, z0 + Math.sin(a) * 70) < 0.9) gentle++;
      }
      if (gentle < 6) continue;
      if (this.towns) {
        const nt = this.towns.nearest(x0, z0, 1);
        if (nt && nt.d < 400) continue;
      }
      if (this.villages) {
        const nv = this.villages.nearest(x0, z0, 1);
        if (nv && nv.d < 220) continue;
      }

      // Type from terrain character.
      const h0 = gen.height(x0, z0);
      gen.masksAt(x0, z0, info);
      const type = h0 < 2 && info.wFa > 0.35 ? 'terai'
        : h0 < 3.5 && info.stream > 0.04 ? 'lakeside'
        : info.wH > 0.4 && h0 > 5 ? 'midhill' : 'valley';

      const dir = gen._trailDir(x0, z0);
      const rdx = dir.x, rdz = dir.z, pdx = -rdz, pdz = rdx;
      const roadYaw = Math.atan2(rdx, rdz);
      const items = [];
      const add = (typ, x, z, yaw, s, collR, sink, rx) => {
        items.push({ type: typ, x, z, yaw, s: s || 1, collR: collR || 0, sink: sink || 0.2, rx });
      };
      const ok = (x, z, slopeLim = 0.6, trailLim = 0.35) => {
        gen.masksAt(x, z, info);
        return info.trail < trailLim && info.stream < 0.2 && this._slope(x, z) < slopeLim;
      };
      const dense = type === 'valley' || type === 'terai';

      // ---- CORE: multi-storey blocks flanking the main road ---------------
      let core = 0;
      for (let i = 0; i < 20; i++) {
        const along = (this._h(ccx, ccz, 10 + i) - 0.5) * 130;
        const side = i % 2 === 0 ? 1 : -1;
        const off = side * (10.5 + this._h(ccx, ccz, 30 + i) * 4);
        const x = x0 + rdx * along + pdx * off;
        const z = z0 + rdz * along + pdz * off;
        if (!ok(x, z, 0.5)) continue;
        add(this._h(ccx, ccz, 50 + i) < 0.5 ? 'cityA' : 'cityB', x, z,
          roadYaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 0.92 + this._h(ccx, ccz, 70 + i) * 0.16, 2.9, 0.3);
        core++;
      }
      if (core < 6) continue; // ground can't carry a city core

      // ---- SIDE STREETS: prop-surface roads at right angles ---------------
      const streets = dense ? 3 : 2;
      for (let sI = 0; sI < streets; sI++) {
        const along = (sI - (streets - 1) / 2) * 55 + (this._h(ccx, ccz, 90 + sI) - 0.5) * 14;
        for (let side = -1; side <= 1; side += 2) {
          for (let seg = 1; seg <= 6; seg++) {
            const off = side * (7 + seg * 8.2);
            const x = x0 + rdx * along + pdx * off;
            const z = z0 + rdz * along + pdz * off;
            if (!ok(x, z, 0.55, 0.5)) break; // street ends at rough ground
            // Pitch the strip to the terrain along the street direction.
            const hA = gen.height(x - pdx * 4, z - pdz * 4);
            const hB = gen.height(x + pdx * 4, z + pdz * 4);
            add('roadseg', x, z, roadYaw, 1, 0, 0.02, Math.atan2(hA - hB, 8));
            // Buildings lining the street (staggered, validated).
            if (seg >= 2 && this._h(ccx, ccz, 200 + sI * 40 + seg * 3 + (side + 1)) < (dense ? 0.75 : 0.5)) {
              const bx = x + rdx * 7.5, bz = z + rdz * 7.5;
              if (ok(bx, bz, 0.5)) {
                const pick = this._h(ccx, ccz, 300 + sI * 40 + seg * 3 + (side + 1));
                const typ = pick < 0.3 ? 'shop' : pick < 0.45 ? 'teashop'
                  : pick < 0.6 ? 'townhouseA' : pick < 0.75 ? 'townhouseB'
                  : pick < 0.85 ? 'workshop' : dense ? 'cityA' : 'townhouseA';
                add(typ, bx, bz, roadYaw + Math.PI, 0.95, 2.4, 0.22);
              }
            }
          }
        }
        // Intersection sign where the side street meets the main road.
        const sx = x0 + rdx * along + pdx * 6, sz2 = z0 + rdz * along + pdz * 6;
        if (ok(sx, sz2, 0.7, 0.55)) add('roadsign', sx, sz2, roadYaw, 1, 0.2, 0.1);
      }

      // ---- COMMERCIAL RING: bazaar life along the main road ---------------
      for (let i = 0; i < 14; i++) {
        const along = (70 + this._h(ccx, ccz, 110 + i) * 80) * (i % 2 === 0 ? 1 : -1);
        const side = this._h(ccx, ccz, 130 + i) < 0.5 ? 1 : -1;
        const off = side * (8.5 + this._h(ccx, ccz, 150 + i) * 3);
        const x = x0 + rdx * along + pdx * off;
        const z = z0 + rdz * along + pdz * off;
        if (!ok(x, z, 0.55)) continue;
        const pick = this._h(ccx, ccz, 170 + i);
        const typ = pick < 0.35 ? 'shop' : pick < 0.55 ? 'stall' : pick < 0.7 ? 'teashop'
          : pick < 0.8 ? 'workshop' : pick < 0.9 ? 'townhouseA' : 'townhouseB';
        add(typ, x, z, roadYaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, typ === 'stall' ? 1.2 : 2.2, 0.2);
      }

      // ---- SERVICES + community -------------------------------------------
      const civic = (typ, along, off, collR) => {
        const x = x0 + rdx * along + pdx * off;
        const z = z0 + rdz * along + pdz * off;
        if (!ok(x, z, 0.5)) return false;
        add(typ, x, z, roadYaw + (off > 0 ? -Math.PI / 2 : Math.PI / 2), 1, collR, 0.24);
        return true;
      };
      civic('school', 120, 26, 3.8);
      civic('clinic', -110, 22, 2.4);   // health post
      civic('clinic', -118, 30, 2.4);   // second wing = small hospital
      civic('fuel', 85, -10.5, 1.6);
      civic('busstop', 25, 7.5, 0);
      civic('busstop', -25, -7.5, 0);
      civic('parklot', 45, 16, 0);      // bus park / parking area
      civic('parklot', -60, -18, 0);
      // Park: a small green with trees and a wall.
      for (let i = 0; i < 4; i++) {
        const x = x0 + rdx * (30 + i * 7) + pdx * -30;
        const z = z0 + rdz * (30 + i * 7) + pdz * -30;
        if (ok(x, z, 0.6)) add(i === 3 ? 'wall' : 'tree', x, z, this._h(ccx, ccz, 400 + i) * 6.28, 1, i === 3 ? 0.9 : 0.5, 0.15);
      }

      // ---- LANDMARKS --------------------------------------------------------
      const lm = this._h(ccx, ccz, 6);
      let landmark = 'pagoda';
      if (type === 'terai' || lm < 0.35) landmark = 'stadium';
      else if (type === 'lakeside' && lm < 0.7) landmark = 'market';
      if (landmark === 'pagoda') {
        civic('pagoda', -45, 24, 3.4) || civic('pagoda', 50, -24, 3.4);
      } else if (landmark === 'stadium') {
        // Oval of stand segments on the flattest edge ground.
        const sx = x0 + rdx * 150, sz2 = z0 + rdz * 150 + 0;
        let placed = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const x = sx + Math.cos(a) * 26, z = sz2 + Math.sin(a) * 22;
          if (!ok(x, z, 0.5, 0.5)) continue;
          add('stand', x, z, Math.atan2(sx - x, sz2 - z) + Math.PI, 1, 2.2, 0.25);
          placed++;
        }
        if (placed >= 4) { civic('flagpole', 150, 30, 0.3); }
        else civic('pagoda', -45, 24, 3.4); // ground refused a stadium
      } else {
        // Central market: dense stall cluster.
        for (let i = 0; i < 8; i++) {
          const x = x0 + rdx * (-20 + (i % 4) * 6) + pdx * (14 + Math.floor(i / 4) * 5);
          const z = z0 + rdz * (-20 + (i % 4) * 6) + pdz * (14 + Math.floor(i / 4) * 5);
          if (ok(x, z, 0.55)) add('stall', x, z, roadYaw, 1, 1.1, 0.15);
        }
      }
      if (this._h(ccx, ccz, 7) > 0.4) civic('stupa', 15, -12, 1.1);

      // Utility poles + signs along the main road through the city.
      for (let i = -5; i <= 5; i++) {
        const x = x0 + rdx * i * 22 + pdx * 6.5;
        const z = z0 + rdz * i * 22 + pdz * 6.5;
        if (ok(x, z, 0.9, 0.5)) add('pole', x, z, roadYaw, 1, 0.25, 0.25);
      }

      const name = NAMES[Math.floor(this._h(ccx, ccz, 8) * NAMES.length)];
      return { id: `Y${ccx},${ccz}`, name, x: x0, z: z0, r: 165, type, landmark, items };
    }
    return null;
  }

  nearest(x, z, cells = 1) {
    const c0x = Math.floor(x / CCELL), c0z = Math.floor(z / CCELL);
    let best = null, bd = 1e9;
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dz = -cells; dz <= cells; dz++) {
        const t = this.cell(c0x + dx, c0z + dz);
        if (!t) continue;
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < bd) { bd = d; best = t; }
      }
    }
    return best && { v: best, d: bd };
  }

  forChunk(ox, oz, size) {
    const out = [];
    const m = 200;
    const c0x = Math.floor((ox - m) / CCELL), c1x = Math.floor((ox + size + m) / CCELL);
    const c0z = Math.floor((oz - m) / CCELL), c1z = Math.floor((oz + size + m) / CCELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const t = this.cell(cx, cz);
        if (t && t.x > ox - m && t.x < ox + size + m && t.z > oz - m && t.z < oz + size + m) {
          out.push(t);
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
          const t = this.cell(c0x + dx, c0z + dz);
          if (t) this._nearby.push(t);
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
