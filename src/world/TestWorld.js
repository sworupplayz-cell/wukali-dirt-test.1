import * as THREE from 'three';

/**
 * TestWorld — Horizon Ride Phase 1A foundation scene.
 *
 * A tiny, static test map that implements the exact world interface the
 * bike / camera / model already consume:
 *   { getHeight, getNormal, getColliders, getSurface, getRenderedPlane,
 *     getSpawn, isInBounds, update }
 *
 * Contents (nothing else):
 *   - flat ground plane
 *   - one straight dirt test road
 *   - one small ramp (baked into the analytic heightfield => jumpable)
 *   - simple sky (flat color + light fog)
 *   - one sun light (+ hemisphere fill so Lambert materials shade)
 *   - deterministic spawn point on the road
 *
 * The heightfield is analytic and trivial: y = 0 everywhere except the
 * ramp wedge. No chunks, no generation, no per-frame work in update().
 */

// Ground extents (half-size). Outside this the bike auto-resets.
const GROUND_HALF = 220;

// Road: a straight strip along +Z through the origin.
const ROAD_HALF_W = 4.5;
const ROAD_LEN = 400;

// Ramp: wedge on the road. Run-up rises linearly, then the deck ends in a
// clean drop-off => takeoff (the bike's airborne transition handles it).
const RAMP_X = 0;          // centered on the road
const RAMP_HALF_W = 3;
const RAMP_Z0 = 60;        // start of the incline
const RAMP_Z1 = 70;        // lip (takeoff edge)
const RAMP_H = 2.2;        // lip height

export class TestWorld {
  constructor(scene) {
    this._spawn = { x: 0, y: 0, z: -20, yaw: 0 }; // on the road, facing the ramp
    this._colliders = []; // no props in the test scene
    this._buildLighting(scene);
    this._buildGeometry(scene);
  }

  // ---- Heightfield --------------------------------------------------------

  getHeight(x, z) {
    // Ramp wedge (the only non-flat feature).
    if (
      x > RAMP_X - RAMP_HALF_W && x < RAMP_X + RAMP_HALF_W &&
      z >= RAMP_Z0 && z < RAMP_Z1
    ) {
      return RAMP_H * ((z - RAMP_Z0) / (RAMP_Z1 - RAMP_Z0));
    }
    return 0;
  }

  getNormal(x, z, out) {
    const e = 0.6;
    const hx = this.getHeight(x + e, z) - this.getHeight(x - e, z);
    const hz = this.getHeight(x, z + e) - this.getHeight(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  /**
   * Rendered-surface plane under a point (used by wheel seating + blob
   * shadow). The test scene's visual meshes match the analytic heightfield
   * exactly (flat plane + planar wedge), so this is the analytic surface.
   */
  getRenderedPlane(x, z, out) {
    out.y = this.getHeight(x, z);
    this.getNormal(x, z, out.n);
    return out;
  }

  getColliders() {
    return this._colliders;
  }

  /** Surface material: groomed dirt road vs. packed test-field dirt. */
  getSurface(x, z, out) {
    const onRoad = Math.abs(x) < ROAD_HALF_W && Math.abs(z) < ROAD_LEN / 2;
    if (onRoad) {
      out.grip = 1.0;
      out.drag = 0.012;
      out.rough = 0.07;
    } else {
      out.grip = 0.93;
      out.drag = 0.07;
      out.rough = 0.3;
    }
    return out;
  }

  getSpawn() {
    return this._spawn;
  }

  isInBounds(x, z) {
    return Math.abs(x) < GROUND_HALF - 4 && Math.abs(z) < GROUND_HALF - 4;
  }

  /** No streaming, no generation — nothing to do per frame. */
  update() {}

  // ---- Scene construction (built once, zero per-frame cost) ---------------

  _buildLighting(scene) {
    const sky = new THREE.Color(0x7ec4e8);
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 120, 320); // soften the ground-plane edge
    scene.add(new THREE.HemisphereLight(0xd4ebff, 0x7d6a44, 0.92));
    const sun = new THREE.DirectionalLight(0xffedc9, 1.22);
    sun.position.set(60, 90, 30);
    scene.add(sun);
  }

  _buildGeometry(scene) {
    // Flat ground.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
      new THREE.MeshLambertMaterial({ color: 0x7a9a52 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    scene.add(ground);

    // Dirt test road (thin strip floated just above the ground plane).
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_W * 2, ROAD_LEN),
      new THREE.MeshLambertMaterial({ color: 0x9b7a4e })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.02;
    road.matrixAutoUpdate = false;
    road.updateMatrix();
    scene.add(road);

    // Ramp wedge — geometry matches the analytic heightfield exactly.
    const ramp = new THREE.Mesh(
      buildRampGeometry(),
      new THREE.MeshLambertMaterial({ color: 0x8a6a42 })
    );
    ramp.matrixAutoUpdate = false;
    ramp.updateMatrix();
    scene.add(ramp);
  }
}

/** Wedge: inclined deck + two side walls + back face. */
function buildRampGeometry() {
  const x0 = RAMP_X - RAMP_HALF_W, x1 = RAMP_X + RAMP_HALF_W;
  const z0 = RAMP_Z0, z1 = RAMP_Z1, h = RAMP_H;
  // prettier-ignore
  const positions = new Float32Array([
    // deck (two triangles)
    x0, 0, z0,  x1, 0, z0,  x1, h, z1,
    x0, 0, z0,  x1, h, z1,  x0, h, z1,
    // back face (at the lip)
    x0, h, z1,  x1, h, z1,  x1, 0, z1,
    x0, h, z1,  x1, 0, z1,  x0, 0, z1,
    // left wall
    x0, 0, z0,  x0, h, z1,  x0, 0, z1,
    // right wall
    x1, 0, z0,  x1, 0, z1,  x1, h, z1,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
