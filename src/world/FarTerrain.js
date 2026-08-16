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
const W = 8000, H = 4000;
const CHUNKS_X = 2, CHUNKS_Z = 2;
const DISCARD_NEAR = 330; // near tile window worst-case covers 375 m

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
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
      }
    }
  }
}
