import * as THREE from 'three';
import { ChunkGrid } from './streaming/ChunkGrid.js';
import { ObjectPool } from './streaming/ObjectPool.js';
import { colorFor } from './palette.js';
import { detailTexture } from './textures.js';

/**
 * TerrainTiles (Phase 2) — sculpted terrain rendering for the fixed world.
 *
 * EXTENDS the Phase 1B streaming architecture (ChunkGrid + ObjectPool are
 * reused untouched): the 500 m sector window stays the logical streaming
 * layer; this class adds a finer RENDER layer of 125 m terrain tiles in a
 * 7x7 window (~437 m radius — past the fog wall, so tiles never pop
 * visibly). All tiles share one uniform 3.125 m lattice:
 *
 *   vertex world x = tileOrigin + i * 3.125   (both exact binary numbers)
 *
 * so two adjacent tiles evaluate the SAME analytic field at the SAME
 * world coordinate on their shared edge — borders are bit-identical and
 * seamless by construction. Uniform resolution means no T-junctions, so
 * no cracks and no skirts needed. (The lattice is LOD-ready: a coarser
 * ring can be added later with the old skirt trick.)
 *
 * Meshes come from a fixed ObjectPool; a rebuild only rewrites vertex
 * buffers. Builds are queued nearest-first, 2 per frame — crossing a tile
 * boundary never stalls a frame, and the player's own tile is always
 * built synchronously as a safety net.
 *
 * One shared vertex-colored Lambert material; no textures at all.
 */

export const TILE = 125;
const RES = 32;              // quads per side -> 3.90625 m cells (exact binary)
const CELL = TILE / RES;
// Chapter 3A/3D anti-popping: VISIBLE window 9x9 (edge ~560 m, deep in
// the haze) PLUS a pre-build ring at radius 5 (Chapter 3D): those tiles
// are fully built but hidden; when the player crosses a tile boundary
// the incoming ring only flips visible=true — zero build latency at the
// moment a tile enters view, so mesh popping cannot happen from build
// lag. Pool is fixed at startup: zero runtime allocations.
const RADIUS = 5;            // 11x11 grid window (outermost ring hidden)
const VIS_R = 4;             // 9x9 visible window
const POOL = 125;            // 121 + spare
// Chapter 5 frame budget for terrain building (ms). Measured cost of one
// tile after the Chapter 5 sampling work: ~1.5 ms on a desktop, ~4-5 ms
// on a slow device. The budget is checked BEFORE each additional tile, so
// a frame spends at most (budget + one tile): fast hardware drains a
// boundary crossing in 3-4 frames, slow hardware falls back to exactly
// one tile per frame instead of blowing the frame.
const BUDGET_MS = 2.2;
// Minimum work done when a tile is STARTED (so a build always progresses
// even if the frame budget was already spent picking it).
const SLICE_MIN_MS = 0.4;
const BUDGET_BURST = 8.0;
const now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() : () => Date.now();
// Chapter 5 relief shading. SUN_* is the normalized direction of the sun
// rig in SectorWorld (offset +140, +150, +80 from the player); SUN_FLAT
// is its dot with flat ground, i.e. the neutral pivot. CURV_SOFT sets how
// deep a hollow has to be (in metres of Laplacian) to reach half shading.
const SUN_X = 0.632, SUN_Y = 0.677, SUN_Z = 0.361;
const SUN_FLAT = SUN_Y;
const CURV_SOFT = 0.4;
const WORLD_W = 8000, WORLD_H = 5000;

export class TerrainTiles {
  constructor(scene, field) {
    this.field = field;
    // Chapter 3B: hand-painted detail map multiplied over the vertex-color
    // palette (one shared 256px canvas texture, world-space tiled UVs).
    this._mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detailTexture() });
    this._detailOn = true;
    this._pool = new ObjectPool(() => this._makeMesh(scene), POOL);
    this._grid = new ChunkGrid(TILE, RADIUS);
    this._queue = [];
    this._info = { h: 0, trail: 0, moist: 0, mtn: 0 };
    this._rgb = [0, 0, 0];
    // (RES+3)^2 height grid incl. 1-cell border for normals.
    this._hgrid = new Float32Array((RES + 3) * (RES + 3));
    this._cur = null; // in-flight resumable tile build
    this.built = 0;   // debug counter
  }

  /** Graphics quality hook: toggle the painted brushwork detail map. */
  setDetail(on) {
    if (on === this._detailOn) return;
    this._detailOn = on;
    this._mat.map = on ? detailTexture() : null;
    this._mat.needsUpdate = true;
  }

  update(px, pz) {
    const moved = this._grid.update(
      px, pz,
      (cx, cz) => this._enter(cx, cz),
      (cx, cz, rec) => this._leave(rec)
    );
    if (moved) {
      // Chapter 3D: refresh ring visibility — pre-built outer-ring tiles
      // entering the 9x9 window just flip visible (no build, no pop).
      this._ccx = Math.floor(px / TILE);
      this._ccz = Math.floor(pz / TILE);
      for (const rec of this._grid.cells.values()) {
        if (!rec || rec === true || !rec.built) continue;
        rec.mesh.visible =
          Math.max(Math.abs(rec.cx - this._ccx), Math.abs(rec.cz - this._ccz)) <= VIS_R;
      }
    }

    // Safety net: the tile under the player is always built, right now.
    const center = this._grid.cells.get(
      ChunkGrid.key(Math.floor(px / TILE), Math.floor(pz / TILE)));
    if (center && center !== true && !center.built) this._buildFull(center);

    // Chapter 5 — RESUMABLE, TIME-BUDGETED terrain building.
    //
    // A whole tile is 1,225 terrain samples: 1.5 ms on a desktop but 5-10
    // ms on a phone, so "one tile per frame" WAS the frame drop players
    // felt while riding — a boundary crossing enqueues ~11 of them. The
    // builder now works in row slices and stops as soon as it has used
    // its slice of the frame, picking up exactly where it left off next
    // frame. Worst case per frame is now (budget + one row), whatever the
    // device. Only one tile is ever in flight, so the shared height grid
    // stays valid, and a tile becomes visible only once it is complete.
    const burst = this._queue.length > 40;
    const budget = burst ? BUDGET_BURST : BUDGET_MS;
    const t0 = now();
    for (;;) {
      if (this._cur) {
        this._slice(budget, t0);
        if (this._cur) break;           // still unfinished: out of budget
      }
      if (this._queue.length === 0 || now() - t0 >= budget) break;
      const rec = this._nextQueued(px, pz);
      if (!rec) break;
      this._build(rec);
    }
  }

  /** Pop the queued tile nearest the player (dropping released records). */
  _nextQueued(px, pz) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this._queue.length; i++) {
      const r = this._queue[i];
      if (r.released || r.built) { this._queue.splice(i, 1); i--; continue; }
      const d = Math.max(Math.abs((r.cx + 0.5) * TILE - px),
        Math.abs((r.cz + 0.5) * TILE - pz));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best < 0 ? null : this._queue.splice(best, 1)[0];
  }

  /** Remaining unbuilt tiles (loading-screen progress). */
  get pending() {
    return this._queue.length;
  }

  /** Build up to n queued tiles immediately (loading-screen warm-up). */
  drainSome(n, px, pz) {
    if (this._cur) this._slice(Infinity, 0); // finish whatever is in flight
    for (let k = 0; k < n && this._queue.length > 0; k++) {
      const rec = this._nextQueued(px, pz);
      if (!rec) break;
      this._buildFull(rec);
    }
    return this._queue.length;
  }

  _enter(cx, cz) {
    // Never generate outside the permanent world rectangle.
    if (cx < 0 || cx * TILE >= WORLD_W || cz < 0 || cz * TILE >= WORLD_H) return null;
    const mesh = this._pool.acquire();
    if (!mesh) return null;
    const rec = { cx, cz, mesh, built: false, released: false };
    this._queue.push(rec);
    return rec;
  }

  _leave(rec) {
    if (!rec || rec === true) return;
    rec.released = true;
    if (this._cur && this._cur.rec === rec) this._cur = null; // abort in flight
    this._pool.release(rec.mesh);
  }

  /** Count of built tiles: [visible, prebuilt-hidden] (debug overlay). */
  count() {
    let n = 0, hid = 0;
    for (const rec of this._grid.cells.values()) {
      if (rec && rec !== true && rec.built) {
        if (rec.mesh.visible) n++; else hid++;
      }
    }
    this.hidden = hid;
    return n;
  }

  /**
   * BEGIN building one pooled mesh from the analytic field (Chapter 5).
   * Sets the tile up as the in-flight job and immediately runs the first
   * slice; `_slice()` finishes it over the following frames. Kept as the
   * single entry point for a tile so build instrumentation still sees
   * exactly one call per tile.
   */
  _build(rec) {
    if (this._cur) this._slice(Infinity, 0); // never two grids at once
    this._cur = {
      rec,
      ox: rec.cx * TILE,
      oz: rec.cz * TILE,
      phase: 0,   // 0 = sample rows, 1 = vertex rows
      row: 0,
      minH: Infinity,
      maxH: -Infinity,
    };
    this._slice(SLICE_MIN_MS, now());
  }

  /** Build a tile to completion in this call (loader + player's own tile). */
  _buildFull(rec) {
    this._build(rec);
    if (this._cur && this._cur.rec === rec) this._slice(Infinity, 0);
  }

  /**
   * Advance the in-flight tile while the frame budget allows. One row of
   * the sample pass costs ~35 terrain samples (~0.1-0.3 ms), so the
   * granularity is fine enough that no device can overshoot a frame.
   */
  _slice(budgetMs, t0) {
    const c = this._cur;
    if (!c) return;
    const rec = c.rec;
    if (rec.released) { this._cur = null; return; }
    const G = RES + 3;
    const grid = this._hgrid;
    const info = this._info;
    const field = this.field;
    const mesh = rec.mesh;
    const attrs = mesh.geometry.attributes;
    const pos = attrs.position.array;
    const col = attrs.color.array;
    const nor = attrs.normal.array;
    const uv = attrs.uv.array;
    const ox = c.ox, oz = c.oz;
    const unlimited = budgetMs === Infinity;

    while (true) {
      if (c.phase === 0) {
        // Sample pass: interior vertices get full info (color), the
        // 1-cell border ring only height (for normals).
        const J = c.row;
        const wz = oz + (J - 1) * CELL;
        const edgeRow = J === 0 || J === G - 1;
        let minH = c.minH, maxH = c.maxH;
        for (let I = 0; I < G; I++) {
          const wx = ox + (I - 1) * CELL;
          let h;
          if (edgeRow || I === 0 || I === G - 1) {
            h = field.height(wx, wz);
          } else {
            field.sample(wx, wz, info);
            h = info.h;
            const v = ((J - 1) * (RES + 1) + (I - 1)) * 3;
            // Shared Phase 3 palette: grass -> basin scrub -> rock ->
            // snow, dirt roads on top (same bands as the far backdrop).
            colorFor(info, this._rgb, wx, wz);
            col[v] = this._rgb[0]; col[v + 1] = this._rgb[1]; col[v + 2] = this._rgb[2];
          }
          grid[J * G + I] = h;
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
        c.minH = minH; c.maxH = maxH;
        if (++c.row >= G) { c.phase = 1; c.row = 0; }
      } else {
        // Vertex pass: positions, grid normals, painted relief shading.
        const j = c.row;
        const inv = 1 / (2 * CELL);
        for (let i = 0; i <= RES; i++) {
          const v = j * (RES + 1) + i;
          const gi = (j + 1) * G + (i + 1);
          pos[v * 3] = i * CELL;
          pos[v * 3 + 1] = grid[gi];
          pos[v * 3 + 2] = j * CELL;
          // World-space painted-detail UV: 1 repeat per 24 m, exact
          // across tile borders because it derives from world coords.
          uv[v * 2] = (ox + i * CELL) / 24;
          uv[v * 2 + 1] = (oz + j * CELL) / 24;
          let nx = (grid[gi - 1] - grid[gi + 1]) * inv;
          let nz = (grid[gi - G] - grid[gi + G]) * inv;
          const il = 1 / Math.hypot(nx, 1, nz);
          nx *= il; nz *= il;
          const ny = il;
          nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;

          // ---- Chapter 5 painted relief (no extra terrain samples) ----
          // 1. CURVATURE AO. The discrete Laplacian of the height grid is
          //    positive in hollows (gullies, road cuts, valley floors) and
          //    negative on convex edges (ridge lines, banks, shoulders).
          //    Its neighbours are already in the grid, so it costs four
          //    adds per vertex — and it is what stops low-poly ground
          //    from reading as one flat painted sheet.
          const lap = (grid[gi - 1] + grid[gi + 1] + grid[gi - G] + grid[gi + G]) *
            0.25 - grid[gi];
          const curv = lap / (Math.abs(lap) + CURV_SOFT); // smooth, in (-1,1)
          // 2. DIRECTIONAL PAINT. The key light is the warm sun rig over
          //    (+x, +y, +z): faces turned into it take a warm bleach,
          //    faces turned away pick up cool sky bounce. Flat ground is
          //    the neutral pivot, so the meadow keeps its palette color.
          const lit = nx * SUN_X + ny * SUN_Y + nz * SUN_Z - SUN_FLAT;
          const shade = (0.82 + 0.18 * ny) *
            (1 - 0.34 * Math.max(0, curv) + 0.14 * Math.max(0, -curv));
          let cr = col[v * 3] * shade;
          let cg = col[v * 3 + 1] * shade;
          let cb = col[v * 3 + 2] * shade;
          if (lit > 0) { cr += lit * 0.11; cg += lit * 0.07; cb -= lit * 0.035; }
          else { cr += lit * 0.05; cg += lit * 0.02; cb -= lit * 0.075; }
          // ---- Chapter 6B GROUND PAINTING (slope + aspect) ------------
          // The palette is a pure function of (x, z, height, moisture),
          // so it cannot know whether a point is a flat meadow or a steep
          // bank — and a hand-painted world is mostly that distinction.
          // The normal is already here, so it costs nothing.
          //
          // 3. SLOPE WEAR. Grass thins on anything steep and the earth
          //    underneath shows through, warm and desaturated. `ny` is
          //    the cosine of the slope, so this engages from about 25 deg
          //    and is full on a cliff.
          const steep = ny < 0.90 ? (0.90 - ny) / 0.54 : 0;
          if (steep > 0) {
            const w = steep > 1 ? 1 : steep;
            cr += (0.44 - cr) * w * 0.44;
            cg += (0.36 - cg) * w * 0.44;
            cb += (0.26 - cb) * w * 0.44;
          }
          // 4. HOLLOW LUSHNESS. Water collects where the surface is
          //    concave, so gullies and valley floors take a cooler, more
          //    saturated green. Convex ground (ridge lines, banks) dries
          //    out. Together with slope wear this is what makes the
          //    ground read as painted terrain rather than a tinted mesh.
          if (curv > 0) {
            const w = curv * 0.42;
            cr += (0.26 - cr) * w; cg += (0.47 - cg) * w; cb += (0.25 - cb) * w;
          } else {
            const w = -curv * 0.22;
            cr += (0.58 - cr) * w; cg += (0.54 - cg) * w; cb += (0.33 - cb) * w;
          }
          col[v * 3] = cr < 0 ? 0 : cr;
          col[v * 3 + 1] = cg < 0 ? 0 : cg;
          col[v * 3 + 2] = cb < 0 ? 0 : cb;
        }
        if (++c.row > RES) { this._finish(c); return; }
      }
      if (!unlimited && now() - t0 >= budgetMs) return;
    }
  }

  /** Publish a finished tile: buffers, bounds, placement, visibility. */
  _finish(c) {
    const rec = c.rec;
    const mesh = rec.mesh;
    const attrs = mesh.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.color.needsUpdate = true;
    attrs.normal.needsUpdate = true;
    attrs.uv.needsUpdate = true;
    const half = TILE / 2;
    mesh.geometry.boundingSphere.center.set(half, (c.minH + c.maxH) / 2, half);
    mesh.geometry.boundingSphere.radius =
      Math.hypot(half * 1.42, (c.maxH - c.minH) / 2);

    mesh.position.set(c.ox, 0, c.oz);
    mesh.updateMatrix();
    // Visible only inside the 9x9 window; the radius-5 ring stays hidden
    // (pre-built) until the window reaches it.
    mesh.visible = this._ccx === undefined ||
      Math.max(Math.abs(rec.cx - this._ccx), Math.abs(rec.cz - this._ccz)) <= VIS_R;
    rec.built = true;
    this.built++;
    this._cur = null;
  }

  _makeMesh(scene) {
    const geo = buildTileGeometry();
    const mesh = new THREE.Mesh(geo, this._mat);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.receiveShadow = true; // costs nothing while shadows are off
    scene.add(mesh);
    return mesh;
  }
}

/**
 * Static tile geometry: (RES+1)^2 vertices, fixed index topology with the
 * diagonal between (i+1,j) and (i,j+1) — the SAME split assumed by
 * SectorWorld.getRenderedPlane, so wheel seating reconstructs the exact
 * triangle the player sees.
 */
function buildTileGeometry() {
  const count = (RES + 1) * (RES + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  const idx = [];
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const a = j * (RES + 1) + i, b = a + 1, c = a + RES + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere();
  return geo;
}

export { CELL };
