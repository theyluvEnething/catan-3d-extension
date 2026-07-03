// Probes the in-game DOM during a "Place Settlement" prompt to discover HOW placement is
// done: are legal spots DOM elements (clickable), or pure-canvas hit-testing? Also dumps the
// canvas list and any elements that look like piece hotspots.
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

// Wait until it's our placement turn.
for (let i = 0; i < 30; i++) {
  const p = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find((e) => /place settlement/i.test((e.innerText || "").trim()) && (e.innerText || "").length < 30);
    return el ? el.innerText.trim() : "";
  });
  if (/place settlement/i.test(p)) break;
  await sleep(1000);
}

const info = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll("canvas")).map((c) => ({
    w: c.width, h: c.height, cls: c.className, id: c.id,
    ctx: (() => { try { return c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl" : "2d?"; } catch { return "?"; } })(),
  }));
  // Look for candidate hotspot elements (small, many, positioned) over the board.
  const all = Array.from(document.querySelectorAll("div,button,span,img,svg,use"));
  const hotspots = all.filter((e) => {
    const r = e.getBoundingClientRect();
    const cls = (e.className || "").toString();
    return (r.width > 4 && r.width < 60 && r.height > 4 && r.height < 60) &&
      /hotspot|spot|node|corner|edge|vertex|placeable|build|hex|tile|intersection/i.test(cls);
  }).slice(0, 20).map((e) => ({ tag: e.tagName, cls: (e.className || "").toString().slice(0, 60), r: e.getBoundingClientRect() }));
  // Class-name frequency for elements overlapping the board center.
  const classes = {};
  for (const e of all) {
    const cls = (e.className || "").toString();
    if (cls) for (const c of cls.split(/\s+/)) classes[c] = (classes[c] || 0) + 1;
  }
  const topClasses = Object.entries(classes).filter(([c]) => /spot|node|corner|edge|vertex|place|build|hex|tile/i.test(c)).sort((a, b) => b[1] - a[1]).slice(0, 20);
  return { canvases, hotspots, topClasses };
});
console.log("CANVASES:", JSON.stringify(info.canvases, null, 2));
console.log("HOTSPOTS:", JSON.stringify(info.hotspots, null, 2));
console.log("BUILD-ish CLASSES:", JSON.stringify(info.topClasses, null, 2));
await page.screenshot({ path: path.join(SHOTS_DIR, "probe-ingame.png") });
await context.close();
