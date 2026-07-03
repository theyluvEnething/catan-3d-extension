/**
 * Isolated-world content script.
 *
 * Owns (eventually) the decoder, the game-state model, the Three.js canvas, and the HUD.
 * For Phase 1 it: receives raw frames from the MAIN-world interceptor over the postMessage
 * bridge, hands them to the decoder + state model, and drives the debug HUD.
 *
 * It also mirrors every captured frame onto window.__CATAN3D_FRAMES__ (in the ISOLATED
 * world's window is not shared with the page — so instead we relay to a harness sink via a
 * dedicated CustomEvent the Playwright harness listens for). See harness/capture.js.
 */
(() => {
  "use strict";
  const BRIDGE = "CATAN3D_FRAME";
  const TAG = "[catan3d/content]";

  // Modules (loaded async as web-accessible ES modules).
  let decodeFrame = null;
  let gameState = null;
  let hud = null;

  const rawLog = []; // ring buffer of recent raw frames for debugging
  const RAW_MAX = 5000;
  const pending = []; // frames that arrive before modules finish loading

  async function boot() {
    try {
      const [{ decodeFrame: df }, { GameState }, { DebugHUD }] = await Promise.all([
        import(chrome.runtime.getURL("src/protocol/decode.js")),
        import(chrome.runtime.getURL("src/state/gameState.js")),
        import(chrome.runtime.getURL("src/render/hud.js")),
      ]);
      decodeFrame = df;
      gameState = new GameState();
      const mountHud = () => { hud = new DebugHUD(); gameState.subscribe(() => hud.render(gameState)); };
      if (document.body) mountHud();
      else window.addEventListener("DOMContentLoaded", mountHud, { once: true });

      // Expose for devtools/harness.
      window.__catan3d.state = gameState;
      window.__catan3d.decodeFrame = decodeFrame;

      // Mount the 3D board once the game canvas exists (poll until it appears).
      import(chrome.runtime.getURL("src/render/mount.js")).then(({ mountBoard }) => {
        let mounted = null;
        const tryMount = () => {
          if (mounted) return;
          if (document.getElementById("game-canvas") && gameState.ready) {
            mounted = mountBoard(gameState);
            if (mounted) { window.__catan3d.board = mounted; console.info(TAG, "3D board mounted"); }
          }
        };
        const iv = setInterval(() => { tryMount(); if (mounted) clearInterval(iv); }, 800);
      }).catch((e) => console.warn(TAG, "3D mount unavailable", e));

      // Flush any frames that queued during load.
      for (const m of pending.splice(0)) processFrame(m);
      console.info(TAG, "modules loaded; state model live");
    } catch (e) {
      console.error(TAG, "module boot failed", e);
    }
  }

  function processFrame(msg) {
    if (!decodeFrame || !gameState) { pending.push(msg); return; }
    try {
      const decoded = decodeFrame(msg);
      if (decoded && decoded.dir === "in") gameState.applyIncoming(decoded);
    } catch (e) {
      // Non-fatal: log rare undecodable frames without breaking the game.
      if (msg.kind === "binary") console.debug(TAG, "decode skip", e.message);
    }
  }

  function onFrame(msg) {
    // msg: { dir, seq, t, kind, text?, b64?, byteLength? }
    if (rawLog.length >= RAW_MAX) rawLog.shift();
    rawLog.push(msg);

    // Relay to the harness (it injects a listener via page.exposeBinding / evaluate).
    try {
      window.dispatchEvent(new CustomEvent("CATAN3D_HARNESS_FRAME", { detail: msg }));
    } catch {}

    processFrame(msg);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== BRIDGE) return;
    onFrame(d);
  });

  // Expose for manual poking from the harness/devtools (isolated world).
  window.__catan3d = {
    rawLog,
    dump: () => JSON.parse(JSON.stringify(rawLog)),
  };

  boot();
  console.info(TAG, "isolated content script ready");
})();
