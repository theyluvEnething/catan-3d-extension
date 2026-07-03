// Deep probe: dismiss consent, read userState, and surface DOM signals of login state
// + the Play buttons. Writes findings to console and a screenshot.
import { launch, SHOTS_DIR } from "./launch.js";
import path from "node:path";

const context = await launch({ withExtension: false });
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

// Try to dismiss the cookie-consent modal by clicking Consent (best-effort, multiple strategies).
const consentClicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, a, div[role=button]"));
  const target = btns.find((b) => /^(consent|accept|agree|got it|i agree)$/i.test((b.innerText || "").trim()));
  if (target) { target.click(); return target.innerText.trim(); }
  return null;
});
await page.waitForTimeout(1500);

const probe = await page.evaluate(() => {
  let userState = null;
  try { userState = JSON.parse(localStorage.getItem("userState")); } catch { userState = localStorage.getItem("userState"); }
  const btns = Array.from(document.querySelectorAll("button, a, div[role=button]"))
    .map((b) => ({ t: (b.innerText || "").trim(), cls: b.className, id: b.id }))
    .filter((b) => b.t && b.t.length < 40);
  return {
    userState,
    userStateType: typeof userState,
    buttons: btns.slice(0, 40),
    title: document.title,
  };
});

console.log("CONSENT_CLICKED", consentClicked);
console.log("PROBE", JSON.stringify(probe, null, 2));
await page.screenshot({ path: path.join(SHOTS_DIR, "probe.png") });
await context.close();
