import * as THREE from 'three';

/**
 * textures.js (Chapter 3B) — procedural hand-painted textures.
 *
 * Everything is generated ONCE at startup on small canvases (no asset
 * files, nothing over 512x512, no PBR maps):
 *
 *   groundAtlas()  — ONE shared 512x512 atlas, 3x2 cells of painted
 *                    materials: grass, dirt, rock | gravel, snow, mud.
 *                    Sampled by props/vegetation (rocks use the rock and
 *                    gravel cells). Each cell is painted with wrapped
 *                    daubs so it tiles seamlessly inside its region.
 *
 *   detailTexture() — a 256x256 seamless NEUTRAL paint-daub map, tiled
 *                    in world space over the terrain and multiplied with
 *                    the vertex-color palette: the vertex colors keep
 *                    doing the material blending (grass/dirt/rock/snow),
 *                    the daubs add the hand-painted brushwork. Average
 *                    luminance ~0.94 so LOD levels still color-match.
 *
 * Deterministic (seeded PRNG) so every load paints the same world.
 */

function prng(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paint wrapped elliptical daubs into a region so it tiles seamlessly. */
function daubs(ctx, x0, y0, w, h, rnd, colors, n, rMin, rMax, alpha) {
  for (let i = 0; i < n; i++) {
    const c = colors[(rnd() * colors.length) | 0];
    const px = x0 + rnd() * w, py = y0 + rnd() * h;
    const rx = rMin + rnd() * (rMax - rMin);
    const ry = rx * (0.55 + rnd() * 0.7);
    const rot = rnd() * Math.PI;
    ctx.fillStyle = c;
    ctx.globalAlpha = alpha * (0.6 + rnd() * 0.4);
    // 3x3 wrap so daubs crossing the cell edge reappear on the far side.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cx = px + ox * w, cy = py + oy * h;
        if (cx < x0 - rx * 2 || cx > x0 + w + rx * 2 ||
            cy < y0 - ry * 2 || cy > y0 + h + ry * 2) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, w, h);
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
}

let _atlas = null;

/** Shared 512x512 painted material atlas (grass/dirt/rock/gravel/snow/mud). */
export function groundAtlas() {
  if (_atlas) return _atlas;
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  const ctx = cv.getContext('2d');
  const rnd = prng(3301);
  const CW = 512 / 3, CH = 256;

  const cells = [
    { base: '#6b8f43', cols: ['#7ba04c', '#5c8039', '#86a95a', '#4f7333', '#93b060'] }, // grass
    { base: '#8a6a44', cols: ['#97764e', '#7a5c3a', '#a2825a', '#6d5233', '#8f7048'] }, // dirt
    { base: '#7d7a74', cols: ['#8b8880', '#6e6b66', '#96938a', '#615f5b', '#84817a'] }, // rock
    { base: '#9a917f', cols: ['#a89f8c', '#8a8272', '#b3aa96', '#7d7668', '#a19885'] }, // gravel
    { base: '#e9edf2', cols: ['#f4f7fa', '#dde4ec', '#ffffff', '#d2dbe6', '#eef2f6'] }, // snow
    { base: '#5f4a35', cols: ['#6b543d', '#52402e', '#775e44', '#483828', '#645040'] }, // mud
  ];
  cells.forEach((c, i) => {
    const x0 = (i % 3) * CW, y0 = ((i / 3) | 0) * CH;
    ctx.fillStyle = c.base;
    ctx.fillRect(x0, y0, CW, CH);
    daubs(ctx, x0, y0, CW, CH, rnd, c.cols, 90, 10, 34, 0.5);  // broad strokes
    daubs(ctx, x0, y0, CW, CH, rnd, c.cols, 160, 2.5, 8, 0.7); // fine speckle
  });

  _atlas = new THREE.CanvasTexture(cv);
  _atlas.colorSpace = THREE.SRGBColorSpace;
  _atlas.wrapS = _atlas.wrapT = THREE.ClampToEdgeWrapping;
  _atlas.anisotropy = 2;
  return _atlas;
}

/** UV rect of an atlas cell (inset to avoid bleeding across cells). */
export function atlasCell(name) {
  const idx = { grass: 0, dirt: 1, rock: 2, gravel: 3, snow: 4, mud: 5 }[name];
  const u0 = (idx % 3) / 3, v0 = idx < 3 ? 0.5 : 0; // canvas y down -> v up
  const inset = 0.012;
  return { u0: u0 + inset, v0: v0 + inset, du: 1 / 3 - inset * 2, dv: 0.5 - inset * 2 };
}

let _detail = null;

/** 256x256 seamless neutral paint-daub detail map (world-tiled multiply). */
export function detailTexture() {
  if (_detail) return _detail;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const ctx = cv.getContext('2d');
  const rnd = prng(7717);
  ctx.fillStyle = 'rgb(240,240,238)';
  ctx.fillRect(0, 0, 256, 256);
  // Neutral daubs: warm/cool luminance strokes around ~0.94 average.
  const tones = [
    'rgb(255,253,247)', 'rgb(224,226,222)', 'rgb(248,244,234)',
    'rgb(214,219,218)', 'rgb(252,248,242)', 'rgb(232,229,220)',
  ];
  daubs(ctx, 0, 0, 256, 256, rnd, tones, 130, 8, 30, 0.5);
  daubs(ctx, 0, 0, 256, 256, rnd, tones, 240, 2, 6, 0.6);
  _detail = new THREE.CanvasTexture(cv);
  _detail.colorSpace = THREE.SRGBColorSpace;
  _detail.wrapS = _detail.wrapT = THREE.RepeatWrapping;
  _detail.anisotropy = 2;
  return _detail;
}

/** Vertical sky gradient (zenith -> horizon) used as the scene background. */
export function skyGradient() {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 128;
  const ctx = cv.getContext('2d');
  // Chapter 6B: four stops instead of three. A two-segment ramp put the
  // whole sky in one blue; the extra stop lets the band just above the
  // horizon go pale and slightly warm, which is what reads as depth in
  // the distance and gives the mountain silhouettes something to sit
  // against. The bottom stop matches HORIZON in palette.js exactly, so
  // the fog dissolves into the sky with no visible seam.
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#4a8ccc');    // zenith, deeper
  g.addColorStop(0.42, '#7db6e4'); // upper
  g.addColorStop(0.78, '#aed3ea'); // lower, cooling out
  g.addColorStop(1, '#d3e2ea');    // horizon haze (== HORIZON)
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
