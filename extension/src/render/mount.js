/**
 * src/render/mount.js — mounts the 3D BoardScene over Colonist's live board.
 *
 * Finds Colonist's game canvas (#game-canvas, WebGL2), hides it VISUALLY but keeps it in the
 * DOM and interactive (Phase 3 forwards clicks to it), and overlays our Three.js canvas in the
 * same layout slot. Subscribes the scene to the reconstructed GameState so it mirrors the live
 * game in real time. Responsive to resize.
 */
import { BoardScene } from "./scene.js";

export function mountBoard(state) {
  const host = locateGameCanvas();
  if (!host) return null;

  // Overlay container positioned exactly over the game canvas.
  const overlay = document.createElement("div");
  overlay.id = "catan3d-overlay";
  Object.assign(overlay.style, {
    position: "absolute", inset: "0", zIndex: "5", pointerEvents: "none",
  });
  const parent = host.parentElement || document.body;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(overlay);

  // Hide Colonist's canvas visually but keep it laid out + interactive underneath.
  host.style.visibility = "hidden";

  const scene = new BoardScene(overlay, { width: host.clientWidth, height: host.clientHeight });
  scene.renderer.domElement.style.pointerEvents = "auto"; // OrbitControls need events
  scene.renderer.domElement.style.width = "100%";
  scene.renderer.domElement.style.height = "100%";

  const sync = () => {
    if (!state.ready) return;
    if (!scene._built) scene.buildBoard(state);
    scene.syncPieces(state);
  };
  sync();
  const unsub = state.subscribe(sync);

  const onResize = () => {
    const w = host.clientWidth || overlay.clientWidth;
    const h = host.clientHeight || overlay.clientHeight;
    if (w && h) scene.resize(w, h);
  };
  window.addEventListener("resize", onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(host);

  return {
    scene,
    dispose() { unsub(); ro.disconnect(); window.removeEventListener("resize", onResize); scene.dispose(); overlay.remove(); host.style.visibility = ""; },
  };
}

function locateGameCanvas() {
  // Colonist renders the board into #game-canvas (WebGL2). Fall back to the largest WebGL canvas.
  let el = document.getElementById("game-canvas");
  if (el) return el;
  const canvases = [...document.querySelectorAll("canvas")].filter((c) => c.width > 400 && c.height > 300);
  canvases.sort((a, b) => b.width * b.height - a.width * a.height);
  return canvases[0] || null;
}
