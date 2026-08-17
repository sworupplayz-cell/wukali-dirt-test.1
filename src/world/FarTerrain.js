import * as THREE from 'three';
import { colorFor } from './palette.js';

/**
 * FarTerrain (Phase 3) — static low-LOD backdrop of the whole continent.
 *
 * The near streamed tiles only cover ~437 m; the Phase 3 mountain ranges
 * are visible for kilometres. This is the cheapest possible answer: the
 * ENTIRE 10,000 x 5,000 m world sampled once at startup on a 50 m grid
 * and split into 4 static meshes (2x2, frustum-culled). ~40 k triangles,
 * 4 draw calls, zero per-frame CPU cost, built from the same analytic
 * field and palette as the near tiles so silhouettes and colors agree.
 *
 * Near-field handling: fragments closer than 385 m are discarded (the
 * near tile window fully covers that disc), so the coarse mesh can never
 * poke through the detailed terrain the player rides on. One line
 * injected into the Lambert shader — reuses the fog depth varying, no
 * custom shader program.
 */

const STEP = 62.5; // 160x80 world grid (exact binary) — ~25 k triangles total
const W = 8000, H = 5000;
const CHUNKS_X = 2, CHUNKS_Z = 2;
const DISCARD_NEAR = 330; // near tile window worst-case covers 375 m
// Sun rig direction (matches SectorWorld + TerrainTiles).
const SUN_X = 0.632, SUN_Y = 0.677, SUN_Z = 0.361;

/** Near-tile-matching relief shading, applied to a finished backdrop chunk. */
function shadeVertices(geo) {
  const col = geo.attributes.color.array;
  const nor = geo.attributes.normal.array;
  for (let v = 0; v < col.length; v += 3) {
    const nx = nor[v], ny = nor[v + 1], nz = nor[v + 2];
    const lit = nx * SUN_X + ny * SUN_Y + nz * SUN_Z - SUN_Y;
    const shade = 0.82 + 0.18 * ny;
    let r = col[v] * shade, g = col[v + 1] * shade, b = col[v + 2] * shade;
    if (lit > 0) { r += lit * 0.11; g += lit * 0.07; b -= lit * 0.035; }
    else { r += lit * 0.05; g += lit * 0.02; b -= lit * 0.075; }
    // Chapter 6B — mirror the near tiles' SLOPE WEAR. The tile builder
    // now bares the earth on anything steep; without the same pass here a
    // mountain flank changed colour the moment a streamed tile took over
    // from the backdrop, which is the tone step Chapter 5 spent a pass
    // removing. The backdrop's 62.5 m grid gives softer normals, so the
    // effect is naturally gentler at range — which is what we want.
    const steep = ny < 0.90 ? (0.90 - ny) / 0.54 : 0;
    if (steep > 0) {
      const w = steep > 1 ? 1 : steep;
      r += (0.44 - r) * w * 0.44;
      g += (0.36 - g) * w * 0.44;
      b += (0.26 - b) * w * 0.44;
    }
    // Chapter 6B — no altitude haze here. Mixing high backdrop ground
    // toward the horizon colour did separate the mountain layers, but it
    // applies to the BACKDROP ONLY: the near tiles have no matching term,
    // so ground at the same altitude changed colour the moment a streamed
    // tile took over, and where the coarse mesh poked through it showed
    // as a flat pale slab in the middle distance. Distance haze has to
    // come from fog, which is a function of camera distance and therefore
    // agrees across both LODs by construction.
    col[v] = r < 0 ? 0 : r;
    col[v + 1] = g < 0 ? 0 : g;
    col[v + 2] = b < 0 ? 0 : b;
  }
}

export class FarTerrain {
  constructor(scene, field) {
    // Chapter 3D: polygonOffset pushes the backdrop behind the near tiles
    // in depth so the overlap band (375-560 m) can never z-fight even at
    // km-scale depth-buffer precision.
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         #ifdef USE_FOG
           if (vFogDepth < ${DISCARD_NEAR.toFixed(1)}) discard;
         #endif`
      );
    };

    const info = { h: 0, trail: 0, moist: 0, mtn: 0 };
    const rgb = [0, 0, 0];
    const cw = W / CHUNKS_X, ch = H / CHUNKS_Z;
    const nx = cw / STEP, nz = ch / STEP;

    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        const ox = cx * cw, oz = cz * ch;
        const verts = (nx + 1) * (nz + 1);
        const pos = new Float32Array(verts * 3);
        const col = new Float32Array(verts * 3);
        for (let j = 0; j <= nz; j++) {
          for (let i = 0; i <= nx; i++) {
            const v = j * (nx + 1) + i;
            const wx = ox + i * STEP, wz = oz + j * STEP;
            field.sample(wx, wz, info);
            pos[v * 3] = wx;
            pos[v * 3 + 1] = info.h - 2.2; // sit clearly under the near tiles
            pos[v * 3 + 2] = wz;
            colorFor(info, rgb, wx, wz);
            col[v * 3] = rgb[0]; col[v * 3 + 1] = rgb[1]; col[v * 3 + 2] = rgb[2];
          }
        }
        const idx = [];
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
            idx.push(a, c, b, b, c, d);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        // Chapter 5: apply the SAME relief shading the near tiles use
        // (slope darkening + warm sun / cool sky directional paint). The
        // backdrop used to be lit by Lambert alone, so a mountain flank
        // changed tone the moment a streamed tile took over from it —
        // that tone step is what read as terrain popping at range.
        shadeVertices(geo);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
      }
    }
  }
}
