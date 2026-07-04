/**
 * src/interact/forward.js — coordinate-forwarding interaction layer (Phase 3).
 *
 * On a click in the 3D scene we raycast to the nearest board target (vertex→settlement/city,
 * edge→road, hex→robber), map that target's board-space position to a pixel on Colonist's
 * hidden canvas via the calibrated affine, and dispatch synthetic pointer events there.
 * Colonist validates the move and emits the real WebSocket message. We never fabricate the
 * outgoing protocol (forwarding only), per the spec's primary strategy.
 *
 * The affine (board→pixel) is provided by the caller (harness derives it via RANSAC on token
 * discs; a live-extension deriver can be added later). Placement CONTEXT (what a click means)
 * comes from the state model's phase/turn info.
 */
import * as THREE from "../../vendor/three.module.js";
import { hexCenter, cornerPosExact, edgePos } from "../render/boardGeometry.js";

export class Forwarder {
  /**
   * @param {BoardScene} scene
   * @param {GameState} state
   * @param {HTMLCanvasElement} colonistCanvas  the hidden #game-canvas
   * @param {{a,b,tx,c,d,ty}} affine  board-space -> page-pixel transform
   */
  constructor(scene, state, colonistCanvas, affine) {
    this.scene = scene;
    this.state = state;
    this.canvas = colonistCanvas;
    this.affine = affine;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._pickers = { corners: [], edges: [], hexes: [] };
    this._buildPickTargets();
    this._hoverMesh = null;
    this._attach();
  }

  setAffine(aff) { this.affine = aff; }

  boardToPixel(u, v) {
    const a = this.affine;
    return [a.a * u + a.b * v + a.tx, a.c * u + a.d * v + a.ty];
  }

  // Invisible pickable meshes at every corner, edge, and hex, tagged with their coords.
  _buildPickTargets() {
    const st = this.state;
    const group = new THREE.Group();
    group.name = "pick-targets";
    const cornerGeo = new THREE.SphereGeometry(0.16, 8, 6);
    const edgeGeo = new THREE.BoxGeometry(0.34, 0.12, 0.16);
    const hexGeo = new THREE.CircleGeometry(0.5, 6);
    const invisible = new THREE.MeshBasicMaterial({ visible: false });

    for (const c of st.corners) {
      const { u, v } = cornerPosExact(c.x, c.y, c.z);
      const m = new THREE.Mesh(cornerGeo, invisible.clone());
      m.position.set(u, 0.5, v);
      m.userData = { kind: "corner", coord: c, u, v };
      group.add(m); this._pickers.corners.push(m);
    }
    for (const e of st.edges) {
      const { u, v } = edgePos(e.x, e.y, e.z);
      const m = new THREE.Mesh(edgeGeo, invisible.clone());
      m.position.set(u, 0.45, v);
      m.userData = { kind: "edge", coord: e, u, v };
      group.add(m); this._pickers.edges.push(m);
    }
    for (const h of st.hexes) {
      const { u, v } = hexCenter(h.x, h.y);
      const m = new THREE.Mesh(hexGeo, invisible.clone());
      m.rotation.x = -Math.PI / 2; m.position.set(u, 0.42, v);
      m.userData = { kind: "hex", coord: h, u, v };
      group.add(m); this._pickers.hexes.push(m);
    }
    this.scene.board.add(group);
    this.pickGroup = group;
  }

  _attach() {
    const dom = this.scene.renderer.domElement;
    dom.addEventListener("pointermove", (ev) => this._onMove(ev));
    dom.addEventListener("click", (ev) => this._onClick(ev));
  }

  _pickablesForContext() {
    // Which target kind is relevant right now, from the state phase.
    const p = this._context();
    if (p === "settlement" || p === "city") return this._pickers.corners;
    if (p === "road") return this._pickers.edges;
    if (p === "robber") return this._pickers.hexes;
    return [];
  }

  // Derive the current interaction context from the state model.
  _context() {
    const st = this.state;
    if (st.currentTurnColor !== st.us) return null; // not our turn
    const as = st.actionState;
    // actionState 3 (setup: place road after settlement) or road-building
    if (as === 3) return "road";
    if (as === 24) return "robber"; // moving robber
    // In setup (completedTurns < 8) with actionState 1 -> place settlement
    if ((st.completedTurns ?? 0) < 8 && as === 1) return "settlement";
    // otherwise allow build via explicit modes (set by UI buttons) — default settlement.
    return this._forcedContext || "settlement";
  }
  setContext(ctx) { this._forcedContext = ctx; } // UI can force build-city / build-road etc.

  _raycast(ev, pickables) {
    const dom = this.scene.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.scene.camera);
    const hits = this.raycaster.intersectObjects(pickables, false);
    return hits.length ? hits[0].object : null;
  }

  _onMove(ev) {
    const pickables = this._pickablesForContext();
    const hit = pickables.length ? this._raycast(ev, pickables) : null;
    this._setHover(hit);
  }

  _setHover(target) {
    if (this._hoverMarker) { this.scene.board.remove(this._hoverMarker); this._hoverMarker = null; }
    if (!target) { this.scene.renderer.domElement.style.cursor = ""; return; }
    this.scene.renderer.domElement.style.cursor = "pointer";
    // a glowing ring/marker at the target
    const isHex = target.userData.kind === "hex";
    const geo = isHex ? new THREE.RingGeometry(0.35, 0.5, 24) : new THREE.RingGeometry(0.12, 0.2, 20);
    const mk = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    mk.rotation.x = -Math.PI / 2;
    mk.position.set(target.userData.u, 0.5, target.userData.v);
    this._hoverMarker = mk; this.scene.board.add(mk);
  }

  _onClick(ev) {
    const ctx = this._context();
    if (!ctx) return;
    const pickables = this._pickablesForContext();
    const hit = this._raycast(ev, pickables);
    if (!hit) return;
    const { u, v } = hit.userData;
    const [px, py] = this.boardToPixel(u, v);
    this.forwardClick(px, py);
  }

  // Dispatch a synthetic pointer/mouse click to Colonist's canvas at page-pixel (px,py).
  forwardClick(px, py) {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const clientX = px, clientY = py;
    const common = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
    canvas.dispatchEvent(new PointerEvent("pointerdown", common));
    canvas.dispatchEvent(new MouseEvent("mousedown", common));
    canvas.dispatchEvent(new PointerEvent("pointerup", { ...common, buttons: 0 }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
    canvas.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    return { px, py, rect };
  }

  dispose() {
    if (this.pickGroup) this.scene.board.remove(this.pickGroup);
    if (this._hoverMarker) this.scene.board.remove(this._hoverMarker);
  }
}
