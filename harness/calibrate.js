// Calibrates axial(x,y,z) -> canvas pixel. Robust strategy: place ONE setup settlement per
// launch via a coarse scan, record (cornerCoord -> clickPixel), append to
// debug/calibration-samples.json, and re-fit a SIMILARITY transform (scale+rotation+
// translation) once >=2 non-collinear samples exist. Run it 2-3 times.
//
//   node harness/calibrate.js          # one sample, then fit if enough
//   node harness/calibrate.js --reset  # clear accumulated samples first
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLES_PATH = path.join(ROOT, "debug", "calibration-samples.json");
const CAL_PATH = path.join(ROOT, "debug", "calibration.json");

export function cornerBoardXY(x, y, z) {
  const hx = Math.sqrt(3) * (x + y / 2);
  const hy = 1.5 * y;
  return [hx, hy + (z === 0 ? -0.5 : 0.5)];
}
// Least-squares similarity fit (Umeyama, 2D) from N>=2 pairs.
function fitSimilarity(pairs) {
  const n = pairs.length;
  let mbx = 0, mby = 0, mpx = 0, mpy = 0;
  for (const p of pairs) { mbx += p.bx; mby += p.by; mpx += p.px; mpy += p.py; }
  mbx /= n; mby /= n; mpx /= n; mpy /= n;
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, varB = 0;
  for (const p of pairs) {
    const bx = p.bx - mbx, by = p.by - mby, px = p.px - mpx, py = p.py - mpy;
    Sxx += px * bx; Sxy += px * by; Syx += py * bx; Syy += py * by;
    varB += bx * bx + by * by;
  }
  // Rotation from the 2x2 cross-covariance [Sxx Sxy; Syx Syy].
  const theta = Math.atan2(Syx - Sxy, Sxx + Syy);
  const s = (Math.cos(theta) * (Sxx + Syy) + Math.sin(theta) * (Syx - Sxy)) / varB;
  const cos = Math.cos(theta) * s, sin = Math.sin(theta) * s;
  const tx = mpx - (cos * mbx - sin * mby);
  const ty = mpy - (sin * mbx + cos * mby);
  return { cos, sin, tx, ty, s, theta };
}
const project = (cal, bx, by) => [cal.cos * bx - cal.sin * by + cal.tx, cal.sin * bx + cal.cos * by + cal.ty];

const reset = process.argv.includes("--reset");
let samples = [];
if (!reset && fs.existsSync(SAMPLES_PATH)) { try { samples = JSON.parse(fs.readFileSync(SAMPLES_PATH, "utf8")); } catch {} }

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, { screenshotDir: SHOTS_DIR });
await sleep(4000);

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const R = Math.min(box.width, box.height) * 0.44;
const prompt = () => page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("*")).find((e) => /place settlement|place road/i.test((e.innerText || "").trim()) && (e.innerText || "").length < 30);
  return el ? el.innerText.trim().toLowerCase() : "";
});
const owned = () => page.evaluate(() => {
  const gs = window.__catan3d?.state; const cs = gs?.gameState?.mapState?.tileCornerStates || {}; const us = gs?.us;
  return Object.entries(cs).filter(([, c]) => c && c.owner === us).map(([i]) => Number(i));
});
const coordOf = (idx) => page.evaluate((i) => {
  const c = window.__catan3d?.state?.gameState?.mapState?.tileCornerStates?.[i]; return c ? { x: c.x, y: c.y, z: c.z } : null;
}, idx);

// Wait for our settlement turn, then coarse-scan until one lands.
let got = null;
for (let w = 0; w < 60 && !/place settlement/.test(await prompt()); w++) await sleep(1000);
const before = await owned();
scan:
for (let ring = 0.1; ring <= 1.0; ring += 0.045) {
  const n = Math.max(8, Math.round(ring * 50));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const px = cx + Math.cos(a) * R * ring, py = cy + Math.sin(a) * R * ring;
    await page.mouse.click(px, py);
    await sleep(260);
    const fresh = (await owned()).find((idx) => !before.includes(idx));
    if (fresh != null) { got = { idx: fresh, px, py }; break scan; }
  }
}
if (got) {
  const c = await coordOf(got.idx);
  const [bx, by] = cornerBoardXY(c.x, c.y, c.z);
  // avoid duplicate corner samples
  if (!samples.some((s) => s.idx === got.idx && Math.abs(s.px - got.px) < 3)) {
    samples.push({ idx: got.idx, coord: c, bx, by, px: got.px, py: got.py, box });
  }
  console.log(`SAMPLE (total ${samples.length}): corner${got.idx} (${c.x},${c.y},${c.z}) <- px(${got.px.toFixed(0)},${got.py.toFixed(0)})`);
  fs.writeFileSync(SAMPLES_PATH, JSON.stringify(samples, null, 2));
} else {
  console.log("no settlement landed this run");
}

// Fit if we have >=2 non-collinear (distinct board pos) samples.
const distinct = samples.filter((s, i) => samples.findIndex((t) => t.bx === s.bx && t.by === s.by) === i);
if (distinct.length >= 2) {
  const cal = fitSimilarity(distinct);
  let err = 0; for (const s of distinct) { const [px, py] = project(cal, s.bx, s.by); err += Math.hypot(px - s.px, py - s.py); }
  console.log("SIMILARITY:", JSON.stringify(cal));
  console.log(`mean reprojection err(px): ${(err / distinct.length).toFixed(1)} over ${distinct.length} samples`);
  fs.writeFileSync(CAL_PATH, JSON.stringify({ similarity: cal, box, canvasId: "game-canvas", nSamples: distinct.length }, null, 2));
  console.log("wrote debug/calibration.json");
} else {
  console.log(`have ${distinct.length} distinct sample(s); run again to reach 2+.`);
}
await context.close();
