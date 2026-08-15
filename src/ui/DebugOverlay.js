/**
 * DebugOverlay (Phase 1B) — small developer HUD for the streaming engine.
 *
 * Shows: FPS, player X/Z, current sector, loaded sector count, draw calls.
 * Toggle: F3 (desktop) or the tiny DBG button (mobile).
 *
 * Zero cost while hidden; visible it updates the DOM at 5 Hz, never per
 * frame. Listens on window directly so the Input abstraction (preserved
 * this phase) stays untouched.
 */
export class DebugOverlay {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('debug-overlay');
    this.btn = document.getElementById('btn-debug');
    this.visible = false;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault(); // browsers bind F3 to find-in-page
        this.toggle();
      }
    });
    this.btn.addEventListener('click', () => this.toggle());

    this._timer = setInterval(() => this._paint(), 200);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    this.btn.classList.toggle('on', this.visible);
  }

  _paint() {
    if (!this.visible) return;
    const g = this.game;
    const p = g.bike.position;
    const d = g.world.debug;
    const info = g.renderer.info.render;
    const groundH = g.world.getHeight(p.x, p.z);
    const slope = g.world.slopeAt ? g.world.slopeAt(p.x, p.z) : 0;
    const peak = g.world.peakAt ? g.world.peakAt(p.x, p.z) : null;
    this.el.textContent =
      `FPS ${g.stats.fps}\n` +
      `X ${p.x.toFixed(1)}  Z ${p.z.toFixed(1)}\n` +
      `SECTOR (${d.sectorX},${d.sectorZ})\n` +
      `LOADED ${d.loaded}  TILES ${d.tiles ?? 0}\n` +
      `ELEVATION ${groundH.toFixed(1)} m\n` +
      `ALTITUDE ${Math.max(0, p.y - groundH).toFixed(2)} m\n` +
      `SLOPE ${(slope * 100).toFixed(0)}%  (${(Math.atan(slope) * 180 / Math.PI).toFixed(1)}\u00B0)\n` +
      (peak
        ? `PEAK ${peak.name}  [${peak.id}]\nRANGE ${peak.chain}\n`
        : `PEAK -\n`) +
      `DRAW CALLS ${info.calls}  TRIS ${info.triangles}`;
  }
}
