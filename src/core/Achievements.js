/**
 * Achievements — lightweight local achievement manager.
 * One record per conquered mountain summit plus count-based meta
 * achievements. Persists to localStorage; no backend, no per-frame work.
 * Kept UI-agnostic so a future dedicated achievements screen can read
 * `list()` without changes here.
 */
const KEY = 'wukali_achievements';

const META = [
  { count: 1, id: 'first_summit', title: 'First Summit' },
  { count: 3, id: 'mountain_rider', title: 'Mountain Rider' },
  { count: 5, id: 'king_of_mountains', title: 'King of the Mountains' },
];

export class Achievements {
  constructor() {
    try {
      this._data = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      this._data = {};
    }
    this._data.summits = this._data.summits || {};
    this._data.meta = this._data.meta || {};
    this._data.trials = this._data.trials || {};
    this._data.discoveries = this._data.discoveries || {};
    this._data.challenges = this._data.challenges || {};
  }

  /**
   * Challenge completion (Phase 3K-3). Stunt zones keep the best SCORE,
   * timed runs keep the best TIME. Returns { first, improved, best, meta }.
   */
  completeChallenge(id, name, kind, value) {
    const prev = this._data.challenges[id];
    const first = prev === undefined;
    const improved = first || (kind === 'sz' ? value > prev.v : value < prev.v);
    if (improved) this._data.challenges[id] = { v: value, name, kind };
    const metaKey = kind === 'sz' ? 'stunt_star' : kind === 'or' ? 'pathfinder' : 'wayfinder';
    let meta = null;
    if (!this._data.meta[metaKey]) {
      this._data.meta[metaKey] = true;
      meta = kind === 'sz' ? 'Stunt Star' : kind === 'or' ? 'Pathfinder' : 'Wayfinder';
    }
    this._save();
    return { first, improved, best: this._data.challenges[id].v, meta };
  }

  /**
   * Nature discovery (Phase 3K-2): lakes, waterfalls, viewpoints.
   * Returns null if already discovered, else { name, count, meta }.
   */
  discover(id, name) {
    if (this._data.discoveries[id]) return null;
    this._data.discoveries[id] = name;
    const count = Object.keys(this._data.discoveries).length;
    let meta = null;
    if (count >= 5 && !this._data.meta.explorer) {
      this._data.meta.explorer = true;
      meta = 'Explorer';
    }
    this._save();
    return { name, count, meta };
  }

  /**
   * Register a time-trial completion (Phase 3K-1). Keeps the best time per
   * mountain. Returns { first, improved, best } for the UI.
   */
  completeTrial(id, name, time) {
    const prev = this._data.trials[id];
    const first = prev === undefined;
    const improved = first || time < prev.t;
    if (improved) this._data.trials[id] = { t: time, name };
    let meta = null;
    if (!this._data.meta.trail_timer) {
      this._data.meta.trail_timer = true;
      meta = 'Trail Timer';
    }
    this._save();
    return { first, improved, best: this._data.trials[id].t, meta };
  }

  get summitCount() {
    return Object.keys(this._data.summits).length;
  }

  hasSummit(id) {
    return !!this._data.summits[id];
  }

  /**
   * Register a summit. Returns null if already conquered, else
   * { name, meta: [newly unlocked meta titles] } for the UI banner.
   */
  reachSummit(mountain) {
    if (this._data.summits[mountain.id]) return null;
    this._data.summits[mountain.id] = mountain.name;
    const meta = [];
    for (const a of META) {
      if (!this._data.meta[a.id] && this.summitCount >= a.count) {
        this._data.meta[a.id] = true;
        meta.push(a.title);
      }
    }
    this._save();
    return { name: mountain.name, meta };
  }

  /** All unlocked achievements (for a future achievements screen). */
  list() {
    return {
      summits: { ...this._data.summits },
      meta: META.filter((a) => this._data.meta[a.id]).map((a) => a.title),
      trials: { ...this._data.trials },
      discoveries: { ...this._data.discoveries },
      challenges: { ...this._data.challenges },
    };
  }

  _save() {
    localStorage.setItem(KEY, JSON.stringify(this._data));
  }
}
