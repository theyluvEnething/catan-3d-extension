/**
 * src/state/watchdog.js — desync watchdog.
 *
 * Our GameState is built by applying incremental diffs (type-91) on top of the initial
 * snapshot (type-4). If our diff-application ever drifts from Colonist's authoritative state,
 * the board silently goes wrong. Colonist periodically re-sends a FULL snapshot; the watchdog
 * compares the board WE had reconstructed (from diffs) against that fresh authoritative
 * snapshot and reports any mismatch — so drift is caught, not hidden.
 *
 * It hooks GameState by wrapping _applySnapshot: on every snapshot after the first, it diffs
 * the pre-snapshot reconstructed board vs the incoming one over the fields that matter
 * (tileCornerStates owners/buildingType, tileEdgeStates owners, robber, current turn).
 *
 * No DOM, no external imports. Clock is injectable (opts.now); console is guarded.
 */

const OWNER = (o) => (o == null ? -1 : o);

// Compare the piece/robber/turn state of two gameState trees. Returns an array of diffs.
function compareBoards(mine, theirs) {
  const out = [];
  const mc = mine?.mapState?.tileCornerStates || {};
  const tc = theirs?.mapState?.tileCornerStates || {};
  const me = mine?.mapState?.tileEdgeStates || {};
  const te = theirs?.mapState?.tileEdgeStates || {};

  const cornerKeys = new Set([...Object.keys(mc), ...Object.keys(tc)]);
  for (const k of cornerKeys) {
    const a = mc[k] || {}, b = tc[k] || {};
    if (OWNER(a.owner) !== OWNER(b.owner)) out.push({ kind: "corner-owner", index: k, mine: OWNER(a.owner), theirs: OWNER(b.owner) });
    else if (OWNER(a.owner) !== -1 && (a.buildingType || 1) !== (b.buildingType || 1)) out.push({ kind: "corner-building", index: k, mine: a.buildingType, theirs: b.buildingType });
  }
  const edgeKeys = new Set([...Object.keys(me), ...Object.keys(te)]);
  for (const k of edgeKeys) {
    const a = me[k] || {}, b = te[k] || {};
    if (OWNER(a.owner) !== OWNER(b.owner)) out.push({ kind: "edge-owner", index: k, mine: OWNER(a.owner), theirs: OWNER(b.owner) });
  }
  const mr = mine?.mechanicRobberState?.locationTileIndex, tr = theirs?.mechanicRobberState?.locationTileIndex;
  if (mr != null && tr != null && mr !== tr) out.push({ kind: "robber", mine: mr, theirs: tr });
  const mtn = mine?.currentState?.currentTurnPlayerColor, ttn = theirs?.currentState?.currentTurnPlayerColor;
  if (mtn != null && ttn != null && mtn !== ttn) out.push({ kind: "turn", mine: mtn, theirs: ttn });
  return out;
}

/**
 * Attach the watchdog to a GameState instance. Returns { report(), onDesync(cb), detach() }.
 * On each snapshot (except the first), it compares our just-built board to the authoritative
 * one and records the result.
 *
 * @param state       a GameState instance
 * @param opts.onDesync  optional callback(drifts, record)
 * @param opts.now       optional clock () => ms (defaults to Date.now)
 */
export function attachWatchdog(state, { onDesync, now } = {}) {
  const clock = typeof now === "function" ? now : () => { try { return Date.now(); } catch { return 0; } };
  const history = []; // { t, drifts: [...] }
  let checks = 0, desyncs = 0;
  const cbs = onDesync ? [onDesync] : [];

  const origApply = state._applySnapshot.bind(state);
  state._applySnapshot = function (payload) {
    // our reconstructed board just before the authoritative snapshot replaces it
    const priorBoard = state.gameState;
    const incoming = payload && payload.gameState;
    if (state.ready && priorBoard && incoming) {
      checks++;
      const drifts = compareBoards(priorBoard, incoming);
      if (drifts.length) {
        desyncs++;
        const rec = { t: clock(), drifts };
        history.push(rec);
        if (history.length > 50) history.shift();
        for (const cb of cbs) { try { cb(drifts, rec); } catch {} }
        safeWarn("[catan-interface/watchdog] DESYNC detected —", drifts.length, "field(s):", JSON.stringify(drifts.slice(0, 6)));
      }
    }
    return origApply(payload);
  };

  return {
    report: () => ({ checks, desyncs, clean: desyncs === 0, lastDrift: history[history.length - 1] || null, history: history.slice() }),
    onDesync: (cb) => cbs.push(cb),
    detach: () => { state._applySnapshot = origApply; },
  };
}

function safeWarn(...a) { try { if (typeof console !== "undefined" && console.warn) console.warn(...a); } catch {} }
