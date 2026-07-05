/**
 * src/interact/colonistButtons.js — drive Colonist's OWN in-game buttons.
 *
 * Some actions have no verified game-channel action id we can direct-send:
 *   - ROLL dice   — Colonist rolls via a client shortcut (Spacebar) / the #roll-dice-button; there
 *                   is no reverse-engineered "roll" game-action.
 *   - BUY dev card — the outgoing buy-dev frame was never captured; the action id is unknown and was
 *                   exhaustively NOT found by probing (see NOTES / memory).
 *
 * For these we click Colonist's REAL DOM button instead. Unlike the WebGL #game-canvas (which
 * ignores untrusted synthetic pointer events), ordinary DOM buttons DO respond to a synthetic
 * pointer/mouse/click gesture — React's onClick fires and Colonist's own client sends the correct,
 * in-sequence frame through its normal path. (And our MAIN-world sequence-ownership fix renumbers
 * every outgoing frame, so a Colonist-authored send stays perfectly gap-free alongside ours.)
 *
 * These live at the document body level (outside our overlay). Our click-shield overlay does NOT
 * cover them, and even if it did we dispatch straight to the element, not via a hit-test.
 *
 * Runs in the ISOLATED content-script world, which shares the page DOM.
 */

// Stable Colonist element ids (verified via harness/dump-game-buttons.js — see game-buttons.json).
export const COLONIST_BTN = {
  roll: "roll-dice-button",
  buyDev: "action-button-buy-dev-card",
  passTurn: "action-button-pass-turn",
  trade: "action-button-trade",
};

// Class fallbacks in case an id is ever missing (Colonist hashes classes per build, so these are
// prefixes we match with [class^=...]-style startsWith checks).
const CLASS_FALLBACK = {
  roll: ["diceGroup", "roll-dice"],
  buyDev: ["buyDevelopmentCardButton"],
  passTurn: ["passTurnButton", "endTurnButton"],
  trade: ["tradeButton"],
};

/** Find a Colonist button element by logical name (id first, then class-prefix fallback). */
export function findColonistButton(name) {
  const id = COLONIST_BTN[name];
  if (id) {
    const byId = document.getElementById(id);
    if (byId) return byId;
  }
  for (const prefix of CLASS_FALLBACK[name] || []) {
    const el = document.querySelector(`[class*="${prefix}"]`);
    if (el) return el;
  }
  return null;
}

/**
 * Fire a realistic click gesture on a DOM element. A plain el.click() is usually enough for React,
 * but some handlers listen on pointerdown/up; dispatch the full sequence to be safe. Coordinates
 * are taken from the element's own center so React's synthetic-event pointer data is sane.
 */
export function clickElement(el) {
  if (!el) return false;
  try {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, composed: true };
    el.dispatchEvent(new PointerEvent("pointerover", base));
    el.dispatchEvent(new PointerEvent("pointerenter", base));
    el.dispatchEvent(new PointerEvent("pointerdown", base));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    const up = { ...base, buttons: 0 };
    el.dispatchEvent(new PointerEvent("pointerup", up));
    el.dispatchEvent(new MouseEvent("mouseup", up));
    el.dispatchEvent(new MouseEvent("click", up));
    // Also call the native .click() as a belt-and-suspenders for handlers bound only to onClick.
    if (typeof el.click === "function") el.click();
    return true;
  } catch (e) {
    console.warn("[catan3d/colonistButtons] click failed", e);
    return false;
  }
}

/** Click a Colonist button by logical name. Returns true if the element was found + clicked. */
export function clickColonistButton(name) {
  const el = findColonistButton(name);
  if (!el) { console.info("[catan3d/colonistButtons]", name, "button not found in DOM"); return false; }
  return clickElement(el);
}

/**
 * Roll the dice. Prefer clicking #roll-dice-button; if it isn't present, fall back to dispatching
 * the Spacebar keyboard shortcut Colonist also accepts.
 */
export function rollDice() {
  if (clickColonistButton("roll")) return true;
  // Spacebar fallback (Colonist's documented roll shortcut).
  try {
    const opts = { bubbles: true, cancelable: true, key: " ", code: "Space", keyCode: 32, which: 32, view: window };
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keyup", opts));
    return true;
  } catch (e) { console.warn("[catan3d/colonistButtons] spacebar roll failed", e); return false; }
}
