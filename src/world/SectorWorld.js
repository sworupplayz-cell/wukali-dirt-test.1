import * as THREE from 'three';
import { ChunkGrid } from './streaming/ChunkGrid.js';
import { ObjectPool } from './streaming/ObjectPool.js';

/**
 * SectorWorld — Horizon Ride Phase 1B fixed-world streaming engine.
 *
 * A PERMANENT, FINITE world coordinate system:
 *   world rectangle:  10,000 m (x) x 5,000 m (z)   = 50 km^2
 *   sector size:      500 m x 500 m
 *   grid:             20 columns x 10 rows = 200 fixed sectors
 *
 * Sector (col,row) covers x in [col*500, col*500+500), z likewise.
 * Sector IDs are fixed forever: (0,0) .. (19,9). Coordinates are never
 * generated outside this rectangle — streaming requests outside the grid
 * are simply skipped.
 *
 * STREAMING: a 3x3 sector window (Chebyshev radius 1) follows the player,
 * driven by the retained ChunkGrid utility. Ground meshes come from a
 * fixed ObjectPool — sectors load/unload while riding with zero allocation
 * and no loading screen.
 *
 * PLACEHOLDER TERRAIN (this phase only): every sector is a flat plane with
 * a deterministic per-sector debug tint so streaming is visible. No hills,
 * no props, no decorations. The analytic heightfield is y = 0 everywhere,
 * so bike physics is exact and never waits on meshes.
 *
 * Implements the exact world interface the bike/camera/model consume:
 * { getHeight, getNormal, getColliders, getSurface, getRenderedPlane,
 *   getSpawn, isInBounds, update }.
 */

export const SECTOR_SIZE = 500;
export const WORLD_COLS = 20;
export const WORLD_ROWS = 10;
export const WORLD_W = SECTOR_SIZE * WORLD_COLS; // 10,000 m
export const WORLD_H = SECTOR_SIZE * WORLD_ROWS; //  5,000 m
const STREAM_RADIUS = 1; // 3x3 active window

export class SectorWorld {
  constructor(scene) {
    this.scene = scene;
    // Spawn at the exact world center, facing +Z.
    this._spawn = { x: WORLD_W / 2, y: 0, z: WORLD_H / 2, yaw: 0 };
    this._colliders = []; // no props this phase
    this._buildLighting(scene);

    // 3x3 window = 9 sectors max; +1 spare so enter-before-release order
    // changes can never starve the pool.
    this._pool = new ObjectPool(() => this._makeSectorMesh(), 10);
    this._grid = new ChunkGrid(SECTOR_SIZE, STREAM_RADIUS);
    this._tint = new THREE.Color();

    // Debug/HUD info (read by the F3 overlay + tests). Updated in update().
    this.debug = { sectorX: 0, sectorZ: 0, loaded: 0 };
  }

  // ---- Heightfield (flat placeholder) --------------------------------------

  getHeight() {
    return 0;
  }

  getNormal(x, z, out) {
    out.set(0, 1, 0);
    return out;
  }

  getRenderedPlane(x, z, out) {
    out.y = 0;
    out.n.set(0, 1, 0);
    return out;
  }

  getColliders() {
    return this._colliders;
  }

  /** Uniform packed-dirt test surface. */
  getSurface(x, z, out) {
    out.grip = 0.95;
    out.drag = 0.03;
    out.rough = 0.15;
    return out;
  }

  getSpawn() {
    return this._spawn;
  }

  /**
   * Finite world: no invisible walls (boundaries disabled), but riding
   * fully off the 10,000 x 5,000 rectangle triggers the bike's existing
   * safe-spot reset failsafe rather than falling into the void.
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

  // ---- Streaming ------------------------------------------------------------

  /** Per-frame: keep the 3x3 sector window centered on the player. */
  update(pos) {
    this._grid.update(
      pos.x, pos.z,
      (cx, cz) => this._loadSector(cx, cz),
      (cx, cz, mesh) => this._unloadSector(mesh)
    );
    const s = this.sectorAt(pos.x, pos.z);
    this.debug.sectorX = s.x;
    this.debug.sectorZ = s.z;
    this.debug.loaded = this._countLoaded();
  }

  _loadSector(cx, cz) {
    // Never generate outside the permanent 20x10 grid.
    if (cx < 0 || cx >= WORLD_COLS || cz < 0 || cz >= WORLD_ROWS) return null;
    const mesh = this._pool.acquire();
    if (!mesh) return null; // cannot happen with a sized pool
    mesh.position.set(cx * SECTOR_SIZE + SECTOR_SIZE / 2, 0, cz * SECTOR_SIZE + SECTOR_SIZE / 2);
    mesh.updateMatrix();
    mesh.material.color.copy(this._sectorTint(cx, cz));
    mesh.visible = true;
    return mesh;
  }

  _unloadSector(mesh) {
    if (mesh) this._pool.release(mesh);
  }

  _countLoaded() {
    let n = 0;
    for (const data of this._grid.cells.values()) if (data) n++;
    return n;
  }

  /** Deterministic per-sector debug tint (green family, clearly distinct). */
  _sectorTint(cx, cz) {
    // Small integer hash -> stable pseudo-random in [0,1).
    let h = (cx * 73856093) ^ (cz * 19349663);
    h = (h ^ (h >>> 13)) * 1274126177;
    const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    // Hue wanders green->olive->teal; lightness alternates checker-style so
    // even similar hues read as different sectors at a glance.
    const hue = 0.21 + r * 0.16;
    const light = 0.3 + 0.1 * ((cx + cz) % 2) + r * 0.05;
    return this._tint.setHSL(hue, 0.42, light);
  }

  _makeSectorMesh() {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SECTOR_SIZE, SECTOR_SIZE),
      new THREE.MeshLambertMaterial({ color: 0x7a9a52 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  _buildLighting(scene) {
    const sky = new THREE.Color(0x7ec4e8);
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 120, 380); // hides the streaming edge
    scene.add(new THREE.HemisphereLight(0xd4ebff, 0x7d6a44, 0.92));
    const sun = new THREE.DirectionalLight(0xffedc9, 1.22);
    sun.position.set(60, 90, 30);
    scene.add(sun);
  }
}
