// Legal-move helpers: given the reconstructed game state, enumerate legal corners/edges/hexes
// for the current placement context. Used by the auto-player to pick a target to click.
// Rules are the standard Catan constraints, applied to Colonist's coordinate model.
import {
  hexCorners, cornerEdges, edgeCorners, cornerHexes,
} from "../extension/src/render/boardGeometry.js";

// Build a set key for a corner/edge coordinate.
const ck = (c) => `${c.x},${c.y},${c.z}`;

// All corner coords present on the board (from state), as a Map key->index.
export function cornerIndex(state) {
  const cs = state.gameState.mapState.tileCornerStates;
  const map = new Map();
  for (const [i, c] of Object.entries(cs)) map.set(ck(c), { index: Number(i), ...c });
  return map;
}
export function edgeIndex(state) {
  const es = state.gameState.mapState.tileEdgeStates;
  const map = new Map();
  for (const [i, e] of Object.entries(es)) map.set(ck(e), { index: Number(i), ...e });
  return map;
}

// Legal settlement corners: empty corner, no adjacent (distance-1) settlement/city
// (distance rule). During SETUP any such corner is legal; in main play must also touch a
// road you own — the auto-player only needs setup + relaxed rules, so we apply the
// distance rule (always required) and leave road-adjacency to Colonist's own validation
// (it rejects illegal clicks; we try the next candidate).
export function legalSettlementCorners(state) {
  const corners = cornerIndex(state);
  const occupied = new Set();
  for (const [key, c] of corners) if (c.owner != null && c.owner !== -1) occupied.add(key);
  // neighbors of occupied corners (via shared edges) are blocked by distance rule
  const blocked = new Set(occupied);
  for (const key of occupied) {
    const c = corners.get(key);
    for (const e of cornerEdges(c.x, c.y, c.z)) {
      for (const nc of edgeCorners(e.x, e.y, e.z)) blocked.add(ck(nc));
    }
  }
  const out = [];
  for (const [key, c] of corners) if (!blocked.has(key)) out.push(c);
  return out;
}

// Legal road edges for a color: empty edge adjacent to one of your corners or your roads.
export function legalRoadEdges(state, color) {
  const edges = edgeIndex(state);
  const corners = cornerIndex(state);
  const yourCorners = [...corners.values()].filter((c) => c.owner === color);
  const yourEdges = [...edges.values()].filter((e) => e.owner === color);
  const touch = new Set();
  for (const c of yourCorners) for (const e of cornerEdges(c.x, c.y, c.z)) touch.add(ck(e));
  for (const e of yourEdges) {
    for (const c of edgeCorners(e.x, e.y, e.z)) for (const e2 of cornerEdges(c.x, c.y, c.z)) touch.add(ck(e2));
  }
  const out = [];
  for (const [key, e] of edges) if ((e.owner == null || e.owner === -1) && touch.has(key)) out.push(e);
  return out;
}

// Any hex the robber is NOT currently on (legal robber destinations).
export function legalRobberHexes(state) {
  const hs = state.gameState.mapState.tileHexStates;
  const cur = state.gameState.mechanicRobberState?.locationTileIndex;
  return Object.entries(hs).map(([i, h]) => ({ index: Number(i), ...h })).filter((h) => h.index !== cur);
}
