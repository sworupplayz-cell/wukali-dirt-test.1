import * as THREE from 'three';
import { vnoise } from './noise.js';

/**
 * Mountains — layered distant Himalayan backdrop.
 *
 * Three concentric ridgeline bands around the player (radii beyond the
 * mountain-destination impostor range, so real destinations are never
 * occluded). Each band's silhouette comes from periodic seeded noise
 * (sampled on a circle, so there is no wrap seam), with atmospheric
 * depth colors: nearer band darker/greener, farther bands paler with
 * snow. One merged geometry, one unlit draw call, no collision, and the
 * group simply follows the player so the horizon never ends.
 */
const BANDS = [
  // radius, base height, ridge amplitude, snow fraction, haze (0 near .. 1 far)
  // Low rolling mid-hills just past streaming range: bridges the fog line
  // to the far ridges (kept low so destination impostors stay visible).
  { r: 1500, base: 8, amp: 62, snow: 2, haze: 0.68 },
  { r: 2500, base: 90, amp: 210, snow: 0.72, haze: 0.30 },
  { r: 3300, base: 160, amp: 330, snow: 0.55, haze: 0.55 },
  { r: 4300, base: 260, amp: 470, snow: 0.42, haze: 0.75 },
];
const SEGS = 160;
const SKY = { r: 0.7, g: 0.83, b: 0.94 };

export class Mountains {
  constructor(scene, seed) {
    const pos = [], col = [], idx = [];
    let vbase = 0;
    BANDS.forEach((band, bi) => {
      const salt = (seed | 0) * 31 + bi * 7 + 101;
      // Column heights from periodic ridged noise.
      const hs = new Array(SEGS);
      for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        // Sample noise on a circle => silhouette is periodic (no seam).
        const cx = Math.cos(a) * 2.3 + 9.7, cz = Math.sin(a) * 2.3 - 4.1;
        let n = vnoise(cx, cz, salt);
        n = 0.62 * n + 0.38 * vnoise(cx * 2.7 + 13.1, cz * 2.7 + 5.7, salt + 3);
        const ridged = 1 - Math.abs(2 * n - 1); // sharp peaks, soft valleys
        hs[s] = band.base + band.amp * (0.28 + 0.72 * ridged * ridged);
      }
      // Three rows per column: below-horizon base, shoulder, peak.
      const rowY = (s, row) => (row === 0 ? -140 : row === 1 ? hs[s] * 0.52 : hs[s]);
      for (let row = 0; row < 3; row++) {
        for (let s = 0; s < SEGS; s++) {
          const a = (s / SEGS) * Math.PI * 2;
          pos.push(Math.cos(a) * band.r, rowY(s, row), Math.sin(a) * band.r);
          const t = hs[s] / (band.base + band.amp); // 0..1 peak fraction
          let r, g, b;
          if (row === 0) {
            // Base melts into the horizon haze.
            r = SKY.r; g = SKY.g; b = SKY.b;
          } else {
            // Forested-blue lower slopes -> rock -> snow by height.
            r = 0.30; g = 0.40; b = 0.42;
            const rock = smooth(0.45, 0.7, t * (row === 1 ? 0.55 : 1));
            r += (0.46 - r) * rock; g += (0.47 - g) * rock; b += (0.53 - b) * rock;
            const snow = row === 2 ? smooth(band.snow, band.snow + 0.12, t) : 0;
            r += (0.94 - r) * snow; g += (0.95 - g) * snow; b += (0.98 - b) * snow;
            // Atmospheric perspective per band.
            r += (SKY.r - r) * band.haze; g += (SKY.g - g) * band.haze; b += (SKY.b - b) * band.haze;
          }
          col.push(r, g, b);
        }
      }
      for (let row = 0; row < 2; row++) {
        const a0 = vbase + row * SEGS, b0 = vbase + (row + 1) * SEGS;
        for (let s = 0; s < SEGS; s++) {
          const s1 = (s + 1) % SEGS;
          idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
        }
      }
      vbase += 3 * SEGS;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    // Unlit + fog-exempt: pure silhouettes above the distance haze.
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: false,
      side: THREE.DoubleSide, // robust to winding; 2k tris either way
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(x, z) {
    this.mesh.position.set(x, 0, z);
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
