// Tests coordinate-forwarding: calibrate, then place a settlement by computing a legal
// corner's pixel via the affine and dispatching a SYNTHETIC click to Colonist's canvas
// (no real mouse). Confirms the settlement lands on the intended corner.
//
// Reuses the RANSAC token calibration inline, then drives the forward.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { hexCenter, cornerPosExact } from "../extension/src/render/boardGeometry.js";
import { legalSettlementCorners } from "./legal.js";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- inline calibration (RANSAC similarity -> full affine on token discs) ---
function fitAffine(pairs) { const n = pairs.length; let SXX = 0, SYY = 0, SXY = 0, SX = 0, SY = 0, SxpX = 0, SxpY = 0, Sxp = 0, SypX = 0, SypY = 0, Syp = 0; for (const { X, Y, px, py } of pairs) { SXX += X * X; SYY += Y * Y; SXY += X * Y; SX += X; SY += Y; SxpX += px * X; SxpY += px * Y; Sxp += px; SypX += py * X; SypY += py * Y; Syp += py; } const M = [[SXX, SXY, SX], [SXY, SYY, SY], [SX, SY, n]]; const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]); const solve = (rhs) => { const D = det3(M); const col = (i) => M.map((r, ri) => r.map((v, ci) => ci === i ? rhs[ri] : v)); return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D]; }; const [a, b, tx] = solve([SxpX, SxpY, Sxp]); const [c, d, ty] = solve([SypX, SypY, Syp]); return { a, b, tx, c, d, ty }; }
function fitSim(prs) { const n = prs.length; let mbx = 0, mby = 0, mpx = 0, mpy = 0; for (const p of prs) { mbx += p.X; mby += p.Y; mpx += p.px; mpy += p.py; } mbx /= n; mby /= n; mpx /= n; mpy /= n; let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, varB = 0; for (const p of prs) { const bx = p.X - mbx, by = p.Y - mby, px = p.px - mpx, py = p.py - mpy; Sxx += px * bx; Sxy += px * by; Syx += py * bx; Syy += py * by; varB += bx * bx + by * by; } const th = Math.atan2(Syx - Sxy, Sxx + Syy); const s = (Math.cos(th) * (Sxx + Syy) + Math.sin(th) * (Syx - Sxy)) / varB; const a = Math.cos(th) * s, b = -Math.sin(th) * s, c = Math.sin(th) * s, d = Math.cos(th) * s; return { a, b, tx: mpx - (a * mbx + b * mby), c, d, ty: mpy - (c * mbx + d * mby) }; }
const project = (aff, X, Y) => [aff.a * X + aff.b * Y + aff.tx, aff.c * X + aff.d * Y + aff.ty];

async function calibrate(page, box) {
  const hexes = await page.evaluate(() => Object.values(window.__catan3d.state.gameState.mapState.tileHexStates).map((h) => ({ x: h.x, y: h.y, type: h.type, dice: h.diceNumber })));
  const tokenHexes = hexes.filter((h) => h.type !== 0 && h.dice);
  const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  const png = PNG.sync.read(buf); const W = png.width, H = png.height;
  // token disc blobs (see calibrate3)
  const xMax = W * 0.66, hudX = W * 0.22, hudY = H * 0.5; const pts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < xMax; x++) { if (x < hudX && y < hudY) continue; const i = (y * W + x) * 4; const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]; if (r > 225 && g > 220 && b > 195 && Math.abs(r - g) < 16 && (r - b) < 40 && (g - b) < 40) pts.push([x, y]); }
  const cell = 40, grid = new Map(); for (const [x, y] of pts) { const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`; let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push([x, y]); }
  const seeds = []; for (const arr of grid.values()) { if (arr.length < 40) continue; let ax = 0, ay = 0; for (const [x, y] of arr) { ax += x; ay += y; } seeds.push([ax / arr.length, ay / arr.length]); }
  const blobs = []; for (const [sx, sy] of seeds) { let ax = 0, ay = 0, n = 0, r2 = 0; for (const [x, y] of pts) { const dd = Math.hypot(x - sx, y - sy); if (dd < 24) { ax += x; ay += y; n++; r2 += dd; } } if (n < 120) continue; const meanR = r2 / n; if (meanR < 6 || meanR > 20) continue; blobs.push([ax / n, ay / n, n]); }
  const uniq = []; for (const b of blobs.sort((a, z) => z[2] - a[2])) if (!uniq.some((u) => Math.hypot(u[0] - b[0], u[1] - b[1]) < 28)) uniq.push(b);
  const targets = tokenHexes.map((h) => { const { u, v } = hexCenter(h.x, h.y); return { X: u, Y: v }; });
  // RANSAC similarity
  let bestAff = null, bestInl = -1;
  for (let t = 0; t < 4000; t++) { const i1 = (t * 7) % targets.length, i2 = (t * 13 + 3) % targets.length; if (i1 === i2) continue; const j1 = (t * 5) % uniq.length, j2 = (t * 11 + 1) % uniq.length; if (j1 === j2) continue; const aff = fitSim([{ X: targets[i1].X, Y: targets[i1].Y, px: uniq[j1][0], py: uniq[j1][1] }, { X: targets[i2].X, Y: targets[i2].Y, px: uniq[j2][0], py: uniq[j2][1] }]); const sc = Math.hypot(aff.a, aff.c); if (sc < box.width * 0.03 || sc > box.width * 0.2) continue; let inl = 0; for (const tt of targets) { const [px, py] = project(aff, tt.X, tt.Y); let bd = Infinity; for (const bl of uniq) bd = Math.min(bd, Math.hypot(bl[0] - px, bl[1] - py)); if (bd < 18) inl++; } if (inl > bestInl) { bestInl = inl; bestAff = aff; } }
  // refine full affine on inliers
  const match = (aff) => { const used = new Set(); const prs = []; for (const t of targets) { const [rx, ry] = project(aff, t.X, t.Y); let bi = -1, bd = Infinity; for (let i = 0; i < uniq.length; i++) { if (used.has(i)) continue; const dd = Math.hypot(uniq[i][0] - rx, uniq[i][1] - ry); if (dd < bd) { bd = dd; bi = i; } } if (bi >= 0) { used.add(bi); prs.push({ X: t.X, Y: t.Y, px: uniq[bi][0], py: uniq[bi][1], d: bd }); } } return prs; };
  let aff = bestAff; let prs = match(aff).filter((p) => p.d < 22); if (prs.length >= 4) { aff = fitAffine(prs); prs = match(aff).filter((p) => p.d < 18); if (prs.length >= 4) aff = fitAffine(prs); }
  const affPage = { a: aff.a, b: aff.b, tx: aff.tx + box.x, c: aff.c, d: aff.d, ty: aff.ty + box.y };
  return { affine: affPage, inliers: bestInl, nBlobs: uniq.length };
}

// --- main ---
const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);

const box = await (await page.$("#game-canvas")).boundingBox();
// Wait until it's our first settlement placement.
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
for (let w = 0; w < 60; w++) { if (/place settlement/.test(await prompt())) break; await sleep(1000); }

const { affine, inliers, nBlobs } = await calibrate(page, box);
console.log("calibrated: inliers", inliers, "blobs", nBlobs, "affine", JSON.stringify(affine));

// Pick a legal settlement corner from state.
const st = await page.evaluate(() => ({ corners: window.__catan3d.state.gameState.mapState.tileCornerStates, edges: window.__catan3d.state.gameState.mapState.tileEdgeStates, us: window.__catan3d.state.us }));
const legal = legalSettlementCorners({ gameState: { mapState: { tileCornerStates: st.corners, tileEdgeStates: st.edges } } });
// choose a fairly central corner for a reliable test
const target = legal[Math.floor(legal.length / 2)];
const { u, v } = cornerPosExact(target.x, target.y, target.z);
const [px, py] = project(affine, u, v);
console.log(`target corner (${target.x},${target.y},${target.z}) -> pixel (${px.toFixed(0)},${py.toFixed(0)})`);

const beforeOwned = await page.evaluate((us) => Object.entries(window.__catan3d.state.gameState.mapState.tileCornerStates).filter(([, c]) => c.owner === us).map(([i]) => Number(i)), st.us);

// Forward a synthetic click to Colonist's canvas at that pixel.
const forwarded = await page.evaluate(({ px, py }) => {
  const canvas = document.getElementById("game-canvas");
  const common = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  canvas.dispatchEvent(new PointerEvent("pointerdown", common));
  canvas.dispatchEvent(new MouseEvent("mousedown", common));
  canvas.dispatchEvent(new PointerEvent("pointerup", { ...common, buttons: 0 }));
  canvas.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
  canvas.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
  return true;
}, { px, py });
await sleep(1200);

const afterOwned = await page.evaluate((us) => Object.entries(window.__catan3d.state.gameState.mapState.tileCornerStates).filter(([, c]) => c.owner === us).map(([i, c]) => ({ i: Number(i), x: c.x, y: c.y, z: c.z })), st.us);
const landed = afterOwned.find((c) => !beforeOwned.includes(c.i));
if (landed) {
  const match = landed.x === target.x && landed.y === target.y && landed.z === target.z;
  console.log(`RESULT: settlement landed at corner${landed.i} (${landed.x},${landed.y},${landed.z}) — ${match ? "EXACT MATCH ✓" : "landed but not exact (snap to neighbor)"}`);
} else {
  console.log("RESULT: no settlement placed by the synthetic click ✗");
}
await page.screenshot({ path: path.join(SHOTS_DIR, "test-forward.png") });
await context.close();
