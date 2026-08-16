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
    this.built = 0; // debug counter
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

    // Safety net: the tile under the player is always built.
    const key = `${Math.floor(px / TILE)},${Math.floor(pz / TILE)}`;
    const center = this._grid.cells.get(key);
    if (center && center !== true && !center.built) this._build(center);

    // Nearest-first incremental builds. Polish pass: a boundary crossing
    // enqueues ~11 hidden-ring tiles; at 1/frame (~2.5 ms each) they
    // drain in 11 frames with NO frame spike. Only a full-window refill
    // (teleport/reset: 100+ tiles, screen already covered by the far
    // backdrop) is allowed to burst at 3/frame.
    const perFrame = this._queue.length > 40 ? 3 : 1;
    for (let n = 0; n < perFrame && this._queue.length > 0; n++) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < this._queue.length; i++) {
        const r = this._queue[i];
        if (r.released) { this._queue.splice(i, 1); i--; continue; }
        const d = Math.max(Math.abs((r.cx + 0.5) * TILE - px), Math.abs((r.cz + 0.5) * TILE - pz));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (this._queue.length === 0) break;
      const rec = this._queue.splice(best, 1)[0];
      if (!rec.built && !rec.released) this._build(rec);
    }
  }

  /** Remaining unbuilt tiles (loading-screen progress). */
  get pending() {
    return this._queue.length;
  }

  /** Build up to n queued tiles immediately (loading-screen warm-up). */
  drainSome(n, px, pz) {
    for (let k = 0; k < n && this._queue.length > 0; k++) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < this._queue.length; i++) {
        const r = this._queue[i];
        if (r.released) { this._queue.splice(i, 1); i--; continue; }
        const d = Math.max(Math.abs((r.cx + 0.5) * TILE - px), Math.abs((r.cz + 0.5) * TILE - pz));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (this._queue.length === 0) break;
      const rec = this._queue.splice(best, 1)[0];
      if (!rec.built && !rec.released) this._build(rec);
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

  /** Fill one pooled mesh from the analytic field. */
  _build(rec) {
    const mesh = rec.mesh;
    const ox = rec.cx * TILE, oz = rec.cz * TILE;
    const G = RES + 3;
    const grid = this._hgrid;
    const info = this._info;
    const field = this.field;
    const pos = mesh.geometry.attributes.position.array;
    const col = mesh.geometry.attributes.color.array;
    const nor = mesh.geometry.attributes.normal.array;
    const uv = mesh.geometry.attributes.uv.array;

    // Sample pass: interior vertices get full info (color), the 1-cell
    // border ring only height (for normals).
    let minH = Infinity, maxH = -Infinity;
    for (let J = 0; J < G; J++) {
      for (let I = 0; I < G; I++) {
        const wx = ox + (I - 1) * CELL, wz = oz + (J - 1) * CELL;
        let h;
        if (I === 0 || J === 0 || I === G - 1 || J === G - 1) {
          h = field.height(wx, wz);
        } else {
          field.sample(wx, wz, info);
          h = info.h;
          const v = ((J - 1) * (RES + 1) + (I - 1)) * 3;
          // Shared Phase 3 palette: grass -> basin scrub -> rock -> snow,
          // dirt roads on top (same bands as the far backdrop).
          colorFor(info, this._rgb, wx, wz);
          col[v] = this._rgb[0]; col[v + 1] = this._rgb[1]; col[v + 2] = this._rgb[2];
        }
        grid[J * G + I] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    // Vertex pass: positions, grid normals, slope shading.
    const inv = 1 / (2 * CELL);
    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const v = j * (RES + 1) + i;
        const gi = (j + 1) * G + (i + 1);
        pos[v * 3] = i * CELL;
        pos[v * 3 + 1] = grid[gi];
        pos[v * 3 + 2] = j * CELL;
        // World-space painted-detail UV: 1 repeat per 24 m, exact across
        // tile borders because it derives from world coordinates.
        uv[v * 2] = (ox + i * CELL) / 24;
        uv[v * 2 + 1] = (oz + j * CELL) / 24;
        let nx = (grid[gi - 1] - grid[gi + 1]) * inv;
        let nz = (grid[gi - G] - grid[gi + G]) * inv;
        const il = 1 / Math.hypot(nx, 1, nz);
        nx *= il; nz *= il;
        const ny = il;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        // Steeper faces darken slightly (cheap ambient occlusion feel).
        const shade = 0.82 + 0.18 * ny;
        col[v * 3] *= shade; col[v * 3 + 1] *= shade; col[v * 3 + 2] *= shade;
      }
    }

    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.attributes.normal.needsUpdate = true;
    mesh.geometry.attributes.uv.needsUpdate = true;
    const half = TILE / 2;
    mesh.geometry.boundingSphere.center.set(half, (minH + maxH) / 2, half);
    mesh.geometry.boundingSphere.radius = Math.hypot(half * 1.42, (maxH - minH) / 2);

    mesh.position.set(ox, 0, oz);
    mesh.updateMatrix();
    // Visible only inside the 9x9 window; the radius-5 ring stays hidden
    // (pre-built) until the window reaches it.
    mesh.visible = this._ccx === undefined ||
      Math.max(Math.abs(rec.cx - this._ccx), Math.abs(rec.cz - this._ccz)) <= VIS_R;
    rec.built = true;
    this.built++;
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
