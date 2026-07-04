// Clean showcase capture: start a game, play setup + a few turns via our layer, mount the 3D
// board, HIDE the debug HUD, enlarge the 3D canvas to fill the viewport, and capture a
// beautiful full-frame 3D shot + a top-down + the real 2D board for comparison.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const to = (pr, ms) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TO")), ms))]);
const MIME = { ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((req, res) => { const fp = path.join(ROOT, "extension", decodeURIComponent(req.url.split("?")[0])); fs.readFile(fp, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "access-control-allow-origin": "*" }); res.end(d); }); });
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const SHOW = path.join(SHOTS_DIR, "showcase"); fs.mkdirSync(SHOW, { recursive: true });

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("not logged in"); await context.close(); server.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
if (!(await page.$("#game-canvas"))) { console.log("no canvas"); await context.close(); server.close(); process.exit(1); }

const ev = (fn, a) => to(page.evaluate(fn, a), 8000);
const core = () => ev(() => { const s = window.__catan3d.state; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, robber: s.robberTileIndex }; });
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; });
let lastCorner = null; let turns = 0;
const t0 = Date.now();
while (Date.now() - t0 < 6 * 60 * 1000) {
  let c, p; try { c = await core(); p = await prompt(); } catch { continue; }
  if (c.completed >= 8 && turns >= 3) break;
  const mine = c.turn === c.us;
  if (c.completed < 8) {
    if (mine && /place settlement/.test(p)) { const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }); lastCorner = r; await sleep(1200); }
    else if (mine && /place road/.test(p)) { await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner); await sleep(1200); }
    else await sleep(700);
    continue;
  }
  if (!mine) { if (/discard/.test(p)) { for (let k = 0; k < 4; k++) { await ev(() => window.__catan3d.sendGameAction(2, true)); await sleep(200); } } else await sleep(800); continue; }
  if (/move.*robber|place.*robber/.test(p)) { await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }); await sleep(900); continue; }
  if (c.turnState === 1) { await to(page.keyboard.press("Space"), 6000).catch(() => {}); await sleep(1300); continue; }
  if (c.turnState === 2) { turns++; await ev(() => window.__catan3d.sendGameAction(6, true)); await sleep(1000); continue; }
  await sleep(700);
}

// real 2D board
await page.screenshot({ path: path.join(SHOW, "showcase-2d.png") });

// mount 3D, hide HUD, enlarge canvas to fill viewport
await page.evaluate(async (base) => { const { mountBoard } = await import(base + "/src/render/mount.js"); const b = mountBoard(window.__catan3d.state); window.__catan3d.board = b; }, base);
await sleep(2000);
await page.evaluate(() => {
  // hide the debug HUD + Colonist chrome so the 3D board is the hero
  const hud = document.querySelector("[id*=catan3d-hud], .catan3d-hud, #catan3d-hud"); if (hud) hud.style.display = "none";
  for (const el of document.querySelectorAll("*")) { const t = (el.className || "").toString(); if (/CATAN 3D|state HUD/i.test(el.innerText || "") && el.getBoundingClientRect().top < 50 && el.getBoundingClientRect().left < 50) { /* leave */ } }
  // make our overlay canvas fill the window on top
  const ov = document.getElementById("catan3d-overlay"); if (ov) { ov.style.position = "fixed"; ov.style.inset = "0"; ov.style.zIndex = "2147483647"; const cv = ov.querySelector("canvas"); if (cv) { cv.style.width = "100vw"; cv.style.height = "100vh"; } }
  const s = window.__catan3d.board && window.__catan3d.board.scene; if (s) { s.resize(window.innerWidth, window.innerHeight); }
});
await sleep(500);
// try to hide the HUD element specifically (it's a fixed div the content/inject added)
await page.evaluate(() => { for (const el of document.querySelectorAll("div")) { if (/^CATAN 3D/.test((el.innerText || "").trim())) { el.style.display = "none"; break; } } });
await sleep(1200);
await page.screenshot({ path: path.join(SHOW, "showcase-3d.png") });

// top-down
await page.evaluate(() => { const s = window.__catan3d.board && window.__catan3d.board.scene; if (s) { s.camera.position.set(0, 22, 0.01); s.camera.lookAt(0, 0, 0); s.controls.target.set(0, 0, 0); s.controls.update(); } });
await sleep(800);
await page.screenshot({ path: path.join(SHOW, "showcase-3d-topdown.png") });

console.log("SHOWCASE_DONE");
await context.close(); server.close(); process.exit(0);
