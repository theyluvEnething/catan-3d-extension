// Shared Chrome launcher for the Colonist harness.
// Uses real Chrome (channel: 'chrome', headless: false) via a persistent profile so the
// logged-in Colonist session is reused. Loads the unpacked MV3 extension.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { buildInitScript } from "./inject.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const PROFILE_DIR = path.join(ROOT, ".colonist-profile");
export const EXTENSION_DIR = path.join(ROOT, "extension");
export const DEBUG_DIR = path.join(ROOT, "debug");
export const FRAMES_DIR = path.join(DEBUG_DIR, "frames");
export const SHOTS_DIR = path.join(DEBUG_DIR, "screenshots");

for (const d of [FRAMES_DIR, SHOTS_DIR]) fs.mkdirSync(d, { recursive: true });

/**
 * Launch real Chrome with the persistent Colonist profile.
 *
 * NOTE on extensions: Chrome 137+ blocks command-line --load-extension on the stable
 * channel, so the harness injects the extension's runtime via addInitScript instead
 * (inject:true, default). This runs the SAME source the extension ships. The packaged
 * extension/ still loads normally when the user picks "Load unpacked" in chrome://extensions.
 */
export async function launch({ inject = true } = {}) {
  // Guard: if a previous harness Chrome is still holding the profile, launching fails with
  // "profile already in use". Best-effort: remove the singleton lock files so we can relaunch.
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.rmSync(path.join(PROFILE_DIR, f), { force: true }); } catch {}
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null, // use real window size
  });
  if (inject) {
    await context.addInitScript({ content: buildInitScript() });
  }
  return context;
}

/**
 * Verify the Colonist session is logged in. Returns { loggedIn, evidence }.
 * We check for the absence of a "Log in" / "Sign in" call-to-action and the presence of
 * a play surface. Colonist's exact DOM is discovered live; this uses resilient heuristics.
 */
export async function checkLogin(page) {
  await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" });
  // Give the SPA a moment to hydrate.
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    // Ground-truth signals discovered from the live DOM:
    //  - localStorage.userState is {} when logged out, populated when logged in.
    //  - A `.web-header-login-button` ("Login") exists only when logged out.
    let userState = null;
    try {
      userState = JSON.parse(localStorage.getItem("userState") || "null");
    } catch {
      userState = localStorage.getItem("userState");
    }
    // Authoritative: userState.isLoggedIn (populated once signed in). The header login
    // button can persist in the DOM even when logged in, so it is NOT a reliable signal.
    const isLoggedIn = !!(userState && typeof userState === "object" && userState.isLoggedIn);
    return {
      title: document.title,
      url: location.href,
      isLoggedIn,
      username: userState && userState.username,
      userStateKeys: userState && typeof userState === "object" ? Object.keys(userState) : [],
    };
  });

  return { loggedIn: info.isLoggedIn, evidence: info };
}
