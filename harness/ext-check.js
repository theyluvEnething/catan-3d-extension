// Verifies the injected runtime works end-to-end: WebSocket patched (MAIN world),
// decoder + state model live, HUD element present, and a readable state snapshot that
// matches a started game. Screenshots the HUD over the live board.
import { launch, checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
page.on("console", (m) => { const t = m.text(); if (/catan3d/i.test(t)) console.log("PAGE>", t); });

const { loggedIn } = await checkLogin(page);
console.log("loggedIn:", loggedIn);
await dismissConsent(page);

const patched = await page.evaluate(() => ({
  wsName: window.WebSocket && window.WebSocket.name,
  installed: !!(window.__catan3d && window.__catan3d.__installed),
}));
console.log("runtime:", JSON.stringify(patched));

await startBotGame(page, { screenshotDir: SHOTS_DIR });
await sleep(5000);

const hud = await page.evaluate(() => {
  const el = document.getElementById("catan3d-hud");
  return el ? { present: true } : { present: false };
});
const snap = await page.evaluate(() => window.__catan3d && window.__catan3d.snapshot && window.__catan3d.snapshot());
console.log("HUD present:", hud.present);
console.log("STATE snapshot:", JSON.stringify(snap, null, 2));
await page.screenshot({ path: path.join(SHOTS_DIR, "ext-check-hud.png") });
await context.close();
