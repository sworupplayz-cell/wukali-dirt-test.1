import { hash01 } from './noise.js';
import { makeInfo } from './TerrainGenerator.js';

/**
 * Villages (Phase 3L-1) — procedural Nepali village clusters, deterministic
 * from the world seed. Pure placement logic: the villages RENDER through
 * the existing chunk scatter/instancing/collider pipeline (ChunkManager
 * injects each village's items into the chunks they fall in), so streaming,
 * pooling and collision all come for free.
 *
 * Village rules: gentle lowland farm/hill ground near an existing trail
 * (villages grow along roads), never on mountain domes or streams. Every
 * building is individually slope-checked; unbuildable spots are simply
 * skipped, which keeps layouts organic. Forest cells get small hamlets
 * (2-3 houses in a clearing) instead.
 */
const VCELL = 820;   // denser grid: rural life should be hard to MISS
const VP = 0.8;
const NAMES = ['Siddha Gaun', 'Suryodaya Gaun', 'Pipalbot', 'Laliguras Tole',
  'Danda Bazaar', 'Seti Khola Gaun', 'Bhalu Kharka', 'Chiya Tole',
  'Kagate Gaun', 'Milan Tole', 'Sallaghari', 'Dhunge Gaun'];

export class Villages {
  constructor(generator) {
    this.gen = generator;
    this.seed = generator.seed | 0;
    this._cells = new Map();
    this._info = makeInfo();
    this._t = 0;
    this._nearby = [];
    this._ckey = '';
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 31 + salt); }

  cell(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let v = this._cells.get(key);
    if (v === undefined) {
      v = this._build(cx, cz);
      this._cells.set(key, v);
    }
    return v;
  }

  _slopeOk(x, z, lim) {
    const g = this.gen;
    const s = Math.abs(g.height(x + 3, z) - g.height(x - 3, z)) +
              Math.abs(g.height(x, z + 3) - g.height(x, z - 3));
    return s < lim;
  }

  _build(cx, cz) {
    if (this._h(cx, cz, 1) > VP) return null;
    const gen = this.gen, info = this._info;
    for (let c = 0; c < 4; c++) {
      const vx = (cx + 0.2 + 0.6 * this._h(cx, cz, 2 + c * 9)) * VCELL;
      const vz = (cz + 0.2 + 0.6 * this._h(cx, cz, 3 + c * 9)) * VCELL;
      gen.masksAt(vx, vz, info);
      if (info.mtn > 0.02 || info.stream > 0.15 || info.lo < 0.55) continue;
      const farmish = info.wFa + info.wH;
      const hamlet = farmish < 0.5;
      if (hamlet && info.wF < 0.55) continue;    // neither farmland nor forest
      if (!this._slopeOk(vx, vz, 0.9)) continue;
      // Villages grow along roads: an existing trail must pass close by.
      let nearTrail = info.trail > 0.2;
      for (let k = 0; k < 6 && !nearTrail; k++) {
        const a = (k / 6) * Math.PI * 2;
        gen.masksAt(vx + Math.cos(a) * 34, vz + Math.sin(a) * 34, info);
        if (info.trail > 0.25) nearTrail = true;
      }
      if (!nearTrail && !hamlet) continue;       // hamlets may hide off-road

      const items = [];
      const add = (type, x, z, yaw, s, collR, sink) => {
        items.push({ type, x, z, yaw, s: s || 1, collR: collR || 0, sink: sink || 0.15 });
      };
      const houses = hamlet ? 2 + Math.floor(this._h(cx, cz, 4) * 2)
        : 5 + Math.floor(this._h(cx, cz, 4) * 5);
      let placed = 0;
      for (let i = 0; i < houses + 10 && placed < houses; i++) {
        const a = this._h(cx, cz, 10 + i) * Math.PI * 2;
        const r = 9 + this._h(cx, cz, 30 + i) * (hamlet ? 13 : 26);
        const x = vx + Math.cos(a) * r, z = vz + Math.sin(a) * r;
        gen.masksAt(x, z, info);
        if (info.trail > 0.35 || info.stream > 0.2) continue; // never block the road
        if (!this._slopeOk(x, z, 0.75)) continue;
        add('house', x, z, Math.atan2(vx - x, vz - z) + (this._h(cx, cz, 50 + i) - 0.5) * 0.7,
          0.9 + this._h(cx, cz, 70 + i) * 0.3, 2.4, 0.22);
        placed++;
      }
      if (placed < 2) continue; // ground too rough for a settlement

      // Center pieces: stupa or flagpole; hamlets keep it modest.
      if (!hamlet && this._h(cx, cz, 5) > 0.35 && this._slopeOk(vx, vz, 0.5)) {
        add('stupa', vx, vz, this._h(cx, cz, 6) * 6.28, 1, 1.1, 0.15);
      } else if (this._slopeOk(vx, vz, 0.6)) {
        add('flagpole', vx, vz, this._h(cx, cz, 6) * 6.28, 1, 0.3, 0.1);
      }
      const extras = hamlet ? 2 : 4;
      for (let i = 0; i < extras; i++) {
        const a = this._h(cx, cz, 90 + i) * Math.PI * 2;
        const r = 12 + this._h(cx, cz, 110 + i) * 22;
        const x = vx + Math.cos(a) * r, z = vz + Math.sin(a) * r;
        gen.masksAt(x, z, info);
        if (info.trail > 0.4 || info.stream > 0.25 || !this._slopeOk(x, z, 0.6)) continue;
        if (this._h(cx, cz, 130 + i) > 0.45) {
          add('haystack', x, z, this._h(cx, cz, 150 + i) * 6.28, 0.85 + this._h(cx, cz, 151 + i) * 0.4, 0, 0.12);
        } else {
          add('wall', x, z, this._h(cx, cz, 150 + i) * 6.28, 1 + this._h(cx, cz, 152 + i) * 0.3, 0.9, 0.18);
        }
      }
      // Corn field beside the village: two visible rows of clumps make
      // every settlement read as farmland (validated per clump).
      if (!hamlet) {
        const fa = this._h(cx, cz, 8) * Math.PI * 2;
        const fx = vx + Math.cos(fa) * 34, fz = vz + Math.sin(fa) * 34;
        const ra = fa + Math.PI / 2;
        for (let row = 0; row < 2; row++) {
          for (let i = 0; i < 5; i++) {
            const x = fx + Math.cos(ra) * (i - 2) * 2.0 + Math.cos(fa) * row * 2.2;
            const z = fz + Math.sin(ra) * (i - 2) * 2.0 + Math.sin(fa) * row * 2.2;
            gen.masksAt(x, z, info);
            if (info.trail > 0.35 || info.stream > 0.2 || !this._slopeOk(x, z, 0.8)) continue;
            add('corn', x, z, this._h(cx, cz, 160 + row * 8 + i) * 6.28,
              0.9 + this._h(cx, cz, 180 + row * 8 + i) * 0.3, 0, 0.05);
          }
        }
      }
      const name = NAMES[Math.floor(this._h(cx, cz, 7) * NAMES.length)];
      return { id: `G${cx},${cz}`, name, x: vx, z: vz,
        r: hamlet ? 26 : 42, hamlet, items };
    }
    return null;
  }

  /** Nearest village to a point (spawn selection / debug). */
  nearest(x, z, cells = 3) {
    const c0x = Math.floor(x / VCELL), c0z = Math.floor(z / VCELL);
    let best = null, bd = 1e9;
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dz = -cells; dz <= cells; dz++) {
        const v = this.cell(c0x + dx, c0z + dz);
        if (!v) continue;
        const d = Math.hypot(v.x - x, v.z - z);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best && { v: best, d: bd };
  }

  /** Villages whose footprint may touch a chunk (used by the scatter). */
  forChunk(ox, oz, size) {
    const out = [];
    const c0x = Math.floor((ox - 80) / VCELL), c1x = Math.floor((ox + size + 80) / VCELL);
    const c0z = Math.floor((oz - 80) / VCELL), c1z = Math.floor((oz + size + 80) / VCELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const v = this.cell(cx, cz);
        if (v && v.x > ox - 70 && v.x < ox + size + 70 && v.z > oz - 70 && v.z < oz + size + 70) {
          out.push(v);
        }
      }
    }
    return out;
  }

  /** Discovery scan (2 Hz): returns a village record when first entered. */
  update(px, pz, dt) {
    this._t += dt;
    if (this._t < 0.5) return null;
    this._t = 0;
    const ck = `${Math.floor(px / 300)},${Math.floor(pz / 300)}`;
    if (ck !== this._ckey) {
      this._ckey = ck;
      this._nearby.length = 0;
      const c0x = Math.floor(px / VCELL), c0z = Math.floor(pz / VCELL);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const v = this.cell(c0x + dx, c0z + dz);
          if (v) this._nearby.push(v);
        }
      }
    }
    for (const v of this._nearby) {
      if (v.found) continue;
      // Sight-distance trigger: the name greets the rider as the houses
      // emerge from the haze, not only after threading between them.
      if (Math.hypot(px - v.x, pz - v.z) < v.r + 60) {
        v.found = true;
        return v;
      }
    }
    return null;
  }
}
