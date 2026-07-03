// GATE 2 verification: start a bot game, play the opening so pieces exist, then mount the 3D
// board OVER the live Colonist canvas and screenshot both the 3D mirror and (for comparison)
// the real board. Confirms the 3D scene mirrors the live game in real time.
//
// The extension can't be loaded via CLI on Chrome 149, so the harness injects the runtime and
// serves extension/ over HTTP to dynamically import the (module-based) 3D scene into the page.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serve extension/ so the page can import the ES-module 3D scene.
const MIME = { ".js": "text/javascript", ".json": "application/json", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, "extension", decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "access-control-allow-origin": "*" });
    res.end(d);
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); server.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4000);

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const owned = () => page.evaluate(() => { const gs = window.__catan3d?.state, cs = gs?.gameState?.mapState?.tileCornerStates || {}, es = gs?.gameState?.mapState?.tileEdgeStates || {}, us = gs?.us; return Object.values(cs).filter((c) => c.owner === us).length + Object.values(es).filter((e) => e.owner === us).length; });
const diceThrown = () => page.evaluate(() => window.__catan3d?.state?.gameState?.diceState?.diceThrown);
const turnOf = () => page.evaluate(() => window.__catan3d?.state?.currentTurnColor);
const us = () => page.evaluate(() => window.__catan3d?.state?.us);

// Play a few turns so bots + we place pieces.
console.log("playing opening to populate pieces…");
for (let i = 0; i < 60; i++) {
  const p = await prompt();
  const done = await page.evaluate(() => window.__catan3d?.state?.completedTurns || 0);
  if (done >= 8) break; // setup complete
  if (/place settlement|place road/.test(p)) { const b = await owned(); outer: for (let ring = 0.08; ring <= 1; ring += 0.04) { const n = Math.max(8, Math.round(ring * 54)); for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); if (await owned() > b) break outer; } } await sleep(600); }
  else if (/roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); }
  else if (/answer trade/.test(p)) { await page.keyboard.press("Escape"); await sleep(400); }
  else if (await turnOf() === await us() && await diceThrown()) { await page.keyboard.press("Space"); await sleep(700); }
  else await sleep(1000);
}

// Screenshot the REAL board first (3D not yet mounted).
await page.screenshot({ path: path.join(SHOTS_DIR, "gate2-real-board.png") });

// Mount the 3D board over the live canvas by importing mount.js into the page.
const mountResult = await page.evaluate(async (base) => {
  try {
    const { mountBoard } = await import(base + "/src/render/mount.js");
    const state = window.__catan3d.state;
    const board = mountBoard(state);
    window.__catan3d.board = board;
    return board ? "mounted" : "no-canvas";
  } catch (e) { return "ERROR: " + e.message; }
}, base);
console.log("MOUNT:", mountResult);
await sleep(2500);
await page.screenshot({ path: path.join(SHOTS_DIR, "gate2-3d-board.png") });

// Report reconstructed piece counts for cross-check.
const counts = await page.evaluate(() => {
  const gs = window.__catan3d.state; const b = gs.buildings();
  return { settlements: b.settlements.length, cities: b.cities.length, roads: b.roads.length, robber: gs.robberTileIndex, turn: gs.currentTurnColor };
});
console.log("RECONSTRUCTED:", JSON.stringify(counts));
console.log("screenshots: gate2-real-board.png, gate2-3d-board.png");

await context.close();
server.close();
