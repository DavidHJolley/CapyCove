// Minimal event emitter used across the game.
export class Emitter {
  #map = new Map();
  on(evt, fn) {
    if (!this.#map.has(evt)) this.#map.set(evt, new Set());
    this.#map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    this.#map.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    this.#map.get(evt)?.forEach((fn) => {
      try { fn(...args); } catch (e) { console.error(`[events] ${evt} handler:`, e); }
    });
  }
}
