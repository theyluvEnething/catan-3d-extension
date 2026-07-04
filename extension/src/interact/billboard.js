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

    // Confirm on pointerdown (beats any capture-phase handlers Colonist attaches on click) and
    // also on click as a fallback. Guard against double-firing via a small latch.
    const confirm = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this._confirming) return; this._confirming = true;
      const a = this._active; this.hide();
      if (a && a.onConfirm) { try { a.onConfirm(); } catch (err) { console.warn("[catan3d] billboard confirm failed", err); } }
      setTimeout(() => { this._confirming = false; }, 50);
    };
    el.addEventListener("pointerdown", confirm, true);
    el.addEventListener("click", confirm, true);
  }

  /**
   * Show the billboard above a world position with the given piece icon.
   * @param {{x,y,z}} world  three world coords (the piece's location)
   * @param {string} kind  'settlement'|'city'|'road'|'robber'|'dev'
   * @param {number} colorId  player colour for piece recolor
   * @param {()=>void} onConfirm
   * @param {()=>void} [onCancel]
   */
  async show(world, kind, colorId, onConfirm, onCancel) {
    this._active = { world: new THREE.Vector3(world.x, world.y, world.z), onConfirm, onCancel };
    // pick icon
    let src = "";
    if (kind === "settlement" || kind === "city" || kind === "road") src = await pieceDataUrl(kind, colorId);
    else if (kind === "robber") src = assetUrl("icon_player") || "";
    else if (kind === "dev") src = assetUrl("card_devcardback") || "";
    this.iconEl.src = src;
    this.el.style.display = "block";
    this._tick();
    if (!this._raf) this._loop();
  }

  hide() {
    const a = this._active;
    this._active = null;
    this.el.style.display = "none";
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    return a;
  }

  cancel() { const a = this.hide(); if (a && a.onCancel) a.onCancel(); }

  get isActive() { return !!this._active; }

  _loop() { this._raf = requestAnimationFrame(() => { this._tick(); if (this._active) this._loop(); else this._raf = 0; }); }

  _tick() {
    if (!this._active) return;
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
    // hide if behind camera
    this.el.style.visibility = this._world.z > 1 ? "hidden" : "visible";
  }

  dispose() { if (this._raf) cancelAnimationFrame(this._raf); if (this.el) this.el.remove(); }
}
