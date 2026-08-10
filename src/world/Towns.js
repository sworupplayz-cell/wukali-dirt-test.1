import { hash01 } from './noise.js';
import { makeInfo } from './TerrainGenerator.js';

/**
 * Towns (Phase 3L-2) — procedural Nepali hill towns and roadside bazaars,
 * deterministic from the world seed. Towns anchor ON an existing trail so
 * the road through town comes free (terrain-following, flattened,
 * rideable). Layout: a bazaar strip of shops/stalls flanking the road,
 * traditional houses clustered behind, civic pieces (school, clinic,
 * workshop, fuel stop, bus stops, stupa) at the edges, utility poles along
 * the roadside. Everything renders through the existing chunk scatter /
 * instancing / collider pipeline, exactly like Villages.
 */
const TCELL = 2000;   // discoverability fix: towns every ~2 km of country
const TP = 0.85;
const NAMES = ['Seti Bazaar', 'Pipal Chowk', 'Suryodaya Bazaar', 'Kali Khola Bazaar',
  'Janajyoti Tole', 'Bhimsen Chowk', 'Naya Bazaar', 'Buddha Chowk',
  'Himal Bazaar', 'Gorkha Chowk', 'Machhapuchhre Tole', 'Annapurna Chowk'];

export class Towns {
  constructor(generator, villages) {
    this.gen = generator;
    this.villages = villages;
    this.seed = generator.seed | 0;
    this._cells = new Map();
    this._info = makeInfo();
    this._t = 0;
    this._nearby = [];
    this._ckey = '';
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 37 + salt); }

  cell(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let t = this._cells.get(key);
    if (t === undefined) {
      t = this._build(cx, cz);
      this._cells.set(key, t);
    }
    return t;
  }

  _slopeOk(x, z, lim) {
    const g = this.gen;
    const s = Math.abs(g.height(x + 3, z) - g.height(x - 3, z)) +
              Math.abs(g.height(x, z + 3) - g.height(x, z - 3));
    return s < lim;
  }

  _build(cx, cz) {
    if (this._h(cx, cz, 1) > TP) return null;
    const gen = this.gen, info = this._info;
    for (let c = 0; c < 5; c++) {
      let tx = (cx + 0.15 + 0.7 * this._h(cx, cz, 2 + c * 11)) * TCELL;
      let tz = (cz + 0.15 + 0.7 * this._h(cx, cz, 3 + c * 11)) * TCELL;
      // Towns must sit ON a road: walk toward the nearest trail sample.
      let onRoad = false;
      for (let step = 0; step < 3 && !onRoad; step++) {
        gen.masksAt(tx, tz, info);
        if (info.trail > 0.55) { onRoad = true; break; }
        let bx = tx, bz = tz, bt = info.trail;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const nx = tx + Math.cos(a) * 30, nz = tz + Math.sin(a) * 30;
          gen.masksAt(nx, nz, info);
          if (info.trail > bt) { bt = info.trail; bx = nx; bz = nz; }
        }
        tx = bx; tz = bz;
        if (bt > 0.55) onRoad = true;
      }
      if (!onRoad) continue;
      gen.masksAt(tx, tz, info);
      if (info.mtn > 0.02 || info.stream > 0.12 || info.lo < 0.55) continue;
      if (!this._slopeOk(tx, tz, 0.85)) continue;
      if (this.villages) {
        const nv = this.villages.nearest(tx, tz, 1);
        if (nv && nv.d < 140) continue; // keep villages and towns apart
      }

      // Road tangent at the chowk: the bazaar runs along it.
      const dir = gen._trailDir(tx, tz);
      const rdx = dir.x, rdz = dir.z;
      const pdx = -rdz, pdz = rdx; // across the road

      const items = [];
      const add = (type, x, z, yaw, s, collR, sink) => {
        items.push({ type, x, z, yaw, s: s || 1, collR: collR || 0, sink: sink || 0.18 });
      };
      const roadYaw = Math.atan2(rdx, rdz);
      const ok = (x, z, slopeLim = 0.7, trailLim = 0.35) => {
        gen.masksAt(x, z, info);
        return info.trail < trailLim && info.stream < 0.2 && this._slopeOk(x, z, slopeLim);
      };

      // Bazaar strip: shops/stalls/teashops flanking the road (never on it).
      const shops = 10 + Math.floor(this._h(cx, cz, 4) * 6);
      let placedShops = 0;
      for (let i = 0; i < shops + 8 && placedShops < shops; i++) {
        const along = (this._h(cx, cz, 10 + i) - 0.5) * 130;
        const side = i % 2 === 0 ? 1 : -1; // both flanks always build up
        const off = side * (8.5 + this._h(cx, cz, 50 + i) * 2.5);
        const x = tx + rdx * along + pdx * off;
        const z = tz + rdz * along + pdz * off;
        if (!ok(x, z, 0.6)) continue;
        const pick = this._h(cx, cz, 70 + i);
        const type = pick < 0.45 ? 'shop' : pick < 0.7 ? 'stall' : 'teashop';
        add(type, x, z, roadYaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2),
          0.95 + this._h(cx, cz, 90 + i) * 0.15, type === 'stall' ? 1.2 : 2.1, 0.2);
        placedShops++;
      }
      if (placedShops < 4) continue; // ground too rough for a bazaar

      // Town houses clustered behind the bazaar rows.
      const houses = 9 + Math.floor(this._h(cx, cz, 5) * 7);
      for (let i = 0; i < houses + 8; i++) {
        const along = (this._h(cx, cz, 110 + i) - 0.5) * 150;
        const side = this._h(cx, cz, 130 + i) < 0.5 ? 1 : -1;
        const off = side * (15 + this._h(cx, cz, 150 + i) * 34);
        const x = tx + rdx * along + pdx * off;
        const z = tz + rdz * along + pdz * off;
        if (!ok(x, z, 0.6)) continue;
        const t = this._h(cx, cz, 170 + i) < 0.5 ? 'townhouseA' : 'townhouseB';
        add(t, x, z, roadYaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2) +
          (this._h(cx, cz, 190 + i) - 0.5) * 0.5, 0.9 + this._h(cx, cz, 210 + i) * 0.2, 2.6, 0.22);
      }

      // Civic pieces at the edges (each validated; skipped if unbuildable).
      const civic = (type, along, off, collR, slopeLim = 0.55) => {
        const x = tx + rdx * along + pdx * off;
        const z = tz + rdz * along + pdz * off;
        if (!ok(x, z, slopeLim)) return;
        add(type, x, z, roadYaw + (off > 0 ? -Math.PI / 2 : Math.PI / 2), 1, collR, 0.22);
      };
      civic('school', 75 + this._h(cx, cz, 6) * 30, this._h(cx, cz, 7) < 0.5 ? 22 : -22, 3.8);
      civic('clinic', -(70 + this._h(cx, cz, 8) * 30), this._h(cx, cz, 9) < 0.5 ? 18 : -18, 2.4);
      civic('workshop', (this._h(cx, cz, 15) - 0.5) * 100, this._h(cx, cz, 16) < 0.5 ? 14 : -14, 2.5);
      civic('fuel', 55 + this._h(cx, cz, 17) * 20, this._h(cx, cz, 18) < 0.5 ? 10.5 : -10.5, 1.6);
      civic('busstop', 30, 7.5, 0, 0.7);
      civic('busstop', -35, -7.5, 0, 0.7);
      if (this._h(cx, cz, 19) > 0.3) civic('stupa', (this._h(cx, cz, 20) - 0.5) * 60, this._h(cx, cz, 21) < 0.5 ? 13 : -13, 1.1);
      civic('flagpole', (this._h(cx, cz, 22) - 0.5) * 40, this._h(cx, cz, 23) < 0.5 ? 12 : -12, 0.3, 0.7);

      // Utility poles along the roadside.
      for (let i = -3; i <= 3; i++) {
        const x = tx + rdx * i * 20 + pdx * 6.5;
        const z = tz + rdz * i * 20 + pdz * 6.5;
        if (!ok(x, z, 0.9, 0.5)) continue;
        add('pole', x, z, roadYaw, 1, 0.25, 0.25);
      }

      const name = NAMES[Math.floor(this._h(cx, cz, 24) * NAMES.length)];
      return { id: `T${cx},${cz}`, name, x: tx, z: tz, r: 62, items };
    }
    return null;
  }

  /** Nearest town (spawn/debug). */
  nearest(x, z, cells = 2) {
    const c0x = Math.floor(x / TCELL), c0z = Math.floor(z / TCELL);
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

  /** Towns whose footprint may touch a chunk (used by the scatter). */
  forChunk(ox, oz, size) {
    const out = [];
    const m = 110;
    const c0x = Math.floor((ox - m) / TCELL), c1x = Math.floor((ox + size + m) / TCELL);
    const c0z = Math.floor((oz - m) / TCELL), c1z = Math.floor((oz + size + m) / TCELL);
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

  /** Discovery scan (2 Hz): fires once when a town comes into view. */
  update(px, pz, dt) {
    this._t += dt;
    if (this._t < 0.5) return null;
    this._t = 0;
    const ck = `${Math.floor(px / 400)},${Math.floor(pz / 400)}`;
    if (ck !== this._ckey) {
      this._ckey = ck;
      this._nearby.length = 0;
      const c0x = Math.floor(px / TCELL), c0z = Math.floor(pz / TCELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const t = this.cell(c0x + dx, c0z + dz);
          if (t) this._nearby.push(t);
        }
      }
    }
    for (const t of this._nearby) {
      if (t.found) continue;
      if (Math.hypot(px - t.x, pz - t.z) < t.r + 60) {
        t.found = true;
        return t;
      }
    }
    return null;
  }
}
