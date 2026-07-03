// Pins the hex resource `type` enum to real resources by pairing a decoded snapshot with a
// board screenshot from the SAME game. Prints each hex's (x,y,type,dice) and saves the board
// image so the type->resource mapping can be read off directly.
import { launch, checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, { screenshotDir: SHOTS_DIR });
await sleep(5000);

const hexes = await page.evaluate(() => {
  const gs = window.__catan3d?.state;
  const hs = gs?.gameState?.mapState?.tileHexStates || {};
  return Object.entries(hs).map(([i, h]) => ({ i: Number(i), x: h.x, y: h.y, type: h.type, dice: h.diceNumber }));
});
console.log("HEXES (idx: (x,y) type dice):");
for (const h of hexes.sort((a, b) => a.i - b.i)) console.log(`  ${String(h.i).padStart(2)}: (${h.x},${h.y}) type=${h.type} dice=${h.dice}`);
const byType = {};
for (const h of hexes) (byType[h.type] = byType[h.type] || []).push(h.dice);
console.log("type -> dice numbers:", JSON.stringify(byType));

await page.screenshot({ path: path.join(SHOTS_DIR, "pin-colors-board.png") });
console.log("saved pin-colors-board.png — read colors off it against the (x,y,dice) above");
await context.close();
