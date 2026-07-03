/**
 * src/state/gameState.js — reconstructs the full Catan game state from intercepted frames.
 *
 * Colonist delivers state as:
 *   - a FULL snapshot   (id "130", data.type 4)  -> replace gameState wholesale
 *   - INCREMENTAL diffs (id "130", data.type 91) -> deep-merge `payload.diff` into gameState
 *
 * The diff format (type 91) is a partial object mirroring the gameState tree; applying it is
 * a recursive merge where `null` means delete. This applier is validated against full-game
 * captures (harness/replay.js) — see NOTES.md §3.
 *
 * Everything here is protocol-shaped but not protocol-DECODING (that's src/protocol/decode.js).
 */

export class GameState {
  constructor() {
    this.reset();
  }
  reset() {
    this.ready = false;         // true once we've seen a snapshot
    this.us = null;             // our player color
    this.playOrder = [];        // array of colors in turn order
    this.gameState = null;      // the live gameState tree
    this.gameDetails = null;
    this.gameSettings = null;
    this.playerUserStates = null;
    this.log = [];              // human-readable event log for the HUD
    this.rev = 0;               // bumps on every applied change
    this._subs = new Set();
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit(evt) { this.rev++; for (const fn of this._subs) { try { fn(this, evt); } catch (e) { console.warn(e); } } }

  /**
   * Apply a decoded incoming frame. `decoded` is the output of decodeFrame() for dir:"in":
   *   { id, type, payload, sequence, msg }
   */
  applyIncoming(decoded) {
    if (!decoded || decoded.id !== "130") return; // game stream only
    const { type, payload } = decoded;
    switch (type) {
      case 4: return this._applySnapshot(payload);
      case 91: return this._applyDiff(payload);
      case 1: this.gameSettingsMeta = payload; return;
      default:
        // Record unknown game types so we can discover them from live play.
        this._note(`type${type}`, payload);
        return;
    }
  }

  _applySnapshot(payload) {
    this.us = payload.playerColor;
    this.playOrder = payload.playOrder || [];
    this.gameState = payload.gameState || {};
    this.gameDetails = payload.gameDetails || null;
    this.gameSettings = payload.gameSettings || null;
    this.playerUserStates = payload.playerUserStates || null;
    this.ready = true;
    this._logEvent("snapshot", { us: this.us, order: this.playOrder });
    this._emit({ kind: "snapshot" });
  }

  _applyDiff(payload) {
    if (!this.gameState) return; // diff before snapshot — shouldn't happen
    const diff = payload && payload.diff;
    if (diff && typeof diff === "object") {
      deepMerge(this.gameState, diff);
      this._summarizeDiff(diff);
    }
    if (payload && payload.timeLeftInState != null) this.timeLeftInState = payload.timeLeftInState;
    this._emit({ kind: "diff", diff });
  }

  // ---- convenience accessors (used by HUD + renderer) ----
  get hexes() { return objVals(this.gameState?.mapState?.tileHexStates); }
  get corners() { return objVals(this.gameState?.mapState?.tileCornerStates); }
  get edges() { return objVals(this.gameState?.mapState?.tileEdgeStates); }
  get ports() { return objVals(this.gameState?.mapState?.portEdgeStates); }
  get robberTileIndex() { return this.gameState?.mechanicRobberState?.locationTileIndex; }
  get dice() {
    const d = this.gameState?.diceState;
    return d ? { thrown: d.diceThrown, d1: d.dice1, d2: d.dice2, sum: d.dice1 + d.dice2 } : null;
  }
  get currentTurnColor() { return this.gameState?.currentState?.currentTurnPlayerColor; }
  get turnState() { return this.gameState?.currentState?.turnState; }
  get actionState() { return this.gameState?.currentState?.actionState; }
  get completedTurns() { return this.gameState?.currentState?.completedTurns; }
  get bank() { return this.gameState?.bankState?.resourceCards; }
  get playerColors() {
    const ps = this.gameState?.playerStates;
    return ps ? Object.keys(ps).map(Number) : [];
  }
  playerState(color) { return this.gameState?.playerStates?.[color]; }

  // Settlements/cities/roads placed, as {color, cornerIndex|edgeIndex}.
  buildings() {
    const out = { settlements: [], cities: [], roads: [] };
    const corners = this.gameState?.mapState?.tileCornerStates || {};
    for (const [idx, c] of Object.entries(corners)) {
      if (c && c.owner != null && c.owner !== -1) {
        // buildingType enum (verified from live diffs): 1 = settlement, 2 = city.
        const kind = c.buildingType === 2 ? "cities" : "settlements";
        out[kind].push({ color: c.owner, cornerIndex: Number(idx), raw: c });
      }
    }
    const edges = this.gameState?.mapState?.tileEdgeStates || {};
    for (const [idx, e] of Object.entries(edges)) {
      if (e && e.owner != null && e.owner !== -1) {
        out.roads.push({ color: e.owner, edgeIndex: Number(idx), raw: e });
      }
    }
    return out;
  }

  // ---- logging ----
  _logEvent(kind, data) {
    this.log.push({ rev: this.rev, kind, data, t: Date.now() });
    if (this.log.length > 500) this.log.shift();
  }
  _note(kind, payload) { this._logEvent(kind, summarize(payload)); }
  _summarizeDiff(diff) {
    // Try to describe the diff in gameplay terms for the HUD log.
    const parts = [];
    if (diff.diceState) parts.push(`dice=${diff.diceState.dice1}+${diff.diceState.dice2}`);
    if (diff.mechanicRobberState?.locationTileIndex != null)
      parts.push(`robber→tile${diff.mechanicRobberState.locationTileIndex}`);
    if (diff.currentState?.currentTurnPlayerColor != null)
      parts.push(`turn→${diff.currentState.currentTurnPlayerColor}`);
    if (diff.currentState?.turnState != null) parts.push(`turnState=${diff.currentState.turnState}`);
    if (diff.mapState?.tileCornerStates) parts.push(`corners±`);
    if (diff.mapState?.tileEdgeStates) parts.push(`edges±`);
    this._logEvent("diff", parts.length ? parts.join(" ") : Object.keys(diff));
  }
}

// --- deep merge: applies a Colonist diff into a target. null = delete key. ---
export function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) { delete target[k]; continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array)) {
      if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v; // primitives, arrays, Date, bytes -> replace
    }
  }
  return target;
}

function objVals(o) {
  if (!o) return [];
  return Object.entries(o).map(([idx, v]) => ({ index: Number(idx), ...v }));
}
function summarize(p) {
  if (p == null) return p;
  if (Array.isArray(p)) return `[array ${p.length}]`;
  if (typeof p === "object") return Object.keys(p);
  return p;
}
