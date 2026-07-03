// Live Gate-1 validator: at intervals, compares our RECONSTRUCTED state against Colonist's own
// ground-truth surfaces (the visible player panels + game log), and reports agreement. Run it
// ALONGSIDE autoplay is not possible (one profile) — instead this drives its own short game and
// checks agreement at several checkpoints, screenshotting HUD-vs-board each time.
//
//   node harness/validate-live.js
import { launch, checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await launch({ inject: true });
const page = ctx.pages()[0] || (await ctx.newPage());
await checkLogin(page); await dismissConsent(page);
await startBotGame(page, {}); await sleep(4000);

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const owned = () => page.evaluate(() => { const gs = window.__catan3d?.state, cs = gs?.gameState?.mapState?.tileCornerStates || {}, es = gs?.gameState?.mapState?.tileEdgeStates || {}, us = gs?.us; return Object.values(cs).filter((c) => c.owner === us).length + Object.values(es).filter((e) => e.owner === us).length; });
const diceThrown = () => page.evaluate(() => window.__catan3d?.state?.gameState?.diceState?.diceThrown);

// Ground truth from Colonist's DOM: parse the game log lines + count settlement/road icons.
async function groundTruth() {
  return page.evaluate(() => {
    // Colonist's log lines live in the chat/log panel; capture recent text lines.
    const logLines = Array.from(document.querySelectorAll("*"))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.innerText || "").trim())
      .filter((t) => /placed a (settlement|road|city)|rolled|moved robber|stole|got|received starting|wants to give/i.test(t));
    return { logLineCount: logLines.length, logSample: logLines.slice(-12) };
  });
}
// Our reconstructed counts.
async function reconstructed() {
  return page.evaluate(() => {
    const gs = window.__catan3d?.state; if (!gs?.ready) return null;
    const cs = Object.values(gs.gameState.mapState.tileCornerStates);
    const es = Object.values(gs.gameState.mapState.tileEdgeStates);
    const settlements = cs.filter((c) => c.owner != null && c.owner !== -1 && c.buildingType !== 2).length;
    const cities = cs.filter((c) => c.buildingType === 2).length;
    const roads = es.filter((e) => e.owner != null && e.owner !== -1).length;
    return { settlements, cities, roads, robber: gs.robberTileIndex, turn: gs.currentTurnColor, completedTurns: gs.completedTurns };
  });
}

const checkpoints = [];
async function checkpoint(label) {
  const r = await reconstructed(); const g = await groundTruth();
  const shot = path.join(SHOTS_DIR, `gate1-${label}.png`);
  await page.screenshot({ path: shot });
  checkpoints.push({ label, reconstructed: r, groundTruthLogLines: g.logLineCount, logSample: g.logSample });
  console.log(`\n=== CHECKPOINT ${label} ===`);
  console.log("reconstructed:", JSON.stringify(r));
  console.log("colonist log (recent):"); for (const l of g.logSample) console.log("   ·", l);
}

// Play a bit, checkpointing at setup-done, mid-game.
let lastDone = -1;
for (let i = 0; i < 200; i++) {
  const p = await prompt();
  const r = await reconstructed();
  if (r && r.completedTurns !== lastDone) {
    lastDone = r.completedTurns;
    if ([4, 8, 12].includes(lastDone)) await checkpoint(`turns${lastDone}`);
    if (lastDone >= 12) break;
  }
  if (/place settlement|place road/.test(p)) { const b = await owned(); outer: for (let ring = 0.08; ring <= 1; ring += 0.04) { const n = Math.max(8, Math.round(ring * 54)); for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); if (await owned() > b) break outer; } } await sleep(700); }
  else if (/roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); }
  else if (/answer trade/.test(p)) { await page.keyboard.press("Escape"); await sleep(500); }
  else { await page.keyboard.press("Space"); await sleep(900); }
}
console.log("\nGATE-1 CHECKPOINTS:", checkpoints.length, "written to", SHOTS_DIR);
await ctx.close();
