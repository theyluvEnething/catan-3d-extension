// Harness-side injection of the extension's runtime.
//
// Chrome 137+ blocks command-line --load-extension on the STABLE channel, so for automated
// dev/testing we inject the SAME source modules the extension ships (decode/state/hud) plus
// the interceptor, via Playwright's addInitScript (runs in the MAIN world at document_start,
// before Colonist opens its WebSocket). The shipped extension/ still loads normally when the
// USER clicks "Load unpacked" in chrome://extensions (that path is NOT blocked).
//
// We import the ES modules as source text and wrap them into a single init script that:
//   1) patches window.WebSocket to capture + forward frames,
//   2) decodes each frame, applies it to a GameState, renders the HUD,
//   3) exposes window.__catan3d = { state, decodeFrame, rawLog } for the harness to read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(__dirname, "..", "extension", "src");

function read(rel) { return fs.readFileSync(path.join(EXT_SRC, rel), "utf8"); }

// Strip ESM export keywords so the source can run as a plain concatenated script in the page.
function deExport(src) {
  return src
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "");
}

export function buildInitScript() {
  const decode = deExport(read("protocol/decode.js"));
  const gameState = deExport(read("state/gameState.js"));
  const hud = deExport(read("render/hud.js"));

  // Assemble a single IIFE. Order matters: decode -> gameState -> hud -> glue.
  return `
(() => {
  "use strict";
  // Only run in the top frame (Colonist's game), not ad/analytics iframes.
  try { if (window.top !== window.self) return; } catch { return; }
  if (window.__catan3d && window.__catan3d.__installed) return;

  // ---- decode.js ----
  ${decode}

  // ---- gameState.js ----
  ${gameState}

  // ---- hud.js ----
  ${hud}

  // ---- runtime glue ----
  const state = new GameState();
  let hud = null;
  function mountHud(){ try { hud = new DebugHUD(); state.subscribe(()=>hud.render(state)); } catch(e){ console.warn("hud", e);} }
  if (document.body) mountHud(); else window.addEventListener("DOMContentLoaded", mountHud, {once:true});

  const rawLog = [];
  function handle(dir, data) {
    let frame;
    if (typeof data === "string") frame = { dir, kind:"text", text:data };
    else {
      let u8;
      if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof Blob) { data.arrayBuffer().then(b=>handle(dir, b)); return; }
      else return;
      frame = { dir, kind:"binary", bytes:u8 };
    }
    if (rawLog.length > 4000) rawLog.shift();
    rawLog.push({ dir:frame.dir, kind:frame.kind });
    try {
      const decoded = decodeFrame(frame);
      if (decoded && decoded.dir === "in") state.applyIncoming(decoded);
      window.dispatchEvent(new CustomEvent("CATAN3D_HARNESS_FRAME", { detail:{ dir:frame.dir, kind:frame.kind } }));
    } catch(e) { /* rare undecodable frame */ }
  }

  const Native = window.WebSocket;
  function Patched(...args){
    const s = new Native(...args);
    s.addEventListener("message", ev => handle("in", ev.data));
    const send = s.send;
    s.send = function(d){ handle("out", d); return send.apply(this, arguments); };
    return s;
  }
  Patched.prototype = Native.prototype;
  ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(k=>{ try{ Patched[k]=Native[k]; }catch{} });
  window.WebSocket = Patched;

  window.__catan3d = { __installed:true, state, decodeFrame, rawLog,
    snapshot: () => ({
      ready: state.ready, us: state.us, playOrder: state.playOrder,
      turn: state.currentTurnColor, phase: { turnState: state.turnState, actionState: state.actionState },
      completedTurns: state.completedTurns, robber: state.robberTileIndex, dice: state.dice,
      buildings: state.buildings(),
      counts: { hexes: state.hexes.length, corners: state.corners.length, edges: state.edges.length, ports: state.ports.length },
      players: state.playerColors.map(c => ({ color:c, vp: (()=>{ const ps=state.playerState(c); return ps&&ps.victoryPointsState?Object.values(ps.victoryPointsState).reduce((a,x)=>a+x,0):0; })() })),
      log: state.log.slice(-8),
    }),
  };
  console.info("[catan3d/inject] runtime installed (harness)");
})();
`;
}
