/**
 * src/render/mount.js — mounts the 3D BoardScene EXACTLY over Colonist's live board canvas.
 *
 * Colonist's #game-canvas is not laid out at inset:0 of its parent — it carries a CSS
 * `transform: translate(0%, -50%)`, `top: 50%`, and a `left: <px>` offset, and its intrinsic
 * width/height (e.g. 2688×1971) are scaled down by a CSS `width/height` in px. The only robust
 * way to overlay it is to mirror its **live bounding box** (getBoundingClientRect) — which folds
 * in every transform, offset and scale — and keep mirroring it as the window resizes, the
 * sidebar toggles, or Colonist re-lays-out the board. We use a `position: fixed` overlay pinned
 * to that rect and re-measure each animation frame (a rect read is cheap and only writes styles
 * when the box actually changed).
 *
 * The real canvas is hidden VISUALLY (opacity/visibility) but stays in the DOM and interactive so
 * Phase-3 direct-send / event forwarding keeps working underneath.
 */
import { BoardScene } from "./scene.js";

export function mountBoard(state, opts = {}) {
  const host = locateGameCanvas();
  if (!host) return null;

  // Fixed overlay pinned to the canvas's viewport rect (updated every frame).
  //
  // The overlay is a CLICK-SHIELD: pointer-events:auto on the overlay itself so it CATCHES every
  // click/drag over the board region — nothing leaks through to Colonist's WebGL #game-canvas
  // underneath (which would cause accidental board interaction). Our own interactive layers (the
  // 3D canvas, the confirm billboard, the HUD's .pe controls) sit on top and handle their own
  // clicks; anything they don't handle is absorbed by the shield instead of reaching Colonist.
  const overlay = document.createElement("div");
  overlay.id = "catan3d-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    left: "0px", top: "0px", width: "0px", height: "0px",
    zIndex: "2147483000",
    pointerEvents: "auto",   // shield: catch all pointer events in the board rect
    overflow: "hidden",
    background: "transparent",
  });
  document.body.appendChild(overlay);

  // We do NOT mutate Colonist's #game-canvas at all — no visibility:hidden, no style changes on
  // their render surface. Our opaque 3D board simply COVERS it (the scene renders a solid
  // background, so Colonist's canvas is fully obscured beneath our overlay). Touching Colonist's
  // own DOM nodes can trip their consistency checks; covering instead of hiding avoids that.
  //
  // Colonist's modal flows we don't rebuild (trade panel, discard-on-7, robber/steal prompts,
  // dialogs) render in #dialog-container-root at the body level. Raise that container above our
  // shield ONCE so those dialogs stay fully clickable on top of the overlay. (This is a benign
  // z-index on a container meant to be topmost — not a mutation of the board/render surface.)
  ensureDialogsAboveOverlay();

  const rect0 = host.getBoundingClientRect();
  const w0 = Math.max(1, Math.round(rect0.width));
  const h0 = Math.max(1, Math.round(rect0.height));

  const scene = new BoardScene(overlay, { width: w0, height: h0 });
  scene.renderer.domElement.style.pointerEvents = "auto"; // OrbitControls need events
  scene.renderer.domElement.style.width = "100%";
  scene.renderer.domElement.style.height = "100%";
  scene.renderer.domElement.style.display = "block";

  const sync = () => {
    if (!state.ready) return;
    if (!scene._built) scene.buildBoard(state);
    scene.syncPieces(state);
  };
  sync();
  const unsub = state.subscribe(sync);

  // --- Live bounding-box tracking -------------------------------------------------------------
  // Mirror #game-canvas's rect onto the overlay. Only touch the DOM/renderer when it changed.
  let last = { x: -1, y: -1, w: -1, h: -1 };
  const EPS = 0.5;
  function measure() {
    // If Colonist swapped the canvas element, re-locate it.
    if (!host.isConnected) {
      const next = locateGameCanvas();
      if (next && next !== host) { return handle.remount(); }
    }
    const r = host.getBoundingClientRect();
    const x = r.left, y = r.top, w = r.width, h = r.height;
    if (w < 2 || h < 2) return; // canvas not laid out yet / hidden
    const moved = Math.abs(x - last.x) > EPS || Math.abs(y - last.y) > EPS;
    const resized = Math.abs(w - last.w) > EPS || Math.abs(h - last.h) > EPS;
    if (!moved && !resized) return;
    last = { x, y, w, h };
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    if (resized) scene.resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }

  // Re-measure every frame (cheap; scene already runs its own rAF loop). We hook a lightweight
  // secondary rAF rather than piggy-backing the scene loop to keep concerns separate.
  let rafId = 0;
  let running = true;
  const tick = () => { if (!running) return; measure(); rafId = requestAnimationFrame(tick); };
  rafId = requestAnimationFrame(tick);

  // Belt-and-suspenders: also respond immediately to explicit resize / DOM mutations.
  const onResize = () => measure();
  window.addEventListener("resize", onResize, { passive: true });
  const ro = new ResizeObserver(measure);
  try { ro.observe(host); } catch {}
  // Watch the canvas's style attribute (Colonist mutates left/top/transform/size on layout).
  const mo = new MutationObserver(measure);
  try { mo.observe(host, { attributes: true, attributeFilter: ["style", "width", "height"] }); } catch {}

  measure();

  const handle = {
    scene,
    overlay,
    host,
    getRect: () => host.getBoundingClientRect(),
    remount() {
      // Colonist replaced the canvas — tear down and rebuild against the new element.
      this.dispose();
      const fresh = mountBoard(state, opts);
      if (fresh) Object.assign(handle, fresh);
      return handle;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      unsub();
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", onResize);
      scene.dispose();
      overlay.remove();
      // We never mutated Colonist's canvas, so there is nothing to restore on it.
    },
  };
  return handle;
}

function locateGameCanvas() {
  // Colonist renders the board into #game-canvas (WebGL2). Fall back to the largest WebGL canvas.
  let el = document.getElementById("game-canvas");
  if (el) return el;
  const canvases = [...document.querySelectorAll("canvas")].filter((c) => c.width > 400 && c.height > 300);
  canvases.sort((a, b) => b.width * b.height - a.width * a.height);
  return canvases[0] || null;
}

// Our click-shield overlay sits at z-index 2147483000. Colonist's modal dialogs + notifications
// (trade panel, discard, robber/steal prompts, reconnect banner) render in these body-level
// containers. Raise them ABOVE the shield so they stay clickable on top of the overlay — the user
// still needs those native flows. Applied once, idempotently, and re-checked as containers appear.
function ensureDialogsAboveOverlay() {
  const OVERLAY_Z = 2147483000;
  const ABOVE = String(OVERLAY_Z + 10);
  const ids = ["dialog-container-root", "top-notification-container", "corner-notification-container"];
  const bump = () => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.dataset.c3dRaised !== "1") {
        // only set position if static (z-index needs a positioned element)
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        el.style.zIndex = ABOVE;
        el.dataset.c3dRaised = "1";
      }
    }
  };
  bump();
  // Colonist creates/replaces these containers lazily; watch the body briefly to catch them.
  try {
    const mo = new MutationObserver(bump);
    mo.observe(document.body, { childList: true, subtree: false });
    // stop watching after a while; dialogs that appear later still get bumped on next mount/open.
    setTimeout(() => { try { mo.disconnect(); } catch {} }, 20000);
  } catch {}
}
