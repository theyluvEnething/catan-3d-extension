// Play ONE full bot game with real trusted clicks and log EVERY outgoing game action with the
// UI-prompt context at the time, so we can attribute action ids to roll/pass/city/robber/etc
// from a single natural game (no fragile per-action state setup, low resource use).
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeOutgoing } from "../extension/src/protocol/decode.js";
import fs from "node:fs";
import path from "node:path";

const clone = Number(process.argv[2] ?? 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());

let curPrompt = "";
const actions = []; // {action, payload, prompt}
page.on("websocket", (ws) => ws.on("framesent", (f) => {
  const p = f.payload; if (!Buffer.isBuffer(p)) return;
  try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && d.body.action !== 66) actions.push({ action: d.body.action, payload: d.body.payload, prompt: curPrompt }); } catch {}
}));

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log(JSON.stringify({ error: "not logged in" })); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);
if (!(await page.$("#game-canvas"))) { console.log(JSON.stringify({ error: "no canvas" })); await ctx.close(); process.exit(0); }

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const snap = () => page.evaluate(() => window.__catan3d.snapshot());
const owned = () => page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState, us = s.us; return Object.values(ms.tileCornerStates).filter((c) => c.owner === us).length + Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length; });
const mine = () => page.evaluate(() => window.__catan3d.state.currentTurnColor === window.__catan3d.state.us);
const clickScan = async (pred, o = {}) => { const { r0 = 0.06, r1 = 1, st = 0.04 } = o; for (let ring = r0; ring <= r1; ring += st) { const n = Math.max(8, Math.round(ring * 52)); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(130); if (await pred()) return true; } } return false; };

// Click a top-bar build button by fuzzy text/aria (settlement/city/road/dev)
async function clickBuild(kind) {
  const sel = await page.evaluateHandle((kind) => {
    const els = [...document.querySelectorAll("button,[role=button],[class*=button],[class*=btn],[aria-label]")];
    const rx = new RegExp(kind, "i");
    return els.find((e) => rx.test((e.getAttribute("aria-label") || "") + " " + (e.className || "") + " " + (e.innerText || ""))) || null;
  }, kind);
  const el = sel.asElement(); if (el) { await el.click().catch(() => {}); return true; } return false;
}

function dump() {
  const byAction = {};
  for (const a of actions) { const k = a.action; (byAction[k] = byAction[k] || { action: k, count: 0, payloads: new Set(), prompts: new Set() }); byAction[k].count++; byAction[k].payloads.add(typeof a.payload === "object" ? JSON.stringify(a.payload) : a.payload); byAction[k].prompts.add((a.prompt || "").slice(0, 24)); }
  const summary = Object.values(byAction).map((b) => ({ action: b.action, count: b.count, payloads: [...b.payloads].slice(0, 6), prompts: [...b.prompts].slice(0, 6) }));
  try { fs.writeFileSync(path.join(SHOTS_DIR, "..", "fullgame-actions.json"), JSON.stringify({ actions, summary }, null, 2)); } catch {}
  console.log("FULLGAME_ACTIONS " + JSON.stringify(summary));
}
// Dump periodically so we get data even if the game stalls or Playwright cleanup throws.
const dumpTimer = setInterval(dump, 20000);

const t0 = Date.now(); const MAX = 10 * 60 * 1000;
let boughtDev = false, builtCity = false;
try {
while (Date.now() - t0 < MAX) {
  curPrompt = await prompt();
  const s = await snap();
  if (/game over|has won|victory/i.test(curPrompt) || s.log?.some?.((l) => /won|game.?over/i.test(String(l)))) break;
  const m = await mine();

  if (/place settlement/.test(curPrompt) && m) { const b = await owned(); await clickScan(async () => (await owned()) > b); }
  else if (/place road/.test(curPrompt) && m) { const b = await owned(); await clickScan(async () => (await owned()) > b, { r0: 0.03, r1: 0.2, st: 0.02 }); }
  else if (/roll/.test(curPrompt) && m) { await page.keyboard.press("Space"); await sleep(1300); }
  else if (/move.*robber|place.*robber/.test(curPrompt)) { const rb = s.robber; await clickScan(async () => (await snap()).robber !== rb, { r0: 0.1, r1: 1, st: 0.08 }); await sleep(700); /* steal target */ await clickScan(async () => !/steal|select/.test(await prompt()), { r0: 0.02, r1: 0.25, st: 0.05 }); }
  else if (/discard/.test(curPrompt)) { for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width * (0.28 + i * 0.09), box.y + box.height * 0.9); await sleep(180); } await page.keyboard.press("Enter"); await sleep(700); }
  else if (m && /(your turn|build|trade|pass)/.test(curPrompt)) {
    // occasionally try a city + a dev-card buy to capture those ids, else pass
    if (!builtCity) { curPrompt = "try-city"; if (await clickBuild("city")) { await sleep(300); const before = await page.evaluate(() => { const s = window.__catan3d.state; return Object.values(s.gameState.mapState.tileCornerStates).filter((c) => c.owner === s.us && c.buildingType === 2).length; }); await clickScan(async () => (await page.evaluate(() => { const s = window.__catan3d.state; return Object.values(s.gameState.mapState.tileCornerStates).filter((c) => c.owner === s.us && c.buildingType === 2).length; })) > before, { r0: 0.05, r1: 0.6, st: 0.05 }); builtCity = true; } }
    if (!boughtDev) { curPrompt = "try-buydev"; if (await clickBuild("develop|dev.?card|buy")) { await sleep(600); boughtDev = true; } }
    curPrompt = "pass"; await page.keyboard.press("Space"); await sleep(800);
  } else await sleep(900);
}
} catch (e) { console.log("LOOP_ERROR " + (e && e.message || e)); }
clearInterval(dumpTimer);
dump();
try { await page.screenshot({ path: path.join(SHOTS_DIR, "fullgame-actions-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
