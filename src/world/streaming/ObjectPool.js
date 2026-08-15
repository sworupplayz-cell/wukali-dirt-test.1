/**
 * ObjectPool — neutral, engine-agnostic fixed-capacity object pool.
 *
 * Retained from the endless-world streaming architecture (Phase 1A reset):
 * the gameplay world generation was removed, but this pooling pattern is
 * the foundation for any future streamed content — acquire/release instead
 * of allocate/GC while riding.
 *
 * Not wired into any update loop; it costs nothing until used.
 */
export class ObjectPool {
  /**
   * @param {() => T} create   factory for one pooled object
   * @param {number} capacity  fixed pool size (pre-allocated)
   * @param {(obj: T) => void} [onRelease] optional cleanup on release
   */
  constructor(create, capacity, onRelease = null) {
    this._free = [];
    this._onRelease = onRelease;
    for (let i = 0; i < capacity; i++) this._free.push(create());
  }

  /** Take an object, or null when the pool is exhausted (never allocates). */
  acquire() {
    return this._free.pop() || null;
  }

  /** Return an object to the pool. */
  release(obj) {
    if (this._onRelease) this._onRelease(obj);
    this._free.push(obj);
  }

  get available() {
    return this._free.length;
  }
}
