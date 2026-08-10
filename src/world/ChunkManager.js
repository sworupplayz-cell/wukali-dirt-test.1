import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { PROP } from './props.js';
import { makeInfo } from './TerrainGenerator.js';
import { mulberry32, hashInt, hash01, sstep, vnoise } from './noise.js';

/**
 * ChunkManager — endless world streaming.
 *
 * The world is a grid of 64 m chunks. Around the player:
 *   Chebyshev <= 1  -> inner ring, 2 m mesh resolution (9 chunks)
 *   Chebyshev == 2  -> outer ring, 4 m mesh resolution (16 chunks)
 *   Chebyshev  > 2  -> recycled immediately
 * 25 active chunks cover ~160 m; fog hides the streaming edge.
 *
 * Terrain meshes come from two fixed pools (never allocated at runtime);
 * a rebuild only rewrites vertex buffers. Every chunk edge vertex samples
 * the same analytic terrain function at the same world coordinate, so
 * chunk edges match exactly; LOD T-junction cracks are hidden by a small
 * downward "skirt" built into each chunk mesh.
 *
 * Builds are queued (nearest first) and limited per frame so streaming
 * never blocks a frame for long. The player's own chunk is always built
 * synchronously as a safety net (physics is analytic and never waits).
 */

export const CHUNK_SIZE = 64;
const LOAD_R = 2;      // active radius (chunks)
const INNER_R = 1;     // full-resolution radius
const INNER_RES = 32;  // quads per side, inner (2 m)
const OUTER_RES = 16;  // quads per side, outer (4 m)
const SKIRT = 3;       // skirt depth (m)
const MAX_PROPS_PER_CHUNK = 44;

export class ChunkManager {
  constructor(scene, generator, villages = null, towns = null, cities = null, industry = null) {
    this.scene = scene;
    this.gen = generator;
    this.villages = villages;
    this.towns = towns;
    this.cities = cities;
    this.industry = industry;
    this.chunks = new Map();       // key -> chunk record
    this.queue = [];               // keys awaiting mesh build
    this.activeColliders = [];
    this.pools = new InstancedPool(scene);
    this._instancesDirty = false;
    this._pcx = null;
    this._pcz = null;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Inner pool must cover the worst case: all 25 chunks on a mountain
    // dome are promoted to full resolution.
    this._innerPool = new MeshPool(scene, INNER_RES, 27, mat);
    this._outerPool = new MeshPool(scene, OUTER_RES, 18, mat);
    this._info = makeInfo();
    this._color = [0, 0, 0];
  }

  update(px, pz) {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    if (cx !== this._pcx || cz !== this._pcz) {
      this._pcx = cx; this._pcz = cz;
      this._retarget();
    }

    // Safety net: terrain under the player is always visible.
    const center = this.chunks.get(key(cx, cz));
    if (center && !center.built) this._build(center);

    // Nearest-first incremental building; 2/frame only under backlog.
    const perFrame = this.queue.length > 8 ? 2 : 1;
    for (let i = 0; i < perFrame && this.queue.length > 0; i++) {
      let best = 0, bestD = Infinity;
      for (let q = 0; q < this.queue.length; q++) {
        const c = this.chunks.get(this.queue[q]);
        if (!c) { this.queue.splice(q, 1); q--; continue; }
        const d = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz));
        if (d < bestD) { bestD = d; best = q; }
      }
      if (this.queue.length === 0) break;
      const c = this.chunks.get(this.queue.splice(best, 1)[0]);
      if (c) this._build(c);
    }

    if (this._instancesDirty) {
      this._instancesDirty = false;
      this.pools.rebuild(this.chunks.values());
      this._rebuildColliders();
    }
  }

  /** Recompute the desired chunk set after the player crossed a boundary. */
  _retarget() {
    const cx = this._pcx, cz = this._pcz;
    // Recycle far chunks.
    for (const [k, c] of this.chunks) {
      if (Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) > LOAD_R) {
        this._release(c);
        this.chunks.delete(k);
        this._instancesDirty = true;
      }
    }
    // Ensure required chunks exist with the right LOD role.
    for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
      for (let dz = -LOAD_R; dz <= LOAD_R; dz++) {
        const ccx = cx + dx, ccz = cz + dz;
        // Mountain-dome chunks always build at full resolution: 4 m sampling
        // on steep modulated slopes visibly diverges from the analytic
        // surface the physics rides on.
        const role =
          Math.max(Math.abs(dx), Math.abs(dz)) <= INNER_R || this._onMountain(ccx, ccz)
            ? 'inner'
            : 'outer';
        const k = key(ccx, ccz);
        let c = this.chunks.get(k);
        if (!c) {
          c = { key: k, cx: ccx, cz: ccz, role, built: false, mesh: null, props: [], colliders: [] };
          this._scatter(c);
          this.chunks.set(k, c);
          this.queue.push(k);
          this._instancesDirty = true;
        } else if (c.role !== role) {
          c.role = role;
          this._releaseMesh(c);
          c.built = false;
          if (!this.queue.includes(k)) this.queue.push(k);
        }
      }
    }
  }

  /** True if a chunk overlaps a mountain destination's dome. */
  _onMountain(ccx, ccz) {
    const mn = this.gen.summitAt(ccx * CHUNK_SIZE + CHUNK_SIZE / 2, ccz * CHUNK_SIZE + CHUNK_SIZE / 2, 1e9);
    if (!mn) return false;
    const d = Math.hypot(ccx * CHUNK_SIZE + CHUNK_SIZE / 2 - mn.x, ccz * CHUNK_SIZE + CHUNK_SIZE / 2 - mn.z);
    return d < mn.R + 46; // dome + a little of the surrounding approach
  }

  _release(c) {
    this._releaseMesh(c);
    c.props.length = 0;
    c.colliders.length = 0;
  }

  _releaseMesh(c) {
    if (!c.mesh) return;
    (c.meshPool === 'inner' ? this._innerPool : this._outerPool).release(c.mesh);
    c.mesh = null;
  }

  /** Fill one pooled terrain mesh with sampled heights/colors/normals. */
  _build(c) {
    const pool = c.role === 'inner' ? this._innerPool : this._outerPool;
    this._releaseMesh(c);
    const mesh = pool.acquire();
    if (!mesh) { c.built = true; return; } // pool exhausted (cannot happen with sized pools)
    c.mesh = mesh;
    c.meshPool = c.role;

    const N = pool.res;
    const step = CHUNK_SIZE / N;
    const ox = c.cx * CHUNK_SIZE, oz = c.cz * CHUNK_SIZE;
    const G = N + 3; // sample grid incl. 1-cell border for normals
    const grid = pool.scratch;
    const geo = mesh.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    const nor = geo.attributes.normal.array;
    const info = this._info, rgb = this._color;
    const colScratch = pool.colorScratch;

    let minH = Infinity, maxH = -Infinity;
    for (let J = 0; J < G; J++) {
      for (let I = 0; I < G; I++) {
        const wx = ox + (I - 1) * step, wz = oz + (J - 1) * step;
        const border = I === 0 || J === 0 || I === G - 1 || J === G - 1;
        let h;
        if (border) {
          h = this.gen.height(wx, wz);
        } else {
          this.gen.sampleInfo(wx, wz, info);
          h = info.h;
          this.gen.colorFor(info, rgb);
          const ci = ((J - 1) * (N + 1) + (I - 1)) * 3;
          colScratch[ci] = rgb[0]; colScratch[ci + 1] = rgb[1]; colScratch[ci + 2] = rgb[2];
        }
        grid[J * G + I] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    // Main grid vertices.
    const inv = 1 / (2 * step);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const v = j * (N + 1) + i;
        const gi = (j + 1) * G + (i + 1);
        const h = grid[gi];
        pos[v * 3] = i * step;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = j * step;
        let nx = (grid[gi - 1] - grid[gi + 1]) * inv;
        let nz = (grid[gi - G] - grid[gi + G]) * inv;
        let ny = 1;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        // Slope shading: steep faces turn rocky-brown and darken slightly.
        const rockMix = sstep(0.80, 0.58, ny);
        const shade = 0.78 + 0.22 * ny;
        col[v * 3] = (colScratch[v * 3] + (0.45 - colScratch[v * 3]) * rockMix) * shade;
        col[v * 3 + 1] = (colScratch[v * 3 + 1] + (0.40 - colScratch[v * 3 + 1]) * rockMix) * shade;
        col[v * 3 + 2] = (colScratch[v * 3 + 2] + (0.33 - colScratch[v * 3 + 2]) * rockMix) * shade;
      }
    }
    // Skirt vertices: copy the matching edge vertex, dropped by SKIRT.
    const perim = pool.perimeter;
    const base = (N + 1) * (N + 1);
    for (let k2 = 0; k2 < perim.length; k2++) {
      const src = perim[k2], dst = base + k2;
      pos[dst * 3] = pos[src * 3];
      pos[dst * 3 + 1] = pos[src * 3 + 1] - SKIRT;
      pos[dst * 3 + 2] = pos[src * 3 + 2];
      nor[dst * 3] = nor[src * 3]; nor[dst * 3 + 1] = nor[src * 3 + 1]; nor[dst * 3 + 2] = nor[src * 3 + 2];
      col[dst * 3] = col[src * 3]; col[dst * 3 + 1] = col[src * 3 + 1]; col[dst * 3 + 2] = col[src * 3 + 2];
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    const half = CHUNK_SIZE / 2;
    geo.boundingSphere.center.set(half, (minH + maxH) / 2, half);
    geo.boundingSphere.radius = Math.hypot(half * 1.42, (maxH - minH) / 2 + SKIRT);

    mesh.position.set(ox, 0, oz);
    mesh.updateMatrix();
    mesh.visible = true;
    c.built = true;
    this._instancesDirty = true;
  }

  /** Deterministic per-chunk prop scatter (independent of load order). */
  _scatter(c) {
    const rng = mulberry32(hashInt(c.cx, c.cz, this.gen.seed ^ 0x51ab));
    const info = this._info;
    const ox = c.cx * CHUNK_SIZE, oz = c.cz * CHUNK_SIZE;

    // Feature deck props (ramp/bridge) owned by the chunk containing them.
    this.gen.featuresInRect(ox, oz, ox + CHUNK_SIZE, oz + CHUNK_SIZE, (f) => {
      if (f.x < ox || f.x >= ox + CHUNK_SIZE || f.z < oz || f.z >= oz + CHUNK_SIZE) return;
      const yaw = Math.atan2(f.dx, f.dz);
      if (f.type === 'ramp') c.props.push({ t: PROP.ramp, x: f.x, y: f.h0, z: f.z, yaw, s: 1 });
      else if (f.type === 'bridge') c.props.push({ t: PROP.bridge, x: f.x, y: f.h0 - 0.14, z: f.z, yaw, s: 1 });
    });

    // Signature road-bridge decks owned by this chunk.
    const near = this.gen.nearestMountain(ox + CHUNK_SIZE / 2, oz + CHUNK_SIZE / 2, 1);
    if (near && near.bridgePts) {
      for (const bp of near.bridgePts) {
        if (bp.x >= ox && bp.x < ox + CHUNK_SIZE && bp.z >= oz && bp.z < oz + CHUNK_SIZE) {
          c.props.push({ t: PROP.bridge, x: bp.x, y: bp.h0 - 0.16, z: bp.z,
            yaw: Math.atan2(bp.dx, bp.dz), s: 1.3 });
        }
      }
    }

    // Summit markers: a prayer-flag pole + small chorten beside the peak of
    // any mountain destination whose summit lies in this chunk.
    const summit = this.gen.summitAt(ox + CHUNK_SIZE / 2, oz + CHUNK_SIZE / 2, CHUNK_SIZE);
    if (summit && summit.x >= ox && summit.x < ox + CHUNK_SIZE &&
        summit.z >= oz && summit.z < oz + CHUNK_SIZE) {
      const mark = (t, dx, dz, yaw, s2 = 1, collR = 0) => {
        const y = this.gen.height(summit.x + dx, summit.z + dz);
        c.props.push({ t, x: summit.x + dx, y: y - 0.12, z: summit.z + dz, yaw, s: s2 });
        if (collR) c.colliders.push({ x: summit.x + dx, z: summit.z + dz, r: collR });
      };
      const kind = summit.kind || 0;
      if (kind === 1 || kind === 6) {
        // Hero summits: chorten flanked by a line of prayer flags.
        mark(PROP.stupa, -7, 4, 2.1, 1.25, 1.3);
        mark(PROP.flagpole, 7, -1, 0.6);
        mark(PROP.flagpole, 10, 4, 1.7);
        mark(PROP.flagpole, 4, 9, 2.9);
      } else if (kind === 3) {
        // Rock peak: cairn of boulders.
        mark(PROP.rock, 6, 2, 0.4, 1.6, 1.3);
        mark(PROP.rock, 8, 5, 1.9, 1.1);
        mark(PROP.rock, 4, 6, 3.1, 0.8);
        mark(PROP.flagpole, -6, -3, 1.2);
      } else if (kind === 5) {
        // Village peak: shrine + haystack pair.
        mark(PROP.stupa, -6, 4, 2.1, 1, 1.1);
        mark(PROP.haystack, 7, 2, 0.8);
        mark(PROP.wall, 4, -7, 1.2);
      } else {
        mark(PROP.flagpole, 7, 0, 0.6);
        mark(PROP.stupa, -6, 4, 2.1, 1, 1.1);
      }
    }

    // Phase 3L-1: village buildings owned by this chunk (placed through the
    // normal prop/collider pipeline, so instancing + streaming are free).
    // Villages also clear trees inside their footprint (see below).
    let clearings = null;
    const inject = (settlements) => {
      for (const v of settlements) {
        (clearings = clearings || []).push(v);
        for (const it of v.items) {
          if (it.x < ox || it.x >= ox + CHUNK_SIZE || it.z < oz || it.z >= oz + CHUNK_SIZE) continue;
          const prop = { t: PROP[it.type], x: it.x, y: this.gen.height(it.x, it.z) - it.sink,
            z: it.z, yaw: it.yaw, s: it.s };
          if (it.rx) prop.rx = it.rx; // terrain-pitched strips (city streets)
          c.props.push(prop);
          if (it.collR > 0) c.colliders.push({ x: it.x, z: it.z, r: it.collR * it.s });
        }
      }
    };
    if (this.villages) inject(this.villages.forChunk(ox, oz, CHUNK_SIZE));
    if (this.towns) inject(this.towns.forChunk(ox, oz, CHUNK_SIZE));
    if (this.cities) inject(this.cities.forChunk(ox, oz, CHUNK_SIZE));
    if (this.industry) inject(this.industry.forChunk(ox, oz, CHUNK_SIZE));
    const inClearing = (x, z) => {
      if (!clearings) return false;
      for (const v of clearings) {
        const dx = x - v.x, dz = z - v.z;
        // +22 m: keep the surrounding tree belt back from the houses so
        // villages have open, rideable approaches (discoverability fix).
        const rr = v.r + 22;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
      return false;
    };

    // Phase 3L-1 content draws from its OWN rng stream so pre-existing
    // prop/rock/tree placements stay bit-identical to earlier phases.
    const rng2 = mulberry32(hashInt(c.cx, c.cz, this.gen.seed ^ 0x7e11));

    // Phase 3L-1: water mill — rare, beside a stream, one per lucky chunk.
    if (hash01(c.cx, c.cz, this.gen.seed * 41 + 3) < 0.22) {
      for (let k2 = 0; k2 < 14; k2++) {
        const x = ox + rng2() * CHUNK_SIZE, z = oz + rng2() * CHUNK_SIZE;
        this.gen.sampleInfo(x, z, info);
        if (info.stream < 0.3 || info.stream > 0.8 || info.trail > 0.3 || info.mtn > 0.02) continue;
        if (this._normalY(x, z) < 0.9) continue;
        c.props.push({ t: PROP.mill, x, y: this.gen.height(x, z) - 0.25, z,
          yaw: rng2() * Math.PI * 2, s: 1 });
        c.colliders.push({ x, z, r: 2.1 });
        break;
      }
    }

    // Phase 3L-1F: crop fields — a deterministic 40 m field grid assigns a
    // crop per suitable cell (matched to elevation/terraces/wetness/hills);
    // each field plants ORGANIZED ROW STRIPS (one instance = a merged 5.5 m
    // row of plants). Strips are owned by the chunk containing their
    // center, all placement derives from field/row indices (chunk-order
    // independent), and every strip is individually terrain-validated.
    {
      const FIELD = 40;
      let cropCount = 0;
      const f0x = Math.floor((ox - FIELD) / FIELD), f1x = Math.floor((ox + CHUNK_SIZE + FIELD) / FIELD);
      const f0z = Math.floor((oz - FIELD) / FIELD), f1z = Math.floor((oz + CHUNK_SIZE + FIELD) / FIELD);
      for (let fx = f0x; fx <= f1x && cropCount < 18; fx++) {
        for (let fz = f0z; fz <= f1z && cropCount < 18; fz++) {
          const crop = this._cropField(fx, fz);
          if (!crop) continue;
          const cxc = (fx + 0.5) * FIELD, czc = (fz + 0.5) * FIELD;
          const dirI = Math.floor(hash01(fx, fz, this.gen.seed * 47 + 5) * 4);
          const a = dirI * (Math.PI / 4);
          const rdx = Math.cos(a), rdz = Math.sin(a);        // along the row
          const pdx = -rdz, pdz = rdx;                       // across rows
          if (crop === 'banana') {
            // Fruit grove: a loose cluster instead of rows.
            for (let i = 0; i < 5; i++) {
              const x = cxc + (hash01(fx * 7 + i, fz, this.gen.seed + 61) - 0.5) * 22;
              const z = czc + (hash01(fx, fz * 7 + i, this.gen.seed + 62) - 0.5) * 22;
              if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) continue;
              if (!this._cropSpotOk(x, z, info, 0.25)) continue;
              c.props.push({ t: PROP.banana, x, y: this.gen.height(x, z) - 0.1, z,
                yaw: hash01(i, fx + fz, 9) * 6.28, s: 0.9 + hash01(i, fx - fz, 10) * 0.35 });
              cropCount++;
            }
            continue;
          }
          const rows = 4, segs = 3;
          const rowGap = crop === 'tea' ? 3.4 : 2.9;
          for (let rI = 0; rI < rows; rI++) {
            for (let sI = 0; sI < segs; sI++) {
              const off = (rI - (rows - 1) / 2) * rowGap;
              const along = (sI - (segs - 1) / 2) * 6.1;
              const x = cxc + rdx * along + pdx * off;
              const z = czc + rdz * along + pdz * off;
              if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) continue;
              if (!this._cropSpotOk(x, z, info, crop === 'rice' ? 0.5 : 0.25)) continue;
              if (inClearing(x, z)) continue;
              if (crop === 'corn') {
                // Corn rows reuse the clump prop, two clumps per segment.
                for (const dd of [-1.4, 1.4]) {
                  c.props.push({ t: PROP.corn, x: x + rdx * dd, z: z + rdz * dd,
                    y: this.gen.height(x + rdx * dd, z + rdz * dd) - 0.05,
                    yaw: hash01(rI * 7 + sI, fx + fz, 11) * 6.28, s: 0.9 + hash01(sI, rI, 12) * 0.3 });
                }
              } else {
                c.props.push({ t: PROP[crop], x, y: this.gen.height(x, z) - 0.12, z,
                  yaw: a, s: 0.95 + hash01(rI * 5 + sI, fx * 3 + fz, 13) * 0.15 });
              }
              cropCount++;
            }
          }
          // Paddies get a simple irrigation channel along the field edge.
          if (crop === 'rice') {
            const chx = cxc + pdx * ((rows + 0.6) / 2) * rowGap;
            const chz = czc + pdz * ((rows + 0.6) / 2) * rowGap;
            if (chx >= ox && chx < ox + CHUNK_SIZE && chz >= oz && chz < oz + CHUNK_SIZE &&
                this._cropSpotOk(chx, chz, info, 0.6)) {
              c.props.push({ t: PROP.channel, x: chx, y: this.gen.height(chx, chz) - 0.04, z: chz,
                yaw: a, s: 1.6 });
            }
          }
        }
      }
    }

    // Micro-props: grass tufts, small stones, fallen branches. Denser and
    // road-tolerant (they may line trail edges), never collide, and their
    // density follows a coherent patch noise so meadows/clearings vary.
    for (let k2 = 0; k2 < 18 && c.props.length < MAX_PROPS_PER_CHUNK; k2++) {
      const x = ox + rng() * CHUNK_SIZE;
      const z = oz + rng() * CHUNK_SIZE;
      this.gen.sampleInfo(x, z, info);
      if (info.trail > 0.6 || info.stream > 0.3) continue; // keep path centers clean
      if (this.gen.nearFeature(x, z)) continue;
      const patch = vnoise(x * 0.02 + 7.7, z * 0.02 - 3.3, this.gen.seed * 13 + 91);
      const lush = (info.wH + info.wFa * 0.9 + info.wF * 0.6) * (0.3 + patch);
      const pick = rng();
      let t = -1, s = 0.7 + rng() * 0.7, sink = 0.05;
      if (pick < 0.62 * lush) t = PROP.grass;
      else if (pick < 0.62 * lush + 0.20 * (info.wRk + info.wMnt + info.mtn * 0.8 + 0.12)) {
        t = PROP.stone; sink = 0.08 + (1 - this._normalY(x, z)) * 0.5;
      }
      else if (pick < 0.62 * lush + 0.34 && info.wF > 0.4) { t = PROP.branch; sink = 0.05; }
      if (t < 0) continue;
      c.props.push({ t, x, y: this.gen.height(x, z) - sink, z, yaw: rng() * Math.PI * 2, s });
    }

    for (let k2 = 0; k2 < 44 && c.props.length < MAX_PROPS_PER_CHUNK; k2++) {
      const x = ox + rng() * CHUNK_SIZE;
      const z = oz + rng() * CHUNK_SIZE;
      this.gen.sampleInfo(x, z, info);
      if (info.trail > 0.25 || info.stream > 0.15) continue;   // keep paths ridable
      if (this.gen.nearFeature(x, z)) continue;                // clear jump landings
      if (inClearing(x, z)) continue;                          // village footprints stay open
      const ny = this._normalY(x, z);
      const pick = rng();

      // Biome-weighted type selection (many attempts intentionally place
      // nothing — open, breathable landscape). Mountain destinations use
      // their own rules: dense pine band low, rocks high, no farm props.
      let t = -1, s = 1, sink = 0.1, collR = 0;
      const wH = info.wH, wF = info.wF, wFa = info.wFa, wRk = info.wRk, wMnt = info.wMnt;
      const forestPatch = 0.45 + 1.1 * vnoise(x * 0.012 - 11.1, z * 0.012 + 8.8, this.gen.seed * 13 + 92);
      if (info.mtn > 0.04) {
        const ref = info.mtnRef;
        const forestMul = ref && ref.forestMul !== undefined ? ref.forestMul : 1;
        // Deep-forest kinds keep trees higher up the dome.
        const bandTop = forestMul > 1.2 ? 0.72 : 0.45;
        const band = sstep(0.05, 0.15, info.mtn) * (1 - sstep(bandTop, bandTop + 0.15, info.mtn));
        let acc = 1.0 * band * forestPatch * forestMul + (ref && ref.barren ? 0.02 : 0.08);
        if (pick < acc && ny > 0.8) { t = PROP.pine; s = 0.8 + rng() * 0.7; collR = 0.5 * s; }
        else if (pick < (acc += (0.5 + (ref && ref.rockBig ? 0.35 : 0)) * sstep(0.45, 0.65, info.mtn) + 0.05)) {
          t = PROP.rock;
          s = (0.5 + rng() * 1.1) * (ref && ref.rockBig ? 1.7 : 1);
          sink = 0.25 * s;
          if (s > 0.75) collR = 0.85 * s;
        }
        else if (pick < (acc += 0.18 * band)) { t = PROP.bush; s = 0.7 + rng() * 0.8; }
        else if (ref && ref.village && info.mtn > 0.05 && info.mtn < 0.3) {
          // Kind-5 lower dome: terraced village life.
          if (pick < acc + 0.05 && ny > 0.94) { t = PROP.house; collR = 2.4; sink = 0.2; }
          else if (pick < acc + 0.15 && ny > 0.88) { t = PROP.haystack; s = 0.8 + rng() * 0.5; }
          else if (pick < acc + 0.24 && ny > 0.85) { t = PROP.wall; s = 0.9 + rng() * 0.4; sink = 0.15; }
        }
      } else {
      let acc = (0.78 * wF + 0.08 * wH) * forestPatch + 0.12 * wRk + 0.06 * wMnt;
      if (pick < acc && ny > 0.82) { t = PROP.pine; s = 0.8 + rng() * 0.7; collR = 0.5 * s; }
      else if (pick < (acc += 0.36 * wH + 0.15 * wFa) && ny > 0.82) { t = PROP.tree; s = 0.8 + rng() * 0.6; collR = 0.5 * s; }
      else if (pick < (acc += 0.34 * wH + 0.30 * wF + 0.16 * wRk + 0.10 * wFa)) { t = PROP.bush; s = 0.7 + rng() * 0.8; }
      else if (pick < (acc += 0.14 * wH + 0.16 * wF + 0.60 * wRk + 0.65 * wMnt)) {
        t = PROP.rock; s = 0.5 + rng() * 1.1; sink = 0.25 * s;
        if (s > 0.75) collR = 0.85 * s;
      }
      else if (pick < (acc += 0.14 * wF)) { t = PROP.log; s = 0.8 + rng() * 0.5; }
      else if (pick < (acc += 0.22 * wFa) && ny > 0.9) { t = PROP.haystack; s = 0.8 + rng() * 0.5; }
      else if (pick < (acc += 0.05 * wFa + 0.012 * wH) && ny > 0.955) { t = PROP.house; collR = 2.4; sink = 0.2; }
      else if (pick < (acc += 0.16 * wFa) && ny > 0.9) { t = PROP.wall; s = 0.9 + rng() * 0.4; sink = 0.15; }
      else if (pick < (acc += 0.012 * (wMnt + wRk)) && ny > 0.9) { t = PROP.flagpole; collR = 0.3; }
      else if (pick < (acc += 0.007 * (wMnt + wRk + wH)) && ny > 0.93) { t = PROP.stupa; collR = 1.1; sink = 0.15; }
      }
      if (t < 0) continue;

      // Sink props deeper on slopes so their downhill edge never floats.
      if (t === PROP.rock) sink += (1 - ny) * 1.3 * s;
      else if (t === PROP.pine || t === PROP.tree) sink += (1 - ny) * 0.8 * s;
      else if (t === PROP.bush || t === PROP.log) sink += (1 - ny) * 0.6 * s;

      const y = this.gen.height(x, z) - sink;
      const prop = { t, x, y, z, yaw: rng() * Math.PI * 2, s };
      if (t === PROP.rock) prop.rx = (rng() - 0.5) * 0.5;
      c.props.push(prop);
      if (collR > 0) c.colliders.push({ x, z, r: collR });
    }
  }

  /**
   * Crop for a 40 m field cell, or null (Phase 3L-1F). Deterministic and
   * matched to terrain: rice on wet terraced lowland, wheat/mustard on low
   * flat farms, veg beside villages, tea on eastern-style hills, potatoes
   * on cooler high ground, corn through the village farm belt.
   */
  _cropField(fx, fz) {
    if (hash01(fx, fz, this.gen.seed * 53 + 17) > 0.55) return null;
    const info = this._info;
    const x = (fx + 0.5) * 40, z = (fz + 0.5) * 40;
    this.gen.sampleInfo(x, z, info);
    if (info.mtn > 0.02 || info.trail > 0.45 || info.stream > 0.55) return null;
    const h = info.h;
    const ny = this._normalY(x, z);
    if (ny < 0.87) return null;
    const pick = hash01(fz, fx, this.gen.seed * 59 + 23);
    if (info.terr > 0.3 && h < 9 && info.lo > 0.6) return 'rice';
    if (h < 5 && info.lo > 0.8 && info.wFa > 0.3 && pick < 0.4) return 'banana';
    if (this.villages) {
      const nv = this.villages.nearest(x, z, 1);
      if (nv && nv.d < 150 && nv.d > 45 && pick < 0.5) return 'veg';
    }
    if (info.wFa > 0.45 && info.terr < 0.3 && h < 13) return pick < 0.55 ? 'wheat' : 'mustard';
    // Elevation windows match THIS world's lowland relief (roughly -5..+15 m
    // off the mountain domes): tea takes the upper hillsides, potatoes the
    // coolest high ground.
    if (info.wH > 0.5 && h >= 6 && ny > 0.9 && pick < 0.6) return 'tea';
    if (h >= 9 && info.wH + info.wRk > 0.55) return 'potato';
    if (info.wFa + info.wH > 0.55 && h >= 4 && h <= 26) return 'corn';
    return null;
  }

  /** A single crop strip must sit on plantable ground. */
  _cropSpotOk(x, z, info, streamLim) {
    this.gen.sampleInfo(x, z, info);
    if (info.trail > 0.3 || info.stream > streamLim || info.mtn > 0.02) return false;
    if (this.gen.nearFeature(x, z)) return false;
    return this._normalY(x, z) > 0.88;
  }

  _normalY(x, z) {
    const e = 1.2;
    const dx = this.gen.height(x + e, z) - this.gen.height(x - e, z);
    const dz = this.gen.height(x, z + e) - this.gen.height(x, z - e);
    return (2 * e) / Math.hypot(dx, 2 * e, dz);
  }

  /** Colliders from the player's 3x3 chunk neighborhood only. */
  _rebuildColliders() {
    this.activeColliders.length = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = this.chunks.get(key(this._pcx + dx, this._pcz + dz));
        if (!c) continue;
        for (let i = 0; i < c.colliders.length; i++) this.activeColliders.push(c.colliders[i]);
      }
    }
  }

  /** Debug/verification surface (used by automated tests). */
  debugInfo() {
    let built = 0;
    for (const c of this.chunks.values()) if (c.built) built++;
    return {
      chunks: this.chunks.size,
      built,
      queued: this.queue.length,
      colliders: this.activeColliders.length,
      instances: this.pools.totalInstances(),
      meshPoolFree: this._innerPool.free.length + this._outerPool.free.length,
    };
  }
}

function key(cx, cz) {
  return cx + ',' + cz;
}

/**
 * Fixed pool of terrain meshes for one LOD level. Geometry index/topology is
 * static; rebuilds only rewrite vertex data. Includes the skirt ring.
 */
class MeshPool {
  constructor(scene, res, capacity, material) {
    this.res = res;
    this.free = [];
    const G = res + 3;
    this.scratch = new Float32Array(G * G);
    this.colorScratch = new Float32Array((res + 1) * (res + 1) * 3);
    this.perimeter = buildPerimeter(res);
    for (let i = 0; i < capacity; i++) {
      const mesh = new THREE.Mesh(buildChunkGeometry(res, this.perimeter), material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.free.push(mesh);
    }
  }

  acquire() { return this.free.pop() || null; }

  release(mesh) {
    mesh.visible = false;
    this.free.push(mesh);
  }
}

/** Counter-clockwise boundary walk (viewed from above) — 4N vertex indices. */
function buildPerimeter(N) {
  const perim = [];
  const v = (i, j) => j * (N + 1) + i;
  for (let i = 0; i < N; i++) perim.push(v(i, 0));
  for (let j = 0; j < N; j++) perim.push(v(N, j));
  for (let i = N; i > 0; i--) perim.push(v(i, N));
  for (let j = N; j > 0; j--) perim.push(v(0, j));
  return perim;
}

function buildChunkGeometry(N, perim) {
  const mainCount = (N + 1) * (N + 1);
  const total = mainCount + perim.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));

  const idx = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Skirt quads: consecutive perimeter pairs; CCW walk keeps winding outward.
  const M = perim.length;
  for (let k = 0; k < M; k++) {
    const a = perim[k], b = perim[(k + 1) % M];
    const sa = mainCount + k, sb = mainCount + ((k + 1) % M);
    idx.push(a, b, sb, a, sb, sa);
  }
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere();
  return geo;
}
