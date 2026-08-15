import * as THREE from 'three';
import { ChunkGrid } from './streaming/ChunkGrid.js';
import { TerrainField } from './TerrainField.js';
import { TerrainTiles, CELL } from './TerrainTiles.js';
import { FarTerrain } from './FarTerrain.js';
import { Props } from './Props.js';

/**
 * SectorWorld — Horizon Ride fixed-world streaming engine.
 *
 * Phase 1B established the PERMANENT world coordinate system:
 *   world rectangle:  10,000 m (x) x 5,000 m (z)   = 50 km^2
 *   sector size:      500 m x 500 m
 *   grid:             20 columns x 10 rows = 200 fixed sectors
 * Sector IDs are fixed forever: (0,0)..(19,9); coordinates are never
 * generated outside the rectangle.
 *
 * Phase 2 replaces the flat debug planes with one seamless sculpted
 * terrain, WITHOUT touching the streaming architecture:
 *   - the 3x3 SECTOR window (ChunkGrid) remains the logical streaming
 *     layer — sector enter/leave is where future phases will hang
 *     gameplay content (props, colliders, spawns);
 *   - TerrainField is the analytic ground truth: height is a pure
 *     deterministic function of world (x, z), so physics NEVER waits for
 *     meshes and every sector matches its neighbors exactly;
 *   - TerrainTiles renders the field as pooled 125 m tiles on a shared
 *     global lattice (bit-identical borders => zero seams).
 *
 * World interface consumed by the bike/camera/model (unchanged):
 * { getHeight, getNormal, getColliders, getSurface, getRenderedPlane,
 *   getSpawn, isInBounds, update }.
 */

export const SECTOR_SIZE = 500;
export const WORLD_COLS = 20;
export const WORLD_ROWS = 10;
export const WORLD_W = SECTOR_SIZE * WORLD_COLS; // 10,000 m
export const WORLD_H = SECTOR_SIZE * WORLD_ROWS; //  5,000 m
const STREAM_RADIUS = 1; // 3x3 logical sector window

export class SectorWorld {
  constructor(scene) {
    this.scene = scene;
    this.field = new TerrainField();
    this.tiles = new TerrainTiles(scene, this.field);
    // Phase 3: static continent backdrop so the ranges read from anywhere.
    this.far = new FarTerrain(scene, this.field);
    // Phase 3 rebalance: instanced exploration props, streamed with the
    // logical sector window (7 draw calls total).
    this.props = new Props(scene, this.field);
    this._propsDirty = true;
    this._buildLighting(scene);

    // Logical 3x3 sector window (Phase 1B architecture, preserved).
    // Sectors carry no meshes now — terrain rendering moved to the finer
    // tile layer — but the window still tracks which sectors are "active"
    // for future gameplay streaming.
    this._grid = new ChunkGrid(SECTOR_SIZE, STREAM_RADIUS);

    // Spawn ON a dirt trail near the world center, facing down the trail —
    // deterministic scan for a FLAT stretch (the rebalanced massifs grew,
    // so a fixed z could land on a foothill).
    let sx = this.field.nsCenter(5, 2500), sz = 2500;
    for (let dz = 0; dz <= 900; dz += 30) {
      for (const s of dz === 0 ? [0] : [dz, -dz]) {
        const z = 2500 + s;
        const x = this.field.nsCenter(5, z);
        const e = 8;
        const slope = Math.hypot(
          this.field.height(x + e, z) - this.field.height(x - e, z),
          this.field.height(x, z + e) - this.field.height(x, z - e)
        ) / (2 * e);
        if (slope < 0.06) { sx = x; sz = z; dz = 1e9; break; }
      }
    }
    this._spawn = { x: sx, y: this.field.height(sx, sz), z: sz, yaw: 0 };

    this._surfScratch = { h: 0, trail: 0, moist: 0, mtn: 0, roadType: 0 };

    // Debug/HUD info (read by the F3 overlay + tests). Updated in update().
    this.debug = { sectorX: 0, sectorZ: 0, loaded: 0, tiles: 0 };
  }

  // ---- Heightfield ----------------------------------------------------------

  getHeight(x, z) {
    return this.field.height(x, z);
  }

  getNormal(x, z, out) {
    const e = 0.6;
    const hx = this.field.height(x + e, z) - this.field.height(x - e, z);
    const hz = this.field.height(x, z + e) - this.field.height(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  /**
   * The RENDERED terrain plane near a point: the analytic field sampled on
   * the tiles' global 3.125 m lattice with the fixed diagonal split —
   * exactly the triangle the player sees. Wheel seating and the blob
   * shadow use this so tyres sit on the visible surface, not up to a few
   * cm off between lattice vertices.
   */
  getRenderedPlane(x, z, out) {
    const cs = CELL;
    const f = this.field;
    const gx = Math.floor(x / cs) * cs, gz = Math.floor(z / cs) * cs;
    const fx = (x - gx) / cs, fz = (z - gz) / cs;
    const h00 = f.height(gx, gz), h10 = f.height(gx + cs, gz);
    const h01 = f.height(gx, gz + cs), h11 = f.height(gx + cs, gz + cs);
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
    return this.props.colliders;
  }

  /**
   * Surface material under the wheels: groomed dirt trail (full grip,
   * free-rolling, near-smooth) fading into open grass/dirt country
   * (slightly loose, mildly draggy, bumpy).
   */
  getSurface(x, z, out) {
    const t = this.field.sample(x, z, this._surfScratch).trail;
    out.grip = 0.92 + 0.08 * t;
    out.drag = 0.055 - 0.043 * t;
    out.rough = 0.34 - 0.27 * t;
    return out;
  }

  getSpawn() {
    return this._spawn;
  }

  /**
   * Finite world: no invisible walls (boundaries disabled), but riding
   * fully off the 10,000 x 5,000 rectangle triggers the bike's existing
   * safe-spot reset failsafe rather than falling off the terrain.
   */
  isInBounds(x, z) {
    return x >= 0 && x < WORLD_W && z >= 0 && z < WORLD_H;
  }

  /** Sector ID for a world position, clamped to the fixed grid. */
  sectorAt(x, z) {
    return {
      x: Math.min(WORLD_COLS - 1, Math.max(0, Math.floor(x / SECTOR_SIZE))),
      z: Math.min(WORLD_ROWS - 1, Math.max(0, Math.floor(z / SECTOR_SIZE))),
    };
  }

  /** Slope (rise/run) under a point — debug overlay. */
  slopeAt(x, z) {
    const e = 1.5;
    const hx = this.field.height(x + e, z) - this.field.height(x - e, z);
    const hz = this.field.height(x, z + e) - this.field.height(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }

  /** Peak record if (x,z) is inside a mountain massif, else null (F3). */
  peakAt(x, z) {
    return this.field.landforms.peakAt(x, z);
  }

  /** Road under a point: { type, slope% } or null (F3). */
  roadInfoAt(x, z) {
    const t = this.field.sample(x, z, this._surfScratch).roadType;
    if (!t) return null;
    const names = { 1: 'MAIN', 2: 'PASS', 3: 'SPIRAL', 4: 'TRAIL' };
    return { type: names[t] || '-', slope: (this.slopeAt(x, z) * 100).toFixed(0) };
  }

  /** Nearest scenic viewpoint (F3 + tests). */
  nearestViewpoint(x, z) {
    return this.field.landforms.nearestViewpoint(x, z);
  }

  // ---- Streaming ------------------------------------------------------------

  /** Per-frame: sector window (logical) + terrain tile window (render). */
  update(pos) {
    const moved = this._grid.update(
      pos.x, pos.z,
      (cx, cz) => this._sectorEnter(cx, cz),
      () => { this._propsDirty = true; }
    );
    if (moved || this._propsDirty) {
      this._propsDirty = false;
      const ids = [];
      for (const rec of this._grid.cells.values()) {
        if (rec) ids.push([rec.cx, rec.cz]);
      }
      this.props.rebuild(ids);
    }
    this.tiles.update(pos.x, pos.z);

    const s = this.sectorAt(pos.x, pos.z);
    this.debug.sectorX = s.x;
    this.debug.sectorZ = s.z;
    this.debug.loaded = this._countLoaded();
    this.debug.tiles = this.tiles.count();
    this.debug.props = this.props.count;
  }

  _sectorEnter(cx, cz) {
    // Sectors outside the permanent 20x10 grid are never activated.
    if (cx < 0 || cx >= WORLD_COLS || cz < 0 || cz >= WORLD_ROWS) return null;
    return { cx, cz }; // logical record; gameplay content attaches here later
  }

  _countLoaded() {
    let n = 0;
    for (const data of this._grid.cells.values()) if (data) n++;
    return n;
  }

  _buildLighting(scene) {
    const sky = new THREE.Color(0x7ec4e8);
    scene.background = sky;
    // Phase 3: fog opens up to ~7 km so the mountain ranges read as a
    // continent; the near/far terrain handoff (385-437 m) hides inside
    // the fog ramp's start.
    scene.fog = new THREE.Fog(sky, 300, 7000);
    scene.add(new THREE.HemisphereLight(0xd4ebff, 0x7d6a44, 0.92));
    const sun = new THREE.DirectionalLight(0xffedc9, 1.22);
    sun.position.set(60, 90, 30);
    scene.add(sun);
  }
}
