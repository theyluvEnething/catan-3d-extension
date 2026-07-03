// Starts a Solo-vs-bots game by clicking through Colonist's live UI.
//
// The deep flow (create room -> add bots -> start) is DISCOVERED, not assumed: at each step
// we log the visible/clickable buttons so the real labels drive the next click. Known-stable
// selectors found from the live DOM are used where we have them:
//   #landingpage_cta_playwithfriends , #landingpage_cta_playonline , .web-sidebar-play
//
// Exports:
//   dismissConsent(page)                 - best-effort dismissal of the GDPR consent modal
//   startBotGame(page, {screenshotDir})  - drives the vs-bots flow, returns a report
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listClickables(page) {
  return page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll("button, a, [role=button], .btn, [class*=button], [class*=cta]")
    );
    const seen = new Set();
    const out = [];
    for (const el of els) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue; // skip hidden
      const key = t + "|" + el.id + "|" + el.className;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ t: t.slice(0, 50), id: el.id, cls: (el.className || "").toString().slice(0, 80) });
    }
    return out.slice(0, 60);
  });
}

// Click the first element whose visible text matches `re`, or an explicit selector list.
async function clickByText(page, re, { selectors = [] } = {}) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      const box = await el.boundingBox();
      if (box) { await el.click().catch(() => {}); return { via: "selector", sel }; }
    }
  }
  const handle = await page.evaluateHandle((src) => {
    const rx = new RegExp(src, "i");
    const els = Array.from(document.querySelectorAll("button, a, [role=button], div, span"));
    return els.find((el) => {
      const t = (el.innerText || "").trim();
      const rect = el.getBoundingClientRect();
      return t && rx.test(t) && rect.width > 0 && rect.height > 0 && t.length < 40;
    }) || null;
  }, re.source);
  const elem = handle.asElement();
  if (elem) {
    await elem.scrollIntoViewIfNeeded().catch(() => {});
    await elem.click().catch(() => {});
    return { via: "text", re: re.source };
  }
  return null;
}

export async function dismissConsent(page) {
  // The consent modal (Quantcast/GDPR) may be in the main doc or an iframe. Try both.
  const tryClick = async (frame) => {
    return frame.evaluate(() => {
      const cands = Array.from(document.querySelectorAll("button, a, [role=button]"));
      const t = cands.find((b) =>
        /^(consent|accept all|accept|agree|i agree|got it|ok)$/i.test((b.innerText || "").trim())
      );
      if (t) { t.click(); return (t.innerText || "").trim(); }
      return null;
    }).catch(() => null);
  };

  let clicked = await tryClick(page.mainFrame());
  if (!clicked) {
    for (const f of page.frames()) {
      clicked = await tryClick(f);
      if (clicked) break;
    }
  }
  if (clicked) await sleep(800);
  return clicked;
}

export async function startBotGame(page, { screenshotDir } = {}) {
  const report = { steps: [] };
  const shot = async (name) => {
    if (screenshotDir) {
      const p = path.join(screenshotDir, `start-${name}.png`);
      await page.screenshot({ path: p }).catch(() => {});
      report.steps.push({ shot: p });
    }
  };
  const snap = async (label) => {
    const c = await listClickables(page);
    report.steps.push({ label, clickables: c });
    console.log(`\n[start:${label}] clickables:`);
    for (const b of c) console.log("   ", JSON.stringify(b));
  };

  await dismissConsent(page);
  await snap("landing");
  await shot("landing");

  // The "Play vs. Bots" mode picker is on the landing page itself (sidebar "Play" is active
  // by default). Discovered stable IDs:
  //   .mm-mode-card                -> the mode card (title "Play vs. Bots")
  //   #mm-mode-card-button         -> "Start Game" on the collapsed card
  //   #mm-details-play-button      -> "Start Game" on the expanded details view
  // Either button starts the game; #mm-mode-card-button on the landing is the direct path.

  // Ensure the vs-bots card is the selected one (there may be multiple mode cards).
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".mm-mode-card"));
    const card = cards.find((c) => /play vs\.? bots/i.test(c.innerText || ""));
    if (card && !card.classList.contains("selected")) card.click();
  }).catch(() => {});
  await sleep(400);

  // Keep Easy difficulty (default) for fast deterministic games.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#mm-bot-difficulty-segmented-control button"))
      .find((b) => /easy/i.test(b.innerText || ""));
    if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click();
  }).catch(() => {});

  // Click the exact "Start Game" button using Playwright's REAL (trusted) click — React
  // ignores programmatic element.click() for this CTA. The big orange bottom CTA is
  // #mm-details-play-button; #mm-mode-card-button is the fallback inline button.
  let startClick = null;
  for (const sel of ["#mm-details-play-button", "#mm-mode-card-button"]) {
    const el = await page.$(sel);
    if (el) {
      const box = await el.boundingBox();
      if (box) {
        await el.click({ force: true }).catch(async () => {
          // last resort: click at the element's center coordinates
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        });
        startClick = sel;
        break;
      }
    }
  }
  report.steps.push({ action: "click-start-game", result: startClick });
  await sleep(4000);
  await snap("after-start");
  await shot("after-start");

  // Wait for the game to actually load: Colonist renders the board into a LARGE <canvas>
  // and the sidebar/lobby chrome disappears. Poll up to ~25s.
  let inGame = false;
  for (let i = 0; i < 25; i++) {
    const probe = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll("canvas"));
      const big = canvases.find((c) => c.width > 400 && c.height > 300);
      const sidebar = document.querySelector(".web-sidebar-play");
      return {
        bigCanvas: !!big,
        canvasCount: canvases.length,
        sidebarGone: !sidebar,
        url: location.href,
      };
    });
    // In-game when a large canvas exists AND the lobby sidebar is gone.
    if (probe.bigCanvas && probe.sidebarGone) { inGame = true; report.gameProbe = probe; break; }
    report.gameProbe = probe;
    await sleep(1000);
  }
  report.inGame = inGame;
  report.url = page.url();
  await snap("in-game");
  await shot("in-game");
  return report;
}
