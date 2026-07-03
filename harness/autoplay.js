// Full-game auto-player for Gate-1 capture. Drives a complete bot game by:
//   - reading the reconstructed state to know the current context (place settlement/road/city,
//     move robber, roll, discard, end turn),
//   - computing candidate target pixels via the board geometry + a center/scale calibration,
//   - clicking the best LEGAL candidate, verifying via a state change, retrying nearby on miss.
// Colonist validates every move server-side and snaps clicks to the nearest legal spot, so the
// auto-player is intentionally tolerant: it tries ranked candidates until the state advances.
//
//   node harness/autoplay.js
import { launch, checkLogin, SHOTS_DIR, FRAMES_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { hexCenter, cornerPosExact, edgePos } from "../extension/src/render/boardGeometry.js";
import { legalSettlementCorners, legalRoadEdges, legalRobberHexes } from "./legal.js";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tsSlug() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

const runDir = path.join(FRAMES_DIR, tsSlug() + "-fullgame");
fs.mkdirSync(runDir, { recursive: true });
const jsonl = fs.createWriteStream(path.join(runDir, "frames.jsonl"), { flags: "a" });
let frameCount = 0;

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
page.on("websocket", (ws) => {
  const url = ws.url();
  ws.on("framesent", (f) => rec("out", f.payload, url));
  ws.on("framereceived", (f) => rec("in", f.payload, url));
});
function rec(dir, payload, url) {
  const isBuf = Buffer.isBuffer(payload); frameCount++;
  jsonl.write(JSON.stringify({ ch: "cdp", dir, t: Date.now(), url, kind: isBuf ? "binary" : "text", ...(isBuf ? { b64: payload.toString("base64") } : { text: payload }) }) + "\n");
}

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("NOT LOGGED IN"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, { screenshotDir: SHOTS_DIR });
await sleep(4000);

const box = await (await page.$("#game-canvas")).boundingBox();
console.log("CAPTURE_DIR", runDir, "canvas", JSON.stringify(box));

// ---- calibration: center anchor + scale-from-geometry (refined by click retries) ----
// From calibration samples, board center (0,0) ~ canvas center; derive scale so the axial
// extent fills ~82% of the canvas. Rotation ~0 (Colonist board is axis-aligned pointy-top).
function buildCalibration(state) {
  const hs = state.hexes;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const h of hs) { const c = hexCenter(h.x, h.y); minU = Math.min(minU, c.u); maxU = Math.max(maxU, c.u); minV = Math.min(minV, c.v); maxV = Math.max(maxV, c.v); }
  const spanU = maxU - minU, spanV = maxV - minV;
  const scale = Math.min((box.width * 0.80) / spanU, (box.height * 0.80) / spanV);
  const midU = (minU + maxU) / 2, midV = (minV + maxV) / 2;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // pixel = center + scale * (boardPoint - mid). y grows downward on screen -> flip v.
  return { toPx: (u, v) => [cx + (u - midU) * scale, cy + (v - midV) * scale] };
}

const stateSnap = () => page.evaluate(() => {
  const gs = window.__catan3d?.state; if (!gs?.ready) return null;
  return {
    us: gs.us, turn: gs.currentTurnColor, actionState: gs.actionState, turnState: gs.turnState,
    completedTurns: gs.completedTurns, robber: gs.robberTileIndex,
    hexes: Object.values(gs.gameState.mapState.tileHexStates),
    corners: gs.gameState.mapState.tileCornerStates,
    edges: gs.gameState.mapState.tileEdgeStates,
    diceThrown: gs.gameState.diceState?.diceThrown,
    winner: gs.gameState.currentState?.winner ?? gs.gameState.gameOver ?? null,
    playerStates: gs.gameState.playerStates,
  };
});
// The in-game action prompt lives in the bottom action bar: [class^=messageContainer].
const promptText = () => page.evaluate(() => {
  const el = document.querySelector('[class*="messageContainer"]');
  return el ? (el.innerText || "").trim() : "";
});
// Dismiss the "daily free roll" / reward popups that block the board at game start.
async function dismissPopups() {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button,div[role=button],[class*=close],[class*=Close]"));
    const b = btns.find((e) => /^(collect|claim|ok|close|continue|no thanks|skip)$/i.test((e.innerText || "").trim()) && e.getBoundingClientRect().width > 0);
    if (b) { b.click(); return (b.innerText || "").trim(); }
    return null;
  });
}
async function clickBtn(re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, "i");
    const el = Array.from(document.querySelectorAll("button,div,span,img")).find((e) => rx.test((e.innerText || e.getAttribute?.("aria-label") || "").trim()) && (e.getBoundingClientRect().width > 0));
    if (el) { el.click(); return true; } return false;
  }, re.source);
}

// Ownership snapshot for change-detection.
const ownedCount = (s) => {
  const cs = Object.values(s.corners).filter((c) => c.owner === s.us).length;
  const es = Object.values(s.edges).filter((e) => e.owner === s.us).length;
  return cs + es;
};

// Try clicking a ranked list of board-space targets until `changed()` becomes true.
async function clickTargets(cal, targets, changed, label) {
  for (const t of targets) {
    const [px, py] = cal.toPx(t.u, t.v);
    for (const [dx, dy] of [[0, 0], [0, -6], [6, 0], [0, 6], [-6, 0], [8, -8]]) {
      await page.mouse.move(px + dx, py + dy);
      await page.mouse.click(px + dx, py + dy);
      await sleep(200);
      if (await changed()) { console.log(`  ${label} OK @(${Math.round(px)},${Math.round(py)})`); return true; }
    }
  }
  return false;
}

// Reliable fallback: spiral-scan the whole board canvas, clicking until `changed()`.
// Colonist snaps to the nearest legal spot, so a dense scan always lands SOMETHING legal.
// (Used for Gate-1 full-game capture; precise calibration is a Phase-3 concern.)
async function scanClick(changed, label) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const R = Math.min(box.width, box.height) * 0.46;
  for (let ring = 0.08; ring <= 1.0; ring += 0.04) {
    const n = Math.max(8, Math.round(ring * 54));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring; // rotate each ring so points don't align radially
      const px = cx + Math.cos(a) * R * ring, py = cy + Math.sin(a) * R * ring;
      await page.mouse.click(px, py);
      await sleep(150);
      if (await changed()) { console.log(`  ${label} scan-OK @(${Math.round(px)},${Math.round(py)})`); return { px, py }; }
    }
  }
  console.log(`  ${label}: scan found nothing`);
  return null;
}

let cal = null;
let steps = 0, lastLog = "";
const t0 = Date.now();
while (steps++ < 2000) {
  const s = await stateSnap();
  if (!s) { await sleep(800); continue; }
  if (!cal) cal = buildCalibration(s);

  const popup = await dismissPopups();
  if (popup) { console.log("  dismissed popup:", popup); await sleep(500); continue; }
  const p = (await promptText()).toLowerCase();
  const line = `${p} | turn=${s.turn} us=${s.us} act=${s.actionState} done=${s.completedTurns} f=${frameCount}`;
  if (line !== lastLog) { console.log("STEP", line); lastLog = line; }

  if (s.winner != null || /won|game over|victory|winner/i.test(p)) { console.log("GAME OVER winner=", s.winner); break; }
  if (Date.now() - t0 > 14 * 60 * 1000) { console.log("time cap"); break; }

  // Trade answers can arrive on OTHER players' turns — handle before the turn-gate.
  if (/answer trade|respond|trade offer|accept.*decline/.test(p)) {
    // The offer's response row (top trade panel) is [pencil][X decline][✓ accept]. We want the
    // MIDDLE "decline" (X) button. Find the 3-button action row and click the middle one.
    const rejected = await page.evaluate(() => {
      // action buttons are small square pointer elements around y150-175, x>1200.
      const btns = Array.from(document.querySelectorAll("*")).filter((e) => {
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return cs.cursor === "pointer" && r.width > 20 && r.width < 60 && r.height > 20 && r.height < 60 && r.y > 130 && r.y < 200 && r.x > 1180;
      });
      // dedupe by x, sort left->right; the decline X is the middle of the 3.
      const uniq = []; const seenX = new Set();
      for (const b of btns.sort((a, z) => a.getBoundingClientRect().x - z.getBoundingClientRect().x)) {
        const x = Math.round(b.getBoundingClientRect().x / 10);
        if (!seenX.has(x)) { seenX.add(x); uniq.push(b); }
      }
      if (uniq.length >= 2) { uniq[uniq.length - 2].click(); return uniq.length; } // 2nd from right = decline
      if (uniq.length === 1) { uniq[0].click(); return 1; }
      return 0;
    });
    if (!rejected) await page.keyboard.press("Escape");
    await sleep(700); continue;
  }
  if (/discard/.test(p)) {
    // On a 7, if we hold >7 cards we must discard floor(n/2). The discard UI shows our cards
    // (bottom bar, .cardContainer). Click cards until the confirm/discard button enables, then
    // confirm. Best-effort: click several cards, then press the discard button / Space.
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="cardContainer"]')).filter((e) => e.getBoundingClientRect().y > 780);
      // click roughly half of them
      const k = Math.max(1, Math.floor(cards.length / 2));
      for (let i = 0; i < k && i < cards.length; i++) cards[i].click();
    });
    await sleep(500);
    await clickBtn(/discard|confirm|ok/);
    await page.keyboard.press("Space");
    await sleep(1000); continue;
  }

  // Only act on OUR turn/prompts otherwise.
  const myPrompt = /place settlement|place road|place city|move robber|roll|end turn|your turn|build/.test(p);
  if (!myPrompt || s.turn !== s.us) { await sleep(1200); continue; }

  // Our main turn with dice already thrown and no placement prompt -> just end the turn.
  if (s.turn === s.us && s.diceThrown && !/place|move robber|roll/.test(p)) {
    await page.keyboard.press("Space"); await sleep(700);
    await clickBtn(/end turn|pass/); await sleep(900); continue;
  }
  if (/roll/.test(p)) {
    // Spacebar = Colonist's roll-dice shortcut (verified).
    await page.keyboard.press("Space"); await sleep(1300);
    if (!(await stateSnap())?.diceThrown) { await page.keyboard.press("Space"); await sleep(1200); }
    continue;
  }

  if (/place settlement/.test(p)) {
    const before = ownedCount(s);
    const changed = async () => { const n = await stateSnap(); return n && ownedCount(n) > before; };
    await scanClick(changed, "settlement");
    await sleep(700); continue;
  }
  if (/place road/.test(p)) {
    const before = ownedCount(s);
    const changed = async () => { const n = await stateSnap(); return n && ownedCount(n) > before; };
    await scanClick(changed, "road");
    await sleep(700); continue;
  }
  if (/place city/.test(p)) {
    const before = JSON.stringify(s.corners);
    const changed = async () => { const n = await stateSnap(); return n && JSON.stringify(n.corners) !== before; };
    await scanClick(changed, "city"); await sleep(700); continue;
  }
  if (/move robber/.test(p)) {
    const before = s.robber;
    const changed = async () => { const n = await stateSnap(); return n && n.robber !== before; };
    await scanClick(changed, "robber"); await sleep(900);
    await clickBtn(/steal|ok|confirm/); await sleep(600); continue;
  }
  if (/end turn|pass/.test(p)) {
    // Spacebar also confirms/ends turn in Colonist.
    await page.keyboard.press("Space"); await sleep(900);
    await clickBtn(/end turn|pass/); await sleep(600); continue;
  }

  await sleep(1000);
}

await page.screenshot({ path: path.join(runDir, "final.png") });
console.log("FINAL frames:", frameCount, "steps:", steps, "dir:", runDir);
jsonl.end(); await sleep(500); await context.close();
