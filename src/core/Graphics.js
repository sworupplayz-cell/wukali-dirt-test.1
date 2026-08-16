import * as THREE from 'three';

/**
 * Graphics (Chapter 3C) — the complete graphics quality system.
 *
 * RENDERING ONLY: every knob here touches the renderer, lights, fog,
 * camera far plane, vegetation instance counts or texture bindings.
 * Physics, terrain generation, roads, camera behaviour and streaming
 * architecture are untouched.
 *
 * 5 presets (Potato / Low / Medium / High / Ultra) + full manual
 * overrides, persisted to localStorage and restored on launch. First
 * launch auto-detects the device tier. Every change applies INSTANTLY —
 * even anti-aliasing (the canvas is swapped for a fresh GL context).
 */

const KEY = 'horizon_graphics';

export const PRESETS = {
  potato: {
    renderScale: 0.6, renderDist: 800, shadows: 0, vegetation: 0.25,
    terrainDetail: 0, fogQuality: 0, antialias: false, fpsLimit: 60,
  },
  low: {
    renderScale: 0.8, renderDist: 1200, shadows: 1, vegetation: 0.5,
    terrainDetail: 1, fogQuality: 1, antialias: false, fpsLimit: 60,
  },
  medium: {
    renderScale: 1.0, renderDist: 1800, shadows: 2, vegetation: 0.75,
    terrainDetail: 1, fogQuality: 1, antialias: true, fpsLimit: 60,
  },
  high: {
    renderScale: 1.2, renderDist: 2400, shadows: 3, vegetation: 1.0,
    terrainDetail: 1, fogQuality: 1, antialias: true, fpsLimit: 60,
  },
  ultra: {
    renderScale: 1.5, renderDist: 3200, shadows: 4, vegetation: 1.0,
    terrainDetail: 1, fogQuality: 1, antialias: true, fpsLimit: 120,
  },
};

// Shadow tiers: 0 off | 1 low 512 | 2 medium 1024 | 3 high 1536 | 4 ultra 2048.
const SHADOW_MAP = [0, 512, 1024, 1536, 2048];
// Render distance -> FogExp2 density (tuned visually) and camera far plane.
const FOG_D = { 800: 0.00125, 1200: 0.00082, 1800: 0.00056, 2400: 0.00042, 3200: 0.00030 };
const FAR_D = { 800: 3200, 1200: 4800, 1800: 7000, 2400: 9600, 3200: 12000 };
// Vegetation far-impostor ring radius by density tier.
const VEG_FAR_R = (v) => (v <= 0.25 ? 2 : v <= 0.5 ? 3 : 4);

export class Graphics {
  constructor() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY)); } catch { /* defaults */ }
    if (stored && stored.preset) {
      this.data = { ...PRESETS.medium, ...stored };
      this.preset = stored.preset;
    } else {
      // First launch: auto-detect the device tier.
      this.preset = detectTier();
      this.data = { ...PRESETS[this.preset], preset: this.preset };
      this._save();
    }
    this.game = null;
  }

  /** Estimated tier chosen on first launch ('potato'|'medium'|'high'). */
  get current() { return this.data; }

  attach(game) {
    this.game = game;
    this.apply();
  }

  setPreset(name) {
    if (!PRESETS[name]) return;
    this.preset = name;
    this.data = { ...PRESETS[name], preset: name };
    this._save();
    this.apply();
  }

  /** Manual override of one setting (marks the preset as custom). */
  set(key, value) {
    this.data[key] = value;
    if (key !== 'fpsLimit') { this.preset = 'custom'; this.data.preset = 'custom'; }
    this._save();
    this.apply();
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  /** Push every setting into the live renderer/scene. Instant, no restart. */
  apply() {
    const g = this.game;
    if (!g) return;
    const d = this.data;

    // Anti-aliasing needs a fresh GL context: swap the canvas if changed.
    if (g.renderer.getContextAttributes?.().antialias !== undefined) {
      const cur = g.renderer.getContext().getContextAttributes().antialias;
      if (cur !== d.antialias) g.recreateRenderer(d.antialias);
    }

    // Render scale.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    g.renderer.setPixelRatio(Math.max(0.4, dpr * d.renderScale));
    g._resize();

    // FPS limit.
    g.setFpsLimit(d.fpsLimit);

    // Render distance: fog density + camera far plane.
    const world = g.world;
    const fogD = FOG_D[d.renderDist] ?? 0.00056;
    if (d.fogQuality === 0) {
      // Simplified fog: linear (cheapest shader path).
      const end = 1.9 / fogD;
      world.scene.fog = new THREE.Fog(new THREE.Color(0xc9dfec), end * 0.22, end);
    } else {
      world.scene.fog = new THREE.FogExp2(new THREE.Color(0xc9dfec), fogD);
    }
    g.camera.far = FAR_D[d.renderDist] ?? 7000;
    g.camera.updateProjectionMatrix();

    // Shadows.
    const size = SHADOW_MAP[d.shadows] || 0;
    const sun = world.sun;
    if (sun) {
      const on = size > 0;
      if (g.renderer.shadowMap.enabled !== on) {
        g.renderer.shadowMap.enabled = on;
        // Recompile materials so the shadow chunks are added/removed.
        world.scene.traverse((o) => {
          if (o.material) o.material.needsUpdate = true;
        });
      }
      sun.castShadow = on;
      if (on && sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
    }

    // Better lighting at High/Ultra: stronger warm sun + brighter fill.
    if (world.sun) world.sun.intensity = d.shadows >= 3 ? 1.45 : 1.35;
    if (world.fill) world.fill.intensity = d.shadows >= 3 ? 0.3 : 0.22;

    // Vegetation density + far-impostor ring.
    if (world.vegetation) {
      world.vegetation.setQuality(d.vegetation, VEG_FAR_R(d.vegetation));
    }

    // Terrain detail: painted brushwork map on/off.
    if (world.tiles && world.tiles.setDetail) world.tiles.setDetail(d.terrainDetail > 0);
  }
}

/** Crude first-launch device-tier estimate (players can change anytime). */
function detectTier() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile && (mem <= 2 || cores <= 4)) return 'potato';
  if (!mobile && cores >= 8 && mem >= 8) return 'high';
  if (mobile && mem >= 6 && cores >= 8) return 'high';
  return 'medium';
}
