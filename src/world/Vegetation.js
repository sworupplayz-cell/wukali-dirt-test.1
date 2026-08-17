import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, mulberry32, hashInt, sstep, vnoise } from './noise.js';

/**
 * Vegetation (Chapter 3B) — stylized low-poly trees & ground cover.
 *
 * 10 plant types, ONE InstancedMesh per type per LOD level. Placement is
 * a pure deterministic function of the 125 m cell ID; a ChunkGrid-style
 * window in SectorWorld triggers rebuild() when the player crosses a
 * cell. Instancing only — placement rewrites matrices, never allocates.
 *
 * LOD + distance culling:
 *   near ring (<= 250 m): full models (canopy + trunk)
 *   far ring  (<= 560 m): trees swap to a 2-triangle cone impostor of
 *                         matching color; ground cover culls entirely.
 * Both rings rebuild from the same deterministic lists, so a plant never
 * moves — it only changes representation. New instances always appear
 * at the window edge, deep inside the fog haze (no visible popping).
 *
 * Species by biome (analytic field masks, no new terrain queries beyond
 * one sample per candidate at placement time):
 *   pine/fir     — mountain foothills & the Glacier belt (300-900 m)
 *   birch/oak    — lowland moist meadows
 *   dead tree    — dry scrub and high rocky slopes
 *   bush/fern    — forest floor + road fringes
 *   grass patch / flowers — open lowland (never on roads)
 * Vertex-colored with painted variation; no textures on vegetation.
 */

const CELL = 125;
const NEAR_R = 2;   // 5x5 cells full detail  (~312 m)
// The spawn point (see SectorWorld). Nothing with a trunk is planted in
// its immediate bubble, so the player never starts inside a tree.
const SPAWN_X = 4026, SPAWN_Z = 2464;
const SPAWN_CLEAR = 13;
const GROUND_R = 1; // 3x3 cells for grass/flowers (~190 m) — Chapter 5B
                    // distance culling: sward is invisible clutter at
                    // 300 m but costs instances, matrix writes and fill.
const FAR_R = 4;    // 9x9 cells impostors    (~562 m)
const CKEY = 65536;        // integer cell-cache key stride
const CELL_BUDGET_MS = 0.8; // Chapter 5: per-frame plant-generation budget
const VEG_STAGGER = 5;      // frames to wait behind the terrain tile fill
const nowMs = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() : () => Date.now();

// ---- Chapter 5B ecosystem ---------------------------------------------------
// 20 plant models in five families, one InstancedMesh each, all sharing
// two materials. A mesh with zero instances costs no draw call (three.js
// skips instanceCount 0), so biome gating keeps the visible set small:
// reeds only appear near water, alpine grass only high up, and so on.
const TREES = ['pine', 'fir', 'oak', 'birch', 'dead'];
// The four bushes of the brief: small shrub, round bush, mountain bush,
// dry bush. (Ferns are ground cover, with the clover patches.)
const BUSHES = ['shrub', 'bush', 'mountainBush', 'dryBush'];
const GRASSES = ['grass', 'grassTall', 'sedge', 'tussock', 'reed', 'alpineGrass'];
const FLOWERS = ['flowerY', 'flowerP', 'flowerW'];
const GROUND = ['fern', 'clover'];
// Forest-floor detail: fallen logs, stumps and mossy boulders.
const DETAIL = ['logFallen', 'logMossy', 'stump', 'mossRock'];
// Small ground cover: culled to the inner ring (see GROUND_R).
const SWARD = {};
for (const t of [...GRASSES, ...FLOWERS, 'clover']) SWARD[t] = true;
const TYPES = [...TREES, ...BUSHES, ...GRASSES, ...FLOWERS, ...GROUND, ...DETAIL];
// Trunk collision radius per type (0 = ride-through ground cover; fallen
// logs stay ride-over so they never block a line through a forest).
const COLL = { pine: 0.42, fir: 0.36, birch: 0.34, oak: 0.55, dead: 0.38 };
for (const t of [...BUSHES, ...GRASSES, ...FLOWERS, ...GROUND, ...DETAIL]) COLL[t] = 0;
const CAP_NEAR = {
  pine: 560, fir: 460, birch: 200, oak: 160, dead: 110,
  shrub: 200, bush: 240, mountainBush: 160, dryBush: 180,
  grass: 900, grassTall: 620, sedge: 320, tussock: 520, reed: 160, alpineGrass: 380,
  flowerY: 420, flowerP: 360, flowerW: 320,
  fern: 240, clover: 460,
  logFallen: 70, logMossy: 60, stump: 90, mossRock: 140,
};
const CAP_FAR = { pine: 1050, fir: 850, birch: 500, oak: 380, dead: 260 };

export class Vegetation {
  constructor(scene, field) {
    this.field = field;
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
    this.visibleNear = 0;
    this.visibleFar = 0;
    this.colliders = []; // near-ring tree trunks (bike prop-collision)

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const matD = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    this._near = {};
    for (const t of TYPES) {
      const geo = GEO_BUILDERS[t]();
      const card = GRASSES.includes(t) || FLOWERS.includes(t) || t === 'fern' || t === 'clover';
      const m = new THREE.InstancedMesh(geo, card ? matD : mat, CAP_NEAR[t]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Chapter 5B colour variation: sward, bushes and stone carry a
      // per-INSTANCE tint. It multiplies into the shared material on the
      // GPU, so a whole meadow of one mesh still comes out in a hundred
      // shades — no extra material, no extra draw call.
      if (TINTED[t]) {
        m.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(CAP_NEAR[t] * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true; // only renders into the map when shadows are on
      scene.add(m);
      this._near[t] = m;
    }
    this._far = {};
    for (const t of Object.keys(CAP_FAR)) {
      const m = new THREE.InstancedMesh(buildImpostor(t), mat, CAP_FAR[t]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
      this._far[t] = m;
    }

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._cellCache = new Map();
    this._pcx = null;
    this._pcz = null;
    this._density = 1;   // Chapter 3C: fraction of plants kept
    this._farR = FAR_R;  // Chapter 3C: impostor ring radius (cells)
    // HOTFIX: ecosystem zones — the backbone of world population.
    this.zones = buildZones(field);
  }

  /**
   * Debug report (hotfix 5B.2). Returns what the vegetation system is
   * actually feeding the GPU right now: instances per family, the cells
   * in the streamed window, the render radii and the nearest tree. Call
   * `world.vegetation.debugReport()` from the console.
   */
  debugReport(px = this._pcx * CELL, pz = this._pcz * CELL) {
    const fam = { trees: 0, bushes: 0, sward: 0, detail: 0 };
    let near = 0, far = 0, nearest = Infinity;
    for (const [k, m] of Object.entries(this._near)) {
      near += m.count;
      if (TREES.includes(k)) fam.trees += m.count;
      else if (BUSHES.includes(k)) fam.bushes += m.count;
      else if (SWARD[k]) fam.sward += m.count;
      else fam.detail += m.count;
      if (TREES.includes(k)) {
        const a = m.instanceMatrix.array;
        for (let i = 0; i < m.count; i++) {
          const d = Math.hypot(a[i * 16 + 12] - px, a[i * 16 + 14] - pz);
          if (d < nearest) nearest = d;
        }
      }
    }
    for (const m of Object.values(this._far)) far += m.count;
    const meshes = Object.values(this._near).concat(Object.values(this._far));
    return {
      instancesNear: near, instancesFar: far, families: fam,
      activeCells: (this._farR * 2 + 1) ** 2, cellsCached: this._cellCache.size,
      nearRadiusM: NEAR_R * CELL, farRadiusM: this._farR * CELL,
      groundRadiusM: GROUND_R * CELL,
      density: this._density, noCull: !!this.debugNoCull,
      meshesInScene: meshes.filter((m) => m.parent).length, meshesTotal: meshes.length,
      nearestTreeM: nearest === Infinity ? null : +nearest.toFixed(1),
    };
  }

  /** Debug: drop the culling + thinning rules and rebuild (A/B testing). */
  debugSetCulling(on) {
    this.debugNoCull = !on;
    if (this._pcx !== null) this._rebuild(this._pcx, this._pcz, Infinity);
  }

  /** Graphics quality hook: density in [0,1] + far ring radius (cells). */
  setQuality(density, farR) {
    const far = Math.max(NEAR_R + 1, Math.min(FAR_R, farR));
    if (density === this._density && far === this._farR) return;
    this._density = density;
    // HOTFIX 5B.2: at the low quality tiers the requested impostor ring
    // was the SAME radius as the full-detail ring, which meant no distant
    // trees at all — the horizon went bare and the world read as empty.
    // The ring is now always at least one cell beyond the near ring.
    this._farR = far;
    if (this._pcx !== null) this._rebuild(this._pcx, this._pcz, Infinity);
  }

  /** Per-frame: rebuild instance lists when the player crosses a cell;
   *  animate the grow-in scale of plants that just switched to the near
   *  ring (smooth LOD transition instead of an abrupt swap). */
  update(px, pz) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    if (cx !== this._pcx || cz !== this._pcz) {
      // Chapter 5: a boundary crossing used to price ~17 brand-new cell
      // lists (each one terrain-samples ~35 candidates) into ONE frame —
      // a 10-20 ms stall on a phone, right in the middle of riding. The
      // window now fills under a time budget over as many frames as it
      // needs; plants that are not placed yet simply grow in a frame or
      // two later, which the LOD grow-in animation already covers.
      // A TELEPORT (or the first fill) still completes immediately: the
      // screen is behind the loading overlay or the player just moved
      // somewhere entirely new, so nothing must be missing.
      const jump = this._pcx === null ? 99
        : Math.max(Math.abs(cx - this._pcx), Math.abs(cz - this._pcz));
      this._pcx = cx; this._pcz = cz;
      if (jump > 1) {
        this._rebuild(cx, cz, Infinity);
      } else {
        // Terrain tiles use the SAME 125 m grid, so a crossing used to
        // bill new tiles AND new plants to one frame. Plants wait a few
        // frames for the tile ring to finish first — invisible (the LOD
        // grow-in already fades them in) and it halves the worst frame.
        this._pending = true;
        this._delay = VEG_STAGGER;
      }
    } else if (this._pending) {
      if (this._delay > 0) this._delay--;
      else this._rebuild(cx, cz, CELL_BUDGET_MS);
    }
    if (this._growing && this._growing.length > 0) this._stepGrow();
  }

  /** Advance grow-in animations (a few matrix rewrites per frame, no allocs). */
  _stepGrow() {
    const now = performance.now();
    let write = 0;
    for (let i = 0; i < this._growing.length; i++) {
      const g = this._growing[i];
      const t = (now - g.t0) / 450;
      const mesh = this._near[g.type];
      // HOTFIX 5B.2: instance slots are reassigned on every window
      // rebuild, so an animation started before the last rebuild would
      // write ITS plant's transform into whatever now owns that slot —
      // a tree visibly jumping or shrinking away. Entries are stamped
      // with the rebuild they belong to and dropped when it moves on.
      if (g.ver !== this._rebuildVer || g.slot >= mesh.count) continue;
      const k = t >= 1 ? 1 : 1 - (1 - t) * (1 - t); // ease-out
      this._write(mesh, g.slot, g.p, 0.25 + 0.75 * k);
      mesh.instanceMatrix.needsUpdate = true;
      if (t < 1) this._growing[write++] = g;
    }
    this._growing.length = write;
  }

  /** Cached plant list for one 125 m cell, or null when it has not been
   *  generated yet and `build` is false (the amortized window fill). */
  _cellPlants(cx, cz, build = true) {
    const hit = this._cellCache.get(cx * CKEY + cz);
    if (hit) return hit;
    if (!build) return null;
    const job = this._startCell(cx, cz);
    while (!this._stepCell(job)) { /* generate the whole cell now */ }
    return this._cacheCell(job);
  }

  /**
   * Chapter 5: cell generation is RESUMABLE at candidate granularity.
   * One dense forest cell is ~24 candidates and every candidate costs a
   * terrain sample, a road-distance query and several height probes — on
   * a phone that is several milliseconds, i.e. a visible hitch if it all
   * lands on one frame. `_advanceCell` does as many candidates as the
   * frame budget allows and remembers where it stopped.
   */
  _startCell(cx, cz) {
    const f = this.field;
    const ox = cx * CELL, oz = cz * CELL;
    const rng = mulberry32(hashInt(cx, cz, 0x7e93));
    // Cell-representative ground: drives how much grows here and what.
    const hCell = f.height(ox + CELL * 0.5, oz + CELL * 0.5);
    // TREES GET DENSER WITH ELEVATION. The lowland meadows are open
    // grass, the flanks above ~150 m carry real forest, and it thins out
    // again at the tree line. Elevation biases the forest FIELD itself
    // (not just the count), so whole hillsides turn wooded.
    const elev = sstep(55, 300, hCell) * (1 - sstep(900, 1200, hCell));
    // Forest density field: patchy woods, not uniform speckle.
    const forest = vnoise(cx * 0.17 + 3.7, cz * 0.17 - 8.1, 4441) + 0.24 * elev;
    const woods = Math.max(0, forest - 0.32) * (0.5 + 1.7 * elev);
    // The conifer belt carries a real forest: its stands are allowed up
    // to 40 trees a cell, roughly double the lowland woods.
    const cap = 22 + 18 * sstep(0.45, 0.85, elev);
    let nTrees = woods > 0 ? Math.min(cap | 0, (3 + woods * 34 * (0.7 + 0.9 * elev)) | 0) : 0;
    let nGround = 11 + (rng() * 5 | 0);
    // HOTFIX: an ECOSYSTEM ZONE over this cell multiplies its budget and
    // sets the species mix...
    const zh = zoneAt(this.zones, ox + CELL * 0.5, oz + CELL * 0.5);
    const zoneKind = zh ? zh.zone.kind : null;
    if (zh) {
      const k = 1 + 2.4 * zh.w;
      nTrees = Math.min(38, Math.round((nTrees + 3) * k));
      nGround = Math.round(nGround * (1 + 0.9 * zh.w));
    }
    // ...and OUTSIDE the zones the plains still get a floor of scattered
    // trees and brush, so no stretch of rideable ground is bare.
    if (nTrees < 2 && hCell >= 50 && hCell < 900) nTrees = 2;
    // THE SPAWN VALLEY (hotfix 5B.1). The first thing the player sees can
    // never be an empty field: the meadow bowl gets a guaranteed budget of
    // groves and ground detail, thinning back to the normal world by
    // ~500 m out. The road corridors keep the riding lines clear.
    const dsx = ox + CELL * 0.5 - SPAWN_X, dsz = oz + CELL * 0.5 - SPAWN_Z;
    const dSpawn = Math.hypot(dsx, dsz);
    if (dSpawn < 520) {
      const k = 1 - sstep(180, 520, dSpawn);
      nTrees = Math.max(nTrees, Math.round(9 + 11 * k));
      nGround = Math.max(nGround, Math.round(14 + 10 * k));
    }

    // FOREST STRUCTURE (Chapter 5B). Each cell holds a handful of stands.
    // A stand has a dense core and a thinning edge (the scatter radius is
    // r * u^0.9 rather than the uniform r * sqrt(u)), and one stand in
    // three carries a CLEARING — an empty middle that reads as a glade.
    // Nothing here is grid-aligned; between the stands the ground is open.
    const nc = 2 + (rng() * 3 | 0);
    const clusters = [];
    for (let i = 0; i < nc; i++) {
      clusters.push({
        x: ox + 10 + rng() * (CELL - 20),
        z: oz + 10 + rng() * (CELL - 20),
        r: 11 + rng() * 34,
        seed: rng(),
        clearing: rng() < 0.34 ? 0.22 + rng() * 0.26 : 0,
      });
    }
    return {
      cx, cz, key: cx * CKEY + cz,
      ox, oz, rng, forest, elev, nTrees, clusters, zoneKind,
      total: nTrees + nGround, i: 0, list: [],
    };
  }

  /** Evaluate ONE placement candidate. Returns true when the cell is done. */
  _stepCell(job) {
    const f = this.field;
    const lf = f.landforms;
    const info = this._info;
    const rng = job.rng;
    const { forest, nTrees, clusters, zoneKind } = job;
    const i = job.i++;
    const isTree = i < nTrees;
    // Scatter inside a stand: dense core, thinning edge, glade in the
    // middle of some of them.
    const c = clusters[(rng() * clusters.length) | 0];
    const u = rng();
    const rel = Math.pow(u, isTree ? 0.9 : 0.62);
    if (rel < c.clearing) return job.i >= job.total;
    const ang = rng() * 6.283, rad = c.r * rel;
    const x = c.x + Math.cos(ang) * rad, z = c.z + Math.sin(ang) * rad;
    // Guards are ordered CHEAPEST FIRST: squared distances and a road
    // lookup cost a fraction of a terrain sample, and they reject most
    // candidates before the expensive work starts.
    const dmx = x - 4000, dmz = z - 2500;
    const dMeadow2 = dmx * dmx + dmz * dmz;
    // Rider's Meadow: only the groomed practice core stays clear — 32 m
    // for sward, 46 m for trunks. Everything beyond that is the spawn
    // VALLEY: groves, brush, flowers and stone right up to the meadow
    // rim, with the road corridors keeping the riding lines open.
    // Sward returns immediately outside it and light trees from 200 m, so
    // the player spawns in a meadow that is visibly surrounded by
    // vegetation rather than on an empty plain.
    const meadowOk = isTree ? dMeadow2 >= 46 * 46 : dMeadow2 >= 32 * 32;
    // Roads keep a clear riding corridor: 11 m for anything with a trunk,
    // 6 m for sward, so the verge is alive but the bed never is.
    const clearNeed = isTree ? 11 : 6;
    const spx = x - SPAWN_X, spz = z - SPAWN_Z;
    const spawnOk = !isTree || spx * spx + spz * spz > SPAWN_CLEAR * SPAWN_CLEAR;
    if (meadowOk && spawnOk && x >= 30 && x <= 7970 && z >= 30 && z <= 4970 &&
        !nearViewpoint(lf, x, z) && !nearLandmark(lf, x, z) &&
        !lf.inWater(x, z) && lf.roadDist(x, z) >= clearNeed) {
      f.sample(x, z, info);
      const h = info.h;
      // The beach itself stays open sand, but its dunes carry sparse
      // marram-style bunch grass so the coast is not a dead strip.
      const dune = z > 4420 && h < 66;
      if (h >= 47 && info.trail <= 0.02 && (!dune || rng() < 0.34)) {
        const e = 5;
        // One-sided differences: the slope test costs two samples instead
        // of four (the centre height is already in `info`).
        const sl = Math.hypot(f.height(x + e, z) - h, f.height(x, z + e) - h) / e;
        // Conifers hold ground the rest of the ecosystem cannot: the
        // slope gate opens up in the belt above 150 m.
        const slopeMax = isTree && h > 150 ? 0.98 : 0.55;
        // RIDGES STAY SPARSE and their viewpoints stay open: on an
        // authored ridge crest most candidates are dropped.
        const onCrest = lf.ridgeSystems(x, z, 0) > 22;
        if (sl <= slopeMax && !(onCrest && rng() > 0.32)) {
          const r = rng(), rr = rng();
          let t = null, s = 1, ok = true;
          if (isTree) {
            if (h > 1250) ok = false;              // above the tree line
            else if (h > 150) {
              // MOUNTAIN SLOPES: dense pine and fir, dead snags in dry
              // ground, mountain bush and mossy boulders underneath.
              t = h > 620 && r < 0.3 ? 'dead' : r < 0.58 ? 'pine' : 'fir';
              if (rr > 0.9) t = rr > 0.96 ? 'mossRock' : 'mountainBush';
            } else {
              // ROLLING HILLS: mixed broadleaf woods.
              t = r < 0.4 ? 'birch' : r < 0.7 ? 'oak' : rr < 0.5 ? 'pine' : 'bush';
            }
            // An ecosystem zone stamps its own character on the stand.
            if (zoneKind === 'pine') t = r < 0.62 ? 'pine' : r < 0.9 ? 'fir' : 'dead';
            else if (zoneKind === 'birch') t = r < 0.68 ? 'birch' : r < 0.86 ? 'oak' : 'bush';
            else if (zoneKind === 'thicket') t = r < 0.45 ? 'bush' : r < 0.7 ? 'shrub' : r < 0.9 ? 'oak' : 'dryBush';
            else if (zoneKind === 'flower' && r > 0.55) t = r < 0.8 ? 'birch' : 'bush';
            if (info.moist < 0.25 && rr < 0.32) t = 'dead';
            // Random scale 0.85-1.25 (brief), random yaw below.
            s = 0.85 + rng() * 0.4;
            // Forest floor timber: logs, stumps and moss rocks, only in
            // real woodland.
            // Forest-floor detail: each STAND carries one kind of debris
            // (its seed picks it), so a wood shows logs or stumps or
            // mossy boulders rather than all four at once — which keeps
            // the number of instanced meshes drawn in any one place low.
            if (forest > 0.55 && rr > 0.88) {
              t = c.seed < 0.3 ? 'logFallen' : c.seed < 0.55 ? 'stump'
                : c.seed < 0.8 ? 'mossRock' : 'logMossy';
              s = 0.85 + rng() * 0.4;
            }
          } else if (h > 900 && sl <= 0.4) {
            // Alpine mat above the forest: less grass, more rock.
            t = r < 0.5 ? 'alpineGrass' : r < 0.78 ? 'mountainBush' : 'mossRock';
            s = 0.7 + rng() * 0.4;
          } else if (sl > 0.4) {
            ok = false;
          } else if (dune) {
            // Dune grass and dry brush on the sand.
            if (isTree) ok = false;
            else { t = r < 0.62 ? 'tussock' : r < 0.86 ? 'dryBush' : 'grass'; s = 0.7 + rng() * 0.4; }
          } else if (lakeNear(lf, x, z)) {
            // LAKESHORE: grass and reeds at the water, the odd birch.
            t = r < 0.5 ? 'reed' : r < 0.78 ? 'sedge' : r < 0.9 ? 'grass' : 'birch';
            s = t === 'birch' ? 0.85 + rng() * 0.4 : 0.8 + rng() * 0.5;
          } else if (h > 150) {
            // Mountain slopes carry little sward and plenty of stone.
            t = r < 0.34 ? 'alpineGrass' : r < 0.6 ? 'mossRock'
              : r < 0.88 ? 'mountainBush' : 'tussock';
            s = 0.72 + rng() * 0.45;
          } else if (forest > 0.5) {
            // Forest floor: ferns, brush, clover and moss.
            // Forest floor: a stand is either a fern floor or a clover
            // floor, with brush through it.
            const floor = c.seed < 0.55 ? 'fern' : 'clover';
            t = r < 0.42 ? floor : r < 0.66 ? 'bush' : r < 0.86 ? 'shrub' : 'mossRock';
            s = 0.75 + rng() * 0.5;
          } else if (info.moist < 0.34) {
            // Dry open country: bunch grass and dry bushes.
            t = r < 0.48 ? 'tussock' : r < 0.7 ? 'dryBush' : r < 0.88 ? 'grass' : 'shrub';
            s = 0.75 + rng() * 0.5;
          } else {
            // SPAWN VALLEY / damp open meadow: mixed sward, clover and
            // wildflower drifts. The stand's own seed picks which colour
            // dominates, so drifts come out single-coloured like real ones.
            // Meadow sward: two grasses, the stand's own third species
            // (sedge in damp ground, tussock in dry, clover in between)
            // and its own flower colour.
            const third = info.moist > 0.55 ? 'sedge' : c.seed < 0.5 ? 'clover' : 'tussock';
            // A flower-field ecosystem is mostly blossom.
            if (zoneKind === 'flower' && r > 0.28) {
              t = c.seed < 0.4 ? 'flowerY' : c.seed < 0.75 ? 'flowerP' : 'flowerW';
            } else if (r < 0.32) t = 'grass';
            else if (r < 0.56) t = 'grassTall';
            else if (r < 0.72) t = third;
            else if (r < 0.94) {
              t = c.seed < 0.4 ? 'flowerY' : c.seed < 0.75 ? 'flowerP' : 'flowerW';
            } else t = 'shrub';
            // Sward stays close to life size — coverage comes from the
            // dense on-demand top-up inside the culling ring, not from
            // oversized tufts (those read as cardboard from the saddle).
            s = t === 'shrub' ? 0.8 + rng() * 0.5 : 0.9 + rng() * 0.5;
          }
          if (ok && t) {
            const big = TRUNKED[t] === true;
            const rF = big ? 0.9 : 0.5;
            const y = (big
              ? Math.min(h, f.height(x + rF, z), f.height(x - rF, z),
                f.height(x, z + rF), f.height(x, z - rF))
              : Math.min(h, f.height(x + rF, z), f.height(x, z + rF))) - 0.06 * s;
            // Per-instance tint (0..1) drives the shared-material colour
            // variation for sward and stone — see _write().
            const tint = hash01(x | 0, z | 0, 0x51ce);
            job.list.push({ t, x, z, y, yaw: rng() * 6.283, s, tint, tree: COLL[t] > 0 });
          }
        }
      }
    }
    return job.i >= job.total;
  }

  /**
   * Dense meadow sward for one cell (hotfix: populate the world).
   *
   * The main pass places the structure — trees, bushes, forest floor —
   * at a density the whole 81-cell window can afford. Grass has to be an
   * order of magnitude denser than that to read as a meadow at riding
   * speed, but it is culled to the inner ~190 m ring, so it is generated
   * separately and only for the cells that can actually show it.
   */
  _swardTopUp(cx, cz, list) {
    list.swardDone = true;
    const f = this.field;
    const lf = f.landforms;
    const info = this._info;
    const ox = cx * CELL, oz = cz * CELL;
    const rng = mulberry32(hashInt(cx, cz, 0x5ea7));
    const zh = zoneAt(this.zones, ox + CELL * 0.5, oz + CELL * 0.5);
    const flowerZone = zh && zh.zone.kind === 'flower';
    // Patches, not a wash: a handful of drifts per cell, each with its
    // own dominant species and flower colour.
    const nd = 3 + (rng() * 3 | 0);
    const drifts = [];
    for (let i = 0; i < nd; i++) {
      drifts.push({
        x: ox + 8 + rng() * (CELL - 16), z: oz + 8 + rng() * (CELL - 16),
        r: 16 + rng() * 30, seed: rng(),
      });
    }
    // The spawn valley gets roughly double the close-range detail: this
    // is the first thing the player ever sees.
    const nearSpawn = Math.hypot(ox + CELL * 0.5 - SPAWN_X, oz + CELL * 0.5 - SPAWN_Z) < 320;
    const n = (nearSpawn ? 130 : 60) + (rng() * 30 | 0);
    for (let i = 0; i < n; i++) {
      const d = drifts[(rng() * drifts.length) | 0];
      const ang = rng() * 6.283, rad = d.r * Math.pow(rng(), 0.55);
      const x = d.x + Math.cos(ang) * rad, z = d.z + Math.sin(ang) * rad;
      const dmx = x - 4000, dmz = z - 2500;
      if (dmx * dmx + dmz * dmz < 32 * 32) continue;
      if (x < 30 || x > 7970 || z < 30 || z > 4970) continue;
      if (lf.inWater(x, z) || lf.roadDist(x, z) < 6) continue;
      f.sample(x, z, info);
      const h = info.h;
      if (h < 47 || info.trail > 0.02) continue;
      if (z > 4420 && h < 66 && rng() > 0.3) continue;   // open sand
      const e = 5;
      const sl = Math.hypot(f.height(x + e, z) - h, f.height(x, z + e) - h) / e;
      if (sl > 0.5) continue;
      const r = rng(), rr = rng();
      let t;
      // MEADOW DETAIL (hotfix 5B.1): the close-range mix also carries
      // ferns, small bushes, fallen logs and mossy stones. All of it
      // lives inside the ~190 m culling ring, so it is detail the player
      // actually sees rather than instances burned on the horizon.
      // Bushes, ferns, logs and stones read from much further away than
      // a grass tuft, so the close-range mix carries a healthy share.
      if (rr > (nearSpawn ? 0.78 : 0.9) && h < 900) {
        t = rr > 0.975 ? 'logFallen' : rr > 0.95 ? 'mossRock'
          : rr > 0.9 ? 'fern' : rr > 0.85 ? 'bush' : 'shrub';
        const s2 = t === 'logFallen' ? 0.85 + rng() * 0.35 : 0.8 + rng() * 0.5;
        const y2 = Math.min(h, f.height(x + 0.7, z), f.height(x, z + 0.7)) - 0.06 * s2;
        list.push({ t, x, z, y: y2, yaw: rng() * 6.283, s: s2,
          tint: hash01(x | 0, z | 0, 0x51ce), tree: false });
        continue;
      }
      if (h > 900) t = r < 0.7 ? 'alpineGrass' : 'tussock';
      else if (h > 150) t = r < 0.45 ? 'tussock' : r < 0.8 ? 'grass' : 'alpineGrass';
      else if (flowerZone && r > 0.35) {
        t = d.seed < 0.4 ? 'flowerY' : d.seed < 0.75 ? 'flowerP' : 'flowerW';
      } else if (info.moist < 0.34) {
        t = r < 0.55 ? 'tussock' : r < 0.85 ? 'grass' : 'dryBush';
      } else {
        t = r < 0.34 ? 'grass' : r < 0.6 ? 'grassTall'
          : r < 0.72 ? (info.moist > 0.55 ? 'sedge' : 'clover')
            : r < 0.9 ? (d.seed < 0.4 ? 'flowerY' : d.seed < 0.75 ? 'flowerP' : 'flowerW')
              : 'clover';
      }
      const s = t === 'dryBush' ? 0.8 + rng() * 0.4 : 0.85 + rng() * 0.55;
      const y = Math.min(h, f.height(x + 0.5, z), f.height(x, z + 0.5)) - 0.06 * s;
      list.push({ t, x, z, y, yaw: rng() * 6.283, s,
        tint: hash01(x | 0, z | 0, 0x51ce), tree: false });
    }
  }

  /** Store a finished cell job in the LRU cache and return its list. */
  _cacheCell(job) {
    // Trees are generated first, so the far ring (which only draws tree
    // impostors) can stop after the tree prefix instead of walking every
    // blade of grass in all 81 cells of the window.
    let treeN = 0;
    for (let i = 0; i < job.list.length; i++) if (job.list[i].tree) treeN = i + 1;
    job.list.treeN = treeN;
    // LRU-ish bound: drop the OLDEST entries instead of wiping the whole
    // cache (a full clear meant every cell around the player had to be
    // regenerated on the very next crossing).
    if (this._cellCache.size > 420) {
      let drop = 80;
      for (const k of this._cellCache.keys()) {
        this._cellCache.delete(k);
        if (--drop <= 0) break;
      }
    }
    this._cellCache.set(job.key, job.list);
    return job.list;
  }

  /** Resume or start one cell under the frame budget; null if unfinished. */
  _advanceCell(cx, cz, budgetMs, t0) {
    let job = this._job;
    if (!job || job.cx !== cx || job.cz !== cz) {
      if (nowMs() - t0 >= budgetMs) return null;
      job = this._job = this._startCell(cx, cz);
    }
    while (!this._stepCell(job)) {
      if (nowMs() - t0 >= budgetMs) return null;
    }
    this._job = null;
    return this._cacheCell(job);
  }

  _rebuild(cx, cz, budgetMs = Infinity) {
    // Track which near cells are NEW this rebuild: their trees grow in.
    const prevCells = this._nearCells || new Set();
    const nowCells = new Set();
    const t0 = budgetMs === Infinity ? 0 : nowMs();
    if (budgetMs === Infinity) this._job = null; // drop any partial job
    let pending = false;
    let swardDone = false; // at most one dense sward cell per frame
    this._rebuildVer = (this._rebuildVer || 0) + 1;
    if (!this._growing) this._growing = [];
    const nearCounts = {}, farCounts = {};
    for (const t of TYPES) nearCounts[t] = 0;
    for (const t of Object.keys(CAP_FAR)) farCounts[t] = 0;
    this.colliders.length = 0;

    const R = this._farR;
    const den = this._density;
    const growNow = performance.now();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const nearRing = ring <= NEAR_R;
        const groundRing = ring <= GROUND_R;
        const cellKey = (cx + dx) * CKEY + (cz + dz);
        const isNewNear = nearRing && !prevCells.has(cellKey) && prevCells.size > 0;
        // Generate this cell's plant list only while inside the frame
        // budget; skipped cells are picked up on following frames.
        let plants = this._cellPlants(cx + dx, cz + dz, false);
        if (!plants) {
          plants = budgetMs === Infinity
            ? this._cellPlants(cx + dx, cz + dz, true)
            : this._advanceCell(cx + dx, cz + dz, budgetMs, t0);
          if (!plants) { pending = true; continue; }
        }
        if (nearRing) nowCells.add(cellKey);
        // HOTFIX: cells inside the ground ring get a DENSE sward top-up.
        // Meadow grass is only ever drawn within ~190 m, so generating it
        // for the whole 81-cell window would be wasted work — it is built
        // on demand, one cell per frame, and cached with the cell.
        if (groundRing && !plants.swardDone) {
          if (budgetMs === Infinity || !swardDone) {
            swardDone = true;
            this._swardTopUp(cx + dx, cz + dz, plants);
          } else {
            pending = true;
          }
        }
        const nPlants = nearRing ? plants.length : (plants.treeN || 0);
        for (let pi = 0; pi < nPlants; pi++) {
          const p = plants[pi];
          // Density thinning: deterministic per-plant keep test.
          //
          // HOTFIX 5B.2 — the quality setting used to thin EVERYTHING by
          // the same fraction, so a phone preset (25%) deleted three out
          // of four TREES. Trees are the silhouette of the world; grass
          // is filler. Ground cover now takes the full cut and woody
          // plants keep at least 80% of their number, which is what a
          // low-end device should be spending its instances on.
          const den2 = this.debugNoCull ? 1 : (TRUNKED[p.t] ? Math.max(0.8, den) : den);
          if (den2 < 1 && hash01(pi, p.x | 0, 0x5c1) > den2) continue;
          if (nearRing) {
            // Ground cover is culled to the inner ring.
            if (!groundRing && SWARD[p.t] && !this.debugNoCull) continue;
            const n = nearCounts[p.t];
            if (n >= CAP_NEAR[p.t]) continue;
            this._write(this._near[p.t], n, p, 1);
            nearCounts[p.t] = n + 1;
            const cr = COLL[p.t];
            if (cr > 0) this.colliders.push({ x: p.x, z: p.z, r: cr * p.s });
            // Smooth LOD swap: plants in cells that just became near
            // grow in over ~0.45 s instead of appearing at full scale.
            if (isNewNear && p.tree && this._growing.length < 220) {
              this._growing.push({ type: p.t, slot: n, p, t0: growNow, ver: this._rebuildVer });
            }
          } else if (CAP_FAR[p.t] !== undefined) {
            const n = farCounts[p.t];
            if (n >= CAP_FAR[p.t]) continue;
            this._write(this._far[p.t], n, p, 1);
            farCounts[p.t] = n + 1;
          }
        }
      }
    }
    this._pending = pending;
    let vn = 0, vf = 0;
    for (const t of TYPES) {
      this._near[t].count = nearCounts[t];
      this._near[t].instanceMatrix.needsUpdate = true;
      if (this._near[t].instanceColor) this._near[t].instanceColor.needsUpdate = true;
      vn += nearCounts[t];
    }
    for (const t of Object.keys(CAP_FAR)) {
      this._far[t].count = farCounts[t];
      this._far[t].instanceMatrix.needsUpdate = true;
      vf += farCounts[t];
    }
    this.visibleNear = vn;
    this.visibleFar = vf;
    this.collVersion = (this.collVersion || 0) + 1;
    this._nearCells = nowCells;
  }

  _compose(p) {
    this._p.set(p.x, p.y, p.z);
    this._e.set(0, p.yaw, 0);
    this._q.setFromEuler(this._e);
    this._s.setScalar(p.s);
    this._m.compose(this._p, this._q, this._s);
  }

  /**
   * Chapter 5B: write an instance transform STRAIGHT into the instance
   * buffer. Every plant is a yaw rotation plus a uniform scale, so the
   * Vector3 / Euler / Quaternion / Matrix4.compose / setMatrixAt chain
   * (five objects and a copy per plant) reduces to sixteen float stores.
   * With ~2,400 instances rewritten whenever the window moves, this is
   * the difference between a 6 ms hitch and a fraction of a millisecond.
   */
  _write(mesh, slot, p, scale) {
    const a = mesh.instanceMatrix.array;
    const o = slot * 16;
    const S = p.s * scale;
    const c = Math.cos(p.yaw) * S, sn = Math.sin(p.yaw) * S;
    a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = S; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    a[o + 12] = p.x; a[o + 13] = p.y; a[o + 14] = p.z; a[o + 15] = 1;
    const ic = mesh.instanceColor;
    if (ic) {
      // Two-axis variation: value (sun-bleached to deep) and hue (warm
      // straw to cool green), both from the plant's own hash so a plant
      // never changes shade when the window is rebuilt.
      const t = p.tint, u = 1 - t;
      const co = slot * 3;
      ic.array[co] = 0.86 + 0.3 * t;
      ic.array[co + 1] = 0.9 + 0.2 * u;
      ic.array[co + 2] = 0.82 + 0.26 * t * u * 2;
    }
  }
}

// ---- Low-poly vertex-colored geometry (painted color variation) -------------

function colored(geo, r, g, b, jitter = 0.05) {
  // Normalize: icosahedrons are non-indexed while cones/cylinders/planes
  // are indexed — mergeGeometries needs all-or-none.
  if (geo.index) geo = geo.toNonIndexed();
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = (hash01(i, 17, 71) - 0.5) * jitter * 2;
    col[i * 3] = r + j; col[i * 3 + 1] = g + j; col[i * 3 + 2] = b + j * 0.7;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function trunk(r0, r1, h, cr, cg, cb) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 5);
  g.translate(0, h / 2, 0);
  return colored(g, cr, cg, cb, 0.04);
}

/**
 * A grass BLADE: one tapered triangle, leaning and curving a little.
 * Chapter 5B used crossed rectangles for sward, which read as cardboard
 * cards from a riding camera; a cluster of tapered blades reads as grass
 * and costs FEWER triangles (one per blade instead of two).
 */
function blade(w, h, lean, twist) {
  const g = new THREE.BufferGeometry();
  const c = Math.cos(twist), sn = Math.sin(twist);
  const rx = (x, z) => x * c - z * sn, rz = (x, z) => x * sn + z * c;
  const tipX = Math.sin(lean) * h * 0.45, tipY = Math.cos(lean) * h;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    rx(-w * 0.5, 0), 0, rz(-w * 0.5, 0),
    rx(w * 0.5, 0), 0, rz(w * 0.5, 0),
    rx(tipX, 0), tipY, rz(tipX, 0),
  ]), 3));
  g.computeVertexNormals();
  return g;
}

/** A tuft: `n` blades fanned around the origin. */
function bladeTuft(n, w, h, spread, r, gr, b, jitter = 0.08) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const lean = 0.12 + spread * hash01(i, 3, 41);
    const hh = h * (0.7 + 0.5 * hash01(i, 7, 43));
    const bl = blade(w, hh, lean, t * Math.PI * 2 + hash01(i, 11, 47));
    bl.translate((hash01(i, 13, 53) - 0.5) * w * 1.6, 0, (hash01(i, 17, 59) - 0.5) * w * 1.6);
    parts.push(colored(bl, r, gr, b, jitter));
  }
  return mergeGeometries(parts);
}

const GEO_BUILDERS = {
  /** Pine: tall trunk + 3 stacked cones. */
  pine() {
    const parts = [trunk(0.22, 0.15, 2.2, 0.36, 0.26, 0.17)];
    for (let i = 0; i < 3; i++) {
      const c = new THREE.ConeGeometry(1.6 - i * 0.42, 2.2, 6);
      c.translate(0, 2.6 + i * 1.5, 0);
      parts.push(colored(c, 0.16, 0.36 + i * 0.03, 0.19, 0.06));
    }
    return mergeGeometries(parts);
  },
  /** Fir: slimmer, bluer, 4 tight cones. */
  fir() {
    const parts = [trunk(0.18, 0.12, 1.6, 0.33, 0.24, 0.16)];
    for (let i = 0; i < 4; i++) {
      const c = new THREE.ConeGeometry(1.15 - i * 0.24, 1.7, 6);
      c.translate(0, 1.9 + i * 1.15, 0);
      parts.push(colored(c, 0.13, 0.3 + i * 0.02, 0.24, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Birch: pale trunk + two bright ellipsoid canopies. */
  birch() {
    const parts = [trunk(0.16, 0.11, 2.6, 0.85, 0.84, 0.78)];
    const c1 = new THREE.IcosahedronGeometry(1.25, 0);
    c1.scale(1, 1.25, 1);
    c1.translate(0, 3.3, 0);
    parts.push(colored(c1, 0.45, 0.62, 0.25, 0.08));
    const c2 = new THREE.IcosahedronGeometry(0.8, 0);
    c2.translate(0.7, 2.6, 0.3);
    parts.push(colored(c2, 0.5, 0.66, 0.28, 0.08));
    return mergeGeometries(parts);
  },
  /** Small oak: thick trunk + broad round canopy. */
  oak() {
    const parts = [trunk(0.3, 0.22, 1.7, 0.34, 0.25, 0.16)];
    const c = new THREE.IcosahedronGeometry(1.7, 0);
    c.scale(1.2, 0.95, 1.2);
    c.translate(0, 2.8, 0);
    parts.push(colored(c, 0.3, 0.45, 0.17, 0.09));
    return mergeGeometries(parts);
  },
  /** Dead tree: bare trunk + 3 branch spikes. */
  dead() {
    const parts = [trunk(0.2, 0.08, 3.2, 0.42, 0.36, 0.3)];
    for (let i = 0; i < 3; i++) {
      const b = new THREE.CylinderGeometry(0.03, 0.07, 1.3, 4);
      b.rotateZ(0.7 + i * 0.5);
      b.rotateY(i * 2.1);
      b.translate(0, 1.7 + i * 0.6, 0);
      parts.push(colored(b, 0.4, 0.34, 0.28, 0.04));
    }
    return mergeGeometries(parts);
  },
  /** Bush: two squashed icosahedrons. */
  bush() {
    const a = new THREE.IcosahedronGeometry(0.85, 0);
    a.scale(1.25, 0.7, 1.25);
    a.translate(0, 0.5, 0);
    const b = new THREE.IcosahedronGeometry(0.55, 0);
    b.scale(1.1, 0.75, 1.1);
    b.translate(0.55, 0.42, 0.3);
    return mergeGeometries([colored(a, 0.24, 0.42, 0.2, 0.07), colored(b, 0.28, 0.46, 0.22, 0.07)]);
  },
  /** Fern: 3 crossed arcs of planes. */
  fern() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.PlaneGeometry(1.1, 0.75);
      p.rotateX(-0.5);
      p.rotateY((i / 3) * Math.PI * 2);
      p.translate(0, 0.35, 0);
      parts.push(colored(p, 0.2, 0.44, 0.22, 0.06));
    }
    return mergeGeometries(parts);
  },
  /** Grass patch: 4 crossed quads (a tuft, never blades). */
  /** Meadow grass: a fan of 7 soft blades. */
  grass() { return bladeTuft(7, 0.09, 0.62, 0.55, 0.42, 0.58, 0.26); },
  /** Small shrub: single squashed icosahedron, drier tint. */
  shrub() {
    const a = new THREE.IcosahedronGeometry(0.6, 0);
    a.scale(1.2, 0.65, 1.2);
    a.translate(0, 0.36, 0);
    return colored(a, 0.38, 0.44, 0.22, 0.08);
  },
  /** Mountain bush: low spreading juniper mat, dark blue-green. */
  mountainBush() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const a = new THREE.IcosahedronGeometry(0.62 - i * 0.1, 0);
      a.scale(1.5, 0.45, 1.5);
      a.translate(Math.cos(i * 2.1) * 0.45, 0.24 + i * 0.12, Math.sin(i * 2.1) * 0.45);
      parts.push(colored(a, 0.17, 0.32, 0.24, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Tall grass: 5 taller crossed blades, lighter and airier. */
  /** Tall grass: 8 longer, lighter blades. */
  grassTall() { return bladeTuft(8, 0.085, 1.05, 0.45, 0.47, 0.6, 0.27); },
  /** Sedge: stiff dark clump for damp ground. */
  /** Sedge: stiff, dark, near-vertical blades for damp ground. */
  sedge() { return bladeTuft(7, 0.07, 0.8, 0.22, 0.28, 0.48, 0.24); },
  /** Tussock: dry straw-coloured bunch grass of the open basins. */
  /** Tussock: a dense straw-coloured bunch of short blades. */
  tussock() { return bladeTuft(10, 0.07, 0.44, 0.85, 0.63, 0.58, 0.3); },
  /** Reed: lakeshore stand, tall and narrow. */
  /** Reed: tall narrow lakeshore stand. */
  reed() { return bladeTuft(6, 0.06, 1.4, 0.16, 0.4, 0.53, 0.26); },
  /** Alpine grass: short, blue-green, hugging the ground up high. */
  /** Alpine grass: short blue-green mat hugging the ground. */
  alpineGrass() { return bladeTuft(6, 0.075, 0.3, 0.7, 0.36, 0.5, 0.33); },
  /** Dry bush: sparse straw-coloured twigs of the dry country. */
  dryBush() {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.CylinderGeometry(0.02, 0.05, 0.85, 4);
      b.rotateZ((i - 2) * 0.34);
      b.rotateY(i * 1.9);
      b.translate(0, 0.42, 0);
      parts.push(colored(b, 0.55, 0.48, 0.28, 0.06));
    }
    const c = new THREE.IcosahedronGeometry(0.42, 0);
    c.scale(1.2, 0.5, 1.2);
    c.translate(0, 0.5, 0);
    parts.push(colored(c, 0.5, 0.45, 0.26, 0.08));
    return mergeGeometries(parts);
  },
  /** Clover patch: a low mat of round leaves. */
  clover() {
    const parts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const l = new THREE.CircleGeometry(0.16, 5);
      l.rotateX(-Math.PI / 2 + 0.2);
      l.rotateY(a);
      l.translate(Math.cos(a) * 0.24, 0.1 + (i % 3) * 0.03, Math.sin(a) * 0.24);
      parts.push(colored(l, 0.3, 0.52, 0.24, 0.05));
    }
    return mergeGeometries(parts);
  },
  /** Tree stump: cut trunk with a pale sawn top. */
  stump() {
    const g = new THREE.CylinderGeometry(0.34, 0.42, 0.62, 7);
    g.translate(0, 0.31, 0);
    const top = new THREE.CircleGeometry(0.34, 7);
    top.rotateX(-Math.PI / 2);
    top.translate(0, 0.625, 0);
    return mergeGeometries([colored(g, 0.38, 0.29, 0.21, 0.05),
      colored(top, 0.72, 0.62, 0.44, 0.04)]);
  },
  /** Moss rock: a boulder with a green cap on its shaded side. */
  mossRock() {
    const r = new THREE.IcosahedronGeometry(0.6, 0);
    r.scale(1.25, 0.8, 1.05);
    r.translate(0, 0.36, 0);
    const moss = new THREE.IcosahedronGeometry(0.5, 0);
    moss.scale(1.15, 0.34, 0.95);
    moss.translate(0, 0.6, 0);
    return mergeGeometries([colored(r, 0.52, 0.5, 0.47, 0.07),
      colored(moss, 0.28, 0.44, 0.24, 0.06)]);
  },
  flowerY() { return flowerOf(0.95, 0.82, 0.22); },
  flowerP() { return flowerOf(0.72, 0.42, 0.85); },
  flowerW() { return flowerOf(0.93, 0.93, 0.95); },
  /** Fallen log: a bare trunk lying in the grass with a broken stub. */
  logFallen() {
    const g = new THREE.CylinderGeometry(0.26, 0.32, 3.4, 6);
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.3, 0);
    const stub = new THREE.CylinderGeometry(0.1, 0.14, 0.7, 5);
    stub.rotateZ(0.9);
    stub.translate(1.3, 0.55, 0.15);
    return mergeGeometries([colored(g, 0.42, 0.33, 0.24, 0.05),
      colored(stub, 0.4, 0.31, 0.22, 0.04)]);
  },
  /** Mossy log: shorter, greener, half sunk into the forest floor. */
  logMossy() {
    const g = new THREE.CylinderGeometry(0.3, 0.34, 2.4, 6);
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.24, 0);
    const moss = new THREE.IcosahedronGeometry(0.33, 0);
    moss.scale(2.6, 0.4, 1.0);
    moss.translate(0, 0.44, 0);
    return mergeGeometries([colored(g, 0.36, 0.3, 0.23, 0.04),
      colored(moss, 0.26, 0.42, 0.22, 0.06)]);
  },
};

/** Wildflower of a given head colour: grass tuft + 6 blossom heads. */
function flowerOf(cr, cg, cb) {
  const parts = [];
  for (let i = 0; i < 2; i++) {
    const p = new THREE.PlaneGeometry(0.7, 0.4);
    p.rotateY((i / 2) * Math.PI);
    p.translate(0, 0.2, 0);
    parts.push(colored(p, 0.4, 0.56, 0.25, 0.06));
  }
  for (let i = 0; i < 6; i++) {
    const b = new THREE.IcosahedronGeometry(0.075, 0);
    b.translate((hash01(i, 3, 9) - 0.5) * 0.72,
      0.34 + hash01(i, 5, 11) * 0.18, (hash01(i, 7, 13) - 0.5) * 0.72);
    parts.push(colored(b, cr, cg, cb, 0.04));
  }
  return mergeGeometries(parts);
}

// Families that carry per-instance colour variation.
const TINTED = {};
for (const t of [...GRASSES, ...FLOWERS, ...BUSHES, 'clover', 'fern', 'mossRock']) TINTED[t] = true;

/**
 * FOREST PATCHES (hotfix 5B.1).
 *
 * 25-35 patches of woodland spread over the 40 km2 map. A patch is NOT a
 * circle: its radius is modulated by three angular harmonics, so the
 * outline is a lobed, irregular shape. Inside, density falls from a dense
 * core to a natural edge and one patch in three carries an interior
 * clearing. Placement is a jittered coarse grid (never aligned), and four
 * extra patches ring Rider's Meadow so the player spawns inside a valley
 * with woods in every direction instead of an empty field.
 */
function buildZones(field) {
  const lf = field.landforms;
  const zones = [];
  const info = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };
  const push = (x, z, r, seedA, minMeadow) => {
    const h = field.height(x, z);
    if (h < 52 || h > 620) return false;
    if (lf.inWater(x, z)) return false;
    if (Math.hypot(x - 4000, z - 2500) < minMeadow) return false;
    const e = 9;
    const sl = Math.hypot(field.height(x + e, z) - field.height(x - e, z),
      field.height(x, z + e) - field.height(x, z - e)) / (2 * e);
    if (sl > 0.5) return false;
    field.sample(x, z, info);
    const kind = h > 200 ? 'pine'
      : h > 110 ? 'mixed'
        : info.moist > 0.52 ? 'flower'
          : hash01(x | 0, z | 0, 0x2a15) < 0.5 ? 'birch' : 'thicket';
    zones.push({
      x, z, r, kind,
      strength: 0.9 + hash01(x | 0, z | 0, 0x2a14) * 0.55,
      // Lobed outline: three harmonics, so no patch is a disc.
      a1: hash01(x | 0, z | 0, 0x31) * 6.283, k1: 0.16 + hash01(x | 0, z | 0, 0x32) * 0.16,
      a2: hash01(x | 0, z | 0, 0x33) * 6.283, k2: 0.08 + hash01(x | 0, z | 0, 0x34) * 0.12,
      a3: hash01(x | 0, z | 0, 0x35) * 6.283,
      // Interior clearing in one patch out of three.
      clear: hash01(x | 0, z | 0, 0x36) < 0.34 ? 0.18 + hash01(x | 0, z | 0, 0x37) * 0.2 : 0,
    });
    return true;
  };

  // SPAWN PATCHES (hotfix 5B.2): six patches ringing Rider's Meadow, the
  // inner ones placed so their lobes reach over the spawn point itself —
  // the player starts INSIDE a forest patch, with only the 46 m practice
  // core kept clear. Forest is therefore visible in every direction from
  // the very first frame, at any quality setting.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 6.283 + 0.55;
    const inner = i % 2 === 0;
    for (let att = 0; att < 4; att++) {
      const d = (inner ? 150 : 240) + att * 50;
      if (push(4000 + Math.cos(a) * d, 2500 + Math.sin(a) * d,
        (inner ? 190 : 140) + hash01(i, att, 0x41) * 60, 0, 120)) break;
    }
  }
  // ...and the rest of the map on a jittered 7 x 5 grid (35 slots).
  const COLS = 7, ROWS = 5;
  const cw = 8000 / COLS, ch = 5000 / ROWS;
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      for (let att = 0; att < 3; att++) {
        const jx = hash01(i, j, 0x2a11 + att * 7), jz = hash01(i, j, 0x2a12 + att * 7);
        const x = (i + 0.12 + jx * 0.76) * cw;
        const z = (j + 0.12 + jz * 0.76) * ch;
        const r = 120 + hash01(i, j, 0x2a13) * 130;   // 120-250 m radius
        if (push(x, z, r, 0, 430)) break;
      }
    }
  }
  return zones;
}

/** Strongest ecosystem zone over a point, or null. */
function zoneAt(zones, x, z) {
  let best = null, bestW = 0;
  for (let i = 0; i < zones.length; i++) {
    const zo = zones[i];
    const dx = x - zo.x, dz = z - zo.z;
    const d = Math.hypot(dx, dz);
    if (d >= zo.r * 1.35) continue;
    // Lobed boundary: the effective radius swings with the bearing, so
    // the patch reads as a wood with bays and headlands, not a disc.
    const th = Math.atan2(dz, dx);
    const R = zo.r * (1 + zo.k1 * Math.sin(th * 2 + zo.a1)
      + zo.k2 * Math.sin(th * 3 + zo.a2) + 0.07 * Math.sin(th * 5 + zo.a3));
    if (d >= R) continue;
    const rel = d / R;
    if (zo.clear && rel < zo.clear) continue;   // interior clearing
    // Dense core, thinning to a natural edge.
    const w = (1 - sstep(0.42, 1, rel)) * zo.strength;
    if (w > bestW) { bestW = w; best = zo; }
  }
  return best ? { zone: best, w: bestW } : null;
}

// Types seated on their whole footprint (anything with a trunk or a
// boulder body); everything else is small enough for two probes.
const TRUNKED = {};
for (const t of [...TREES, 'logFallen', 'logMossy', 'stump', 'mossRock']) TRUNKED[t] = true;

/** Landmarks stay approachable: no planting on a cabin, cave or bridge. */
function nearLandmark(lf, x, z) {
  const ds = lf.destinations;
  if (!ds) return false;
  for (let i = 0; i < ds.length; i++) {
    const dx = x - ds[i].x, dz = z - ds[i].z;
    if (dx * dx + dz * dz < 26 * 26) return true;
  }
  return false;
}

/** Viewpoints keep their sight lines open — nothing is planted inside. */
function nearViewpoint(lf, x, z) {
  const vps = lf.viewpoints;
  if (!vps) return false;
  for (let i = 0; i < vps.length; i++) {
    const dx = x - vps[i].x, dz = z - vps[i].z;
    if (dx * dx + dz * dz < 46 * 46) return true;
  }
  return false;
}

/** Within a lake's shoreline band (reeds and sedge grow there). */
function lakeNear(lf, x, z) {
  const ls = lf.lakes || [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const d = Math.hypot(x - l.x, z - l.z);
    if (d < l.r * 1.5 && d > l.r * 0.95) return true;
  }
  return false;
}

/** Far impostor: one 6-face cone+trunk silhouette, species-tinted. */
function buildImpostor(t) {
  const tint = {
    pine: [0.16, 0.35, 0.19], fir: [0.13, 0.3, 0.23],
    birch: [0.45, 0.6, 0.26], oak: [0.3, 0.44, 0.18], dead: [0.42, 0.36, 0.3],
  }[t];
  const h = t === 'dead' ? 3.4 : t === 'birch' ? 4.4 : t === 'oak' ? 3.6 : 6.2;
  const w = t === 'oak' ? 2.1 : t === 'birch' ? 1.6 : 1.5;
  const c = new THREE.ConeGeometry(w * 0.55, h * 0.75, 5);
  c.translate(0, h * 0.55, 0);
  const tr = new THREE.CylinderGeometry(0.14, 0.2, h * 0.3, 4);
  tr.translate(0, h * 0.15, 0);
  return mergeGeometries([colored(c, tint[0], tint[1], tint[2], 0.05),
    colored(tr, 0.35, 0.26, 0.17, 0.03)]);
}
