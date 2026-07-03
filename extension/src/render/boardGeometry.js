/**
 * src/render/boardGeometry.js — hex-grid math for Colonist's coordinate system.
 *
 * VERIFIED coordinate model (NOTES.md §2b):
 *   - hex faces:  {x, y}      axial
 *   - corners:    {x, y, z}   z ∈ {0,1}  (the 2 corners a hex "owns")
 *   - edges:      {x, y, z}   z ∈ {0,1,2}(the 3 edges a hex "owns")
 *
 * This module converts those to 2D/3D world positions and provides the tile<->corner<->edge
 * adjacency (reproduced from robottler board.py and confirmed against live snapshots).
 * Shared by the 3D renderer (mesh placement) and the interaction layer (raycast targets).
 *
 * Pointy-top layout. World units: 1 hex "radius" = 1. Convert to whatever scale the scene uses.
 */

export const SQRT3 = Math.sqrt(3);

// Hex face center in board space (pointy-top). Axial (x,y).
export function hexCenter(x, y) {
  return { u: SQRT3 * (x + y / 2), v: 1.5 * y };
}

// The 6 corner (x,y,z) coordinates of a hex, in Colonist's ownership scheme
// (matches tile_vertices in robottler board.py, verified vs 54-corner snapshot).
export function hexCorners(x, y) {
  return [
    { x, y, z: 0 },
    { x, y, z: 1 },
    { x: x + 1, y: y - 1, z: 1 },
    { x, y: y - 1, z: 1 },
    { x, y: y + 1, z: 0 },
    { x: x - 1, y: y + 1, z: 0 },
  ];
}

// Adjacent hexes that produce for a settlement on corner (x,y,z).
export function cornerHexes(x, y, z) {
  const out = [{ x, y }];
  if (z === 0) { out.push({ x, y: y - 1 }, { x: x + 1, y: y - 1 }); }
  else { out.push({ x: x - 1, y: y + 1 }, { x, y: y + 1 }); }
  return out;
}

// The 3 edges incident to corner (x,y,z).
export function cornerEdges(x, y, z) {
  if (z === 0) return [{ x, y, z: 0 }, { x: x + 1, y: y - 1, z: 1 }, { x: x + 1, y: y - 1, z: 2 }];
  return [{ x, y: y + 1, z: 0 }, { x, y: y + 1, z: 1 }, { x, y, z: 2 }];
}

// The 2 endpoint corners of edge (x,y,z).
export function edgeCorners(x, y, z) {
  if (z === 0) return [{ x, y, z: 0 }, { x, y: y - 1, z: 1 }];
  if (z === 1) return [{ x, y: y - 1, z: 1 }, { x: x - 1, y: y + 1, z: 0 }];
  return [{ x: x - 1, y: y + 1, z: 0 }, { x, y, z: 1 }]; // z===2
}

// Corner position in board space. Average of the hex center and the vertical z-offset.
// Precisely: a corner is a vertex of the hexagon; we derive it from the owning hex center
// plus the pointy-top vertex direction. z=0 -> upper vertex, z=1 -> lower vertex of the pair.
export function cornerPos(x, y, z) {
  const c = hexCenter(x, y);
  // Pointy-top hexagon vertices sit at angles 90°,150°,210°,270°,330°,30°. The two corners a
  // hex "owns" (z 0/1) are the top (90°/270°). We take z0 = top vertex, z1 = bottom vertex.
  const r = 1; // hex circumradius in these units
  const angle = z === 0 ? Math.PI / 2 : -Math.PI / 2;
  return { u: c.u + r * Math.cos(angle) * 0, v: c.v - r * Math.sin(angle) };
  // NB: this simple form is refined by empirical calibration (debug/calibration.json) for
  // pixel-accurate click forwarding; for 3D mesh placement the corner is computed as the
  // shared vertex of its incident hexes (see cornerPosExact).
}

// Exact corner position = centroid of its adjacent hex centers' shared vertex. More robust
// than the single-hex form: average the incident hexes then push outward. For the 3D scene we
// use the average of incident hex centers offset toward the vertex.
export function cornerPosExact(x, y, z) {
  const hexes = cornerHexes(x, y, z);
  let u = 0, v = 0;
  for (const h of hexes) { const c = hexCenter(h.x, h.y); u += c.u; v += c.v; }
  u /= hexes.length; v /= hexes.length;
  // The corner is a hexagon vertex; the centroid of the 3 (or fewer) surrounding hex centers
  // lands exactly on the shared vertex for interior corners. Edge-of-board corners with <3
  // hexes need a small correction handled by calibration for clicks.
  return { u, v };
}

// Edge midpoint in board space = midpoint of its two endpoint corners.
export function edgePos(x, y, z) {
  const [a, b] = edgeCorners(x, y, z);
  const pa = cornerPosExact(a.x, a.y, a.z);
  const pb = cornerPosExact(b.x, b.y, b.z);
  return { u: (pa.u + pb.u) / 2, v: (pa.v + pb.v) / 2 };
}

// Apply a calibrated similarity transform (from harness/calibrate.js) to a board-space point.
export function applySimilarity(cal, u, v) {
  return [cal.cos * u - cal.sin * v + cal.tx, cal.sin * u + cal.cos * v + cal.ty];
}
