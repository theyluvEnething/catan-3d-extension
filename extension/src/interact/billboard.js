/**
 * src/interact/billboard.js — the confirmation billboard shown over a chosen 3D target.
 *
 * When you pick a legal spot in the 3D scene, we don't place immediately. Instead we pop a small
 * billboard right above that spot — visually the same light-blue plate (box.png) Colonist shows
 * as its own "confirm placement" popup, carrying the piece icon you're about to place. Clicking
 * the billboard confirms and fires the (verified) direct-send; clicking anywhere else cancels.
 *
 * The billboard is a DOM element tracked in SCREEN space: each frame we project the target's 3D
 * world position through the camera and place the billboard 60px above it (matching Colonist's
 * popup offset). This needs no pixel calibration — the 3D camera IS the projection.
 */
import * as THREE from "../../vendor/three.module.js";
import { pieceDataUrl, assetUrl } from "../render/assets.js";

export class ConfirmBillboard {
  /**
   * @param {HTMLElement} host  overlay element (same one the 3D canvas lives in).
   * @param {BoardScene} scene
   * @param {object} [opts] { boxPngUrl, offsetPx }
   */
  constructor(host, scene, opts = {}) {
    this.host = host;   // kept for reference only; the billboard renders to <body> (see below)
    this.scene = scene;
    this.offsetPx = opts.offsetPx ?? 60;
    this.plateUrl = opts.boxPngUrl || (typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL("assets/box.png") : "../../assets/box.png");
    this._world = new THREE.Vector3();
    this._active = null;      // { world, onConfirm, onCancel }
    this._raf = 0;
    this.confirmedAt = 0;     // timestamp of last confirm — forwarder suppresses stray clicks after
    this._build();
  }

  _build() {
    const el = document.createElement("div");
    el.className = "c3d-billboard";
    // Render to <body> with position:FIXED and the MAX z-index. This makes the billboard immune
    // to the overlay's overflow:hidden / pointer-events:none and to Colonist's own high-z DOM
    // (#ui-game, notification containers) — nothing can clip it or steal its clicks.
    el.style.cssText = "position:fixed;left:0;top:0;transform:translate(-50%,-100%);z-index:2147483647;pointer-events:auto;display:none;cursor:pointer;filter:drop-shadow(0 6px 12px rgba(0,0,0,.45));will-change:left,top;";
    el.innerHTML = `
      <div class="bb-plate" style="position:relative;width:76px;height:76px;background-size:100% 100%;display:grid;place-items:center;pointer-events:auto;">
        <img class="bb-icon" alt="" style="width:48px;height:48px;pointer-events:none;">
        <span class="bb-check" style="position:absolute;right:-6px;bottom:-6px;width:26px;height:26px;border-radius:50%;background:#3ec85a;display:grid;place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.4);pointer-events:none;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>
        </span>
      </div>
      <div class="bb-stem" style="position:absolute;left:50%;bottom:-10px;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:11px solid #cfe6f2;pointer-events:none;"></div>`;
    el.querySelector(".bb-plate").style.backgroundImage = `url("${this.plateUrl}")`;
    this.el = el;
    this.iconEl = el.querySelector(".bb-icon");
    document.body.appendChild(el);

    // Confirm on CLICK (not pointerdown): the full press→release→click gesture must complete on
    // the billboard element itself. Confirming on pointerdown would hide the billboard mid-gesture,
    // and the trailing pointerup/click would then land on the board canvas underneath and re-fire
    // its raycast handler. We also stop the gesture's pointer events from reaching anything else,
    // and FREEZE the billboard's position for the duration of the press so camera damping can't
    // slide the plate out from under the cursor between pointerdown and click (the first-placement
    // failure: on mount the camera is still settling, so the plate drifted and the click missed).
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener("pointerdown", (e) => { swallow(e); this._frozen = true; }, true);
    el.addEventListener("pointerup", swallow, true);
    el.addEventListener("mousedown", (e) => { swallow(e); this._frozen = true; }, true);
    el.addEventListener("mouseup", swallow, true);
    el.addEventListener("pointercancel", () => { this._frozen = false; }, true);
    el.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      this._frozen = false;
      if (this._confirming) return; this._confirming = true;
      const a = this._active; this.confirmedAt = Date.now(); this.hide();
      if (a && a.onConfirm) { try { a.onConfirm(); } catch (err) { console.warn("[catan3d] billboard confirm failed", err); } }
      setTimeout(() => { this._confirming = false; }, 60);
    }, true);
  }

  /**
   * Show the billboard above a world position with the given piece icon.
   * @param {{x,y,z}} world  three world coords (the piece's location)
   * @param {string} kind  'settlement'|'city'|'road'|'robber'|'dev'
   * @param {number} colorId  player colour for piece recolor
   * @param {()=>void} onConfirm
   * @param {()=>void} [onCancel]
   */
  show(world, kind, colorId, onConfirm, onCancel) {
    this._active = { world: new THREE.Vector3(world.x, world.y, world.z), onConfirm, onCancel };
    // FIRST-PLACEMENT ROOT FIX: disable OrbitControls while the billboard is up. The click that
    // OPENS the billboard is a pointerdown on the canvas, where OrbitControls calls
    // setPointerCapture(canvas) — capturing the whole gesture to the canvas and (with damping)
    // drifting the camera. On the first placement, with the billboard's box only just realized,
    // that captured/drifting gesture makes the confirm-click miss. Disabling controls makes
    // OrbitControls' onPointerDown early-return (no capture, no camera motion), so the billboard
    // gets a clean, independent press→release every time. Re-enabled in hide().
    try {
      const c = this.scene && this.scene.controls;
      if (c) { this._prevControlsEnabled = c.enabled; c.enabled = false; }
      const dom = this.scene && this.scene.renderer && this.scene.renderer.domElement;
      if (dom && dom.hasPointerCapture) { for (const id of [1, 0]) { try { if (dom.hasPointerCapture(id)) dom.releasePointerCapture(id); } catch {} } }
    } catch {}
    // Show the plate IMMEDIATELY and position it, so it never lags behind the click — the piece
    // recolor (pieceDataUrl) is async and, uncached on the FIRST placement, would otherwise leave
    // the billboard invisible for a beat. Fill the icon in when it resolves.
    this.iconEl.src = "";
    this.el.style.display = "block";
    this.el.style.visibility = "visible";
    this._frozen = false;
    this._tick();
    void this.el.offsetWidth; // force synchronous layout so the plate has a live hit-region now
    if (!this._raf) this._loop();
    const token = (this._iconToken = (this._iconToken || 0) + 1);
    Promise.resolve(
      (kind === "settlement" || kind === "city" || kind === "road") ? pieceDataUrl(kind, colorId)
        : (kind === "robber") ? (assetUrl("icon_player") || "")
          : (kind === "dev") ? (assetUrl("card_devcardback") || "") : ""
    ).then((src) => { if (this._iconToken === token && this._active) this.iconEl.src = src || ""; }).catch(() => {});
    return this;
  }

  hide() {
    const a = this._active;
    this._active = null;
    this._frozen = false;
    this.el.style.display = "none";
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    // Re-enable OrbitControls (disabled in show()) so the user can orbit again between placements.
    try { const c = this.scene && this.scene.controls; if (c && this._prevControlsEnabled !== undefined) { c.enabled = this._prevControlsEnabled; this._prevControlsEnabled = undefined; } } catch {}
    return a;
  }

  cancel() { const a = this.hide(); if (a && a.onCancel) a.onCancel(); }

  get isActive() { return !!this._active; }

  _loop() { this._raf = requestAnimationFrame(() => { this._tick(); if (this._active) this._loop(); else this._raf = 0; }); }

  _tick() {
    if (!this._active) return;
    // While the user is pressing the plate, DON'T reposition it — a moving target between
    // pointerdown and click makes the release land off it. (Belt-and-suspenders alongside
    // disabling OrbitControls in show(); covers any residual camera motion.)
    if (this._frozen) return;
    const cam = this.scene.camera;
    const dom = this.scene.renderer.domElement;
    this._world.copy(this._active.world);
    this._world.project(cam);
    const rect = dom.getBoundingClientRect();
    // project() gives NDC in [-1,1]; the billboard is position:fixed on <body>, so map straight
    // to VIEWPORT pixels (rect is already viewport-relative).
    const x = (this._world.x * 0.5 + 0.5) * rect.width + rect.left;
    const y = (-this._world.y * 0.5 + 0.5) * rect.height + rect.top;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y - this.offsetPx}px`;
    // If the point is behind the camera we can't position it correctly, but an ACTIVE billboard
    // must never become unclickable — clamp with visibility only when there is genuinely no valid
    // projection, and keep it interactive otherwise. (Camera is disabled while active, so z stays
    // valid in practice; this is a guard for edge cases.)
    this.el.style.visibility = this._world.z > 1.5 ? "hidden" : "visible";
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    try { const c = this.scene && this.scene.controls; if (c && this._prevControlsEnabled !== undefined) c.enabled = this._prevControlsEnabled; } catch {}
    if (this.el) this.el.remove();
  }
}
