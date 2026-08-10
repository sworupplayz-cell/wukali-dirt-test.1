import * as THREE from 'three';

/**
 * MountainImpostors — far-LOD for mountain destinations.
 *
 * Streamed terrain only reaches ~160 m, and fog hides its edge — which
 * would make a 300 m-radius destination invisible until the player is
 * already on it. These pooled meshes CONFORM to the real analytic terrain:
 * every vertex samples generator.height() and sits a little below it, so
 * streamed chunks always occlude the impostor up close (including the
 * shape-modulated flanks a plain dome would poke through). When the player
 * is on/near a mountain, its impostor sinks a few extra metres so the
 * coarse interpolation between impostor vertices can never surface through
 * the loaded chunks. No collision; recolored/reshaped only on reassign.
 */
const POOL = 8;
const VIEW_R = 2200;      // impostors appear within this range
const RINGS = 14, SEGS = 36;
const BASE_SINK = 1.6;    // m below the real surface at the peak
const EDGE_SINK = 3.0;    // additional sink toward the rim
const NEAR_SINK = 6.0;    // extra sink while the player is on the mountain

export class MountainImpostors {
  constructor(scene, generator) {
    this.gen = generator;
    this._meshes = [];
    this._assigned = new Array(POOL).fill(null); // mountain records
    this._lastCx = null;
    this._lastCz = null;
    this._heights = new Float32Array((RINGS + 1) * SEGS);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(buildDomeGeometry(), mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this._meshes.push(mesh);
    }
  }

  update(x, z) {
    // Proximity sink runs every call (cheap; prevents poke-through while
    // riding on a mountain).
    for (let i = 0; i < POOL; i++) {
      const m = this._assigned[i];
      if (!m) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      const t = 1 - Math.min(1, Math.max(0, (d - (m.R + 40)) / 140));
      this._meshes[i].position.y = -NEAR_SINK * t;
      this._meshes[i].updateMatrix();
    }

    const cx = Math.floor(x / 300), cz = Math.floor(z / 300);
    if (cx === this._lastCx && cz === this._lastCz) return;
    this._lastCx = cx;
    this._lastCz = cz;

    // Mountains in range, nearest first.
    const found = [];
    const mcx = Math.floor(x / 1200), mcz = Math.floor(z / 1200);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const m = this.gen.mountainCell(mcx + dx, mcz + dz);
        if (!m) continue;
        const d = Math.hypot(m.x - x, m.z - z);
        if (d < VIEW_R) found.push([d, m]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    const want = found.slice(0, POOL).map((f) => f[1]);

    const wantIds = new Set(want.map((m) => m.id));
    for (let i = 0; i < POOL; i++) {
      if (this._assigned[i] && !wantIds.has(this._assigned[i].id)) {
        this._assigned[i] = null;
        this._meshes[i].visible = false;
      }
    }
    for (const m of want) {
      if (this._assigned.some((a) => a && a.id === m.id)) continue;
      const slot = this._assigned.indexOf(null);
      if (slot < 0) break;
      this._assigned[slot] = m;
    }
    // (Re)shape + recolor with distance-based haze: near impostors read as
    // solid terrain, far ones melt into the atmosphere. Runs only when the
    // 300 m tracking cell changes (~1 ms per mountain).
    for (let i = 0; i < POOL; i++) {
      if (this._assigned[i]) this._fill(this._meshes[i], this._assigned[i], x, z);
    }
  }

  /** Sample the real terrain at every vertex; color by height fraction. */
  _fill(mesh, m, px, pz) {
    const dist = Math.hypot(m.x - px, m.z - pz);
    const haze = 0.16 + 0.55 * sm(250, 1900, dist);
    const pos = mesh.geometry.attributes.position;
    const col = mesh.geometry.attributes.color;
    const hs = this._heights;
    const outer = m.R + 40;

    let peakY = -Infinity, baseY = Infinity;
    let i = 0;
    for (let ring = 0; ring <= RINGS; ring++) {
      const rr = ring / RINGS;
      for (let s2 = 0; s2 < SEGS; s2++, i++) {
        const a = (s2 / SEGS) * Math.PI * 2;
        const h = this.gen.height(m.x + Math.cos(a) * rr * outer, m.z + Math.sin(a) * rr * outer);
        hs[i] = h;
        if (h > peakY) peakY = h;
        if (h < baseY) baseY = h;
      }
    }
    const span = Math.max(8, peakY - baseY);
    const snowy = m.H > 66;

    i = 0;
    for (let ring = 0; ring <= RINGS; ring++) {
      const rr = ring / RINGS;
      const sink = BASE_SINK + EDGE_SINK * rr;
      for (let s2 = 0; s2 < SEGS; s2++, i++) {
        const a = (s2 / SEGS) * Math.PI * 2;
        pos.setXYZ(i, Math.cos(a) * rr * outer, hs[i] - sink, Math.sin(a) * rr * outer);
        const t = (hs[i] - baseY) / span;
        // Smoothly blended bands (hard thresholds read as painted rings).
        let r = 0.42, g = 0.50, b = 0.38;               // forested base
        const rockM = sm(0.34, 0.52, t);
        r += (0.47 - r) * rockM; g += (0.45 - g) * rockM; b += (0.42 - b) * rockM;
        const highM = sm(0.64, 0.82, t);
        r += (0.52 - r) * highM; g += (0.52 - g) * highM; b += (0.55 - b) * highM;
        const snowM = snowy ? sm(0.82, 0.92, t) : 0;
        r += (0.93 - r) * snowM; g += (0.94 - g) * snowM; b += (0.97 - b) * snowM;
        col.setXYZ(i, r + (0.70 - r) * haze, g + (0.78 - g) * haze, b + (0.88 - b) * haze);
      }
    }
    // Skirt: outward-sloping apron fading to horizon haze — edge-on it
    // reads as a foothill base rising out of the atmosphere. (A vertical
    // apron reads as a giant pale curtain at mid-range.)
    const rimStart = RINGS * SEGS;
    for (let s2 = 0; s2 < SEGS; s2++, i++) {
      const a = (s2 / SEGS) * Math.PI * 2;
      // Jitter breaks the ruler-straight rim/apron silhouette line.
      const jit = Math.sin(s2 * 12.9898 + m.R) * 43758.5453;
      const jr = (jit - Math.floor(jit)) * 44 - 22;
      pos.setXYZ(i, Math.cos(a) * (outer + 320 + jr), hs[rimStart + s2] - 150 + jr * 0.6, Math.sin(a) * (outer + 320 + jr));
      col.setXYZ(i, 0.70, 0.82, 0.93); // melt into the sky/haze
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    mesh.scale.set(1, 1, 1);
    mesh.position.set(m.x, 0, m.z);
    mesh.updateMatrix();
    mesh.visible = true;
    mesh.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, (peakY + baseY) / 2 - 60, 0),
      Math.hypot(outer + 340, span + 170)
    );
  }
}

/** Flat unit disc topology; vertex positions are rewritten per mountain. */
function buildDomeGeometry() {
  const count = (RINGS + 1) * SEGS + SEGS; // rings + skirt
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const idx = [];
  for (let ring = 0; ring < RINGS + 1; ring++) {
    const a0 = ring * SEGS, b0 = (ring + 1) * SEGS;
    for (let s2 = 0; s2 < SEGS; s2++) {
      const s1 = (s2 + 1) % SEGS;
      idx.push(a0 + s2, b0 + s2, a0 + s1, a0 + s1, b0 + s2, b0 + s1);
    }
  }
  geo.setIndex(idx);
  return geo;
}

function sm(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
