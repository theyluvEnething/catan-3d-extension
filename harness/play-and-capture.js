// Play a full game: setup via DIRECT-SEND (reliable), main phase via direct-send builds +
// keyboard roll/pass, and robber via trusted click (needs isTrusted). Capture the outgoing
// action id for CITY (via clicking Colonist's city button + our settlement, since we don't
// know its direct-send id yet) and ROBBER (via the robber click). Reports captured ids.
//
// This doubles as the GATE-3 driver: it plays a whole game through our layer, tracking any
// desync between our reconstructed state and what Colonist accepts.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeOutgoing } from "../extension/src/protocol/decode.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 41);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());

let ctxTag = "";
const tagged = [];
page.on("websocket", (ws) => ws.on("framesent", (f) => { const p = f.payload; if (!Buffer.isBuffer(p)) return; try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && d.body.action !== 66 && d.body.action !== 15 && d.body.action !== 11) tagged.push({ action: d.body.action, payload: d.body.payload, tag: ctxTag }); } catch {} }));

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("PLAYCAP not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);
const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.42;

const snap = () => page.evaluate(() => window.__catan3d.snapshot());
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const mine = () => page.evaluate(() => window.__catan3d.state.currentTurnColor === window.__catan3d.state.us);
const report = { city: null, robber: null, setupOk: false, desyncs: 0, builds: 0, rolls: 0, robberMoves: 0, turns: 0, events: [] };
let lastCorner = null;

async function place(kind) {
  if (kind === "settlement") { const r = await page.evaluate(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; const res = window.__catan3d.buildSettlement(i); return res && res.ok ? { i, coord: window.__catan3d.state.gameState.mapState.tileCornerStates[i] } : null; }); if (r) { lastCorner = r.coord; return true; } return false; }
  if (kind === "road") { const ok = await page.evaluate((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (!L.length) return false; const res = window.__catan3d.buildRoad(L[0].i); return !!(res && res.ok); }, lastCorner); return ok; }
}

const t0 = Date.now(); const MAX = 11 * 60 * 1000;
let over = false;
while (Date.now() - t0 < MAX && !over) {
  const s = await snap(); const p = await prompt(); const m = await mine();
  over = /game over|has won|victory|you win|you lose/i.test(p);

  if (s.completedTurns < 8) {
    if (/place settlement/.test(p) && m) { ctxTag = "setup-settlement"; if (!(await place("settlement"))) report.desyncs++; await sleep(1200); }
    else if (/place road/.test(p) && m) { ctxTag = "setup-road"; if (!(await place("road"))) report.desyncs++; await sleep(1200); }
    else await sleep(800);
    continue;
  }
  report.setupOk = true;

  if (/roll/.test(p) && m) { ctxTag = "roll"; await page.keyboard.press("Space"); report.rolls++; await sleep(1400); }
  else if ((/move.*robber|place.*robber/.test(p))) {
    ctxTag = "robber"; const rb = s.robber;
    outer: for (let ring = 0.12; ring <= 1; ring += 0.09) { for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(150); if ((await snap()).robber !== rb) break outer; } }
    if ((await snap()).robber !== rb) report.robberMoves++;
    await sleep(700); ctxTag = "steal"; // steal target click
    for (let i = 0; i < 10; i++) { await page.mouse.click(cx + Math.cos(i) * R * 0.15, cy + Math.sin(i) * R * 0.15); await sleep(150); if (!/steal|select/.test(await prompt())) break; }
    await sleep(700);
  }
  else if (/discard/.test(p)) { ctxTag = "discard"; for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width * (0.28 + i * 0.09), box.y + box.height * 0.9); await sleep(180); } await page.keyboard.press("Enter"); await sleep(700); }
  else if (m && /(your turn|build|trade|pass)/.test(p)) {
    report.turns++;
    // try a city via Colonist's UI button (to capture its action id) once we have a legal city
    const cityCorner = await page.evaluate(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; });
    if (cityCorner != null && !report.city) {
      ctxTag = "city";
      // click the city build button (top toolbar), then our settlement
      const clicked = await page.evaluate(() => { const els = [...document.querySelectorAll("button,[role=button],[class*=button],[class*=btn],[aria-label]")]; const b = els.find((e) => /city/i.test((e.getAttribute("aria-label") || "") + " " + (e.className || "") + " " + (e.innerText || ""))); if (b) { b.click(); return true; } return false; });
      if (clicked) { await sleep(300); const before = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner); outer2: for (let ring = 0.05; ring <= 0.6; ring += 0.05) { for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); const bt = await page.evaluate((idx) => window.__catan3d.state.gameState.mapState.tileCornerStates[idx].buildingType, cityCorner); if (bt === 2 && bt !== before) break outer2; } } }
    }
    // build a settlement/road via direct-send if legal (main phase)
    const built = await page.evaluate(() => { const L = window.__catan3d.legalSettlements(); if (L.length) { const r = window.__catan3d.buildSettlement(L[0].i); return !!(r && r.ok); } const Lr = window.__catan3d.legalRoads(); if (Lr.length) { const r = window.__catan3d.buildRoad(Lr[0].i); return !!(r && r.ok); } return false; });
    if (built) report.builds++;
    ctxTag = "pass"; await page.keyboard.press("Space"); await sleep(900);
  }
  else await sleep(900);
}

// attribute captured ids
for (const t of tagged) { if (t.tag === "city" && !report.city) report.city = t.action; if ((t.tag === "robber" || t.tag === "steal") && !report.robber) report.robber = t.action; }
report.taggedSample = tagged.slice(0, 20);
report.over = over;
console.log("PLAYCAP_REPORT " + JSON.stringify(report));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "play-and-capture-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
