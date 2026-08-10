import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, vnoise } from './noise.js';
import { makeInfo } from './TerrainGenerator.js';

/**
 * Population (Phase 3N) — lightweight NPCs and traffic.
 *
 * A strict, pooled ambient-life layer:
 *   - Pedestrians in villages/towns/cities (walkers on bazaar sidewalks,
 *     idlers in front of shops and stalls), workers in industrial zones
 *     walking dock <-> yard with a loading idle, fans at stadium gates.
 *   - Traffic: cars, motorcycles, buses and trucks following the REAL
 *     road (the trail heightfield channel) through each settlement on a
 *     left-hand lane offset, wrapping at the corridor ends (beyond fog).
 *     Trucks pause near industrial loading pads. Parked vehicles sit on
 *     parking pads and bus stops.
 *
 * Hard constraints honoured:
 *   - No pathfinding: NPC paths are 2-point validated segments generated
 *     deterministically from the settlement layout; vehicles follow the
 *     analytic road tangent exactly like the road itself is generated.
 *   - No physics, no ragdolls, NO COLLIDERS: population can never block
 *     the bike or make a road unrideable. Pedestrians scatter out of the
 *     bike's way instead.
 *   - No per-frame allocation: fixed entity pools, scratch vectors,
 *     in-place binding lists. One InstancedMesh per variant/type.
 *   - Chunk-streaming friendly: settlements bind/release their slots as
 *     the player crosses activation radii chosen beyond the fog wall, so
 *     entities appear and disappear invisibly.
 *   - LOD: pedestrians beyond 90 m tick at ~5 Hz with no walk bobbing.
 */

// ---- Budgets (conservative; measured before raising) -----------------------
const CAP = { manA: 16, manB: 16, woman: 16, worker: 14, car: 10, moto: 10, bus: 4, vtruck: 8 };
const MAX_NPC = 40;
const MAX_VEH = 14;
const NPC_LOD_D = 90;      // beyond this: 5 Hz updates, no bob
const ACT = { village: 200, town: 240, city: 260, industry: 260, stadium: 210 };
const RELEASE_PAD = 50;    // hysteresis so borders don't thrash

// ---- Geometry (merged, vertex-colored, one draw call per variant) ----------
function colorize(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute('uv');
  return geo;
}
function merge(parts) {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat);
  parts.forEach((p) => p.dispose());
  flat.forEach((p) => p.dispose());
  return g;
}
const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/** Low-poly villager, ~1.7 m. Variants pick Nepali everyday outfits. */
function person(v) {
  const P = [];
  P.push(colorize(B(0.15, 0.72, 0.17), ...v.pants).translate(-0.09, 0.36, 0));
  P.push(colorize(B(0.15, 0.72, 0.17), ...v.pants).translate(0.09, 0.36, 0));
  const tH = v.long ? 0.8 : 0.6;
  P.push(colorize(B(0.4, tH, 0.22), ...v.shirt).translate(0, v.long ? 0.97 : 1.02, 0));
  P.push(colorize(B(0.09, 0.5, 0.11), ...v.shirt).translate(-0.25, 1.02, 0));
  P.push(colorize(B(0.09, 0.5, 0.11), ...v.shirt).translate(0.25, 1.02, 0));
  P.push(colorize(B(0.2, 0.22, 0.19), ...v.skin).translate(0, 1.45, 0));
  if (v.vest) P.push(colorize(B(0.44, 0.42, 0.25), ...v.vest).translate(0, 1.1, 0));
  if (v.topi) P.push(colorize(B(0.19, 0.09, 0.17), ...v.topi).translate(0, 1.6, 0));
  if (v.helmet) P.push(colorize(B(0.23, 0.12, 0.21), ...v.helmet).translate(0, 1.61, 0));
  if (v.scarf) P.push(colorize(B(0.24, 0.14, 0.21), ...v.scarf).translate(0, 1.57, 0));
  return merge(P);
}
const NPC_BUILD = {
  // Daura-suruwal tones + dhaka topi.
  manA: () => person({ pants: [0.82, 0.8, 0.72], shirt: [0.85, 0.83, 0.76], skin: [0.72, 0.53, 0.38],
    topi: [0.45, 0.3, 0.5], vest: [0.25, 0.25, 0.3] }),
  // Shirt + dark pants, bhadgaunle topi.
  manB: () => person({ pants: [0.25, 0.26, 0.3], shirt: [0.55, 0.2, 0.18], skin: [0.66, 0.47, 0.33],
    topi: [0.12, 0.12, 0.14] }),
  // Red/teal kurta with shawl and headscarf.
  woman: () => person({ pants: [0.16, 0.4, 0.38], shirt: [0.78, 0.22, 0.25], skin: [0.7, 0.5, 0.36],
    long: true, scarf: [0.85, 0.65, 0.2] }),
  // High-vis vest + yellow hard hat.
  worker: () => person({ pants: [0.3, 0.32, 0.38], shirt: [0.45, 0.45, 0.5], skin: [0.68, 0.49, 0.35],
    vest: [0.95, 0.5, 0.1], helmet: [0.92, 0.8, 0.15] }),
};

/** Vehicles face +z. Wheels are simple stubs; no textures. */
function car() {
  const P = [
    colorize(B(1.5, 0.5, 3.4), 0.85, 0.85, 0.86).translate(0, 0.55, 0),
    colorize(B(1.36, 0.45, 1.7), 0.75, 0.76, 0.78).translate(0, 1.02, -0.25),
    colorize(B(1.26, 0.34, 0.08), 0.15, 0.2, 0.26).translate(0, 1.0, 0.62),
    colorize(B(1.52, 0.12, 3.42), 0.2, 0.2, 0.22).translate(0, 0.28, 0),
  ];
  for (const wx of [-0.72, 0.72]) for (const wz of [-1.1, 1.1]) {
    P.push(colorize(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 7), 0.08, 0.08, 0.09)
      .rotateZ(Math.PI / 2).translate(wx, 0.3, wz));
  }
  return merge(P);
}
function moto() {
  const P = [
    colorize(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 7), 0.08, 0.08, 0.09).rotateZ(Math.PI / 2).translate(0, 0.3, 0.62),
    colorize(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 7), 0.08, 0.08, 0.09).rotateZ(Math.PI / 2).translate(0, 0.3, -0.62),
    colorize(B(0.16, 0.3, 1.35), 0.7, 0.15, 0.12).translate(0, 0.62, 0),
    colorize(B(0.52, 0.06, 0.06), 0.2, 0.2, 0.22).translate(0, 1.0, 0.5),
    // Rider.
    colorize(B(0.16, 0.4, 0.42), 0.25, 0.26, 0.3).translate(0, 0.82, -0.05),
    colorize(B(0.36, 0.5, 0.24), 0.2, 0.45, 0.3).translate(0, 1.22, -0.18),
    colorize(B(0.19, 0.2, 0.18), 0.7, 0.5, 0.36).translate(0, 1.56, -0.14),
    colorize(B(0.22, 0.12, 0.2), 0.85, 0.2, 0.15).translate(0, 1.7, -0.14),
  ];
  return merge(P);
}
function bus() {
  const P = [
    colorize(B(2.05, 1.8, 6.6), 0.25, 0.45, 0.75).translate(0, 1.4, 0),
    colorize(B(2.08, 0.34, 6.62), 0.85, 0.25, 0.2).translate(0, 0.85, 0),
    colorize(B(2.09, 0.5, 5.2), 0.16, 0.2, 0.26).translate(0, 1.85, -0.4),
    colorize(B(1.9, 0.38, 0.1), 0.16, 0.2, 0.26).translate(0, 1.7, 3.31),
    colorize(B(1.7, 0.3, 3.2), 0.72, 0.62, 0.4).translate(0, 2.45, -0.5),
  ];
  for (const wz of [-2.1, 2.1]) for (const wx of [-0.85, 0.85]) {
    P.push(colorize(new THREE.CylinderGeometry(0.42, 0.42, 0.26, 7), 0.08, 0.08, 0.09)
      .rotateZ(Math.PI / 2).translate(wx, 0.42, wz));
  }
  return merge(P);
}
function vtruck() {
  // Same lorry silhouette as the parked industrial prop, facing +z.
  const P = [
    colorize(B(1.7, 0.3, 5.6), 0.16, 0.16, 0.18).translate(0, 0.62, 0),
    colorize(B(1.8, 1.6, 1.6), 0.78, 0.28, 0.16).translate(0, 1.55, 2.0),
    colorize(B(1.5, 0.7, 0.14), 0.18, 0.24, 0.3).translate(0, 1.9, 2.62),
    colorize(B(1.85, 1.7, 3.6), 0.24, 0.5, 0.32).translate(0, 1.65, -0.9),
    colorize(B(1.9, 0.35, 3.6), 0.72, 0.62, 0.3).translate(0, 2.6, -0.9),
  ];
  for (const wz of [2.0, -0.1, -1.9]) for (const wx of [-0.85, 0.85]) {
    P.push(colorize(new THREE.CylinderGeometry(0.44, 0.44, 0.3, 7), 0.1, 0.1, 0.11)
      .rotateZ(Math.PI / 2).translate(wx, 0.44, wz));
  }
  return merge(P);
}
const VEH_BUILD = { car, moto, bus, vtruck };

// ---- Manager ---------------------------------------------------------------
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ'); // yaw first, then local pitch/roll
const _s = new THREE.Vector3();
const _dir = { x: 0, z: 0 };

export class Population {
  constructor(scene, generator, villages, towns, cities, industry) {
    this.gen = generator;
    this.villages = villages;
    this.towns = towns;
    this.cities = cities;
    this.industry = industry;
    this.seed = generator.seed | 0;
    this._info = makeInfo();
    this._t = 0;
    this._scanT = 99;
    this._bound = [];      // active settlement bindings
    this._found = [];      // rescan scratch

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.npcMesh = {};
    this.vehMesh = {};
    for (const k of Object.keys(NPC_BUILD)) this.npcMesh[k] = this._mesh(scene, NPC_BUILD[k](), CAP[k], mat);
    for (const k of Object.keys(VEH_BUILD)) this.vehMesh[k] = this._mesh(scene, VEH_BUILD[k](), CAP[k], mat);

    // Fixed entity pools (records reused; never allocated while riding).
    this.npcs = [];
    for (let i = 0; i < MAX_NPC; i++) {
      this.npcs.push({ used: false, kind: '', slot: 0, ax: 0, az: 0, bx: 0, bz: 0,
        x: 0, z: 0, y: 0, tgt: 0, speed: 1, idleT: 0, phase: 0, yaw: 0,
        scX: 0, scZ: 0, load: false, gT: 9, lodT: 0, s: 1 });
    }
    this.vehs = [];
    for (let i = 0; i < MAX_VEH; i++) {
      this.vehs.push({ used: false, kind: '', slot: 0, park: false, x: 0, z: 0, y: 0,
        dx: 0, dz: 1, sign: 1, lane: 2.2, speed: 8, ax: 0, az: 0, corridor: 200, s: 0,
        eAx: 0, eAz: 0, eAdx: 0, eAdz: 1, eBx: 0, eBz: 0, eBdx: 0, eBdz: 1,
        pauseT: 0, coolT: 0, recT: 0, yaw: 0, px: 0, pz: 0, hasPad: false });
    }
  }

  _mesh(scene, geo, cap, mat) {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  }

  _h(a, b, salt) { return hash01(Math.round(a), Math.round(b), this.seed * 77 + salt); }

  /** Allocation-free copy of the generator's trail tangent (same math). */
  _trailDir(x, z, out) {
    const g = this.gen, e = 1.5;
    const c1 = Math.abs(vnoise(x * 0.0033 + 5.1, z * 0.0033 - 9.7, g.ST1) - 0.5);
    const c2 = Math.abs(vnoise(x * 0.0046 - 21.4, z * 0.0046 + 13.9, g.ST2) - 0.5);
    const sc = c1 < c2 ? 0.0033 : 0.0046;
    const ox = c1 < c2 ? 5.1 : -21.4, oz = c1 < c2 ? -9.7 : 13.9;
    const salt = c1 < c2 ? g.ST1 : g.ST2;
    const gx = vnoise((x + e) * sc + ox, z * sc + oz, salt) - vnoise((x - e) * sc + ox, z * sc + oz, salt);
    const gz = vnoise(x * sc + ox, (z + e) * sc + oz, salt) - vnoise(x * sc + ox, (z - e) * sc + oz, salt);
    const len = Math.hypot(gz, gx) || 1;
    out.x = -gz / len;
    out.z = gx / len;
    return out;
  }

  // ---- streaming: bind/release settlements ---------------------------------

  update(px, pz, dt) {
    this._t += dt;
    this._scanT += dt;
    if (this._scanT > 0.7) { this._scanT = 0; this._rescan(px, pz); }
    this._tickNpcs(px, pz, dt);
    this._tickVehicles(px, pz, dt);
  }

  _rescan(px, pz) {
    const found = this._found;
    found.length = 0;
    const R = 300;
    for (const v of this.villages.forChunk(px - R, pz - R, R * 2)) found.push(v);
    for (const t of this.towns.forChunk(px - R, pz - R, R * 2)) found.push(t);
    for (const c of this.cities.forChunk(px - R, pz - R, R * 2)) found.push(c);
    for (const i of this.industry.forChunk(px - R, pz - R, R * 2)) found.push(i);

    // Release bindings that moved out of range.
    for (let i = this._bound.length - 1; i >= 0; i--) {
      const b = this._bound[i];
      const act = ACT[b.kind] || 200;
      if (Math.hypot(b.x - px, b.z - pz) > act + RELEASE_PAD) {
        this._release(b);
        this._bound.splice(i, 1);
      }
    }
    // Bind newly in-range settlements.
    for (const rec of found) {
      const kind = rec.kind || (rec.id[0] === 'G' ? 'village' : rec.id[0] === 'T' ? 'town' : 'city');
      const act = ACT[kind] || 200;
      if (Math.hypot(rec.x - px, rec.z - pz) > act) continue;
      let known = false;
      for (const b of this._bound) if (b.id === rec.id) { known = true; break; }
      if (!known) this._bind(rec, kind);
    }
  }

  _release(b) {
    for (const n of this.npcs) if (n.used && n.bid === b.id) n.used = false;
    for (const v of this.vehs) if (v.used && v.bid === b.id) v.used = false;
  }

  _allocNpc(variant) {
    const cap = CAP[variant];
    let inUse = 0;
    for (const n of this.npcs) if (n.used && n.kind === variant) inUse++;
    if (inUse >= cap) return null;
    for (const n of this.npcs) if (!n.used) return n;
    return null;
  }

  _allocVeh(type) {
    const cap = CAP[type];
    let inUse = 0;
    for (const v of this.vehs) if (v.used && v.kind === type) inUse++;
    if (inUse >= cap) return null;
    for (const v of this.vehs) if (!v.used) return v;
    return null;
  }

  // ---- slot generation (deterministic per settlement) ----------------------

  _bind(rec, kind) {
    const b = { id: rec.id, x: rec.x, z: rec.z, kind };
    this._bound.push(b);
    const gen = this.gen, info = this._info;
    const h = (s) => this._h(rec.x, rec.z, s);
    const okWalk = (x, z) => {
      gen.masksAt(x, z, info);
      return info.stream < 0.2 && info.mtn < 0.05;
    };
    const items = rec.items || [];
    const byType = (t, i) => {
      let n = 0;
      for (const it of items) { if (it.type === t) { if (n === i) return it; n++; } }
      return null;
    };
    const addWalker = (variant, ax, az, bx, bz, speed, load) => {
      if (!okWalk(ax, az) || !okWalk(bx, bz)) return;
      const n = this._allocNpc(variant);
      if (!n) return;
      n.used = true; n.bid = b.id; n.kind = variant;
      n.ax = ax; n.az = az; n.bx = bx; n.bz = bz;
      const f = h(90 + (n.phase = Math.floor(h(91) * 97)));
      n.x = ax + (bx - ax) * f * 0.8; n.z = az + (bz - az) * f * 0.8;
      n.tgt = f < 0.5 ? 1 : 0;
      n.speed = speed || (0.75 + h(92) * 0.45);
      n.idleT = h(93) * 2; n.load = !!load;
      n.scX = 0; n.scZ = 0; n.gT = 9; n.lodT = 0;
      n.s = 0.95 + h(94) * 0.1;
      n.y = gen.height(n.x, n.z);
    };

    // Road axis through the anchor (towns/cities/industry sit ON the trail).
    this._trailDir(rec.x, rec.z, _dir);
    const rdx = _dir.x, rdz = _dir.z, pdx = -rdz, pdz = rdx;
    const roadYaw = Math.atan2(rdx, rdz);
    gen.masksAt(rec.x, rec.z, info);
    const onRoad = info.trail > 0.4;

    if (kind === 'village') {
      const h0 = byType('house', 0), h1 = byType('house', 1), h2 = byType('house', 2);
      if (h0 && h1) addWalker(h(1) < 0.5 ? 'manA' : 'woman', h0.x, h0.z, h1.x, h1.z);
      if (h1 && h2 && !rec.hamlet) addWalker(h(2) < 0.5 ? 'woman' : 'manB', h1.x, h1.z, h2.x, h2.z);
    } else if (kind === 'town') {
      // Bazaar sidewalk strollers, both flanks of the main road.
      for (let i = 0; i < 3; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const a1 = -60 + h(10 + i) * 50, a2 = 15 + h(20 + i) * 55;
        addWalker(['manA', 'woman', 'manB'][i],
          rec.x + rdx * a1 + pdx * side * 6.8, rec.z + rdz * a1 + pdz * side * 6.8,
          rec.x + rdx * a2 + pdx * side * 6.8, rec.z + rdz * a2 + pdz * side * 6.8);
      }
      // Shoppers idling in front of shops/stalls (short shuffle segments).
      for (let i = 0; i < 2; i++) {
        const it = byType(i === 0 ? 'shop' : 'stall', Math.floor(h(30 + i) * 3)) || byType('teashop', 0);
        if (it) {
          const fx = it.x - Math.sin(it.yaw) * 2.2, fz = it.z - Math.cos(it.yaw) * 2.2;
          addWalker(i === 0 ? 'woman' : 'manA', fx, fz, fx + pdx * 2.5, fz + pdz * 2.5, 0.55);
        }
      }
      if (onRoad) {
        this._spawnVehicle('bus', rec, b, 6.5 + h(40), 210);
        this._spawnVehicle('moto', rec, b, 9 + h(41) * 2, 210);
        const stop = byType('busstop', 0);
        if (stop) this._parkVehicle('bus', b, stop.x + pdx * 1.2, stop.z + pdz * 1.2, roadYaw + Math.PI);
      }
    } else if (kind === 'city') {
      // Sidewalk pedestrians along the main road, both sides.
      for (let i = 0; i < 5; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const a1 = -110 + h(10 + i) * 90, a2 = 20 + h(20 + i) * 95;
        addWalker(['manA', 'woman', 'manB', 'woman', 'manB'][i],
          rec.x + rdx * a1 + pdx * side * 7.2, rec.z + rdz * a1 + pdz * side * 7.2,
          rec.x + rdx * a2 + pdx * side * 7.2, rec.z + rdz * a2 + pdz * side * 7.2);
      }
      // Small groups near market life: stalls, shops, bus stops.
      for (let i = 0; i < 3; i++) {
        const it = byType('stall', i) || byType('shop', i) || byType('busstop', i % 2);
        if (it) {
          const fx = it.x - Math.sin(it.yaw) * 2.2, fz = it.z - Math.cos(it.yaw) * 2.2;
          addWalker(['woman', 'manA', 'manB'][i], fx, fz, fx + pdx * 2.2, fz + pdz * 2.2, 0.55);
        }
      }
      if (onRoad) {
        this._spawnVehicle('car', rec, b, 8 + h(42) * 2, 240);
        this._spawnVehicle('car', rec, b, 8.5 + h(43) * 2, 240);
        this._spawnVehicle('moto', rec, b, 10 + h(44) * 2.5, 240);
        this._spawnVehicle('moto', rec, b, 10.5 + h(45) * 2.5, 240);
        this._spawnVehicle('bus', rec, b, 6.5 + h(46), 240);
        for (let i = 0; i < 2; i++) {
          const lot = byType('parklot', i);
          if (lot) this._parkVehicle('car', b, lot.x + pdx * (i ? 2 : -2), lot.z + pdz * (i ? 2 : -2),
            roadYaw + (h(47 + i) < 0.5 ? Math.PI / 2 : -Math.PI / 2));
        }
      }
    } else if (kind === 'industry') {
      // Workers: dock <-> yard hauls with a loading idle at the ends.
      const shedA = byType('warehouse', 0) || byType('factory', 0);
      const shedB = byType('warehouse', 1) || byType('factory', 0) || shedA;
      const pad = byType('parklot', 0);
      const box = byType('container', 0);
      if (shedA && pad) addWalker('worker', shedA.x, shedA.z, pad.x, pad.z, 0.9, true);
      if (shedB && box) addWalker('worker', shedB.x, shedB.z, box.x, box.z, 0.85, true);
      if (shedA && box) addWalker('worker', box.x, box.z, shedA.x, shedA.z, 0.95, true);
      const gate = byType('roadsign', 0);
      if (gate) addWalker('worker', gate.x, gate.z, gate.x + rdx * 18, gate.z + rdz * 18, 0.8, true);
      if (onRoad) {
        const v1 = this._spawnVehicle('vtruck', rec, b, 4.5 + h(50), 170);
        const v2 = this._spawnVehicle('vtruck', rec, b, 5 + h(51), 170);
        for (const v of [v1, v2]) {
          if (v && pad) { v.hasPad = true; v.px = pad.x; v.pz = pad.z; v.coolT = 6 + h(52) * 14; }
        }
      }
    } else if (kind === 'stadium') {
      const lot = byType('parklot', 0);
      if (lot) {
        addWalker('manB', lot.x, lot.z, rec.x + (lot.x - rec.x) * 0.35, rec.z + (lot.z - rec.z) * 0.35);
        addWalker('woman', lot.x + 3, lot.z + 2, rec.x + (lot.x - rec.x) * 0.4, rec.z + (lot.z - rec.z) * 0.4);
        this._parkVehicle('car', b, lot.x - 2, lot.z + 1.5, this._h(lot.x, lot.z, 60) * 6.28);
      }
    }
  }

  /** Walk the road from (x0,z0) for `dist` meters (bind-time only). */
  _walkRoad(x0, z0, sign, dist) {
    let px = x0, pz = z0, dx = 0, dz = 0;
    const step = 14, info = this._info;
    for (let s = 0; s < dist; s += step) {
      this._trailDir(px, pz, _dir);
      let ddx = _dir.x * sign, ddz = _dir.z * sign;
      if ((dx !== 0 || dz !== 0) && ddx * dx + ddz * dz < 0) { ddx = -ddx; ddz = -ddz; }
      dx = ddx; dz = ddz;
      px += dx * step; pz += dz * step;
      let bx = px, bz = pz, bt = -1;
      for (let k = -2; k <= 2; k++) {
        const nx = px - dz * k * 2.2, nz = pz + dx * k * 2.2;
        this.gen.masksAt(nx, nz, info);
        if (info.trail > bt) { bt = info.trail; bx = nx; bz = nz; }
      }
      px = bx; pz = bz;
    }
    return { x: px, z: pz, dx, dz };
  }

  _spawnVehicle(type, rec, b, speed, corridor) {
    const v = this._allocVeh(type);
    if (!v) return null;
    v.used = true; v.bid = b.id; v.kind = type; v.park = false;
    v.ax = rec.x; v.az = rec.z;
    v.corridor = corridor;
    v.speed = speed;
    v.sign = this._h(rec.x + v.speed * 91, rec.z, 70) < 0.5 ? 1 : -1;
    v.lane = 2.1 + this._h(rec.x, rec.z + v.speed * 57, 71) * 0.5;
    // Corridor endpoints found by WALKING the road (wraps always land on
    // tarmac even where the highway curves). A = negative arc end, B = +.
    const wA = this._walkRoad(rec.x, rec.z, -1, corridor);
    const wB = this._walkRoad(rec.x, rec.z, 1, corridor);
    v.eAx = wA.x; v.eAz = wA.z; v.eAdx = -wA.dx; v.eAdz = -wA.dz; // A -> anchor
    v.eBx = wB.x; v.eBz = wB.z; v.eBdx = -wB.dx; v.eBdz = -wB.dz; // B -> anchor
    // Start part-way along the corridor so traffic doesn't clump.
    const off = (this._h(rec.x, rec.z, 72 + speed * 13) - 0.5) * 1.4 * corridor;
    const w = this._walkRoad(rec.x, rec.z, off >= 0 ? 1 : -1, Math.abs(off));
    v.x = w.x; v.z = w.z; v.s = off;
    const tBx = off >= 0 ? w.dx : -w.dx, tBz = off >= 0 ? w.dz : -w.dz; // toward B
    v.dx = tBx * v.sign || v.eAdx; v.dz = tBz * v.sign || v.eAdz;
    v.pauseT = 0; v.coolT = 0; v.recT = 9; v.hasPad = false;
    v.y = this.gen.height(v.x, v.z);
    return v;
  }

  _parkVehicle(type, b, x, z, yaw) {
    const v = this._allocVeh(type);
    if (!v) return null;
    v.used = true; v.bid = b.id; v.kind = type; v.park = true;
    v.x = x; v.z = z; v.yaw = yaw;
    v.y = this.gen.height(x, z);
    return v;
  }

  // ---- per-frame ticks -------------------------------------------------------

  _tickNpcs(px, pz, dt) {
    const t = this._t, gen = this.gen;
    const meshes = this.npcMesh;
    for (const k of Object.keys(meshes)) meshes[k].count = 0;
    for (const n of this.npcs) {
      if (!n.used) continue;
      const distP = Math.hypot(n.x - px, n.z - pz);
      let step = dt;
      const far = distP > NPC_LOD_D;
      if (far) {
        n.lodT += dt;
        if (n.lodT < 0.2) { this._writeNpc(n, t, false); continue; }
        step = n.lodT; n.lodT = 0;
      }
      // Scatter: never let the bike be blocked — pedestrians hurry aside.
      const dbx = n.x + n.scX - px, dbz = n.z + n.scZ - pz;
      const db2 = dbx * dbx + dbz * dbz;
      if (db2 < 42 && db2 > 0.01) {
        const inv = 2.6 * step / Math.sqrt(db2);
        n.scX += dbx * inv; n.scZ += dbz * inv;
      } else {
        n.scX -= n.scX * Math.min(1, step * 0.8);
        n.scZ -= n.scZ * Math.min(1, step * 0.8);
      }
      const scm = Math.hypot(n.scX, n.scZ);
      if (scm > 3.5) { n.scX *= 3.5 / scm; n.scZ *= 3.5 / scm; }

      let walking = false;
      if (n.idleT > 0) {
        n.idleT -= step;
      } else {
        const tx = n.tgt ? n.bx : n.ax, tz = n.tgt ? n.bz : n.az;
        const dx = tx - n.x, dz = tz - n.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) {
          n.tgt ^= 1;
          n.idleT = n.load ? 2.5 + this._h(n.x, n.z, 95) * 3 : 1.2 + this._h(n.x, n.z, 95) * 2.5;
        } else {
          walking = true;
          const mv = Math.min(d, n.speed * step);
          n.x += (dx / d) * mv; n.z += (dz / d) * mv;
          const wy = Math.atan2(dx, dz);
          let dy = wy - n.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          n.yaw += dy * Math.min(1, step * 6);
        }
      }
      n.gT += step;
      if (n.gT > 0.15) { n.gT = 0; n.y = gen.height(n.x + n.scX, n.z + n.scZ); }
      this._writeNpc(n, t, walking && !far);
    }
    for (const k of Object.keys(meshes)) meshes[k].instanceMatrix.needsUpdate = true;
  }

  _writeNpc(n, t, animate) {
    const mesh = this.npcMesh[n.kind];
    let y = n.y - 0.04, rx = 0, rz = 0, yaw = n.yaw;
    if (animate) {
      const w = t * 9 + n.phase;
      y += Math.abs(Math.sin(w)) * 0.045;
      rx = Math.sin(w) * 0.05;
      rz = Math.sin(w * 0.5) * 0.045;
    } else if (n.load && n.idleT > 0) {
      rx = Math.max(0, Math.sin(t * 2.1 + n.phase)) * 0.22;  // lifting/loading
    } else if (n.idleT > 0) {
      yaw += Math.sin(t * 0.7 + n.phase) * 0.12;             // idle look-around
    }
    _p.set(n.x + n.scX, y, n.z + n.scZ);
    _e.set(rx, yaw, rz);
    _q.setFromEuler(_e);
    _s.setScalar(n.s);
    mesh.setMatrixAt(mesh.count++, _m.compose(_p, _q, _s));
  }

  _tickVehicles(px, pz, dt) {
    const gen = this.gen;
    const meshes = this.vehMesh;
    for (const k of Object.keys(meshes)) meshes[k].count = 0;
    for (const v of this.vehs) {
      if (!v.used) continue;
      if (v.park) { this._writeVeh(v, v.yaw, 0); continue; }
      if (v.pauseT > 0) {
        v.pauseT -= dt;
      } else {
        this._trailDir(v.x, v.z, _dir);
        let ddx = _dir.x, ddz = _dir.z;
        if (ddx * v.dx + ddz * v.dz < 0) { ddx = -ddx; ddz = -ddz; }
        v.dx = ddx; v.dz = ddz;
        v.x += ddx * v.speed * dt;
        v.z += ddz * v.speed * dt;
        v.s += v.speed * dt * v.sign;
        // Stay centered on the road crest; recover if the road is lost.
        v.recT += dt;
        if (v.recT > 0.35) {
          v.recT = 0;
          const info = this._info;
          let bo = 0, bt = -1;
          for (let k = -2; k <= 2; k++) {
            gen.masksAt(v.x - ddz * k * 2.2, v.z + ddx * k * 2.2, info);
            if (info.trail > bt) { bt = info.trail; bo = k; }
          }
          if (bo !== 0) { v.x -= ddz * bo * 1.8; v.z += ddx * bo * 1.8; }
          if (bt < 0.3) this._wrapVeh(v); // road lost (sharp fork): restart leg
        }
        // Corridor end reached: reappear at the far end (beyond the fog).
        if (v.s > v.corridor || v.s < -v.corridor) this._wrapVeh(v);
        // Industrial trucks pull in near the loading pad now and then.
        v.coolT -= dt;
        if (v.hasPad && v.coolT <= 0 && Math.hypot(v.x - v.px, v.z - v.pz) < 16) {
          v.pauseT = 6 + this._h(v.x, v.z, 73) * 4;
          v.coolT = 25 + this._h(v.x, v.z, 74) * 15;
        }
      }
      // Left-hand lane offset; ground + pitch from the road itself.
      this._writeVeh(v, Math.atan2(v.dx, v.dz), 1);
    }
    for (const k of Object.keys(meshes)) meshes[k].instanceMatrix.needsUpdate = true;
  }

  /** Send a vehicle back to its corridor entry (per its direction). */
  _wrapVeh(v) {
    if (v.sign > 0) {
      v.x = v.eAx; v.z = v.eAz; v.dx = v.eAdx; v.dz = v.eAdz; v.s = -v.corridor + 4;
    } else {
      v.x = v.eBx; v.z = v.eBz; v.dx = v.eBdx; v.dz = v.eBdz; v.s = v.corridor - 4;
    }
    v.recT = 9; // recenter on the next tick
  }

  _writeVeh(v, yaw, moving) {
    const gen = this.gen;
    let x = v.x, z = v.z;
    if (moving) { x += -v.dz * v.lane; z += v.dx * v.lane; }
    let rx = 0;
    if (moving) {
      const hF = gen.height(x + v.dx * 1.7, z + v.dz * 1.7);
      const hB = gen.height(x - v.dx * 1.7, z - v.dz * 1.7);
      v.y = (hF + hB) * 0.5;
      rx = Math.atan2(hB - hF, 3.4);
    } else if (v.y === 0) {
      v.y = gen.height(x, z);
    }
    const mesh = this.vehMesh[v.kind];
    _p.set(x, v.y + 0.02, z);
    _e.set(rx, yaw, 0);
    _q.setFromEuler(_e);
    _s.setScalar(1);
    mesh.setMatrixAt(mesh.count++, _m.compose(_p, _q, _s));
  }

  /** Debug/test aid: live entity counts. */
  counts() {
    let npc = 0, veh = 0, parked = 0;
    for (const n of this.npcs) if (n.used) npc++;
    for (const v of this.vehs) if (v.used) { veh++; if (v.park) parked++; }
    return { npc, veh, parked, bound: this._bound.length };
  }
}
