// Reaches an "Answer Trade" state and dumps the exact reject-button selector.
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
const turnOf = () => page.evaluate(() => window.__catan3d?.state?.currentTurnColor);
const us = () => page.evaluate(() => window.__catan3d?.state?.us);

for (let i = 0; i < 120; i++) {
  const p = await prompt();
  if (/answer trade/.test(p)) {
    console.log("REACHED answer trade");
    const dump = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll("*")) {
        const r = e.getBoundingClientRect();
        if (r.width < 6 || r.width > 100 || r.y > 300 || r.x < 900) continue;
        const cs = getComputedStyle(e);
        const red = cs.backgroundColor.includes("rgb") && /(\d+),\s*(\d+),\s*(\d+)/.test(cs.backgroundColor);
        out.push({ cls: (e.className || "").toString().slice(0, 45), bg: cs.backgroundColor, cursor: cs.cursor, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) });
      }
      return out.filter((e) => e.cursor === "pointer" || /red|reject|response|answer/i.test(e.cls));
    });
    console.log(JSON.stringify(dump, null, 1));
    await page.screenshot({ path: path.join(SHOTS_DIR, "probe-trade.png") });
    break;
  }
  // advance play: setup placement via scan; roll via space; trades: click any pointer red at top
  if (/place settlement|place road/.test(p)) { const b = await owned(); outer: for (let ring = 0.08; ring <= 1; ring += 0.04) { const n = Math.max(8, Math.round(ring * 54)); for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); if (await owned() > b) break outer; } } await sleep(700); }
  else if (/roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); }
  else if (await turnOf() === await us() && await diceThrown()) { await page.keyboard.press("Space"); await sleep(700); }
  else await sleep(1000);
}
await ctx.close();
