// probe-hud.js — one-shot capture to nail (a) the game DOM layout and (b) the exact state
// tree shape for the HUD rebuild (players, resources, dev cards, bank, awards).
//
//   node harness/probe-hud.js
//
// Opens Colonist in your logged-in profile. START or JOIN a game, then PLAY normally —
// ideally buy a dev card and play one (knight / monopoly / etc.) so we capture those shapes.
// It writes:
//   debug/hud/dom-layout.json     geometry of #game-canvas vs. side panel vs. bottom tray
//   debug/hud/snapshot.json       the latest full gameState snapshot (type 4)
//   debug/hud/diffs.jsonl         every incremental diff (type 91) as it arrives
//   debug/hud/devcard-events.jsonl  diffs that touch dev-card / resource / award state
// Press Enter in the terminal to stop and flush.
import { launch } from "./launch.js";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./launch.js";

const OUT = path.join(ROOT, "debug", "hud");
fs.mkdirSync(OUT, { recursive: true });

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" });

console.log("\n=== Colonist is open. Start/join a game and play a few turns. ===");
console.log("Try to BUY a dev card and PLAY one so we capture those shapes.");
console.log("Press Enter here when done to save everything.\n");

// Stream frames out of the page. The injected runtime dispatches CATAN3D_HARNESS_FRAME.
await page.exposeFunction("__hudSink", (payload) => {
  try {
    const msg = JSON.parse(payload);
    if (msg.kind === "snapshot") {
      fs.writeFileSync(path.join(OUT, "snapshot.json"), JSON.stringify(msg.state, null, 2));
      console.log("  · snapshot captured (players:", Object.keys(msg.state?.playerStates || {}).join(","), ")");
    } else if (msg.kind === "diff") {
      fs.appendFileSync(path.join(OUT, "diffs.jsonl"), JSON.stringify(msg.diff) + "\n");
      // Flag dev-card / resource / award touching diffs.
      const d = msg.diff || {};
      const touches = d.mechanicDevelopmentCardsState || d.mechanicLargestArmyState ||
        d.bankState || Object.values(d.playerStates || {}).some((p) => p && p.resourceCards);
      if (touches) {
        fs.appendFileSync(path.join(OUT, "devcard-events.jsonl"), JSON.stringify(d) + "\n");
        const keys = [];
        if (d.mechanicDevelopmentCardsState) keys.push("dev");
        if (d.mechanicLargestArmyState) keys.push("army");
        if (d.bankState) keys.push("bank");
        if (d.playerStates) keys.push("players");
        console.log("  · dev/resource event:", keys.join("+"));
      }
    }
  } catch (e) { console.warn("sink err", e.message); }
});

// Bridge the injected state model to our sink, and grab DOM layout on demand.
await page.evaluate(() => {
  const send = (o) => window.__hudSink(JSON.stringify(o));
  const hook = () => {
    const gs = window.__catan3d && window.__catan3d.state;
    if (!gs || !gs.subscribe) return false;
    // initial (if snapshot already present)
    if (gs.gameState) send({ kind: "snapshot", state: gs.gameState });
    gs.subscribe((s, evt) => {
      if (evt?.kind === "snapshot") send({ kind: "snapshot", state: s.gameState });
      else if (evt?.kind === "diff") send({ kind: "diff", diff: evt.diff });
    });
    return true;
  };
  if (!hook()) {
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 500);
  }
});

// Snapshot the DOM geometry now and also on Enter (layout may differ pre/in game).
async function grabLayout(tag) {
  const layout = await page.evaluate(() => {
    const pick = (el) => el ? (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, id: el.id, cls: el.className?.toString?.().slice(0, 120) }; })() : null;
    const canvas = document.getElementById("game-canvas");
    // Heuristics for the side panel + bottom tray: find big fixed/absolute containers to the
    // right of and below the canvas. Dump the top-level children of body/#root for mapping.
    const root = document.getElementById("root") || document.body;
    const kids = [...root.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { tag: c.tagName, id: c.id, cls: c.className?.toString?.().slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    // Any element whose id/class hints at the player list / cards / bank.
    const hints = [...document.querySelectorAll("[class*='player'],[class*='Player'],[class*='card'],[class*='Card'],[class*='bank'],[class*='Bank'],[id*='action'],[class*='hand'],[class*='Hand']")]
      .slice(0, 60).map((e) => { const r = e.getBoundingClientRect(); return { tag: e.tagName, id: e.id, cls: e.className?.toString?.().slice(0, 100), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((e) => e.w > 10 && e.h > 10);
    return {
      window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      gameCanvas: pick(canvas),
      canvasAttrs: canvas ? { width: canvas.width, height: canvas.height, style: canvas.getAttribute("style") } : null,
      rootChildren: kids,
      hints,
    };
  });
  fs.writeFileSync(path.join(OUT, `dom-layout${tag}.json`), JSON.stringify(layout, null, 2));
  console.log(`  · DOM layout captured (${tag || "now"}) — canvas:`, layout.gameCanvas);
}
await grabLayout("-initial");

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Playing… press Enter to capture final layout + stop. ", () => { rl.close(); resolve(); });
});
await grabLayout("");
console.log("\n✅ Saved to debug/hud/. Snapshot + diffs + dev-card events + DOM layout.");
await context.close();
