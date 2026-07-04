// Probe unknown action IDs by DIRECT SEND + observing state changes. We reach the main phase
// via reliable direct-send setup, then for CITY we try candidate action ids against a legal
// city corner and detect which one flips buildingType->2. For ROBBER, after a 7 we try
// candidate ids with a legal hex index and detect robberTileIndex change.
//
// Uses ONE game (low resource). Candidates come from robottler (28=city,16=robber) + workflow
// (47,6). We never rely on a guess — only report an id that provably worked.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("PROBE not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);

const snap = () => page.evaluate(() => window.__catan3d.snapshot());
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const mine = () => page.evaluate(() => window.__catan3d.state.currentTurnColor === window.__catan3d.state.us);

// Reliable setup via direct-send using legal helpers.
let lastCorner = null;
async function doSetup() {
  for (let g = 0; g < 40; g++) {
    const s = await snap(); if ((s.completedTurns ?? 0) >= 8) return true;
    const p = await prompt(); const m = await mine();
    if (/place settlement/.test(p) && m) {
      const r = await page.evaluate(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const idx = L[0].i; const res = window.__catan3d.buildSettlement(idx); return { idx, res, coord: window.__catan3d.state.gameState.mapState.tileCornerStates[idx] }; });
      if (r) { await sleep(1200); lastCorner = r.coord; }
    } else if (/place road/.test(p) && m) {
      await page.evaluate((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner);
      await sleep(1200);
    } else await sleep(800);
  }
  return false;
}

const result = { city: null, robber: null, notes: [] };
try {
  await doSetup();
  result.notes.push("setup done, completed=" + (await snap()).completedTurns);

  // Probe CITY: wait for our main turn, ensure we own a settlement, try candidate ids.
  const CITY_CANDS = [28, 47, 6, 27, 17];
  for (let w = 0; w < 120 && !result.city; w++) {
    const s = await snap(); const p = await prompt(); const m = await mine();
    if (m && /roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1300); continue; }
    if (m && /(your turn|build|trade|pass)/.test(p)) {
      // do we have a legal city + resources? try each candidate; detect buildingType->2
      const cityCorner = await page.evaluate(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; });
      if (cityCorner != null) {
        for (const cand of CITY_CANDS) {
          const before = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
          await page.evaluate(({ cand, i }) => window.__catan3d.sendGameAction(cand, i), { cand, i: cityCorner });
          await sleep(900);
          const after = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
          if (after === 2 && before !== 2) { result.city = cand; result.notes.push(`CITY action=${cand} (corner ${cityCorner} -> city)`); break; }
        }
      }
      // advance: pass turn
      await page.keyboard.press("Space"); await sleep(900);
    } else await sleep(800);
  }

  // Probe ROBBER: after a 7, try candidate ids with a legal hex.
  const ROB_CANDS = [16, 25, 24, 26];
  for (let w = 0; w < 60 && !result.robber; w++) {
    const p = await prompt();
    if (/move.*robber|place.*robber/.test(p)) {
      const hex = await page.evaluate(() => { const L = window.__catan3d.legalRobberHexes(); return L.length ? L[0].i : null; });
      const rb = (await snap()).robber;
      for (const cand of ROB_CANDS) {
        await page.evaluate(({ cand, i }) => window.__catan3d.sendGameAction(cand, i), { cand, i: hex });
        await sleep(900);
        if ((await snap()).robber !== rb) { result.robber = cand; result.notes.push(`ROBBER action=${cand} (robber -> tile ${hex})`); break; }
      }
      break;
    }
    if (await mine() && /roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); }
    else await sleep(800);
  }
} catch (e) { result.notes.push("err:" + (e && e.message || e)); }

console.log("PROBE_RESULT " + JSON.stringify(result));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "probe-actions-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
