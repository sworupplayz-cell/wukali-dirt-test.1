import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

/**
 * Low-poly Nepal-inspired prop geometries.
 * Each type is a single merged, vertex-colored geometry so every prop type
 * renders as ONE InstancedMesh draw call. No textures, no transparency.
 */

function colorize(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function merge(parts) {
  // Primitive geometries are a mix of indexed and non-indexed (Icosahedron
  // is non-indexed) — normalize before merging.
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat);
  parts.forEach((p) => p.dispose());
  flat.forEach((p) => p.dispose());
  return g;
}

function pine() {
  const trunk = colorize(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 5), 0.36, 0.25, 0.15).translate(0, 0.8, 0);
  const c1 = colorize(new THREE.ConeGeometry(1.35, 2.6, 6), 0.15, 0.32, 0.18).translate(0, 2.4, 0);
  const c2 = colorize(new THREE.ConeGeometry(0.95, 2.0, 6), 0.18, 0.36, 0.20).translate(0, 3.7, 0);
  return merge([trunk, c1, c2]);
}

function broadleaf() {
  const trunk = colorize(new THREE.CylinderGeometry(0.15, 0.22, 1.6, 5), 0.40, 0.28, 0.17).translate(0, 0.8, 0);
  const blob = colorize(new THREE.IcosahedronGeometry(1.4, 0), 0.24, 0.42, 0.16)
    .scale(1, 0.85, 1).translate(0, 2.5, 0);
  return merge([trunk, blob]);
}

function bush() {
  return colorize(new THREE.IcosahedronGeometry(0.7, 0), 0.22, 0.38, 0.17)
    .scale(1, 0.7, 1).translate(0, 0.34, 0);
}

function rock() {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const rng = mulberry32(1234);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (0.85 + rng() * 0.35),
      p.getY(i) * (0.7 + rng() * 0.3),
      p.getZ(i) * (0.85 + rng() * 0.35));
  }
  g.computeVertexNormals();
  return colorize(g, 0.48, 0.46, 0.43).translate(0, 0.42, 0);
}

function log() {
  return colorize(new THREE.CylinderGeometry(0.22, 0.27, 2.6, 6), 0.34, 0.24, 0.15)
    .rotateZ(Math.PI / 2).translate(0, 0.24, 0);
}

function grass() {
  // Three crossed diamond blades — no textures, no transparency (~6 tris).
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const blade = colorize(new THREE.PlaneGeometry(0.5, 0.55), 0.38, 0.52, 0.20)
      .rotateY((k / 3) * Math.PI)
      .translate(0, 0.26, 0);
    parts.push(blade);
  }
  return merge(parts);
}

function stone() {
  const g = new THREE.IcosahedronGeometry(0.24, 0);
  const rng = mulberry32(777);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (0.8 + rng() * 0.5), p.getY(i) * (0.55 + rng() * 0.3), p.getZ(i) * (0.8 + rng() * 0.5));
  }
  g.computeVertexNormals();
  return colorize(g, 0.52, 0.50, 0.46).translate(0, 0.1, 0);
}

function branch() {
  const a = colorize(new THREE.CylinderGeometry(0.05, 0.08, 1.6, 5), 0.36, 0.27, 0.16)
    .rotateZ(Math.PI / 2).rotateY(0.3).translate(0, 0.07, 0);
  const b = colorize(new THREE.CylinderGeometry(0.03, 0.05, 0.7, 4), 0.33, 0.24, 0.14)
    .rotateZ(Math.PI / 2).rotateY(-0.9).translate(0.3, 0.06, 0.15);
  return merge([a, b]);
}

function haystack() {
  const body = colorize(new THREE.ConeGeometry(1.15, 1.9, 7), 0.72, 0.60, 0.32).translate(0, 0.95, 0);
  const pole = colorize(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 4), 0.4, 0.3, 0.18).translate(0, 2.05, 0);
  return merge([body, pole]);
}

function house() {
  // Simple mid-hill rural house: ochre mud walls, dark pitched roof.
  const walls = colorize(new THREE.BoxGeometry(3.2, 2.1, 2.7), 0.80, 0.68, 0.52).translate(0, 1.05, 0);
  const band = colorize(new THREE.BoxGeometry(3.3, 0.35, 2.8), 0.55, 0.30, 0.20).translate(0, 0.2, 0);
  const roof = colorize(new THREE.ConeGeometry(2.85, 1.5, 4), 0.34, 0.26, 0.22)
    .rotateY(Math.PI / 4).translate(0, 2.85, 0);
  const door = colorize(new THREE.BoxGeometry(0.75, 1.3, 0.1), 0.25, 0.17, 0.10).translate(0.6, 0.65, 1.38);
  const win = colorize(new THREE.BoxGeometry(0.6, 0.55, 0.08), 0.20, 0.22, 0.26).translate(-0.8, 1.35, 1.38);
  return merge([walls, band, roof, door, win]);
}

function wall() {
  // Low dry-stone retaining wall segment.
  const base = colorize(new THREE.BoxGeometry(2.8, 0.55, 0.42), 0.54, 0.52, 0.48).translate(0, 0.26, 0);
  const cap = colorize(new THREE.BoxGeometry(2.9, 0.12, 0.5), 0.62, 0.60, 0.55).translate(0, 0.58, 0);
  return merge([base, cap]);
}

function flagpole() {
  // Prayer-flag pole: two strings of small coloured flags.
  const parts = [colorize(new THREE.CylinderGeometry(0.05, 0.06, 5, 4), 0.42, 0.32, 0.2).translate(0, 2.5, 0)];
  const cols = [[0.25, 0.45, 0.85], [0.92, 0.92, 0.92], [0.85, 0.25, 0.2], [0.25, 0.65, 0.3], [0.9, 0.8, 0.25]];
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) / 6;
      const c = cols[i];
      const f = colorize(new THREE.PlaneGeometry(0.4, 0.3), c[0], c[1], c[2])
        .translate(sgn * t * 2.6, 4.9 - t * 1.9, 0);
      parts.push(f);
    }
  }
  return merge(parts);
}

function stupa() {
  // Tiny whitewashed chorten with a gold spire — rare hilltop landmark.
  const base = colorize(new THREE.BoxGeometry(1.7, 0.5, 1.7), 0.85, 0.84, 0.80).translate(0, 0.25, 0);
  const dome = colorize(new THREE.SphereGeometry(0.75, 8, 6), 0.90, 0.89, 0.86).translate(0, 1.0, 0);
  const box = colorize(new THREE.BoxGeometry(0.5, 0.45, 0.5), 0.88, 0.82, 0.62).translate(0, 1.75, 0);
  const spire = colorize(new THREE.ConeGeometry(0.26, 0.9, 4), 0.85, 0.68, 0.28).translate(0, 2.35, 0);
  return merge([base, dome, box, spire]);
}

function bridgeDeck() {
  // Wooden plank bridge: deck + low side rails (spans the stream carve).
  const deck = colorize(new THREE.BoxGeometry(3.0, 0.16, 12.6), 0.50, 0.38, 0.24).translate(0, 0.08, 0);
  const railL = colorize(new THREE.BoxGeometry(0.14, 0.5, 12.6), 0.42, 0.31, 0.19).translate(1.45, 0.5, 0);
  const railR = railL.clone().translate(-2.9, 0, 0);
  const stripes = colorize(new THREE.BoxGeometry(3.02, 0.04, 0.3), 0.40, 0.30, 0.18);
  const parts = [deck, railL, railR];
  for (let i = -2; i <= 2; i++) parts.push(stripes.clone().translate(0, 0.17, i * 2.6));
  stripes.dispose();
  return merge(parts);
}

function rampDeck() {
  // Curved wooden kicker surface matching the analytic ramp profile
  // h(u) = 2.9 * (u/9)^1.8 exactly, +Z forward, origin at ramp start.
  const SEG = 8, W = 4.6, L = 9;
  const pos = [], col = [], idx = [];
  const plank = [0.52, 0.40, 0.26], side = [0.36, 0.27, 0.17];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const y = 2.9 * Math.pow(t, 1.8) + 0.07;
    pos.push(-W / 2, y, t * L, W / 2, y, t * L);
    col.push(...plank, ...plank);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  // Side flaps down to the dirt.
  let base = pos.length / 3;
  for (let s = 0; s < 2; s++) {
    const x = s === 0 ? -W / 2 : W / 2;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const y = 2.9 * Math.pow(t, 1.8) + 0.07;
      pos.push(x, y, t * L, x, Math.max(0, y - 0.9), t * L);
      col.push(...side, ...side);
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      if (s === 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (SEG + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Prop type registry: name, geometry factory, pool capacity, double-sided? */
function corn() {
  // Corn clump: three tall stalks with drooping leaves (Phase 3L-1 farms).
  const parts = [];
  const spots = [[0, 0], [0.45, 0.3], [-0.35, 0.42]];
  for (let i = 0; i < 3; i++) {
    const [sx, sz] = spots[i];
    const h = 1.5 + i * 0.18;
    parts.push(colorize(new THREE.CylinderGeometry(0.035, 0.06, h, 4), 0.44, 0.56, 0.2)
      .translate(sx, h / 2, sz));
    parts.push(colorize(new THREE.ConeGeometry(0.09, 0.5, 4), 0.78, 0.68, 0.3)
      .translate(sx, h + 0.2, sz));
    parts.push(colorize(new THREE.PlaneGeometry(0.5, 0.16), 0.5, 0.62, 0.24)
      .rotateZ(-0.5).rotateY(i * 2.1).translate(sx, h * 0.55, sz));
    parts.push(colorize(new THREE.PlaneGeometry(0.45, 0.14), 0.46, 0.58, 0.22)
      .rotateZ(0.55).rotateY(i * 2.1 + 1.2).translate(sx, h * 0.4, sz));
  }
  return merge(parts);
}

function waterMill() {
  // Stream-side water mill: stone hut, pitched roof, wooden paddle wheel.
  const hut = colorize(new THREE.BoxGeometry(2.4, 1.9, 2.2), 0.58, 0.56, 0.52).translate(0, 0.95, 0);
  const roof = colorize(new THREE.ConeGeometry(2.1, 1.2, 4), 0.36, 0.27, 0.2)
    .rotateY(Math.PI / 4).translate(0, 2.5, 0);
  const door = colorize(new THREE.BoxGeometry(0.7, 1.2, 0.1), 0.24, 0.16, 0.1).translate(0.4, 0.6, 1.12);
  const parts = [hut, roof, door];
  // Wheel on the side: rim + 4 paddles, plane faces along X.
  const rim = colorize(new THREE.TorusGeometry(1.0, 0.1, 5, 10), 0.42, 0.3, 0.18)
    .rotateY(Math.PI / 2).translate(1.55, 0.85, 0);
  parts.push(rim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    parts.push(colorize(new THREE.BoxGeometry(0.08, 0.55, 0.42), 0.5, 0.36, 0.22)
      .rotateX(a).translate(1.55, 0.85 + Math.cos(a) * 0.95, Math.sin(a) * 0.95));
  }
  parts.push(colorize(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 5), 0.4, 0.3, 0.18)
    .rotateZ(Math.PI / 2).translate(0.9, 0.85, 0));
  return merge(parts);
}

// ---- Phase 3L-1F: crop row strips (one instance = a 5.5 m planted row) ----

function cropBase(r, g, b) {
  return colorize(new THREE.BoxGeometry(5.6, 0.1, 0.55), r, g, b).translate(0, 0.05, 0);
}

function rice() {
  // Paddy row: bright young rice tufts on a wet-mud strip.
  const parts = [cropBase(0.30, 0.27, 0.20)];
  for (let i = 0; i < 6; i++) {
    const x = -2.4 + i * 0.96;
    parts.push(colorize(new THREE.PlaneGeometry(0.5, 0.62), 0.36, 0.66, 0.26).translate(x, 0.4, 0));
    parts.push(colorize(new THREE.PlaneGeometry(0.5, 0.62), 0.42, 0.72, 0.3)
      .rotateY(Math.PI / 2).translate(x, 0.4, 0));
  }
  return merge(parts);
}

function wheat() {
  // Golden wheat: dense tuft cones on dry soil.
  const parts = [cropBase(0.52, 0.42, 0.26)];
  for (let i = 0; i < 6; i++) {
    const x = -2.4 + i * 0.96;
    parts.push(colorize(new THREE.ConeGeometry(0.3, 0.85, 5), 0.76, 0.64, 0.3).translate(x, 0.5, 0));
  }
  return merge(parts);
}

function mustard() {
  // Flowering mustard: green body, vivid yellow crown.
  const parts = [cropBase(0.42, 0.4, 0.24)];
  for (let i = 0; i < 6; i++) {
    const x = -2.4 + i * 0.96;
    parts.push(colorize(new THREE.ConeGeometry(0.28, 0.6, 5), 0.34, 0.5, 0.2).translate(x, 0.36, 0));
    parts.push(colorize(new THREE.IcosahedronGeometry(0.22, 0), 0.9, 0.8, 0.2).translate(x, 0.72, 0));
  }
  return merge(parts);
}

function potato() {
  // Potato ridge: low dark mounds on a raised soil row.
  const parts = [colorize(new THREE.BoxGeometry(5.6, 0.22, 0.7), 0.45, 0.36, 0.24).translate(0, 0.11, 0)];
  for (let i = 0; i < 5; i++) {
    const x = -2.2 + i * 1.1;
    parts.push(colorize(new THREE.IcosahedronGeometry(0.34, 0), 0.2, 0.36, 0.16)
      .scale(1, 0.55, 1).translate(x, 0.3, 0));
  }
  return merge(parts);
}

function veg() {
  // Mixed vegetable row: alternating leafy greens.
  const parts = [cropBase(0.4, 0.34, 0.22)];
  for (let i = 0; i < 6; i++) {
    const x = -2.4 + i * 0.96;
    const light = i % 2 === 0;
    parts.push(colorize(new THREE.IcosahedronGeometry(0.26, 0),
      light ? 0.45 : 0.2, light ? 0.62 : 0.42, light ? 0.25 : 0.18)
      .scale(1, 0.7, 1).translate(x, 0.24, 0));
  }
  return merge(parts);
}

function tea() {
  // Tea hedge: rounded clipped bushes in a tight row.
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(colorize(new THREE.BoxGeometry(1.75, 0.7, 0.85), 0.15, 0.34, 0.18)
      .translate(-1.85 + i * 1.85, 0.4, 0));
    parts.push(colorize(new THREE.BoxGeometry(1.85, 0.12, 0.95), 0.19, 0.4, 0.2)
      .translate(-1.85 + i * 1.85, 0.72, 0));
  }
  return merge(parts);
}

function banana() {
  // Banana plant: pale trunk, big drooping leaves.
  const parts = [colorize(new THREE.CylinderGeometry(0.12, 0.18, 1.7, 5), 0.55, 0.56, 0.4).translate(0, 0.85, 0)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(colorize(new THREE.PlaneGeometry(0.5, 1.6), 0.24, 0.5, 0.2)
      .translate(0, 0.8, 0).rotateX(-0.7).rotateY(a).translate(Math.sin(a) * 0.3, 1.7, Math.cos(a) * 0.3));
  }
  return merge(parts);
}

function channel() {
  // Simple irrigation channel: a shallow water strip along paddy edges.
  const water = colorize(new THREE.BoxGeometry(5.6, 0.06, 0.6), 0.3, 0.46, 0.5).translate(0, 0.03, 0);
  const bankA = colorize(new THREE.BoxGeometry(5.7, 0.14, 0.16), 0.42, 0.36, 0.26).translate(0, 0.07, 0.38);
  const bankB = colorize(new THREE.BoxGeometry(5.7, 0.14, 0.16), 0.42, 0.36, 0.26).translate(0, 0.07, -0.38);
  return merge([water, bankA, bankB]);
}

// ---- Phase 3L-2: Nepali town & bazaar buildings ---------------------------

function corrRoof(w, d, r, g, b) {
  // Corrugated sheet roof: thin slab + ridge strips.
  const parts = [colorize(new THREE.BoxGeometry(w, 0.1, d), r, g, b)];
  for (let i = 0; i < 3; i++) {
    parts.push(colorize(new THREE.BoxGeometry(w + 0.15, 0.05, 0.1), r * 0.85, g * 0.85, b * 0.85)
      .translate(0, 0.06, -d / 2 + 0.2 + i * (d - 0.4) / 2));
  }
  return parts;
}

function townhouseA() {
  // Two-storey plaster house: sky-blue upper, white lower, balcony slab.
  const parts = [
    colorize(new THREE.BoxGeometry(3.4, 2.2, 3.0), 0.88, 0.87, 0.82).translate(0, 1.1, 0),
    colorize(new THREE.BoxGeometry(3.4, 2.0, 3.0), 0.45, 0.62, 0.78).translate(0, 3.2, 0),
    colorize(new THREE.BoxGeometry(3.7, 0.16, 1.0), 0.75, 0.74, 0.7).translate(0, 2.25, 1.7),
    colorize(new THREE.BoxGeometry(3.5, 0.5, 0.06), 0.6, 0.58, 0.55).translate(0, 2.6, 2.16),
    colorize(new THREE.BoxGeometry(0.8, 1.4, 0.08), 0.25, 0.18, 0.12).translate(-0.8, 0.7, 1.52),
    colorize(new THREE.BoxGeometry(0.7, 0.6, 0.08), 0.2, 0.25, 0.3).translate(0.8, 1.4, 1.52),
    colorize(new THREE.BoxGeometry(0.7, 0.6, 0.08), 0.2, 0.25, 0.3).translate(-0.8, 3.4, 1.52),
    colorize(new THREE.BoxGeometry(0.7, 0.6, 0.08), 0.2, 0.25, 0.3).translate(0.8, 3.4, 1.52),
  ];
  for (const rp of corrRoof(3.8, 3.4, 0.55, 0.58, 0.62)) parts.push(rp.translate(0, 4.3, 0));
  return merge(parts);
}

function townhouseB() {
  // Pink/cream plaster house variant with side stair block.
  const parts = [
    colorize(new THREE.BoxGeometry(3.2, 2.1, 2.8), 0.9, 0.72, 0.66).translate(0, 1.05, 0),
    colorize(new THREE.BoxGeometry(3.2, 1.9, 2.8), 0.93, 0.88, 0.78).translate(0, 3.0, 0),
    colorize(new THREE.BoxGeometry(1.0, 2.1, 1.0), 0.8, 0.62, 0.56).translate(2.0, 1.05, -0.5),
    colorize(new THREE.BoxGeometry(0.8, 1.35, 0.08), 0.25, 0.18, 0.12).translate(0.6, 0.68, 1.42),
    colorize(new THREE.BoxGeometry(0.7, 0.6, 0.08), 0.2, 0.25, 0.3).translate(-0.7, 3.1, 1.42),
    colorize(new THREE.BoxGeometry(0.7, 0.6, 0.08), 0.2, 0.25, 0.3).translate(0.7, 3.1, 1.42),
  ];
  for (const rp of corrRoof(3.6, 3.2, 0.62, 0.5, 0.44)) parts.push(rp.translate(0, 4.0, 0));
  return merge(parts);
}

function shop() {
  // Colourful lock-up shop: bright front, awning, sign board.
  const parts = [
    colorize(new THREE.BoxGeometry(3.0, 2.5, 2.6), 0.2, 0.55, 0.55).translate(0, 1.25, 0),
    colorize(new THREE.BoxGeometry(2.2, 1.7, 0.15), 0.1, 0.1, 0.12).translate(0, 0.95, 1.28),
    colorize(new THREE.BoxGeometry(3.1, 0.08, 1.1), 0.95, 0.6, 0.2).translate(0, 2.15, 1.7).rotateX(0.14),
    colorize(new THREE.BoxGeometry(2.6, 0.5, 0.08), 0.95, 0.9, 0.75).translate(0, 2.75, 1.34),
  ];
  for (const rp of corrRoof(3.3, 2.9, 0.55, 0.57, 0.6)) parts.push(rp.translate(0, 2.6, 0));
  return merge(parts);
}

function teashop() {
  // Tiny tea/food shack: plank walls, tarp awning, bench.
  const parts = [
    colorize(new THREE.BoxGeometry(2.4, 2.0, 2.0), 0.5, 0.38, 0.26).translate(0, 1.0, 0),
    colorize(new THREE.BoxGeometry(1.6, 1.1, 0.12), 0.12, 0.1, 0.1).translate(0, 0.8, 1.0),
    colorize(new THREE.BoxGeometry(2.6, 0.06, 1.2), 0.85, 0.3, 0.25).translate(0, 2.0, 1.2).rotateX(0.12),
    colorize(new THREE.BoxGeometry(1.6, 0.08, 0.35), 0.6, 0.48, 0.32).translate(0, 0.45, 1.6),
  ];
  for (const rp of corrRoof(2.6, 2.3, 0.5, 0.52, 0.55)) parts.push(rp.translate(0, 2.1, 0));
  return merge(parts);
}

function workshop() {
  // Garage/workshop: grey shed, wide dark opening, lean-to roof, drum.
  const parts = [
    colorize(new THREE.BoxGeometry(3.6, 2.4, 3.0), 0.55, 0.55, 0.55).translate(0, 1.2, 0),
    colorize(new THREE.BoxGeometry(2.6, 1.9, 0.15), 0.08, 0.08, 0.09).translate(0, 1.0, 1.5),
    colorize(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 7), 0.6, 0.3, 0.15).translate(1.9, 0.4, 1.2),
  ];
  for (const rp of corrRoof(4.0, 3.4, 0.45, 0.47, 0.5)) parts.push(rp.rotateZ(0.08).translate(0, 2.6, 0));
  return merge(parts);
}

function school() {
  // Long single-storey school: white walls, blue band, red roof, doorway.
  const parts = [
    colorize(new THREE.BoxGeometry(7.5, 2.4, 3.0), 0.92, 0.91, 0.86).translate(0, 1.2, 0),
    colorize(new THREE.BoxGeometry(7.6, 0.5, 3.1), 0.3, 0.45, 0.7).translate(0, 0.35, 0),
    colorize(new THREE.BoxGeometry(0.9, 1.5, 0.1), 0.25, 0.18, 0.12).translate(0, 0.75, 1.52),
  ];
  for (let i = 0; i < 3; i++) {
    parts.push(colorize(new THREE.BoxGeometry(0.9, 0.7, 0.1), 0.2, 0.26, 0.32)
      .translate(-2.6 + i * 1.7 + (i > 0 ? 0.9 : 0), 1.5, 1.52));
  }
  for (const rp of corrRoof(7.9, 3.4, 0.68, 0.3, 0.26)) parts.push(rp.translate(0, 2.55, 0));
  return merge(parts);
}

function clinic() {
  // Health post: white block with a red cross.
  const parts = [
    colorize(new THREE.BoxGeometry(3.4, 2.5, 2.8), 0.94, 0.94, 0.92).translate(0, 1.25, 0),
    colorize(new THREE.BoxGeometry(0.75, 0.22, 0.08), 0.85, 0.15, 0.15).translate(0, 2.0, 1.44),
    colorize(new THREE.BoxGeometry(0.22, 0.75, 0.08), 0.85, 0.15, 0.15).translate(0, 2.0, 1.44),
    colorize(new THREE.BoxGeometry(0.85, 1.45, 0.1), 0.3, 0.35, 0.4).translate(0, 0.73, 1.42),
  ];
  for (const rp of corrRoof(3.7, 3.1, 0.62, 0.64, 0.68)) parts.push(rp.translate(0, 2.6, 0));
  return merge(parts);
}

function busstop() {
  // Roadside shelter: two posts, roof, bench.
  return merge([
    colorize(new THREE.BoxGeometry(0.12, 2.1, 0.12), 0.45, 0.45, 0.48).translate(-1.1, 1.05, -0.4),
    colorize(new THREE.BoxGeometry(0.12, 2.1, 0.12), 0.45, 0.45, 0.48).translate(1.1, 1.05, -0.4),
    colorize(new THREE.BoxGeometry(2.8, 0.08, 1.4), 0.35, 0.5, 0.62).translate(0, 2.15, 0).rotateX(0.1),
    colorize(new THREE.BoxGeometry(2.4, 0.08, 0.4), 0.6, 0.48, 0.32).translate(0, 0.5, -0.35),
    colorize(new THREE.BoxGeometry(2.8, 0.9, 0.08), 0.55, 0.6, 0.62).translate(0, 1.5, -0.5),
  ]);
}

function fuelStation() {
  // Tiny fuel stop: canopy on posts + one pump.
  return merge([
    colorize(new THREE.BoxGeometry(0.16, 3.0, 0.16), 0.7, 0.7, 0.72).translate(-1.6, 1.5, 0),
    colorize(new THREE.BoxGeometry(0.16, 3.0, 0.16), 0.7, 0.7, 0.72).translate(1.6, 1.5, 0),
    colorize(new THREE.BoxGeometry(4.4, 0.18, 3.0), 0.85, 0.25, 0.2).translate(0, 3.05, 0),
    colorize(new THREE.BoxGeometry(0.6, 1.3, 0.45), 0.8, 0.3, 0.2).translate(0.5, 0.65, 0),
    colorize(new THREE.BoxGeometry(0.35, 0.3, 0.2), 0.9, 0.9, 0.9).translate(0.5, 1.0, 0.15),
  ]);
}

function utilityPole() {
  // Power pole with crossarm.
  return merge([
    colorize(new THREE.CylinderGeometry(0.07, 0.1, 5.4, 5), 0.4, 0.36, 0.32).translate(0, 2.7, 0),
    colorize(new THREE.BoxGeometry(1.3, 0.1, 0.1), 0.35, 0.32, 0.28).translate(0, 4.9, 0),
    colorize(new THREE.BoxGeometry(0.08, 0.18, 0.08), 0.7, 0.72, 0.75).translate(-0.5, 5.05, 0),
    colorize(new THREE.BoxGeometry(0.08, 0.18, 0.08), 0.7, 0.72, 0.75).translate(0.5, 5.05, 0),
  ]);
}

function marketStall() {
  // Bazaar stall: table + colourful tarp on sticks + produce boxes.
  return merge([
    colorize(new THREE.BoxGeometry(2.0, 0.1, 1.1), 0.55, 0.42, 0.28).translate(0, 0.85, 0),
    colorize(new THREE.BoxGeometry(0.08, 0.85, 0.08), 0.45, 0.35, 0.22).translate(-0.9, 0.43, 0.45),
    colorize(new THREE.BoxGeometry(0.08, 0.85, 0.08), 0.45, 0.35, 0.22).translate(0.9, 0.43, 0.45),
    colorize(new THREE.BoxGeometry(0.08, 2.0, 0.08), 0.45, 0.35, 0.22).translate(-0.9, 1.0, -0.45),
    colorize(new THREE.BoxGeometry(0.08, 2.0, 0.08), 0.45, 0.35, 0.22).translate(0.9, 1.0, -0.45),
    colorize(new THREE.BoxGeometry(2.3, 0.06, 1.5), 0.9, 0.55, 0.15).translate(0, 2.0, 0).rotateX(-0.18),
    colorize(new THREE.BoxGeometry(0.5, 0.25, 0.4), 0.8, 0.2, 0.15).translate(-0.5, 1.02, 0),
    colorize(new THREE.BoxGeometry(0.5, 0.25, 0.4), 0.3, 0.55, 0.2).translate(0.25, 1.02, 0.1),
  ]);
}

// ---- Phase 3L-3: city buildings, streets and landmarks --------------------

function cityBuildingA() {
  // 4-storey concrete block: cream body, blue balcony bands, roof tank.
  const parts = [colorize(new THREE.BoxGeometry(4.2, 8.4, 3.6), 0.85, 0.82, 0.74).translate(0, 4.2, 0)];
  for (let f = 0; f < 4; f++) {
    parts.push(colorize(new THREE.BoxGeometry(4.4, 0.14, 1.1), 0.4, 0.55, 0.7)
      .translate(0, 2.0 + f * 2.0, 1.6));
    for (let w = 0; w < 3; w++) {
      parts.push(colorize(new THREE.BoxGeometry(0.75, 0.9, 0.08), 0.16, 0.2, 0.26)
        .translate(-1.3 + w * 1.3, 1.5 + f * 2.0, 1.82));
    }
  }
  parts.push(colorize(new THREE.CylinderGeometry(0.45, 0.45, 0.8, 7), 0.15, 0.15, 0.17).translate(1.2, 8.8, -0.8));
  parts.push(colorize(new THREE.BoxGeometry(4.4, 0.18, 3.8), 0.55, 0.53, 0.5).translate(0, 8.5, 0));
  return merge(parts);
}

function cityBuildingB() {
  // 5-storey brick-red tower with white floor bands and shopfront base.
  const parts = [colorize(new THREE.BoxGeometry(3.8, 10.0, 3.4), 0.62, 0.34, 0.26).translate(0, 5.0, 0)];
  for (let f = 1; f < 5; f++) {
    parts.push(colorize(new THREE.BoxGeometry(3.95, 0.22, 3.55), 0.9, 0.88, 0.82).translate(0, f * 2.0, 0));
  }
  parts.push(colorize(new THREE.BoxGeometry(3.0, 1.7, 0.15), 0.1, 0.1, 0.12).translate(0, 0.9, 1.72));
  parts.push(colorize(new THREE.BoxGeometry(3.4, 0.5, 0.08), 0.95, 0.75, 0.2).translate(0, 2.1, 1.76));
  parts.push(colorize(new THREE.BoxGeometry(3.9, 0.16, 3.5), 0.5, 0.48, 0.46).translate(0, 10.1, 0));
  return merge(parts);
}

function pagodaTemple() {
  // Landmark pagoda: three stacked roofs on a red base (Nepal style).
  const parts = [
    colorize(new THREE.BoxGeometry(5.2, 0.8, 5.2), 0.75, 0.72, 0.66).translate(0, 0.4, 0),
    colorize(new THREE.BoxGeometry(3.6, 2.4, 3.6), 0.6, 0.25, 0.2).translate(0, 2.0, 0),
    colorize(new THREE.ConeGeometry(3.6, 1.5, 4), 0.45, 0.3, 0.15).rotateY(Math.PI / 4).translate(0, 3.9, 0),
    colorize(new THREE.BoxGeometry(2.4, 1.7, 2.4), 0.6, 0.25, 0.2).translate(0, 5.2, 0),
    colorize(new THREE.ConeGeometry(2.6, 1.3, 4), 0.45, 0.3, 0.15).rotateY(Math.PI / 4).translate(0, 6.5, 0),
    colorize(new THREE.BoxGeometry(1.4, 1.3, 1.4), 0.6, 0.25, 0.2).translate(0, 7.5, 0),
    colorize(new THREE.ConeGeometry(1.6, 1.2, 4), 0.85, 0.68, 0.28).rotateY(Math.PI / 4).translate(0, 8.6, 0),
    colorize(new THREE.ConeGeometry(0.3, 0.9, 4), 0.9, 0.75, 0.3).translate(0, 9.6, 0),
  ];
  return merge(parts);
}

function standSegment() {
  // Stadium stand tier: three stepped concrete rows (arranged in an oval).
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(colorize(new THREE.BoxGeometry(11, 0.7, 1.3), 0.72, 0.7, 0.66)
      .translate(0, 0.35 + i * 0.7, -i * 1.2));
  }
  parts.push(colorize(new THREE.BoxGeometry(11, 0.25, 0.5), 0.3, 0.5, 0.7).translate(0, 2.35, -2.4));
  return merge(parts);
}

function roadSegment() {
  // Side-street surface: dark gravel strip (no collider, terrain-hugging).
  const parts = [
    colorize(new THREE.BoxGeometry(5.2, 0.09, 8.4), 0.34, 0.33, 0.32),
    colorize(new THREE.BoxGeometry(0.5, 0.1, 8.4), 0.55, 0.53, 0.5).translate(2.7, 0.005, 0),
    colorize(new THREE.BoxGeometry(0.5, 0.1, 8.4), 0.55, 0.53, 0.5).translate(-2.7, 0.005, 0),
  ];
  return merge(parts);
}

function roadSign() {
  // Small blue road sign on a pole.
  return merge([
    colorize(new THREE.CylinderGeometry(0.05, 0.06, 2.4, 5), 0.5, 0.5, 0.52).translate(0, 1.2, 0),
    colorize(new THREE.BoxGeometry(1.1, 0.55, 0.06), 0.15, 0.35, 0.7).translate(0, 2.35, 0),
    colorize(new THREE.BoxGeometry(0.9, 0.1, 0.07), 0.9, 0.9, 0.9).translate(0, 2.35, 0.01),
  ]);
}

function parkingLot() {
  // Parking pad: light gravel with painted bays (future traffic-ready).
  const parts = [colorize(new THREE.BoxGeometry(11, 0.08, 7), 0.5, 0.48, 0.45)];
  for (let i = 0; i < 4; i++) {
    parts.push(colorize(new THREE.BoxGeometry(0.15, 0.09, 3), 0.85, 0.85, 0.82)
      .translate(-4 + i * 2.6, 0.005, -1.5));
  }
  return merge(parts);
}

// ---- Phase 3L-4: industrial areas -----------------------------------------

function factory() {
  // Factory hall: big shed, sawtooth roofline with skylight panels, brick
  // smokestack, wide dark gate, sign band.
  const parts = [
    colorize(new THREE.BoxGeometry(9, 4.2, 6.6), 0.62, 0.63, 0.66).translate(0, 2.1, 0),
    colorize(new THREE.BoxGeometry(2.8, 3.0, 0.15), 0.07, 0.07, 0.08).translate(-1.6, 1.5, 3.32),
    colorize(new THREE.BoxGeometry(3.6, 0.7, 0.12), 0.85, 0.45, 0.15).translate(1.8, 3.6, 3.33),
    colorize(new THREE.CylinderGeometry(0.42, 0.58, 6.4, 6), 0.56, 0.30, 0.24).translate(3.2, 6.0, -2.2),
  ];
  for (let i = 0; i < 3; i++) {
    parts.push(colorize(new THREE.BoxGeometry(3.05, 0.16, 6.8), 0.5, 0.52, 0.55)
      .rotateZ(0.42).translate(-2.9 + i * 2.95, 4.85, 0));
    parts.push(colorize(new THREE.BoxGeometry(0.14, 1.15, 6.5), 0.25, 0.4, 0.55)
      .translate(-1.65 + i * 2.95, 4.68, 0));
  }
  return merge(parts);
}
function warehouse() {
  // Godam: long corrugated shed, two loading-bay doors + concrete dock.
  const parts = [
    colorize(new THREE.BoxGeometry(12, 3.4, 6), 0.68, 0.64, 0.55).translate(0, 1.7, 0),
    colorize(new THREE.BoxGeometry(2.4, 2.2, 0.14), 0.10, 0.10, 0.12).translate(-3.0, 1.75, 3.02),
    colorize(new THREE.BoxGeometry(2.4, 2.2, 0.14), 0.10, 0.10, 0.12).translate(3.0, 1.75, 3.02),
    colorize(new THREE.BoxGeometry(9.5, 0.85, 1.7), 0.58, 0.57, 0.54).translate(0, 0.42, 3.85),
    colorize(new THREE.BoxGeometry(2.6, 0.4, 1.6), 0.52, 0.51, 0.48).rotateX(-0.24).translate(0, 0.18, 5.2),
    colorize(new THREE.BoxGeometry(3.4, 0.55, 0.1), 0.2, 0.35, 0.6).translate(0, 3.05, 3.03),
  ];
  for (const rp of corrRoof(12.6, 6.6, 0.46, 0.48, 0.52)) parts.push(rp.rotateZ(0.05).translate(0, 3.55, 0));
  return merge(parts);
}
function truck() {
  // Parked lorry (Tata-style): bright cab, painted cargo bed, six wheels.
  const parts = [
    colorize(new THREE.BoxGeometry(5.6, 0.3, 1.7), 0.16, 0.16, 0.18).translate(0, 0.62, 0),
    colorize(new THREE.BoxGeometry(1.6, 1.6, 1.8), 0.78, 0.28, 0.16).translate(2.0, 1.55, 0),
    colorize(new THREE.BoxGeometry(0.14, 0.7, 1.5), 0.18, 0.24, 0.3).translate(2.62, 1.9, 0),
    colorize(new THREE.BoxGeometry(3.6, 1.7, 1.85), 0.24, 0.5, 0.32).translate(-0.9, 1.65, 0),
    colorize(new THREE.BoxGeometry(3.6, 0.35, 1.9), 0.72, 0.62, 0.3).translate(-0.9, 2.6, 0),
  ];
  for (const wx of [2.0, -0.1, -1.9]) {
    for (const wz of [-0.85, 0.85]) {
      parts.push(colorize(new THREE.CylinderGeometry(0.44, 0.44, 0.3, 7), 0.1, 0.1, 0.11)
        .rotateX(Math.PI / 2).translate(wx, 0.44, wz));
    }
  }
  return merge(parts);
}
function container() {
  // Shipping/storage container with door ribs.
  const parts = [
    colorize(new THREE.BoxGeometry(6, 2.55, 2.4), 0.70, 0.30, 0.20).translate(0, 1.3, 0),
    colorize(new THREE.BoxGeometry(0.12, 2.35, 2.2), 0.45, 0.19, 0.13).translate(3.02, 1.3, 0),
    colorize(new THREE.BoxGeometry(6.1, 0.14, 0.14), 0.5, 0.22, 0.15).translate(0, 2.6, 1.15),
    colorize(new THREE.BoxGeometry(6.1, 0.14, 0.14), 0.5, 0.22, 0.15).translate(0, 2.6, -1.15),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(colorize(new THREE.BoxGeometry(1.15, 2.3, 0.08), 0.62, 0.26, 0.17)
      .translate(-2.2 + i * 1.45, 1.3, 1.22));
  }
  return merge(parts);
}
function silo() {
  // Storage silo / fuel tank: steel cylinder, cone cap, ladder strip.
  return merge([
    colorize(new THREE.CylinderGeometry(1.25, 1.25, 4.4, 8), 0.76, 0.77, 0.80).translate(0, 2.5, 0),
    colorize(new THREE.ConeGeometry(1.3, 1.0, 8), 0.60, 0.62, 0.66).translate(0, 5.2, 0),
    colorize(new THREE.BoxGeometry(0.3, 4.4, 0.1), 0.4, 0.42, 0.45).translate(0, 2.4, 1.24),
    colorize(new THREE.BoxGeometry(1.9, 0.3, 1.9), 0.5, 0.5, 0.48).translate(0, 0.2, 0),
  ]);
}
function pylon() {
  // Transmission tower: tapered 4-sided lattice silhouette + two crossarms.
  return merge([
    colorize(new THREE.CylinderGeometry(0.16, 0.62, 11, 4), 0.55, 0.57, 0.60).translate(0, 5.5, 0),
    colorize(new THREE.BoxGeometry(4.2, 0.16, 0.16), 0.5, 0.52, 0.55).translate(0, 8.5, 0),
    colorize(new THREE.BoxGeometry(3.0, 0.16, 0.16), 0.5, 0.52, 0.55).translate(0, 10.0, 0),
    colorize(new THREE.BoxGeometry(0.1, 0.5, 0.1), 0.75, 0.77, 0.8).translate(-1.9, 8.2, 0),
    colorize(new THREE.BoxGeometry(0.1, 0.5, 0.1), 0.75, 0.77, 0.8).translate(1.9, 8.2, 0),
    colorize(new THREE.BoxGeometry(0.1, 0.5, 0.1), 0.75, 0.77, 0.8).translate(-1.3, 9.7, 0),
    colorize(new THREE.BoxGeometry(0.1, 0.5, 0.1), 0.75, 0.77, 0.8).translate(1.3, 9.7, 0),
  ]);
}
function fence() {
  // Compound fence panel: 8 m of grey mesh between three posts.
  return merge([
    colorize(new THREE.BoxGeometry(8, 1.55, 0.05), 0.47, 0.50, 0.53).translate(0, 1.05, 0),
    colorize(new THREE.BoxGeometry(8.1, 0.12, 0.07), 0.36, 0.38, 0.4).translate(0, 1.85, 0),
    colorize(new THREE.BoxGeometry(0.12, 2.0, 0.12), 0.34, 0.36, 0.38).translate(-3.95, 1.0, 0),
    colorize(new THREE.BoxGeometry(0.12, 2.0, 0.12), 0.34, 0.36, 0.38).translate(0, 1.0, 0),
    colorize(new THREE.BoxGeometry(0.12, 2.0, 0.12), 0.34, 0.36, 0.38).translate(3.95, 1.0, 0),
  ]);
}
function crane() {
  // Construction tower crane: mast, jib, counterweight, hanging hook.
  return merge([
    colorize(new THREE.BoxGeometry(0.55, 11.5, 0.55), 0.88, 0.68, 0.12).translate(0, 5.75, 0),
    colorize(new THREE.BoxGeometry(8.6, 0.42, 0.42), 0.88, 0.68, 0.12).translate(2.6, 11.6, 0),
    colorize(new THREE.BoxGeometry(0.5, 0.9, 0.9), 0.5, 0.5, 0.52).translate(-1.9, 11.3, 0),
    colorize(new THREE.BoxGeometry(0.05, 3.4, 0.05), 0.15, 0.15, 0.16).translate(6.2, 9.9, 0),
    colorize(new THREE.BoxGeometry(0.5, 0.4, 0.5), 0.45, 0.45, 0.48).translate(6.2, 8.0, 0),
  ]);
}
function pile() {
  // Sand/gravel heap at yards and construction sites.
  const g = new THREE.IcosahedronGeometry(1, 0);
  const rng = mulberry32(4242);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, p.getX(i) * (1.35 + rng() * 0.3));
    p.setY(i, Math.max(0.02, p.getY(i)) * 0.6);
    p.setZ(i, p.getZ(i) * (1.15 + rng() * 0.3));
  }
  g.computeVertexNormals();
  return colorize(g, 0.60, 0.53, 0.40).translate(0, 0.06, 0);
}
function conFrame() {
  // Building under construction: concrete column-and-slab frame with rebar.
  const parts = [
    colorize(new THREE.BoxGeometry(7, 0.32, 5), 0.70, 0.70, 0.67).translate(0, 0.2, 0),
    colorize(new THREE.BoxGeometry(7, 0.32, 5), 0.70, 0.70, 0.67).translate(0, 3.1, 0),
    colorize(new THREE.BoxGeometry(7, 0.32, 5), 0.70, 0.70, 0.67).translate(0, 5.9, 0),
  ];
  for (const cx of [-3.1, 0, 3.1]) {
    for (const cz of [-2.15, 2.15]) {
      parts.push(colorize(new THREE.BoxGeometry(0.38, 5.8, 0.38), 0.60, 0.60, 0.58)
        .translate(cx, 3.0, cz));
      parts.push(colorize(new THREE.BoxGeometry(0.08, 1.0, 0.08), 0.45, 0.30, 0.22)
        .translate(cx, 6.4, cz));
    }
  }
  return merge(parts);
}
function bigStand() {
  // Large stadium tier: five stepped rows, seat band, back wall, roof strip.
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const seat = i % 2 === 0;
    parts.push(colorize(new THREE.BoxGeometry(16, 0.72, 1.35),
      seat ? 0.26 : 0.72, seat ? 0.44 : 0.70, seat ? 0.72 : 0.66)
      .translate(0, 0.36 + i * 0.72, -i * 1.25));
  }
  parts.push(colorize(new THREE.BoxGeometry(16, 1.3, 0.45), 0.66, 0.64, 0.60).translate(0, 4.1, -5.2));
  parts.push(colorize(new THREE.BoxGeometry(16, 0.18, 3.2), 0.80, 0.30, 0.24).translate(0, 5.1, -4.0));
  parts.push(colorize(new THREE.BoxGeometry(0.2, 1.6, 0.2), 0.5, 0.5, 0.52).translate(-7.4, 4.2, -3.0));
  parts.push(colorize(new THREE.BoxGeometry(0.2, 1.6, 0.2), 0.5, 0.5, 0.52).translate(7.4, 4.2, -3.0));
  return merge(parts);
}

export const PROP_TYPES = [
  { name: 'pine', build: pine, max: 800 },
  { name: 'tree', build: broadleaf, max: 420 },
  { name: 'bush', build: bush, max: 560 },
  { name: 'rock', build: rock, max: 620 },
  { name: 'log', build: log, max: 170 },
  { name: 'haystack', build: haystack, max: 90 },
  { name: 'house', build: house, max: 48 },
  { name: 'wall', build: wall, max: 140 },
  { name: 'flagpole', build: flagpole, max: 40, doubleSided: true },
  { name: 'stupa', build: stupa, max: 16 },
  { name: 'bridge', build: bridgeDeck, max: 16 },
  { name: 'ramp', build: rampDeck, max: 16, doubleSided: true },
  // Micro-props (Phase 3C-1 ground detail): dense, tiny, never collide.
  { name: 'grass', build: grass, max: 1000, doubleSided: true },
  { name: 'stone', build: stone, max: 450 },
  { name: 'branch', build: branch, max: 160 },
  // Phase 3L-1 rural world.
  { name: 'corn', build: corn, max: 520, doubleSided: true },
  { name: 'mill', build: waterMill, max: 10 },
  // Phase 3L-1F crop rows (one instance = one planted row strip).
  { name: 'rice', build: rice, max: 420, doubleSided: true },
  { name: 'wheat', build: wheat, max: 420 },
  { name: 'mustard', build: mustard, max: 320 },
  { name: 'potato', build: potato, max: 300 },
  { name: 'veg', build: veg, max: 260 },
  { name: 'tea', build: tea, max: 380 },
  { name: 'banana', build: banana, max: 110, doubleSided: true },
  { name: 'channel', build: channel, max: 120 },
  // Phase 3L-2 town & bazaar buildings.
  { name: 'townhouseA', build: townhouseA, max: 60 },
  { name: 'townhouseB', build: townhouseB, max: 60 },
  { name: 'shop', build: shop, max: 60 },
  { name: 'teashop', build: teashop, max: 36 },
  { name: 'workshop', build: workshop, max: 20 },
  { name: 'school', build: school, max: 10 },
  { name: 'clinic', build: clinic, max: 10 },
  { name: 'busstop', build: busstop, max: 20 },
  { name: 'fuel', build: fuelStation, max: 10 },
  { name: 'pole', build: utilityPole, max: 90 },
  { name: 'stall', build: marketStall, max: 60 },
  // Phase 3L-3 city pieces.
  { name: 'cityA', build: cityBuildingA, max: 46 },
  { name: 'cityB', build: cityBuildingB, max: 46 },
  { name: 'pagoda', build: pagodaTemple, max: 6 },
  { name: 'stand', build: standSegment, max: 16 },
  { name: 'roadseg', build: roadSegment, max: 130 },
  { name: 'roadsign', build: roadSign, max: 40 },
  { name: 'parklot', build: parkingLot, max: 20 },
  // Phase 3L-4 industrial areas + big stadiums.
  { name: 'factory', build: factory, max: 10 },
  { name: 'warehouse', build: warehouse, max: 14 },
  { name: 'truck', build: truck, max: 24 },
  { name: 'container', build: container, max: 30 },
  { name: 'silo', build: silo, max: 14 },
  { name: 'pylon', build: pylon, max: 10 },
  { name: 'fence', build: fence, max: 90 },
  { name: 'crane', build: crane, max: 6 },
  { name: 'pile', build: pile, max: 20 },
  { name: 'frame', build: conFrame, max: 6 },
  { name: 'bigstand', build: bigStand, max: 26 },
];

export const PROP = {};
PROP_TYPES.forEach((t, i) => { PROP[t.name] = i; });
