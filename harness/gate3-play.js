// GATE 3 — play a full bot game through OUR interaction layer (direct-send + legal engine),
// with correct turn handling, per-step logging, and desync detection. Placement via
// direct-send (settlement 15 / road 11 / robber 3); roll & pass via keyboard/Space (UI).
//
// The gate: both initial placements, main-phase builds, >=1 robber move, to game end (or a
// generous turn cap), with NO desync between our reconstructed state and what Colonist accepts.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const T0 = Date.now();

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("GATE3 not logged in"); await ctx.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);
const canvas = await page.$("#game-canvas");
if (!canvas) { console.log("GATE3 no canvas"); await ctx.close(); process.exit(1); }
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.42;

// state readers
const S = () => page.evaluate(() => { const s = window.__catan3d.state; return { us: s.us, turn: s.currentTurnColor, turnState: s.turnState, actionState: s.actionState, completed: s.completedTurns, robber: s.robberTileIndex, over: !!s.gameOver }; });
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const pieces = () => page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState, us = s.us; return { s: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType !== 2).length, c: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType === 2).length, r: Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length }; });
const vps = () => page.evaluate(() => { const s = window.__catan3d.snapshot(); return s.players.map((p) => `${p.color}:${p.vp}`).join(" "); });

const rep = { setupSettlements: 0, setupRoads: 0, mainBuilds: 0, rolls: 0, robberMoves: 0, desyncs: 0, turns: 0, over: false, reason: "" };
let lastCorner = null;

// place settlement/road via direct-send; VERIFY it actually landed (piece count grew).
async function directSettlement(setup) {
  const before = (await pieces()); const total0 = before.s + before.c;
  const r = await page.evaluate((setup) => { const L = window.__catan3d.legalSettlements({ setup }); if (!L.length) return { none: true }; const i = L[0].i; const res = window.__catan3d.buildSettlement(i); return { i, res, coord: window.__catan3d.state.gameState.mapState.tileCornerStates[i] }; }, setup);
  if (r.none) return false;
  await sleep(1300);
  const after = await pieces();
  if (after.s + after.c > total0) { lastCorner = r.coord; return true; }
  return false;
}
async function directRoad(setup) {
  const before = (await pieces()).r;
  const r = await page.evaluate(({ setup, fc }) => { const L = window.__catan3d.legalRoads({ setup, fromCorner: fc }); if (!L.length) return { none: true }; const i = L[0].i; const res = window.__catan3d.buildRoad(i); return { i, res }; }, { setup, fc: lastCorner });
  if (r.none) return false;
  await sleep(1300);
  return (await pieces()).r > before;
}

const MAX_MS = 14 * 60 * 1000;
let idleGuard = 0;
while (Date.now() - T0 < MAX_MS) {
  const s = await S(); const p = await prompt();
  if (s.over || /you (win|lose)|has won|game over|victory/i.test(p)) { rep.over = true; rep.reason = "game over"; break; }
  const mine = s.turn === s.us;

  // ---- SETUP ----
  if (s.completed < 8) {
    if (mine && /place settlement/.test(p)) { const ok = await directSettlement(true); if (ok) { rep.setupSettlements++; log("setup settlement", (await pieces())); } else { rep.desyncs++; log("DESYNC setup settlement"); } idleGuard = 0; }
    else if (mine && /place road/.test(p)) { const ok = await directRoad(true); if (ok) { rep.setupRoads++; log("setup road"); } else { rep.desyncs++; log("DESYNC setup road"); } idleGuard = 0; }
    else { await sleep(900); }
    continue;
  }

  // ---- MAIN PHASE ----
  if (!mine) { await sleep(900); idleGuard++; if (idleGuard > 120) { rep.reason = "stalled waiting for our turn"; break; } continue; }
  idleGuard = 0;
  rep.turns++;

  if (/roll/.test(p)) { await page.keyboard.press("Space"); rep.rolls++; log("rolled"); await sleep(1500); continue; }

  if (/move.*robber|place.*robber/.test(p)) {
    const rb = s.robber;
    // try direct-send robber (action 3) at a legal hex; fall back to trusted click
    const moved = await page.evaluate(() => { const L = window.__catan3d.legalRobberHexes(); if (!L.length) return false; const r = window.__catan3d.sendGameAction(3, L[0].i); return !!(r && r.ok); });
    await sleep(1200);
    if ((await S()).robber === rb) { // direct-send didn't move it -> trusted click scan
      outer: for (let ring = 0.12; ring <= 1; ring += 0.09) { for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(150); if ((await S()).robber !== rb) break outer; } }
    }
    if ((await S()).robber !== rb) { rep.robberMoves++; log("moved robber"); }
    // steal target (if a picker shows): click a nearby target
    await sleep(500); for (let i = 0; i < 8; i++) { await page.mouse.click(cx + Math.cos(i) * R * 0.14, cy + Math.sin(i) * R * 0.14); await sleep(150); if (!/steal|select a player/.test(await prompt())) break; }
    await sleep(700); continue;
  }

  if (/discard/.test(p)) { for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width * (0.28 + i * 0.09), box.y + box.height * 0.9); await sleep(180); } await page.keyboard.press("Enter"); log("discarded"); await sleep(800); continue; }

  // main build: settlement (needs road+resources), else road, else city, else pass.
  const built = await page.evaluate(() => { const S = window.__catan3d.legalSettlements(); if (S.length) { const r = window.__catan3d.buildSettlement(S[0].i); if (r && r.ok) return "settlement"; } const Rd = window.__catan3d.legalRoads(); if (Rd.length) { const r = window.__catan3d.buildRoad(Rd[0].i); if (r && r.ok) return "road"; } return null; });
  if (built) { await sleep(1100); rep.mainBuilds++; log("main build attempt:", built); }
  // end turn
  await page.keyboard.press("Space"); await sleep(1000);
  log("turn", rep.turns, "done; VPs", await vps());
}

rep.finalPieces = await pieces();
rep.finalVPs = await vps();
console.log("GATE3_RESULT " + JSON.stringify(rep));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "gate3-play-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
