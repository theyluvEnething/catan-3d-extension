// Renders harness/dev/index.html in headless Chromium and screenshots the 3D board, for fast
// visual iteration on the diorama (no Colonist login needed).
//   node harness/dev-shot.js [outName]
import { chromium } from "playwright";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const out = path.join(__dirname, "..", "debug", "screenshots", (process.argv[2] || "dev-board") + ".png");

// Serve the whole repo over HTTP so ES module imports (extension/src/...) resolve.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const fp = path.join(ROOT, rel);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const devPage = process.argv[3] || "index.html";
const page_url = `http://localhost:${port}/harness/dev/${devPage}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url() + " :: " + (r.failure()?.errorText || "")));
page.on("response", (r) => { if (r.status() >= 400) errors.push("HTTP " + r.status() + " " + r.url()); });
await page.goto(page_url, { waitUntil: "load" });
// wait for scene ready + a few frames rendered
await page.waitForFunction(() => window.__ready === true, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log("wrote", out);
if (errors.length) { console.log("PAGE ERRORS:"); for (const e of errors.slice(0, 15)) console.log("  ", e); }
await browser.close();
server.close();
