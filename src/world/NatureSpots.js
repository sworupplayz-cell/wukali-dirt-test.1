import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeInfo } from './TerrainGenerator.js';
import { hash01, sstep } from './noise.js';

/**
 * NatureSpots (Phase 3K-2) — procedural lakes, waterfalls and scenic
 * viewpoints, deterministic from the world seed and chunk-streaming aware.
 *
 * NOTHING here touches the terrain: lakes are water discs placed only
 * where a deterministic enclosure test finds a genuine terrain basin (the
 * shoreline is the natural terrain/water intersection, hidden by the
 * depth test); waterfalls attach only where an existing stream crosses a
 * real >=3.2 m drop; viewpoints need measured prominence. Candidates are
 * cached per grid cell (cellFeature pattern), rendered through small mesh
 * pools (assigned, never rebuilt), no colliders, no per-frame allocations.
 */
const LAKE_CELL = 560, WF_CELL = 880, VP_CELL = 1150;
const LAKE_P = 0.60, WF_P = 0.70, VP_P = 0.45;
const SHOW_R = 430;          // pools cover spots within this range
const SCAN_DT = 0.5;         // manager tick (s)

const LAKE_NAMES = ['Neelam Taal', 'Seti Pokhari', 'Chandra Taal', 'Hariyo Pokhari',
  'Suna Taal', 'Badal Pokhari', 'Kalika Taal', 'Maya Pokhari'];
const WF_NAMES = ['Dudh Jharana', 'Seti Jharana', 'Chhango Jharana', 'Himsara Jharana',
  'Rani Jharana', 'Bagh Jharana'];
const VP_NAMES = ['Drishya Danda', 'Suryodaya Point', 'Himal Jharoka', 'Batase Danda',
  'Chautari Drishya', 'Tara Danda', 'Shanti Chautari', 'Sagarmatha Jharoka'];

export class NatureSpots {
  constructor(scene, generator, seed) {
    this.gen = generator;
    this.seed = seed | 0;
    this.onDiscover = null;      // (rec) — Game routes to achievements + UI
    this._info = makeInfo();
    this._cells = { lake: new Map(), wf: new Map(), vp: new Map() };
    this._nearby = [];           // POIs within scan radius (refreshed on cell move)
    this._t = 0;
    this._ckey = '';
    this._buildPools(scene);
  }

  // ---- deterministic candidates (cached per cell) ---------------------------

  _cellRec(kind, cell, cx, cz, builder) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    const cache = this._cells[kind];
    let r = cache.get(key);
    if (r === undefined) {
      r = builder(cx, cz);
      cache.set(key, r);
    }
    return r;
  }

  _h(a, b, salt) { return hash01(a, b, this.seed * 17 + salt); }

  lakeCell(cx, cz) {
    return this._cellRec('lake', LAKE_CELL, cx, cz, () => {
      if (this._h(cx, cz, 101) > LAKE_P) return null;
      const gen = this.gen, info = this._info;
      // Up to three jittered candidates per cell; first real basin wins.
      for (let c = 0; c < 3; c++) {
        const bx = (cx + 0.2 + 0.6 * this._h(cx, cz, 102 + c * 7)) * LAKE_CELL;
        const bz = (cz + 0.2 + 0.6 * this._h(cx, cz, 103 + c * 7)) * LAKE_CELL;
        gen.masksAt(bx, bz, info);
        if (info.lo < 0.6 || info.mtn > 0.02 || info.trail > 0.25) continue;
        // Local basin floor near the candidate.
        let mx = bx, mz = bz, mh = gen.height(bx, bz);
        for (let r = 6; r <= 30; r += 6) {
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
            const h = gen.height(x, z);
            if (h < mh) { mh = h; mx = x; mz = z; }
          }
        }
        // Adaptive water level: put the surface below the LOWEST point of
        // the containing ring — enclosure is guaranteed by construction and
        // the shoreline is wherever terrain rises through the water plane.
        const lakeR = 18 + Math.round(this._h(cx, cz, 105 + c) * 22); // 18..40 m
        let ringMin = Infinity;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const h = gen.height(mx + Math.cos(a) * lakeR, mz + Math.sin(a) * lakeR);
          if (h < ringMin) ringMin = h;
        }
        const level = ringMin - 0.3;
        if (level - mh < 0.5) continue; // too shallow: not a real basin
        gen.masksAt(mx, mz, info);
        if (info.trail > 0.25 || info.mtn > 0.02) continue;
        const name = LAKE_NAMES[Math.floor(this._h(cx, cz, 104) * LAKE_NAMES.length)];
        return { type: 'lake', id: `L${cx},${cz}`, name, x: mx, z: mz, y: level,
          r: lakeR, trigR: lakeR + 12 };
      }
      return null;
    });
  }

  wfCell(cx, cz) {
    return this._cellRec('wf', WF_CELL, cx, cz, () => {
      if (this._h(cx, cz, 201) > WF_P) return null;
      const gen = this.gen, info = this._info;
      // Fine scan (streams are narrow): best stream-on-a-drop point wins.
      let best = null;
      for (let i = 1; i < 20; i++) {
        for (let j = 1; j < 20; j++) {
          const x = (cx + i / 20) * WF_CELL, z = (cz + j / 20) * WF_CELL;
          gen.masksAt(x, z, info);
          if (info.stream < 0.5 || info.lo < 0.1 || info.mtn > 0.02 || info.trail > 0.4) continue;
          const h0 = gen.height(x, z);
          let drop = 0, dax = 0, daz = 0;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const dx = Math.cos(a), dz = Math.sin(a);
            const d = h0 - gen.height(x + dx * 20, z + dz * 20);
            if (d > drop) { drop = d; dax = dx; daz = dz; }
          }
          if (drop > 2.4 && (!best || drop > best.drop)) {
            best = { x, z, h0, drop, dax, daz };
          }
        }
      }
      if (!best) return null;
      // Cascade fit: top at the stream lip, base seated on real ground 12 m
      // downslope; the strip tilts to hug the face (never floats).
      const gen2 = this.gen;
      const bxp = best.x + best.dax * 20, bzp = best.z + best.daz * 20;
      const h1 = gen2.height(bxp, bzp);
      const dh = best.h0 - h1;
      if (dh < 2.2) return null; // gentle grade after all: no cascade here
      const name = WF_NAMES[Math.floor(this._h(cx, cz, 202) * WF_NAMES.length)];
      return { type: 'wf', id: `W${cx},${cz}`, name,
        x: bxp, z: bzp, y: h1 - 0.15, dh, horiz: 20,
        len: Math.hypot(20, dh),
        yaw: Math.atan2(best.dax, best.daz), trigR: 30 };
    });
  }

  vpCell(cx, cz) {
    return this._cellRec('vp', VP_CELL, cx, cz, () => {
      if (this._h(cx, cz, 301) > VP_P) return null;
      const gen = this.gen, info = this._info;
      // Several jittered candidates; hill-climb each a little, keep the best.
      let best = null;
      for (let c = 0; c < 5; c++) {
        let x = (cx + 0.15 + 0.7 * this._h(cx, cz, 302 + c * 11)) * VP_CELL;
        let z = (cz + 0.15 + 0.7 * this._h(cx, cz, 303 + c * 11)) * VP_CELL;
        // Two greedy uphill steps toward the local crest.
        for (let step = 0; step < 2; step++) {
          let bx = x, bz = z, bh = gen.height(x, z);
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const nx = x + Math.cos(a) * 22, nz = z + Math.sin(a) * 22;
            const h = gen.height(nx, nz);
            if (h > bh) { bh = h; bx = nx; bz = nz; }
          }
          x = bx; z = bz;
        }
        gen.masksAt(x, z, info);
        if (info.mtn > 0.02 || info.stream > 0.1 || info.trail > 0.5) continue;
        const h0 = gen.height(x, z);
        let sum = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          sum += gen.height(x + Math.cos(a) * 60, z + Math.sin(a) * 60);
        }
        const prom = h0 - sum / 8;
        if (prom < 4.0) continue;
        const slope = Math.abs(gen.height(x + 3, z) - gen.height(x - 3, z)) +
                      Math.abs(gen.height(x, z + 3) - gen.height(x, z - 3));
        if (slope > 1.6) continue;
        if (!best || prom > best.prom) best = { x, z, h0, prom };
      }
      if (!best) return null;
      const name = VP_NAMES[Math.floor(this._h(cx, cz, 304) * VP_NAMES.length)];
      return { type: 'vp', id: `V${cx},${cz}`, name, x: best.x, z: best.z, y: best.h0, trigR: 16 };
    });
  }

  // ---- streaming / pools -----------------------------------------------------

  update(px, pz, dt) {
    this._t += dt;
    if (this._t < SCAN_DT) return null;
    this._t = 0;
    const ck = `${Math.floor(px / 280)},${Math.floor(pz / 280)}`;
    if (ck !== this._ckey) {
      this._ckey = ck;
      this._refresh(px, pz);
    }
    // Discovery check against the small nearby list.
    for (const rec of this._nearby) {
      if (rec.found) continue;
      if (Math.hypot(px - rec.x, pz - rec.z) < rec.trigR) {
        rec.found = true; // session-side gate; persistence lives in Achievements
        return rec;
      }
    }
    return null;
  }

  _refresh(px, pz) {
    this._nearby.length = 0;
    const gather = (cell, fn) => {
      const c0x = Math.floor(px / cell), c0z = Math.floor(pz / cell);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const r = fn.call(this, c0x + dx, c0z + dz);
          if (r) this._nearby.push(r);
        }
      }
    };
    gather(LAKE_CELL, this.lakeCell);
    gather(WF_CELL, this.wfCell);
    gather(VP_CELL, this.vpCell);
    this._assignPools(px, pz);
  }

  _assignPools(px, pz) {
    const near = (type) => this._nearby
      .filter((r) => r.type === type && Math.hypot(px - r.x, pz - r.z) < SHOW_R)
      .slice(0, 8);
    const place = (pool, recs, fn) => {
      for (let i = 0; i < pool.length; i++) {
        const mesh = pool[i], rec = recs[i];
        mesh.visible = !!rec;
        if (rec) fn(mesh, rec);
      }
    };
    place(this.lakePool, near('lake'), (m, r) => {
      m.position.set(r.x, r.y, r.z);
      m.scale.setScalar(r.r);
    });
    place(this.wfPool, near('wf'), (m, r) => {
      // Base sits on the ground; only the strip leans uphill so its top
      // meets the stream lip (cascade hugging the face, never floating).
      m.position.set(r.x, r.y, r.z);
      m.rotation.set(0, r.yaw, 0);
      const ribbon = m.userData.ribbon;
      ribbon.rotation.x = -Math.atan2(r.horiz, r.dh); // lean toward the lip
      ribbon.scale.y = r.len / 4;                     // strip is 4 m at scale 1
    });
    place(this.vpPool, near('vp'), (m, r) => {
      m.position.set(r.x, r.y, r.z);
      m.rotation.y = (r.x * 13.7) % 6.28;
    });
  }

  _buildPools(scene) {
    const color = (geo, r, g, b) => {
      const n = geo.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.deleteAttribute('uv');
      return geo;
    };
    // Lakes: unit discs, scaled per lake. Flat translucent water.
    const waterMat = new THREE.MeshLambertMaterial({
      color: 0x2e7ba6, transparent: true, opacity: 0.78,
    });
    const disc = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    this.lakePool = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(disc, waterMat);
      m.visible = false;
      m.renderOrder = 1;
      scene.add(m);
      this.lakePool.push(m);
    }
    // Waterfalls: white ribbon (4 m tall at scale 1) + foam pad at the base.
    const wfMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    const wfParts = [
      color(new THREE.BoxGeometry(3.4, 4, 0.5).translate(0, 2, 0), 0.88, 0.94, 0.98),
      color(new THREE.BoxGeometry(2.2, 4, 0.52).translate(0, 2.1, 0.02), 0.97, 0.99, 1.0),
    ];
    const wfGeo = mergeGeometries(wfParts.map((g) => g.toNonIndexed()));
    const foamGeo = color(new THREE.CylinderGeometry(2.6, 2.8, 0.35, 10), 0.95, 0.98, 1.0);
    this.wfPool = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const ribbon = new THREE.Mesh(wfGeo, wfMat);
      g.add(ribbon);
      const foam = new THREE.Mesh(foamGeo, wfMat);
      foam.position.y = 0.12; // flat pool at the base; never tilts/stretches
      g.add(foam);
      g.userData.ribbon = ribbon;
      g.visible = false;
      scene.add(g);
      this.wfPool.push(g);
    }
    // Viewpoints: stone cairn + prayer flagpole (reuses the game's low-poly
    // primitive style; one merged mesh each).
    const vpMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const vpParts = [
      color(new THREE.ConeGeometry(1.4, 1.3, 7).translate(0, 0.65, 0), 0.62, 0.6, 0.58),
      color(new THREE.ConeGeometry(0.8, 1.0, 6).translate(0, 1.55, 0), 0.72, 0.7, 0.66),
      color(new THREE.CylinderGeometry(0.07, 0.09, 5.2, 6).translate(0, 2.6, 0), 0.55, 0.42, 0.3),
    ];
    const flagCols = [[0.9, 0.3, 0.25], [0.95, 0.8, 0.3], [0.3, 0.65, 0.85], [0.4, 0.75, 0.4], [0.9, 0.55, 0.25]];
    for (let i = 0; i < 5; i++) {
      const [r, g, b] = flagCols[i];
      vpParts.push(color(
        new THREE.BoxGeometry(0.55, 0.4, 0.04).translate(-1.6 + i * 0.8, 4.9 - Math.abs(i - 2) * 0.18, 0),
        r, g, b));
    }
    const vpGeo = mergeGeometries(vpParts.map((g) => g.toNonIndexed()));
    this.vpPool = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(vpGeo, vpMat);
      m.visible = false;
      scene.add(m);
      this.vpPool.push(m);
    }
  }
}
