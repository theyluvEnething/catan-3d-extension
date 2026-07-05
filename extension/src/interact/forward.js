/**
 * src/interact/forward.js — 3D-click interaction layer (Phase 3, DIRECT-SEND).
 *
 * On a click in the 3D scene we raycast to the nearest board target (vertex→settlement/city,
 * edge→road, hex→robber), look up that target's INDEX in the reconstructed
 * gameState.mapState (tileCornerStates / tileEdgeStates / tileHexStates, matched by x,y,z),
 * and place the piece by DIRECT SEND — emitting the real build message on the game socket
 * (window.__catan3d.buildSettlement/buildRoad, or the generic sendGameAction). Synthetic
 * pointer events do NOT work: Colonist's WebGL input requires isTrusted events (NOTES §2.160).
 *
 * legal.js gates every click: only targets that are legal for the current context (settlement/
 * city/road/robber, setup vs. main phase) can be hovered or sent, so we never emit an illegal
 * action. The 3D→pixel affine is kept only as an optional fallback for the legacy synthetic
 * path (forwardClick) and is off the critical path.
 *
 * Placement CONTEXT (what a click means) comes from the state model's phase/turn info.
 */
import * as THREE from "../../vendor/three.module.js";
import { hexCenter, cornerPosExact, edgePos, edgeCorners } from "../render/boardGeometry.js";
import {
  legalSettlementCorners, legalCityCorners, legalRoadEdges, legalRobberHexes,
} from "./legal.js";

// GAME-channel action codes — ALL ✅ verified from live capture (NOTES: zero-desync set):
// settlement 15, road 11, city 19, robber 3, discard 2, end-turn/pass 6, trade-response 50.
const ACTION_BUILD_CITY = 19;  // ✅ BUILD_CITY (cornerIndex)
const ACTION_MOVE_ROBBER = 3;  // ✅ MOVE_ROBBER (hexIndex)

// Coord key for matching legal-target lists against pick targets. Robber targets (hexes) key
// on (x,y) only; corners/edges key on (x,y,z).
const keyOf = (c, ctx) => (ctx === "robber" ? `${c.x},${c.y}` : `${c.x},${c.y},${c.z}`);

export class Forwarder {
  /**
   * @param {BoardScene} scene
   * @param {GameState} state
   * @param {object} [opts]
   * @param {object} [opts.send]  direct-send API (buildSettlement/buildRoad/sendGameAction).
   *   Defaults to window.__catan3d at call time.
   * @param {HTMLCanvasElement} [opts.colonistCanvas]  hidden #game-canvas (legacy synthetic path).
   * @param {{a,b,tx,c,d,ty}} [opts.affine]  board→pixel transform (legacy synthetic path only).
   * @param {boolean} [opts.allowUnverified]  permit city/robber sends whose action codes are
   *   not yet verified from live capture. Off by default so we never emit a garbage action.
   */
  constructor(scene, state, opts = {}) {
    this.scene = scene;
    this.state = state;
    this._send = opts.send || null;
    this.canvas = opts.colonistCanvas || null;
    this.affine = opts.affine || null;
    this.allowUnverified = !!opts.allowUnverified;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._pickers = { corners: [], edges: [], hexes: [] };
    this._buildPickTargets();
    this._hoverMesh = null;
    this._attach();
    // Show legal-target markers reactively as the game state changes (our turn / phase shifts).
    if (state && typeof state.subscribe === "function") {
      this._unsub = state.subscribe(() => { try { this.refreshLegalMarkers(); } catch {} });
    }
    try { this.refreshLegalMarkers(); } catch {}
  }

  setAffine(aff) { this.affine = aff; }

  // The direct-send API (buildSettlement/buildRoad/sendGameAction). Prefers an injected api,
  // else the page-global window.__catan3d installed by the runtime glue.
  get sendApi() { return this._send || (typeof window !== "undefined" ? window.__catan3d : null); }

  boardToPixel(u, v) {
    const a = this.affine;
    return [a.a * u + a.b * v + a.tx, a.c * u + a.d * v + a.ty];
  }

  // Invisible pickable meshes at every corner, edge, and hex, tagged with their coords.
  //
  // Hit targets are deliberately GENEROUS (a click near a slot should register): corners are big
  // spheres, hexes are full-tile discs, and — critically — EDGES are fat boxes ORIENTED ALONG the
  // edge (matching how the real road bar is drawn, `_makeRoad`). The previous edge target was a
  // small AXIS-ALIGNED box, so diagonal edges presented almost no clickable area where the user was
  // aiming — that made roads feel unplaceable while corner-based settlements worked fine. Orienting
  // + enlarging the box fixes that.
  _buildPickTargets() {
    const st = this.state;
    const group = new THREE.Group();
    group.name = "pick-targets";
    const cornerGeo = new THREE.SphereGeometry(0.2, 10, 8);
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
      // Orient + size the hitbox along the edge, like the visible road. Compute the edge direction
      // from its two endpoint corners (same math as _makeRoad in scene.js).
      let angle = 0, len = 0.5;
      try {
        const [a, b] = edgeCorners(e.x, e.y, e.z);
        const pa = cornerPosExact(a.x, a.y, a.z), pb = cornerPosExact(b.x, b.y, b.z);
        const dx = pb.u - pa.u, dz = pb.v - pa.v;
        len = Math.hypot(dx, dz) || 0.5;
        angle = -Math.atan2(dz, dx);
      } catch {}
      // Fat box: full edge length, tall + wide enough to be an easy click target from the camera.
      const edgeGeo = new THREE.BoxGeometry(len * 0.9, 0.5, 0.34);
      const m = new THREE.Mesh(edgeGeo, invisible.clone());
      m.position.set(u, 0.55, v);
      m.rotation.y = angle;
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
    // Only the LEGAL targets for the current context are pickable (hover + click), so we never
    // highlight or send an illegal move. legal.js computes them from the reconstructed state.
    const p = this._context();
    if (!p) return [];
    const legalKeys = this._legalKeys(p);
    if (!legalKeys) return [];
    const kind = p === "road" ? "edges" : p === "robber" ? "hexes" : "corners";
    return this._pickers[kind].filter((m) => legalKeys.has(keyOf(m.userData.coord, p)));
  }

  // Set of "x,y,z" (or "x,y" for hexes) keys that are legal for the given context.
  _legalKeys(ctx) {
    if (!this.state?.gameState?.mapState) return null;
    const setup = (this.state.completedTurns ?? 0) < 8;
    let list;
    try {
      if (ctx === "settlement") list = legalSettlementCorners(this.state, { setup });
      else if (ctx === "city") list = legalCityCorners(this.state);
      else if (ctx === "road") list = legalRoadEdges(this.state, { setup, fromCorner: this._lastSettlement || null });
      else if (ctx === "robber") list = legalRobberHexes(this.state);
      else return null;
    } catch (e) { console.warn("[catan3d/forward] legal calc failed", e); return null; }
    const keys = new Set();
    for (const t of list || []) keys.add(keyOf(t, ctx));
    return keys;
  }

  // Look up the mapState INDEX of a raycast target by matching its (x,y,z) coord.
  _indexOf(coord, ctx) {
    const ms = this.state?.gameState?.mapState;
    if (!ms) return -1;
    const table = ctx === "road" ? ms.tileEdgeStates
      : ctx === "robber" ? ms.tileHexStates
        : ms.tileCornerStates;
    if (!table) return -1;
    for (const [i, t] of Object.entries(table)) {
      if (t && t.x === coord.x && t.y === coord.y && (ctx === "robber" || t.z === coord.z)) return Number(i);
    }
    return -1;
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
    // a bright glowing ring at the hovered target
    const isHex = target.userData.kind === "hex";
    const geo = isHex ? new THREE.RingGeometry(0.34, 0.52, 28) : new THREE.RingGeometry(0.1, 0.22, 24);
    const mk = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
    mk.renderOrder = 999;
    mk.rotation.x = -Math.PI / 2;
    mk.position.set(target.userData.u, 0.62, target.userData.v);
    this._hoverMarker = mk; this.scene.board.add(mk);
  }

  /**
   * Show faint persistent markers on ALL legal targets for the current context, so the player
   * can see where they may build/move. Call reactively on state change. Cheap (reuses geometry).
   */
  /** Toggle the faint legal-target rings on/off live (from popup settings). */
  setMarkersEnabled(on) {
    this._markersDisabled = !on;
    try { this.refreshLegalMarkers(); } catch {}
  }

  refreshLegalMarkers() {
    if (this._legalGroup) { this.scene.board.remove(this._legalGroup); this._legalGroup = null; }
    if (this._markersDisabled) return; // markers turned off in settings
    const ctx = this._context();
    if (!ctx) return; // not our turn / nothing to do
    const pickables = this._pickablesForContext();
    if (!pickables.length) return;
    const grp = new THREE.Group(); grp.name = "legal-markers";
    const isHex = ctx === "robber";
    const geo = isHex ? new THREE.RingGeometry(0.3, 0.44, 24) : new THREE.RingGeometry(0.09, 0.17, 20);
    const mat = new THREE.MeshBasicMaterial({ color: ctx === "robber" ? 0xffcf6b : 0x86f0a6, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthTest: false });
    for (const m of pickables) {
      const mk = new THREE.Mesh(geo, mat);
      mk.renderOrder = 998; mk.rotation.x = -Math.PI / 2;
      mk.position.set(m.userData.u, 0.55, m.userData.v);
      grp.add(mk);
    }
    this._legalGroup = grp; this.scene.board.add(grp);
  }

  _onClick(ev) {
    // Suppress the stray click that can leak to the canvas immediately after a billboard confirm
    // (the click gesture that pressed the billboard finishing after we hid it). Without this the
    // FIRST placement would instantly re-raycast and re-open/close a billboard.
    if (this._billboard && this._billboard.confirmedAt && (Date.now() - this._billboard.confirmedAt) < 250) return;
    // If a confirm billboard is already up, a click elsewhere cancels it (the billboard's own
    // click handler stops propagation, so reaching here means "clicked off").
    if (this._billboard && this._billboard.isActive) { this._billboard.cancel(); return; }
    const ctx = this._context();
    if (!ctx) return;
    const pickables = this._pickablesForContext(); // already filtered to legal targets
    const hit = this._raycast(ev, pickables);
    if (!hit) return;
    const { coord, u, v } = hit.userData;
    const index = this._indexOf(coord, ctx);
    if (index < 0) { console.warn("[catan3d/forward] no index for target", coord, ctx); return; }
    // Two-step confirm (matches Colonist's own popup): show a billboard above the spot; only on
    // clicking IT do we direct-send. If no billboard is wired, fall back to immediate placement.
    if (this._billboard) {
      const worldY = ctx === "robber" ? 0.5 : (ctx === "road" ? 0.5 : 0.7);
      const color = this.state.us;
      this._billboard.show({ x: u, y: worldY, z: v }, ctx, color,
        () => { this._place(ctx, index, coord); },
        () => {});
      return;
    }
    return this._place(ctx, index, coord);
  }

  /** Wire a ConfirmBillboard so clicks show a confirmation popup before sending. */
  setBillboard(bb) { this._billboard = bb; }

  /**
   * Arm a build mode from the HUD tray ('settlement'|'city'|'road'). During the main phase this
   * sets the forced context so clicks target that piece type and legal markers update. Returns
   * true if the mode is currently placeable (your turn + legal targets exist).
   */
  armBuild(kind) {
    this.setContext(kind);
    try { this.refreshLegalMarkers(); } catch {}
    const targets = this._pickablesForContext();
    return targets.length > 0;
  }

  /** Clear any forced build mode (back to auto-detected context). */
  disarm() { this._forcedContext = null; try { this.refreshLegalMarkers(); } catch {} }

  // Place a piece by DIRECT SEND: emit the real build message on the game socket via the
  // direct-send API. Returns the send result ({ok,...}) or an error object.
  _place(ctx, index, coord) {
    const api = this.sendApi;
    if (!api) { console.warn("[catan3d/forward] no direct-send api (window.__catan3d)"); return { ok: false, error: "no send api" }; }
    let res;
    if (ctx === "settlement") res = api.buildSettlement(index);
    else if (ctx === "road") res = api.buildRoad(index);
    else if (ctx === "city") res = api.sendGameAction(ACTION_BUILD_CITY, index);   // ✅ 19 verified
    else if (ctx === "robber") res = api.sendGameAction(ACTION_MOVE_ROBBER, index); // ✅ 3 verified
    else return { ok: false, error: "unknown context" };
    // Remember the settlement we just placed so setup road legality can key off it.
    if (ctx === "settlement" && res && res.ok) this._lastSettlement = coord;
    this._setHover(null); // clear highlight after a placement
    return res;
  }

  // LEGACY: dispatch a synthetic pointer/mouse click to Colonist's canvas at page-pixel (px,py).
  // Kept for the harness/pixel path only — Colonist ignores untrusted events for real placement.
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
    if (this._unsub) { try { this._unsub(); } catch {} }
    if (this.pickGroup) this.scene.board.remove(this.pickGroup);
    if (this._hoverMarker) this.scene.board.remove(this._hoverMarker);
    if (this._legalGroup) this.scene.board.remove(this._legalGroup);
  }
}
