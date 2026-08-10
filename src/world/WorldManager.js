import * as THREE from 'three';
import { TerrainGenerator, makeInfo } from './TerrainGenerator.js';
import { sstep } from './noise.js';
import { ChunkManager, CHUNK_SIZE } from './ChunkManager.js';
import { Mountains } from './Mountains.js';
import { MountainImpostors } from './MountainImpostors.js';
import { Villages } from './Villages.js';
import { Towns } from './Towns.js';
import { Cities } from './Cities.js';
import { Industrial } from './Industrial.js';
import { Population } from './Population.js';

/**
 * WorldManager — endless procedural world facade.
 *
 * Implements the exact world interface the Phase 1 bike/camera already use
 * ({ getHeight, getNormal, getColliders, getSpawn, isInBounds }), so the
 * bike physics is untouched. Adds update(pos) for chunk streaming, driven
 * by the game loop — the bike knows nothing about chunks.
 */
export class WorldManager {
  constructor(scene, seed = 20) {
    this.seed = seed;
    this.generator = new TerrainGenerator(seed);
    this.generator.getRegistry(); // eager: curated names apply from frame one
    this._buildLighting(scene);
    this.villages = new Villages(this.generator);
    this.towns = new Towns(this.generator, this.villages);
    this.cities = new Cities(this.generator, this.villages, this.towns);
    this.industry = new Industrial(this.generator, this.cities);
    this.population = new Population(scene, this.generator, this.villages, this.towns, this.cities, this.industry);
    this.chunks = new ChunkManager(scene, this.generator, this.villages, this.towns, this.cities, this.industry);
    this.mountains = new Mountains(scene, seed);
    this.impostors = new MountainImpostors(scene, this.generator);
    this._n = new THREE.Vector3();
    this._spawn = null;
    this._pruneT = 0;
    this._surfInfo = makeInfo(); // reused scratch for getSurface (no allocs)
  }

  // ---- Interface used by Bike / FollowCamera / Game -----------------------

  getHeight(x, z) {
    return this.generator.height(x, z);
  }

  getNormal(x, z, out) {
    const e = 0.6;
    const hx = this.generator.height(x + e, z) - this.generator.height(x - e, z);
    const hz = this.generator.height(x, z + e) - this.generator.height(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  /**
   * The RENDERED terrain surface near the player (Phase 3H-1). The visual
   * mesh is the analytic heightfield sampled on a globally-aligned 2 m
   * lattice and triangulated with a fixed diagonal — between vertices it
   * deviates from the smooth analytic surface (up to ~0.3 m in rocky
   * detail). Anything that must visually touch the ground (tyres, blob
   * shadow) has to seat on THIS surface, not the analytic one. Exact
   * reconstruction: 4 analytic samples, the same triangle split as
   * buildChunkGeometry (diagonal (i+1,j)-(i,j+1)), and the triangle's own
   * plane normal. Chunks under/next to the bike always use the 2 m grid.
   */
  getRenderedPlane(x, z, out) {
    const cs = 2; // inner-ring cell size (CHUNK_SIZE 64 / res 32)
    const gen = this.generator;
    const gx = Math.floor(x / cs) * cs, gz = Math.floor(z / cs) * cs;
    const fx = (x - gx) / cs, fz = (z - gz) / cs;
    const h00 = gen.height(gx, gz), h10 = gen.height(gx + cs, gz);
    const h01 = gen.height(gx, gz + cs), h11 = gen.height(gx + cs, gz + cs);
    if (fx + fz <= 1) {
      out.y = h00 + (h10 - h00) * fx + (h01 - h00) * fz;
      out.n.set(-(h10 - h00) / cs, 1, -(h01 - h00) / cs).normalize();
    } else {
      out.y = h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
      out.n.set(-(h11 - h01) / cs, 1, -(h11 - h10) / cs).normalize();
    }
    return out;
  }

  getColliders() {
    return this.chunks.activeColliders;
  }

  /**
   * Surface material under a point (Phase 3H). Classifies the analytic
   * terrain masks the generator already computes into a tiny record the
   * bike physics reads each few steps:
   *   grip  — drive/brake traction multiplier (1 = groomed dirt road)
   *   drag  — rolling-resistance coefficient (1/s, scales with speed)
   *   rough — bump excitation for the suspension & handling (0..1)
   * One extra analytic mask sample per call; no allocations, no raycasts,
   * no physics bodies — the terrain stays a pure heightfield.
   */
  getSurface(x, z, out) {
    const i = this._surfInfo;
    this.generator.masksAt(x, z, i);

    // Off-road base: soft dirt/grass (hills, farms, forest floor) vs bare
    // rock (rocky biome, high mountain biome, and the exposed mid/upper
    // band of destination domes).
    const rock = Math.min(1, i.wRk + i.wMnt + sstep(0.35, 0.62, i.mtn));
    const soft = 1 - rock;
    const forest = Math.min(1, i.wF * 1.4);
    let grip = 0.93 * soft + 0.85 * rock;
    let drag = (0.07 + 0.04 * forest) * soft + 0.085 * rock;
    let rough = (0.30 + 0.16 * forest) * soft + 0.75 * rock;

    // Groomed road/trail overrides the ground it crosses: predictable
    // traction, free rolling, near-smooth. (Kind-4 signature mountains
    // keep their forest roads muddy — slightly slick and soft.)
    const road = sstep(0.35, 0.75, i.trail);
    grip += (1.0 - grip) * road;
    drag += (0.012 - drag) * road;
    rough += (0.07 - rough) * road;
    if (i.mtnKind === 4 && i.mtn > 0.02 && road > 0.1) {
      const m = road;
      grip = Math.min(grip, 1 - 0.12 * m);
      drag = Math.max(drag, 0.05 * m);
      rough = Math.max(rough, 0.2 * m);
    }

    // Stream beds: wet stones — slick and draggy in the watery center.
    const wet = i.stream;
    if (wet > 0.03) {
      grip += (0.68 - grip) * wet;
      drag += (0.5 - drag) * wet * wet;
      rough += (0.55 - rough) * wet * (1 - wet * 0.5);
    }

    out.grip = grip;
    out.drag = drag;
    out.rough = rough;
    return out;
  }

  /** Deterministic spawn: a gentle lowland trail point near the origin,
   *  preferring one within riding distance of a village (Phase 3L-1 fix:
   *  rural content must be encountered during normal exploration — close
   *  enough to reach in a minute, far enough to require actually riding). */
  getSpawn() {
    if (this._spawn) return this._spawn;
    const gen = this.generator;
    const info = makeInfo();
    let best = null;
    let good = null;      // valid trail point without a nearby village
    let fallback = null;  // any rideable trail point at all
    outer:
    for (let r = 0; r <= 2600; r += 8) {
      const steps = Math.max(1, Math.round((r * 6.28) / 14));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        gen.masksAt(x, z, info);
        if (info.trail < 0.65 || info.stream > 0.1) continue;
        const slope = Math.abs(gen.height(x + 3, z) - gen.height(x - 3, z)) +
                      Math.abs(gen.height(x, z + 3) - gen.height(x, z - 3));
        if (slope > 1.2 || gen.nearFeature(x, z)) continue;
        if (!fallback) fallback = { x, z };
        if (info.lo < 0.85) continue; // start deep in the green lowlands
        if (!good) good = { x, z };
        const nearV = this.villages.nearest(x, z, 2);
        const vOk = nearV && nearV.d > 140 && nearV.d < 520 && !nearV.v.hamlet;
        const nearT = this.towns.nearest(x, z, 1);
        const tOk = nearT && nearT.d > 350 && nearT.d < 1100;
        // Best spawn: a town a short road ride away AND a village nearby;
        // then town-only; then village-only (Phase 3L-2 discoverability).
        // Phase 3L-3: among town-tier candidates, prefer one whose region
        // also holds a CITY within a few km of road riding.
        if (tOk && vOk) {
          const nc = this.cities.nearest(x, z, 1);
          if (nc && nc.d < 3000) { best = { x, z }; break outer; }
          if (!this._tvSpawn) this._tvSpawn = { x, z };
        }
        if (tOk && !this._townSpawn) this._townSpawn = { x, z };
        if (vOk && !this._vilSpawn) this._vilSpawn = { x, z };
        if (nearV && nearV.d > 140 && nearV.d < 520 && !this._hamSpawn) this._hamSpawn = { x, z };
      }
    }
    best = best || this._tvSpawn || this._townSpawn || this._vilSpawn || this._hamSpawn || good || fallback || { x: 0, z: 0 };
    const dir = gen._trailDir(best.x, best.z);
    this._spawn = {
      x: best.x,
      y: gen.height(best.x, best.z),
      z: best.z,
      yaw: Math.atan2(dir.x, dir.z),
    };
    return this._spawn;
  }

  isInBounds() {
    return true; // the world is endless; only the y < -30 failsafe remains
  }

  // ---- Mountain destinations ------------------------------------------------

  /** Mountain record if (x,z) is on a summit, else null. */
  summitAt(x, z) {
    return this.generator.summitAt(x, z);
  }

  /** Nearest mountain destination (tests/debug/future UI). */
  nearestMountain(x, z) {
    return this.generator.nearestMountain(x, z);
  }

  /** Curated destination registry (16 named mountains around the origin). */
  getMountainRegistry() {
    return this.generator.getRegistry();
  }

  /** All mountain destinations within maxDist of a point (metadata only). */
  mountainsNear(x, z, maxDist = 2500) {
    const out = [];
    const cellR = Math.ceil(maxDist / 1200);
    const mcx = Math.floor(x / 1200), mcz = Math.floor(z / 1200);
    for (let dx = -cellR; dx <= cellR; dx++) {
      for (let dz = -cellR; dz <= cellR; dz++) {
        const m = this.generator.mountainCell(mcx + dx, mcz + dz);
        if (m && Math.hypot(m.x - x, m.z - z) <= maxDist) out.push(m);
      }
    }
    return out;
  }

  /** Point + uphill heading on a mountain road (tests/debug). */
  roadPoint(mountain, frac, routeIdx = 0) {
    return this.generator.roadPoint(mountain, frac, routeIdx);
  }

  // ---- Streaming -----------------------------------------------------------

  update(pos, dt = 0.016) {
    this.chunks.update(pos.x, pos.z);
    this.mountains.update(pos.x, pos.z);
    this.impostors.update(pos.x, pos.z);
    this._pruneT += dt;
    if (this._pruneT > 5) {
      this._pruneT = 0;
      this.generator.pruneCells(pos.x, pos.z); // bound feature-cell cache
    }
  }

  // ---- Debug / verification (used by automated tests) ----------------------

  debugInfo() {
    return this.chunks.debugInfo();
  }

  /** Find the nearest feature of a type; spiral cell search. Test/debug aid. */
  findFeature(type, x, z, maxCells = 30) {
    const gen = this.generator;
    const c0x = Math.floor(x / 80), c0z = Math.floor(z / 80);
    for (let r = 0; r <= maxCells; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const f = gen.cellFeature(c0x + dx, c0z + dz);
          if (f && f.type === type) return f;
        }
      }
    }
    return null;
  }

  _buildLighting(scene) {
    const sky = new THREE.Color(0x7ec4e8);
    scene.background = sky;
    // Fog hides the streaming edge (~128 m worst case) and doubles as
    // Himalayan valley haze under the distant peaks.
    scene.fog = new THREE.Fog(sky, 62, 158);
    scene.add(new THREE.HemisphereLight(0xd4ebff, 0x7d6a44, 0.92));
    const sun = new THREE.DirectionalLight(0xffedc9, 1.22);
    sun.position.set(60, 90, 30);
    scene.add(sun);
  }
}

export { CHUNK_SIZE };
