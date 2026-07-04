// Bank-trade v4: the trade creator's FIRST occurrence of each resource (boxes index 0-4) are
// the give/offer TYPE buttons. Click the give-type button 4x + the want-type button 1x with real
// mouse clicks, verifying a frame fires after each, then click #action-button-trade-bank and
// capture the execute frame. Also decode the incoming type-43 (trade data) for payload shape.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeOutgoing, decodeFrame } from "../extension/src/protocol/decode.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 88);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TO " + (l || ""))), ms))]);

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
let capOut = false, capIn = false; const outFrames = []; const inTrade = [];
page.on("websocket", (ws) => { ws.on("framesent", (f) => { const p = f.payload; if (!Buffer.isBuffer(p)) return; try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && ![66, 6, 67].includes(d.body.action) && capOut) outFrames.push({ action: d.body.action, payload: d.body.payload }); } catch {} }); ws.on("framereceived", (f) => { const p = f.payload; if (!Buffer.isBuffer(p) || !capIn) return; try { const d = decodeFrame({ dir: "in", kind: "binary", bytes: new Uint8Array(p) }); if (d && (d.type === 43 || (d.payload && d.payload.givingCards))) inTrade.push(d.payload); } catch {} }); });

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("BTV4 not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
log("in game");
const ev = (fn, arg, l) => to(page.evaluate(fn, arg), 8000, l || "ev");
const core = () => ev(() => { const s = window.__catan3d.state; const ps = s.playerState(s.us) || {}; const raw = (ps.resourceCards && ps.resourceCards.cards) || []; const h = {}; for (const r of raw) h[r] = (h[r] || 0) + 1; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, hand: h, robber: s.robberTileIndex }; }, null, "core");
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; }, null, "prompt");

// The give-type buttons: within the trade creator, the FIRST img of each resource id (the
// selector row), distinct from hand cards. We take, per resource, the top-most (smallest y) box.
async function typeButtons() {
  return ev(() => {
    const NAME = { 1: ["lumber", "wood"], 2: ["brick"], 3: ["wool", "sheep"], 4: ["grain", "wheat"], 5: ["ore"] };
    const resOf = (s) => { s = (s || "").toLowerCase(); for (const [r, ns] of Object.entries(NAME)) if (ns.some((n) => s.includes(n))) return Number(r); return null; };
    const root = document.querySelector("[class*=tradeCreator]") || document;
    const imgs = [...root.querySelectorAll("img")].map((im) => { const r = resOf((im.getAttribute("alt") || "") + " " + (im.src || "")); const bb = im.getBoundingClientRect(); return r && bb.width ? { res: r, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, w: bb.width } : null; }).filter(Boolean);
    // group by res, take the top-most (the selector button row sits above the hand)
    const byRes = {}; for (const b of imgs) { if (!byRes[b.res] || b.y < byRes[b.res].y) byRes[b.res] = b; }
    // want side buttons: same but in wanted container; if none, reuse the offer buttons (Colonist
    // often uses +/- on the same card)
    const wantRoot = document.querySelector("[class*=wantedCardSelector],[class*=WantedHalf]");
    const wantImgs = wantRoot ? [...wantRoot.querySelectorAll("img")].map((im) => { const r = resOf((im.getAttribute("alt") || "") + " " + (im.src || "")); const bb = im.getBoundingClientRect(); return r && bb.width ? { res: r, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 } : null; }).filter(Boolean) : [];
    const wantByRes = {}; for (const b of wantImgs) if (!wantByRes[b.res] || b.y < wantByRes[b.res].y) wantByRes[b.res] = b;
    const bank = (() => { const b = document.querySelector("#action-button-trade-bank"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })();
    return { offer: byRes, want: wantByRes, bank };
  }, null, "tb");
}

let lastCorner = null; let done = false; let attempt = 0;
for (let i = 0; i < 800 && !done; i++) {
  let c, p; try { c = await core(); p = await prompt(); } catch { continue; }
  const m = c.turn === c.us;
  if (c.completed < 8) {
    if (m && /place settlement/.test(p)) { const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }); lastCorner = r; await sleep(1100); }
    else if (m && /place road/.test(p)) { await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner); await sleep(1100); }
    else await sleep(600);
    continue;
  }
  if (/move.*robber|place.*robber/.test(p) && m) { await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }); await sleep(900); continue; }
  if (/select player to rob|steal/.test(p) && m) { await page.keyboard.press("Escape").catch(() => {}); await sleep(400); continue; }
  if (m && c.turnState === 1) { await to(page.keyboard.press("Space"), 6000, "roll").catch(() => {}); await sleep(1200); continue; }
  if (m && c.turnState === 2) {
    const surplus = Object.entries(c.hand).find(([r, n]) => n >= 4);
    if (surplus && attempt < 5) {
      attempt++;
      const giveRes = Number(surplus[0]);
      const wantRes = [1, 2, 3, 4, 5].filter((r) => r !== giveRes).sort((a, b) => (c.hand[a] || 0) - (c.hand[b] || 0))[0];
      log(`attempt ${attempt}: give ${giveRes}x4 -> want ${wantRes}. hand=${JSON.stringify(c.hand)}`);
      const handBefore = c.hand;
      outFrames.length = 0; inTrade.length = 0; capOut = true; capIn = true;
      await ev(() => { const b = document.querySelector("#action-button-trade"); if (b) b.click(); }); await sleep(1000);
      let tb = await typeButtons();
      log("offer buttons:", JSON.stringify(Object.keys(tb.offer)), "want:", JSON.stringify(Object.keys(tb.want)), "bank?", !!tb.bank);
      // click give-type button 4x — RE-QUERY before each click (panel re-renders, button moves).
      for (let k = 0; k < 4; k++) { const t = await typeButtons(); const gBtn = t.offer[giveRes]; if (gBtn) await page.mouse.click(gBtn.x, gBtn.y); await sleep(450); log(`  give click ${k + 1}: frames=${outFrames.length}`); }
      // want-type button once (re-query)
      { const t = await typeButtons(); const wBtn = t.want[wantRes] || t.offer[wantRes]; if (wBtn) await page.mouse.click(wBtn.x, wBtn.y); await sleep(450); }
      log("after clicks — out frames:", JSON.stringify(outFrames));
      await page.screenshot({ path: path.join(SHOTS_DIR, `btv5-${attempt}.png`) });
      // execute
      tb = await typeButtons();
      const preExec = outFrames.length;
      if (tb.bank) { await page.mouse.click(tb.bank.x, tb.bank.y); await sleep(1600); }
      const execFrames = outFrames.slice(preExec);
      const handAfter = (await core()).hand;
      const changed = (handAfter[wantRes] || 0) > (handBefore[wantRes] || 0) && (handAfter[giveRes] || 0) < (handBefore[giveRes] || 0);
      log("execute frames:", JSON.stringify(execFrames), "| hand changed:", changed, JSON.stringify(handAfter), "| inTrade:", JSON.stringify(inTrade.slice(0, 2)));
      if (changed) { done = true; console.log("BANK_TRADE_SOLVED " + JSON.stringify({ allFrames: outFrames, execFrames, giveRes, wantRes, tradeData: inTrade.slice(0, 2) })); }
      capOut = false; capIn = false;
      await page.keyboard.press("Escape").catch(() => {}); await sleep(400);
    }
    await ev(() => window.__catan3d.sendGameAction(6, true)); await sleep(900);
    continue;
  }
  await sleep(700);
}
console.log("BTV4_RESULT " + JSON.stringify({ done }));
try { await ctx.close(); } catch {}
process.exit(0);
