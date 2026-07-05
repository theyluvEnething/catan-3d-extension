// test-firsthouse-live.js — LIVE test of the first-placement billboard fix in the real page.
// Launches Colonist, reconnects or starts a game, mounts the FULL 3D stack (mount+forwarder+
// billboard) before setup, and when it's our turn to place the FIRST settlement, drives it via
// REAL mouse: click a legal 3D spot -> click the billboard -> verify the settlement lands.
// This exercises the real OrbitControls pointer-capture path the harness synthetic test can't.
import { launch, checkLogin, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(ROOT, "debug", "hud");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const done = (c) => { log("exiting " + c); setTimeout(() => process.exit(c), 600); };

// Serve extension/ so we can import the ES-module 3D stack into the page.
const EXT = path.join(ROOT, "extension");
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const f = path.join(EXT, p.replace(/^\/ext/, ""));
  if (!f.startsWith(EXT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Access-Control-Allow-Origin": "*" }); res.end(b); });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/ext`;

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
page.on("pageerror", (e) => log("PAGEERROR", e.message));
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { log("not logged in"); done(2); }
await dismissConsent(page);
const stamp = (s) => { try { fs.writeFileSync(path.join(OUT, "firsthouse-progress.txt"), s + "\n"); } catch {} };
stamp("started");
// dismiss reconnect notification; start fresh
await page.evaluate(() => { const b = document.querySelector(".top-notification-close-button"); if (b) b.click(); }).catch(() => {});
await sleep(1200);
// Try up to 3 times to get a fresh game (stale games intermittently block startBotGame).
for (let attempt = 0; attempt < 3 && !(await page.$("#game-canvas")); attempt++) {
  stamp("startBotGame attempt " + attempt);
  log("startBotGame attempt", attempt);
  try { await startBotGame(page, {}); } catch (e) { log("startBotGame threw:", e.message); }
  await sleep(3500);
  for (let w = 0; w < 25 && !(await page.$("#game-canvas")); w++) await sleep(1000);
  if (!(await page.$("#game-canvas"))) { await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" }).catch(() => {}); await sleep(2500); await dismissConsent(page); }
}
if (!(await page.$("#game-canvas"))) { stamp("NO CANVAS after 3 attempts"); log("no canvas"); done(1); }
stamp("in game");
log("in game");

// Provide a shim chrome.runtime.getURL for the served extension, then mount the full stack.
const mounted = await page.evaluate(async (base) => {
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.runtime.getURL) window.chrome.runtime.getURL = (p) => base + "/" + p.replace(/^\//, "");
    const { mountBoard } = await import(base + "/src/render/mount.js");
    const { Forwarder } = await import(base + "/src/interact/forward.js");
    const { ConfirmBillboard } = await import(base + "/src/interact/billboard.js");
    const state = window.__catan3d.state;
    const board = mountBoard(state);
    if (!board) return "no-board";
    const fwd = new Forwarder(board.scene, state, { send: window.__catan3d });
    const bb = new ConfirmBillboard(board.overlay, board.scene);
    fwd.setBillboard(bb);
    window.__T = { board, fwd, bb, state };
    // WARM-UP CLICK (mirrors content.js warmUpFirstClick): fire one synthetic click on the real
    // #game-canvas to prime Colonist's first-interaction state so the first billboard placement works.
    (function warmUp() {
      const canvas = document.getElementById("game-canvas"); if (!canvas) return;
      const r = canvas.getBoundingClientRect(); const px = r.left + r.width / 2, py = r.top + r.height / 2;
      const c = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py, screenX: px, screenY: py, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, composed: true };
      canvas.dispatchEvent(new PointerEvent("pointerover", c)); canvas.dispatchEvent(new PointerEvent("pointermove", c)); canvas.dispatchEvent(new MouseEvent("mousemove", c));
      canvas.dispatchEvent(new PointerEvent("pointerdown", c)); canvas.dispatchEvent(new MouseEvent("mousedown", c));
      const up = { ...c, buttons: 0 };
      canvas.dispatchEvent(new PointerEvent("pointerup", up)); canvas.dispatchEvent(new MouseEvent("mouseup", up)); canvas.dispatchEvent(new MouseEvent("click", up));
      window.__warmedUp = true;
    })();
    return "mounted warmed=" + !!window.__warmedUp;
  } catch (e) { return "ERR:" + e.message + " " + (e.stack || "").slice(0, 200); }
}, base);
log("mount:", mounted);
if (!String(mounted).startsWith("mounted")) { done(1); }

// Helpers
const info = () => page.evaluate(() => {
  const s = window.__catan3d.state; if (!s.ready) return null;
  return { us: s.us, turn: s.currentTurnColor, yourTurn: s.currentTurnColor === s.us, turnState: s.turnState, actionState: s.actionState, completed: s.completedTurns,
    owned: Object.values(s.gameState.mapState.tileCornerStates).filter((c) => c.owner === s.us).length };
});
// screen pixel of a legal settlement pick + the billboard center after opening
const spotScreen = () => page.evaluate(async (base) => {
  const THREE = await import(base + "/vendor/three.module.js");
  const { fwd, board } = window.__T;
  const picks = fwd._pickablesForContext();
  if (!picks.length) return null;
  const m = picks[Math.floor(picks.length / 2)];
  const v = new THREE.Vector3(m.userData.u, 0.55, m.userData.v).project(board.scene.camera);
  const dom = board.scene.renderer.domElement; const r = dom.getBoundingClientRect();
  return { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top };
}, base);
const bbCenter = () => page.evaluate(() => { const p = window.__T.bb.el.querySelector(".bb-plate").getBoundingClientRect(); return { x: p.left + p.width / 2, y: p.top + p.height / 2, active: window.__T.bb.isActive, vis: window.__T.bb.el.style.visibility, controls: window.__T.board.scene.controls.enabled }; });

// Wait until it's our turn to place the FIRST settlement.
log("waiting for our first settlement placement…");
let ready = false;
for (let i = 0; i < 90; i++) {
  const c = await info();
  if (c && c.yourTurn && c.turnState === 0 && c.actionState === 1 && c.owned === 0) { ready = true; break; }
  // if bots are placing / rolling, just wait; press space if we must roll (shouldn't in setup)
  await sleep(1000);
}
if (!ready) { log("never reached our first settlement placement"); done(1); }
log("our first settlement placement is up. Driving via 3D billboard with REAL mouse…");

const before = (await info()).owned;
const spot = await spotScreen();
if (!spot) { log("no legal 3D spot"); done(1); }
// REAL mouse: open the billboard
await page.mouse.move(spot.x, spot.y); await sleep(60);
await page.mouse.down(); await sleep(40); await page.mouse.up();
await sleep(200);
const bc = await bbCenter();
log("billboard after spot-click:", JSON.stringify(bc));
if (!bc.active) { log("✗ billboard did not open"); done(1); }
// REAL mouse: click the billboard to confirm
await page.mouse.move(bc.x, bc.y); await sleep(60);
const bc2 = await bbCenter();
await page.mouse.move(bc2.x, bc2.y); await sleep(30);
await page.mouse.down(); await sleep(50); await page.mouse.up();
await sleep(1500);

const after = await info();
const placed = after.owned > before;
log("RESULT: owned before", before, "after", after.owned, "->", placed ? "✅ FIRST SETTLEMENT PLACED via billboard" : "✗ FAILED (billboard click did not place)");
try { fs.writeFileSync(path.join(OUT, "firsthouse-result.json"), JSON.stringify({ placed, before, after: after.owned, bbAfterOpen: bc, controlsWhileActive: bc.controls }, null, 2)); } catch {}
await page.screenshot({ path: path.join(OUT, "firsthouse-live.png") }).catch(() => {});
done(placed ? 0 : 1);
