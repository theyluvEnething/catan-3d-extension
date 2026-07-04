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
  // Pure geometry + legal-move logic (no three.js) — strip their cross-imports too.
  const boardGeom = deExport(read("render/boardGeometry.js"));
  const legal = deExport(read("interact/legal.js")).replace(/^import\s+.*$/gm, "");
  const watchdog = deExport(read("state/watchdog.js")).replace(/^import\s+.*$/gm, "");

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

  // ---- boardGeometry.js (pure) ----
  ${boardGeom}

  // ---- legal.js (pure) ----
  ${legal}

  // ---- watchdog.js (pure) ----
  ${watchdog}

  // ---- hud.js ----
  ${hud}

  // ---- runtime glue ----
  const state = new GameState();
  let hud = null;
  // Desync watchdog: compares our diff-reconstructed board to each fresh authoritative snapshot.
  const watchdog = attachWatchdog(state);
  function mountHud(){ try { hud = new DebugHUD(); state.subscribe(()=>hud.render(state)); } catch(e){ console.warn("hud", e);} }
  if (document.body) mountHud(); else window.addEventListener("DOMContentLoaded", mountHud, {once:true});

  const rawLog = [];
  // Game-channel wiring for DIRECT SEND (Colonist requires trusted input events, so we place
  // pieces by sending the real build message on the game socket instead of forwarding clicks).
  const wire = { socket: null, channel: null, sequence: 0 };

  function handle(dir, data, socket) {
    let frame;
    if (typeof data === "string") frame = { dir, kind:"text", text:data };
    else {
      let u8;
      if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof Blob) { data.arrayBuffer().then(b=>handle(dir, b, socket)); return; }
      else return;
      frame = { dir, kind:"binary", bytes:u8 };
    }
    if (rawLog.length > 4000) rawLog.shift();
    rawLog.push({ dir:frame.dir, kind:frame.kind });
    try {
      const decoded = decodeFrame(frame);
      if (decoded && decoded.dir === "in") {
        state.applyIncoming(decoded);
        // learn the game-channel serverId from the type-1 handshake payload.
        if (decoded.id === "130" && decoded.type === 1 && decoded.payload && decoded.payload.serverId) {
          wire.channel = decoded.payload.serverId; wire.socket = socket;
        }
      }
      if (decoded && decoded.dir === "out" && decoded.b0 === 3 && decoded.channel) {
        // track the game channel + latest outgoing sequence so our sends stay in order.
        wire.channel = decoded.channel; wire.socket = socket;
        if (decoded.body && typeof decoded.body.sequence === "number") wire.sequence = decoded.body.sequence;
      }
      window.dispatchEvent(new CustomEvent("CATAN3D_HARNESS_FRAME", { detail:{ dir:frame.dir, kind:frame.kind } }));
    } catch(e) { /* rare undecodable frame */ }
  }

  // Outgoing-action log: decode every OUTGOING game frame ({action,payload,sequence}) so the
  // harness can discover unknown action ids (e.g. buy-dev/play-dev) by correlating an action
  // with the state change it produced. Ring-buffered.
  const outActions = [];
  function logOutgoing(d) {
    try {
      let u8 = null;
      if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
      else if (ArrayBuffer.isView(d)) u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      if (!u8 || u8[0] !== 0x03) return;
      const dec = decodeOutgoing(u8); // from decode.js: { action, payload, sequence, ... }
      if (dec && dec.action != null) {
        outActions.push({ action: dec.action, payload: dec.payload, sequence: dec.sequence, t: Date.now() });
        if (outActions.length > 500) outActions.shift();
        try { window.dispatchEvent(new CustomEvent("CATAN3D_OUT_ACTION", { detail: { action: dec.action, payload: dec.payload } })); } catch {}
      }
    } catch {}
  }

  const Native = window.WebSocket;
  function Patched(...args){
    const s = new Native(...args);
    s.addEventListener("message", ev => handle("in", ev.data, s));
    const send = s.send;
    s.send = function(d){ handle("out", d, s); logOutgoing(d); return send.apply(this, arguments); };
    return s;
  }
  Patched.prototype = Native.prototype;
  ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(k=>{ try{ Patched[k]=Native[k]; }catch{} });
  window.WebSocket = Patched;

  // DIRECT SEND: place a piece by emitting the real build message on the game socket.
  // action 15=settlement(cornerIndex), 11=road(edgeIndex). Returns the sequence used or an error.
  function sendGameAction(action, payload) {
    if (!wire.socket || !wire.channel) return { ok:false, error:"no game socket/channel yet" };
    if (wire.socket.readyState !== 1) return { ok:false, error:"socket not open" };
    const sequence = (wire.sequence || 0) + 1;
    try {
      const bytes = encodeChannel(wire.channel, action, payload, sequence);
      wire.socket.send(bytes);          // goes through our wrapped send -> also updates wire.sequence
      wire.sequence = sequence;
      return { ok:true, action, payload, sequence, channel: wire.channel };
    } catch (e) { return { ok:false, error: String(e && e.message || e) }; }
  }

  window.__catan3d = { __installed:true, state, decodeFrame, rawLog, sendGameAction, watchdog,
    outActions,
    outActionsSince: (t) => outActions.filter((a) => a.t >= t),
    desyncReport: () => watchdog.report(),
    wire: () => ({ channel: wire.channel, sequence: wire.sequence, open: wire.socket && wire.socket.readyState === 1 }),
    buildSettlement: (cornerIndex) => sendGameAction(15, cornerIndex),
    buildRoad: (edgeIndex) => sendGameAction(11, edgeIndex),
    // legal-move helpers (pure; from legal.js) bound to the live state
    legalSettlements: (opts) => { try { return legalSettlementCorners(state, opts); } catch(e){ return []; } },
    legalCities: () => { try { return legalCityCorners(state); } catch(e){ return []; } },
    legalRoads: (opts) => { try { return legalRoadEdges(state, opts); } catch(e){ return []; } },
    legalRobberHexes: () => { try { return legalRobberHexes(state); } catch(e){ return []; } },
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
