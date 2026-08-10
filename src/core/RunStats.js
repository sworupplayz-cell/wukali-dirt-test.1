/**
 * RunStats — distance, best-distance persistence and the difficulty value
 * future systems will read. Distance integrates actual bike movement per
 * fixed step; a per-step cap filters out teleports (reset / restart), so
 * they can never inflate the total.
 */
const BEST_KEY = 'wukali_best_m';
// Max legitimate movement in one 1/60 s step is ~0.45 m (26 m/s);
// anything above this is a teleport and is ignored.
const STEP_CAP = 0.9;

export class RunStats {
  constructor() {
    this.distance = 0; // meters
    this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
    this._px = 0;
    this._pz = 0;
  }

  /** Start a new run at the bike's position. */
  reset(x, z) {
    this.distance = 0;
    this._px = x;
    this._pz = z;
  }

  /** Per fixed step; `active` is false while crashed/paused-out. */
  step(x, z, active) {
    const dx = x - this._px, dz = z - this._pz;
    this._px = x;
    this._pz = z;
    if (!active) return;
    const d = Math.hypot(dx, dz);
    if (d < STEP_CAP) this.distance += d;
  }

  /** Close the run; returns true if it set a new best. */
  endRun() {
    if (this.distance > this.best) {
      this.best = this.distance;
      localStorage.setItem(BEST_KEY, String(Math.round(this.best)));
      return true;
    }
    return false;
  }

  /**
   * Progression value for future systems (0 at start, 1 at 4 km).
   * Nothing consumes it yet by design — Phase 3A only exposes it.
   */
  get difficulty() {
    return Math.min(1, this.distance / 4000);
  }
}
