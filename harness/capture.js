// Frame capture harness.
//
// Two independent capture channels, so we can cross-check them:
//   (A) Playwright's native WebSocket CDP API (page.on('websocket')) — authoritative,
//       captures raw frames regardless of our extension.
//   (B) Our extension's in-page bridge (CATAN3D_HARNESS_FRAME CustomEvent) — proves the
//       interceptor works end-to-end.
//
// Every frame is written to debug/frames/ as JSONL plus raw payloads, tagged by direction,
// timestamp, and whether it was text or binary (base64).
//
// Usage:
//   node harness/capture.js               # launch, start a bot game, capture until Ctrl+C
//   node harness/capture.js --no-start    # launch & capture but don't auto-start a game
import { launch, checkLogin, FRAMES_DIR, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import fs from "node:fs";
import path from "node:path";

const NO_START = process.argv.includes("--no-start");

function tsSlug() {
  // Date.now is fine in Node (this is the harness, not a workflow script).
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

const runDir = path.join(FRAMES_DIR, tsSlug());
fs.mkdirSync(runDir, { recursive: true });
const jsonlPath = path.join(runDir, "frames.jsonl");
const jsonl = fs.createWriteStream(jsonlPath, { flags: "a" });
console.log("CAPTURE_DIR", runDir);

let count = { in: 0, out: 0, cdp: 0, bridge: 0 };

function record(rec) {
  jsonl.write(JSON.stringify(rec) + "\n");
}

const context = await launch({ withExtension: true });
const page = context.pages()[0] || (await context.newPage());

// --- Channel A: CDP-level WebSocket frames ---
page.on("websocket", (ws) => {
  const url = ws.url();
  record({ evt: "ws_open", url, t: Date.now() });
  console.log("WS_OPEN", url);
  ws.on("framesent", (f) => {
    const payload = f.payload; // string or Buffer
    const isBuf = Buffer.isBuffer(payload);
    count.out++; count.cdp++;
    record({
      ch: "cdp", dir: "out", t: Date.now(), url,
      kind: isBuf ? "binary" : "text",
      ...(isBuf ? { b64: payload.toString("base64"), byteLength: payload.length } : { text: payload }),
    });
  });
  ws.on("framereceived", (f) => {
    const payload = f.payload;
    const isBuf = Buffer.isBuffer(payload);
    count.in++; count.cdp++;
    record({
      ch: "cdp", dir: "in", t: Date.now(), url,
      kind: isBuf ? "binary" : "text",
      ...(isBuf ? { b64: payload.toString("base64"), byteLength: payload.length } : { text: payload }),
    });
  });
  ws.on("close", () => record({ evt: "ws_close", url, t: Date.now() }));
});

// --- Channel B: extension bridge frames (proves interceptor works) ---
await page.exposeFunction("__catan3dHarnessSink", (msg) => {
  count.bridge++;
  record({ ch: "bridge", ...msg });
});
// Inject a listener in every frame/navigation that forwards bridge CustomEvents to Node.
await page.addInitScript(() => {
  window.addEventListener("CATAN3D_HARNESS_FRAME", (e) => {
    try { window.__catan3dHarnessSink(e.detail); } catch {}
  });
});

// Navigate + verify login.
const { loggedIn, evidence } = await checkLogin(page);
console.log("LOGIN", JSON.stringify({ loggedIn, evidence }));
if (!loggedIn) {
  console.error("\n⛔ NOT LOGGED IN. Run: node harness/login-once.js  then retry.\n");
  await page.screenshot({ path: path.join(SHOTS_DIR, "capture-not-logged-in.png") });
  await context.close();
  process.exit(2);
}

await dismissConsent(page);

if (!NO_START) {
  console.log("Starting bot game…");
  const started = await startBotGame(page, { screenshotDir: SHOTS_DIR });
  console.log("START_RESULT", JSON.stringify(started));
}

// Periodic status + keep-alive. Ctrl+C to stop; flush counts.
const statusTimer = setInterval(() => {
  console.log("COUNTS", JSON.stringify(count), "->", jsonlPath);
}, 5000);

async function shutdown() {
  clearInterval(statusTimer);
  console.log("FINAL_COUNTS", JSON.stringify(count));
  jsonl.end();
  try { await page.screenshot({ path: path.join(SHOTS_DIR, "capture-final.png") }); } catch {}
  await context.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Safety auto-stop after a long session so we never hang forever in CI-like runs.
const MAX_MS = Number(process.env.CAPTURE_MAX_MS || 15 * 60 * 1000);
setTimeout(shutdown, MAX_MS);
