/**
 * src/state/eventBus.js — a tiny, dependency-free event emitter.
 *
 * Used by the engine to fan out "change" / "event" / "desync" notifications to consumers.
 * No DOM, no Node EventEmitter — just a Map of name -> Set of listeners.
 */
export class EventBus {
  constructor() { this._listeners = new Map(); }

  /** Subscribe to `name`. Returns an unsubscribe function. */
  on(name, fn) {
    let set = this._listeners.get(name);
    if (!set) { set = new Set(); this._listeners.set(name, set); }
    set.add(fn);
    return () => { const s = this._listeners.get(name); if (s) s.delete(fn); };
  }

  /** Subscribe once. */
  once(name, fn) {
    const off = this.on(name, (...args) => { off(); fn(...args); });
    return off;
  }

  off(name, fn) { const s = this._listeners.get(name); if (s) s.delete(fn); }

  /** Emit `name` with args. Listener errors are isolated (never break the emitter). */
  emit(name, ...args) {
    const s = this._listeners.get(name);
    if (!s) return;
    for (const fn of [...s]) { try { fn(...args); } catch (e) { safeWarn("[catan-interface] listener error for '" + name + "':", e); } }
  }

  removeAll(name) { if (name) this._listeners.delete(name); else this._listeners.clear(); }
}

function safeWarn(...a) { try { if (typeof console !== "undefined" && console.warn) console.warn(...a); } catch {} }
