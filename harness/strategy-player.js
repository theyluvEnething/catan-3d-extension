// Strategy auto-player: plays a full Colonist bot game through OUR interaction layer
// (direct-send) toward a 10-VP win. Heuristic core + DeepSeek fallback for ambiguous spot
// choices. Self-discovers the city action id on the first affordable city.
//
//   node harness/strategy-player.js [cloneIndex]
//
// Resource enum (verified): WOOD=1 BRICK=2 SHEEP=3 WHEAT=4 ORE=5.
// Costs: road{1,2}  settlement{1,2,3,4}  city{4:2,5:3}  devcard{3,4,5}.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { chooseOption, deepseekAvailable } from "./deepseek.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
// Race every page op against a timeout so a slow/blocked call surfaces instead of hanging.
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT " + (l || ""))), ms))]);

const WOOD = 1, BRICK = 2, SHEEP = 3, WHEAT = 4, ORE = 5;
const COST = { road: { [WOOD]: 1, [BRICK]: 1 }, settlement: { [WOOD]: 1, [BRICK]: 1, [SHEEP]: 1, [WHEAT]: 1 }, city: { [WHEAT]: 2, [ORE]: 3 }, dev: { [SHEEP]: 1, [WHEAT]: 1, [ORE]: 1 } };
// city action id: try candidates until one upgrades a settlement, then lock it.
const CITY_CANDS = [19]; // ✅ VERIFIED: action 19 = build city (payload cornerIndex)
let CITY_ACTION = 19;
const DEV_CANDS = [21, 24, 22, 46];
let DEV_ACTION = null;
const ROBBER_ACTION = 3; // captured candidate; falls back to trusted click if it fails

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("STRAT not logged in"); await ctx.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) { log("canvas still not up at 45s; re-clicking Start"); await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); } }
const canvas = await page.$("#game-canvas");
if (!canvas) { console.log("STRAT no canvas"); await ctx.close(); process.exit(1); }
log("in game; canvas up");
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.42;

// ---- state readers ----
const core = () => page.evaluate(() => {
  const s = window.__catan3d.state; const ps = s.playerState(s.us) || {};
  const vp = ps.victoryPointsState ? Object.values(ps.victoryPointsState).reduce((a, x) => a + (typeof x === "number" ? x : 0), 0) : 0;
  // resourceCards.cards is an ARRAY of resource-ids (one entry per card). Count occurrences.
  const raw = (ps.resourceCards && ps.resourceCards.cards) || [];
  const hand = {}; if (Array.isArray(raw)) { for (const r of raw) hand[r] = (hand[r] || 0) + 1; } else { Object.assign(hand, raw); }
  return { us: s.us, turn: s.currentTurnColor, completed: s.completedTurns, turnState: s.turnState, actionState: s.actionState, robber: s.robberTileIndex, hand, handSize: Array.isArray(raw) ? raw.length : 0, vp, ratios: ps.bankTradeRatiosState || {} };
});
const endTurn = async () => { await page.evaluate(() => window.__catan3d.sendGameAction(6, true)); await sleep(1000); };
const allVP = () => page.evaluate(() => { const s = window.__catan3d.snapshot(); return s.players.map((p) => `${p.color}:${p.vp}`).join(" "); });
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const pieceCounts = () => page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState, us = s.us; return { settlements: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType !== 2).length, cities: Object.values(ms.tileCornerStates).filter((c) => c.owner === us && c.buildingType === 2).length, roads: Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length }; });

function canAfford(hand, cost) { return Object.entries(cost).every(([res, n]) => (hand[res] || 0) >= n); }

// Production value of a corner = sum over adjacent hexes of dice-probability (dots). Uses the
// state's hex dice numbers; pips(n) = 6 - |7 - n|.
async function bestSettlementCorner(setup) {
  return page.evaluate((setup) => {
    const s = window.__catan3d.state, ms = s.gameState.mapState;
    const L = window.__catan3d.legalSettlements({ setup });
    if (!L.length) return null;
    const hexByKey = {}; for (const h of Object.values(ms.tileHexStates)) hexByKey[h.x + "," + h.y] = h;
    const pips = (n) => (n ? 6 - Math.abs(7 - n) : 0);
    // corner -> adjacent hexes via the same rule the renderer uses
    const cornerHexes = (x, y, z) => { const out = [{ x, y }]; if (z === 0) out.push({ x, y: y - 1 }, { x: x + 1, y: y - 1 }); else out.push({ x: x - 1, y: y + 1 }, { x, y: y + 1 }); return out; };
    let scored = L.map((c) => { let v = 0; const res = new Set(); for (const h of cornerHexes(c.x, c.y, c.z)) { const hx = hexByKey[h.x + "," + h.y]; if (hx) { v += pips(hx.diceNumber); if (hx.type) res.add(hx.type); } } return { i: c.i, v, diversity: res.size }; });
    scored.sort((a, b) => (b.v + b.diversity) - (a.v + a.diversity));
    return scored.slice(0, 4); // top few for optional LLM tiebreak
  }, setup);
}

let lastCorner = null;
async function doSettlement(setup) {
  const top = await bestSettlementCorner(setup);
  if (!top || !top.length) return false;
  let choiceI = top[0].i;
  if (top.length > 1 && deepseekAvailable() && Math.abs(top[0].v - top[1].v) <= 1) {
    const c = await core();
    choiceI = await chooseOption(`Catan setup=${setup}. Pick the best settlement spot (production pips + resource diversity). My VP=${c.vp}.`, top.map((t) => ({ id: t.i, desc: `corner ${t.i}: pips ${t.v}, ${t.diversity} resources` })));
  }
  const before = await pieceCounts();
  const coord = await page.evaluate((i) => { const r = window.__catan3d.buildSettlement(i); return r && r.ok ? window.__catan3d.state.gameState.mapState.tileCornerStates[i] : null; }, choiceI);
  await sleep(1200);
  const after = await pieceCounts();
  if (after.settlements + after.cities > before.settlements + before.cities) { lastCorner = coord; return true; }
  return false;
}
async function doRoad(setup) {
  const before = (await pieceCounts()).roads;
  await page.evaluate(({ setup, fc }) => { const L = window.__catan3d.legalRoads({ setup, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, { setup, fc: lastCorner });
  await sleep(1200);
  return (await pieceCounts()).roads > before;
}
async function doCity() {
  const cityCorner = await page.evaluate(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; });
  if (cityCorner == null) return false;
  const cands = CITY_ACTION ? [CITY_ACTION] : CITY_CANDS;
  log("doCity trying candidates on corner", cityCorner, "cands", cands.join(","));
  for (const cand of cands) {
    const before = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
    await page.evaluate(({ cand, i }) => window.__catan3d.sendGameAction(cand, i), { cand, i: cityCorner });
    await sleep(850);
    const after = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
    if (after === 2 && before !== 2) { if (!CITY_ACTION) { CITY_ACTION = cand; log("DISCOVERED city action =", cand); } return true; }
  }
  log("doCity: no candidate worked");
  return false;
}

const rep = { setupSettlements: 0, setupRoads: 0, cities: 0, settlements: 0, roads: 0, devs: 0, rolls: 0, robbers: 0, discards: 0, desyncs: 0, cityAction: null, over: false, maxVP: 0 };

async function moveRobber() {
  const before = (await core()).robber;
  // best hex = an opponent's highest-pip hex not ours; simple: pick legal hex with most pips
  const hex = await page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState; const L = window.__catan3d.legalRobberHexes(); if (!L.length) return null; const pips = (n) => (n ? 6 - Math.abs(7 - n) : 0); L.sort((a, b) => pips(b.diceNumber) - pips(a.diceNumber)); return L[0].i; });
  if (hex == null) return;
  await page.evaluate(({ a, hex }) => window.__catan3d.sendGameAction(a, hex), { a: ROBBER_ACTION, hex });
  await sleep(1100);
  if ((await core()).robber === before) { // fallback trusted click scan
    outer: for (let ring = 0.12; ring <= 1; ring += 0.09) for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(150); if ((await core()).robber !== before) break outer; }
  }
  if ((await core()).robber !== before) rep.robbers++;
  // steal picker: click near robber
  await sleep(500); for (let i = 0; i < 8; i++) { await page.mouse.click(cx + Math.cos(i) * R * 0.14, cy + Math.sin(i) * R * 0.14); await sleep(150); if (!/steal|select a player/.test(await prompt())) break; }
}
async function discard() {
  // discard lowest-value: send action 2 (payload true) per card over the limit. Colonist prompts
  // for the exact selection UI; the toggle approach discards from the front — acceptable.
  const c = await core(); const total = Object.values(c.hand).reduce((a, x) => a + x, 0); const drop = Math.floor(total / 2);
  for (let k = 0; k < drop; k++) { await page.evaluate(() => window.__catan3d.sendGameAction(2, true)); await sleep(250); }
  await page.keyboard.press("Enter"); await sleep(600); rep.discards++;
}

const MAX_MS = 22 * 60 * 1000;
let idle = 0;
let iter = 0; let lastBeat = 0;
while (Date.now() - T0 < MAX_MS) {
  iter++;
  let c, p;
  try { c = await to(core(), 10000, "core"); p = await to(prompt(), 10000, "prompt"); }
  catch (e) { log("read timeout, skipping iter", e.message); await sleep(500); continue; }
  try {
  if (Date.now() - lastBeat > 8000) { lastBeat = Date.now(); log(`beat iter=${iter} completed=${c.completed} turn=${c.turn} us=${c.us} mine=${c.turn === c.us} vp=${c.vp} prompt="${p.slice(0, 28)}"`); }
  rep.maxVP = Math.max(rep.maxVP, c.vp);
  if (/you win|has won|game over|victory|you lose/i.test(p)) { rep.over = true; break; }
  const mine = c.turn === c.us;

  if (c.completed < 8) {
    if (mine && /place settlement/.test(p)) { const ok = await doSettlement(true); ok ? rep.setupSettlements++ : rep.desyncs++; log("setup settlement", ok ? "ok" : "FAIL"); }
    else if (mine && /place road/.test(p)) { const ok = await doRoad(true); ok ? rep.setupRoads++ : rep.desyncs++; log("setup road", ok ? "ok" : "FAIL"); }
    else await sleep(800);
    continue;
  }

  if (!mine) {
    // still handle discard on a 7 even when not our turn
    if (/discard/.test(p)) await discard();
    else { await sleep(800); idle++; if (idle > 200) break; }
    continue;
  }
  idle = 0;

  // Interrupt handlers first (can occur mid-turn).
  if (/move.*robber|place.*robber/.test(p)) { await moveRobber(); await sleep(500); continue; }
  if (/discard/.test(p)) { await discard(); continue; }

  // Use turnState to gate precisely: ts1 = must roll; ts2 = build/trade/end-turn.
  if (c.turnState === 1) { await page.keyboard.press("Space"); rep.rolls++; await sleep(1500); continue; }
  if (c.turnState !== 2) { await sleep(700); continue; } // some other sub-state; wait

  // BUILD PHASE (ts2) — priority: city > settlement > devcard > road. Build as many as afford.
  const hand = c.hand;
  const legalCounts = await page.evaluate(() => ({ set: window.__catan3d.legalSettlements().length, cit: window.__catan3d.legalCities().length, road: window.__catan3d.legalRoads().length }));
  log(`BUILD ts2 hand=${JSON.stringify(hand)} legal(s/c/r)=${legalCounts.set}/${legalCounts.cit}/${legalCounts.road} afford: city=${canAfford(hand, COST.city)} set=${canAfford(hand, COST.settlement)} road=${canAfford(hand, COST.road)}`);
  let builtSomething = false;
  for (let step = 0; step < 4; step++) {
    const h = (await core()).hand;
    if (canAfford(h, COST.city) && await doCity()) { rep.cities++; builtSomething = true; log("built CITY, VP", (await core()).vp); continue; }
    if (canAfford(h, COST.settlement) && await doSettlement(false)) { rep.settlements++; builtSomething = true; log("built settlement"); continue; }
    if (canAfford(h, COST.dev)) { const cands = DEV_ACTION ? [DEV_ACTION] : DEV_CANDS; let d = false; for (const cand of cands) { const bv = await page.evaluate(() => { try { const s = window.__catan3d.state, ps = s.playerState(s.us); const dd = ps.developmentCards || {}; return Object.values(dd).reduce((a, x) => a + (typeof x === "number" ? x : 0), 0); } catch { return 0; } }); await page.evaluate((cand) => window.__catan3d.sendGameAction(cand, true), cand); await sleep(900); const av = await page.evaluate(() => { try { const s = window.__catan3d.state, ps = s.playerState(s.us); const dd = ps.developmentCards || {}; return Object.values(dd).reduce((a, x) => a + (typeof x === "number" ? x : 0), 0); } catch { return 0; } }); if (av > bv) { if (!DEV_ACTION) { DEV_ACTION = cand; log("DISCOVERED dev action =", cand); } rep.devs++; d = true; break; } } if (d) { builtSomething = true; continue; } }
    if (canAfford(h, COST.road) && await doRoad(false)) { rep.roads++; builtSomething = true; continue; }
    break; // nothing more affordable
  }

  // end turn via direct-send pass (action 6); verify it advanced, else fall back to Space.
  const before = c.completed;
  await endTurn();
  if ((await core()).completed === before) { await page.keyboard.press("Space"); await sleep(1000); }
  if (rep.rolls % 6 === 0) log("progress: VPs", await allVP(), "| built", JSON.stringify({ c: rep.cities, s: rep.settlements, d: rep.devs, r: rep.roads }));
  } catch (e) { log("iter error (continuing)", e && e.message || String(e)); await sleep(500); }
}

rep.cityAction = CITY_ACTION; rep.devAction = DEV_ACTION;
rep.finalVPs = await allVP();
rep.finalPieces = await pieceCounts();
try { rep.watchdog = await to(page.evaluate(() => window.__catan3d.desyncReport()), 8000, "wd"); } catch {}
console.log("STRATEGY_RESULT " + JSON.stringify(rep));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "strategy-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
