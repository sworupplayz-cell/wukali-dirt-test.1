/**
 * ChunkGrid — neutral sector/chunk bookkeeping utility.
 *
 * Retained from the endless-world streaming architecture (Phase 1A reset),
 * stripped of all terrain generation: it only tracks which grid cells
 * around a moving focus point should be active, and reports enter/leave
 * deltas. Future world content can attach whatever it wants to a cell.
 *
 * Not wired into any update loop; it costs nothing until used.
 */
const KEY = 65536;   // cell-key stride
const HALF = KEY / 2; // decode window for negative cz

export class ChunkGrid {
  /**
   * @param {number} cellSize world-units per cell
   * @param {number} radius   active Chebyshev radius, in cells
   */
  constructor(cellSize, radius) {
    this.cellSize = cellSize;
    this.radius = radius;
    // Chapter 5: INTEGER cell keys (cx * KEY + cz) instead of "cx,cz"
    // strings. A window refresh used to build ~121 template strings and
    // then parse them back with split(',').map(Number) — pure garbage on
    // exactly the frame the player crosses a boundary, i.e. exactly when
    // the frame budget is already paying for new tiles.
    this.cells = new Map(); // key(cx,cz) -> user data (or true)
    this._fx = null;
    this._fz = null;
  }

  /** Integer key for a cell (shared by every user of the grid). */
  static key(cx, cz) {
    return cx * KEY + cz;
  }

  /**
   * Move the focus point. Calls onEnter(cx, cz) for newly active cells and
   * onLeave(cx, cz, data) for cells that fell out of range. Returns true
   * when the focus crossed a cell boundary (i.e. any work happened).
   */
  update(x, z, onEnter, onLeave) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    if (cx === this._fx && cz === this._fz) return false;
    this._fx = cx;
    this._fz = cz;

    for (const [k, data] of this.cells) {
      const az = ((k % KEY) + KEY + HALF) % KEY - HALF;
      const ax = Math.round((k - az) / KEY);
      if (Math.max(Math.abs(ax - cx), Math.abs(az - cz)) > this.radius) {
        this.cells.delete(k);
        if (onLeave) onLeave(ax, az, data);
      }
    }
    for (let dx = -this.radius; dx <= this.radius; dx++) {
      for (let dz = -this.radius; dz <= this.radius; dz++) {
        const k = (cx + dx) * KEY + (cz + dz);
        if (!this.cells.has(k)) {
          const data = onEnter ? onEnter(cx + dx, cz + dz) : true;
          this.cells.set(k, data === undefined ? true : data);
        }
      }
    }
    return true;
  }

  clear(onLeave) {
    if (onLeave) {
      for (const [k, data] of this.cells) {
        const az = ((k % KEY) + KEY + HALF) % KEY - HALF;
        onLeave(Math.round((k - az) / KEY), az, data);
      }
    }
    this.cells.clear();
    this._fx = this._fz = null;
  }
}
