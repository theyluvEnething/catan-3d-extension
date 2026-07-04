// Play a quick EXAMPLE ROUND for the showcase: start a bot game, complete initial placement +
// a few main-phase turns entirely through OUR direct-send layer (settlement 15 / road 11 /
// city 19 / robber 3 / end-turn 6), then mount the 3D board over Colonist's canvas and capture
// showcase screenshots: the real 2D board, our 3D mirror, and a top-down 3D view.
//
//   node harness/example-round.js [cloneIndex]
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TO " + (l || ""))), ms))]);

// Serve extension/ so we can dynamically import the ES-module 3D scene into the page.
const MIME = { ".js": "text/javascript", ".json": "application/json", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, "extension", decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(fp, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "access-control-allow-origin": "*" }); res.end(d); });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const SHOW = path.join(SHOTS_DIR, "showcase");
fs.mkdirSync(SHOW, { recursive: true });

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("not logged in — run node harness/login-once.js"); await context.close(); server.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
if (!(await page.$("#game-canvas"))) { console.log("no game canvas"); await context.close(); server.close(); process.exit(1); }
log("in game");

const ev = (fn, arg, l) => to(page.evaluate(fn, arg), 8000, l || "ev");
const core = () => ev(() => { const s = window.__catan3d.state; const ps = s.playerState(s.us) || {}; const raw = (ps.resourceCards && ps.resourceCards.cards) || []; const h = {}; for (const r of raw) h[r] = (h[r] || 0) + 1; const vp = ps.victoryPointsState ? Object.values(ps.victoryPointsState).reduce((a, x) => a + (typeof x === "number" ? x : 0), 0) : 0; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, hand: h, vp, robber: s.robberTileIndex }; }, null, "core");
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; }, null, "prompt");
const pieces = () => ev(() => { const s = window.__catan3d.state, ms = s.gameState.mapState, us = s.us; return { s: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType !== 2).length, c: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType === 2).length, r: Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length }; }, null, "pieces");
const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.42;

const report = { setupSettlements: 0, setupRoads: 0, cities: 0, rolls: 0, robbers: 0, desyncs: 0, turns: 0 };
let lastCorner = null;

// ---- Phase 1: play setup + a handful of main turns via our layer ----
const t0 = Date.now(); const MAX = 8 * 60 * 1000;
while (Date.now() - t0 < MAX) {
  let c, p; try { c = await core(); p = await prompt(); } catch { continue; }
  const mine = c.turn === c.us;
  if (c.completed >= 8 && report.turns >= 4) break; // enough main-phase turns for the showcase

  if (c.completed < 8) {
    if (mine && /place settlement/.test(p)) {
      const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; const res = window.__catan3d.buildSettlement(i); return res && res.ok ? window.__catan3d.state.gameState.mapState.tileCornerStates[i] : null; });
      if (r) { lastCorner = r; report.setupSettlements++; log("setup settlement via 3D layer"); } else report.desyncs++;
      await sleep(1200);
    } else if (mine && /place road/.test(p)) {
      const ok = await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (!L.length) return false; const res = window.__catan3d.buildRoad(L[0].i); return !!(res && res.ok); }, lastCorner);
      ok ? report.setupRoads++ : report.desyncs++; await sleep(1200);
    } else await sleep(700);
    continue;
  }

  if (!mine) { if (/discard/.test(p)) { for (let k = 0; k < 4; k++) { await ev(() => window.__catan3d.sendGameAction(2, true)); await sleep(200); } } else await sleep(800); continue; }
  if (/move.*robber|place.*robber/.test(p)) { await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }); if ((await core()).robber !== c.robber) { report.robbers++; log("moved robber via 3D layer"); } await sleep(900); continue; }
  if (c.turnState === 1) { await to(page.keyboard.press("Space"), 6000, "roll").catch(() => {}); report.rolls++; await sleep(1300); continue; }
  if (c.turnState === 2) {
    // build a city if we can (19), else just end the turn
    if ((c.hand[4] || 0) >= 2 && (c.hand[5] || 0) >= 3) { const corner = await ev(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; }); if (corner != null) { const before = await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner); await ev(({ i }) => window.__catan3d.sendGameAction(19, i), { i: corner }); await sleep(900); if ((await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner)) === 2 && before !== 2) { report.cities++; log("built CITY via 3D layer"); } } }
    report.turns++;
    await ev(() => window.__catan3d.sendGameAction(6, true)); await sleep(1000);
    log("main turn", report.turns, "done — VP", (await core()).vp);
    continue;
  }
  await sleep(700);
}

const finalPieces = await pieces();
report.finalPieces = finalPieces;
report.finalVP = (await core()).vp;
log("play done:", JSON.stringify(report));

// ---- Phase 2: screenshot the REAL 2D board ----
await page.screenshot({ path: path.join(SHOW, "01-real-2d-board.png") });
log("captured real 2D board");

// ---- Phase 3: mount the 3D board and screenshot the mirror ----
const mounted = await page.evaluate(async (base) => {
  try { const { mountBoard } = await import(base + "/src/render/mount.js"); const b = mountBoard(window.__catan3d.state); window.__catan3d.board = b; return b ? "ok" : "no-canvas"; } catch (e) { return "ERR:" + e.message; }
}, base);
log("mount:", mounted);
await sleep(2500);
await page.screenshot({ path: path.join(SHOW, "02-3d-mirror.png") });
log("captured 3D mirror");

// top-down 3D view for a clean board shot
await page.evaluate(() => { const s = window.__catan3d.board && window.__catan3d.board.scene; if (s) { s.camera.position.set(0, 20, 0.01); s.camera.lookAt(0, 0, 0); s.controls.target.set(0, 0, 0); s.controls.update(); } }).catch(() => {});
await sleep(800);
await page.screenshot({ path: path.join(SHOW, "03-3d-topdown.png") });
log("captured 3D top-down");

fs.writeFileSync(path.join(SHOW, "report.json"), JSON.stringify(report, null, 2));
console.log("EXAMPLE_ROUND_DONE " + JSON.stringify(report));
await context.close();
server.close();
process.exit(0);
