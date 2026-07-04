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

  // Live-tunable settings (populated from chrome.storage in boot()).
  let settings = null;
  let board = null;       // mount handle (scene + overlay)
  let forwarder = null;
  const onSettingsCbs = [];

  async function boot() {
    try {
      const [{ decodeFrame: df }, { GameState }, { DebugHUD }, { attachWatchdog }, settingsMod] = await Promise.all([
        import(chrome.runtime.getURL("src/protocol/decode.js")),
        import(chrome.runtime.getURL("src/state/gameState.js")),
        import(chrome.runtime.getURL("src/render/hud.js")),
        import(chrome.runtime.getURL("src/state/watchdog.js")),
        import(chrome.runtime.getURL("src/settings.js")),
      ]);
      decodeFrame = df;
      gameState = new GameState();

      // Load user settings and keep them live.
      settings = await settingsMod.loadSettings();
      settingsMod.onSettingsChanged((nv) => { settings = nv; applySettings(nv); });

      // Desync watchdog — compares our reconstruction to each fresh authoritative snapshot.
      const watchdog = attachWatchdog(gameState, { onDesync: (drifts) => { window.__catan3d.lastDesync = drifts; } });
      window.__catan3d.desyncReport = () => watchdog.report();
      const mountHud = () => {
        hud = new DebugHUD();
        hud.setVisible(settings.showHud);
        gameState.subscribe(() => hud.render(gameState));
      };
      if (document.body) mountHud();
      else window.addEventListener("DOMContentLoaded", mountHud, { once: true });

      // Report connection status to the background worker (drives the toolbar badge), and keep
      // it fresh as the game connects / snapshots arrive.
      const reportStatus = () => {
        try { chrome.runtime.sendMessage({ type: "CATAN3D_STATUS", connected: !!gameState.ready }); } catch {}
      };
      gameState.subscribe(reportStatus);
      reportStatus();

      // The popup queries live status and issues commands through this message channel.
      installPopupBridge(settingsMod);

      // Expose for devtools/harness.
      window.__catan3d.state = gameState;
      window.__catan3d.decodeFrame = decodeFrame;

      // Direct-send bridge to the MAIN world (interceptor owns the real socket). The Forwarder
      // calls this to place pieces; we round-trip a CATAN3D_SEND request/response by reqId.
      const pendingSends = new Map();
      let reqSeq = 0;
      window.addEventListener("message", (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== "CATAN3D_SEND_RESULT") return;
        const cb = pendingSends.get(ev.data.reqId); if (cb) { pendingSends.delete(ev.data.reqId); cb(ev.data.result); }
      });
      const sendApi = {
        sendGameAction: (action, payload) => { const reqId = ++reqSeq; return new Promise((res) => { pendingSends.set(reqId, res); window.postMessage({ source: "CATAN3D_SEND", action, payload, reqId }, location.origin); setTimeout(() => { if (pendingSends.has(reqId)) { pendingSends.delete(reqId); res({ ok: false, error: "timeout" }); } }, 1500); }); },
        buildSettlement: (i) => sendApi.sendGameAction(15, i),
        buildRoad: (i) => sendApi.sendGameAction(11, i),
      };
      window.__catan3d.send = sendApi;

      // Mount the 3D board + interaction layer once the game canvas exists. Gated on the
      // `enabled` setting; toggling `enabled` in the popup mounts/unmounts live.
      Promise.all([
        import(chrome.runtime.getURL("src/render/mount.js")),
        import(chrome.runtime.getURL("src/interact/forward.js")),
      ]).then(([{ mountBoard }, { Forwarder }]) => {
        let iv = null;
        const tryMount = () => {
          if (board) return;
          if (!settings.enabled) return;
          if (document.getElementById("game-canvas") && gameState.ready) {
            board = mountBoard(gameState);
            if (board) {
              window.__catan3d.board = board;
              try {
                forwarder = new Forwarder(board.scene, gameState, { send: sendApi });
                window.__catan3d.forwarder = forwarder;
                console.info(TAG, "3D board + interaction mounted");
              } catch (e) { console.warn(TAG, "forwarder init failed", e); }
              applySettings(settings); // apply opacity/rotate/markers to the fresh scene
            }
          }
        };
        const startPolling = () => { if (!iv) iv = setInterval(tryMount, 800); };
        const stopPolling = () => { if (iv) { clearInterval(iv); iv = null; } };
        startPolling();

        // Mount/unmount the whole board when `enabled` flips in the popup.
        onSettingsCbs.push((nv) => {
          if (nv.enabled && !board) { startPolling(); tryMount(); }
          else if (!nv.enabled && board) {
            stopPolling();
            try { board.dispose(); } catch {}
            board = null; forwarder = null;
            window.__catan3d.board = null; window.__catan3d.forwarder = null;
          }
        });
      }).catch((e) => console.warn(TAG, "3D mount unavailable", e));

      // Flush any frames that queued during load.
      for (const m of pending.splice(0)) processFrame(m);
      console.info(TAG, "modules loaded; state model live");
    } catch (e) {
      console.error(TAG, "module boot failed", e);
    }
  }

  // Apply the current settings to every live surface (scene, HUD, markers). Safe to call any
  // time; no-ops for surfaces not yet mounted.
  function applySettings(s) {
    if (!s) return;
    try {
      if (board && board.scene) {
        board.scene.setOpacity(s.opacity);
        board.scene.setAutoRotate(s.autoRotate);
        board.scene.setBackgroundTransparent(s.transparentBg);
      }
      if (hud) hud.setVisible(s.showHud);
      if (forwarder) forwarder.setMarkersEnabled(s.showMarkers);
    } catch (e) { console.warn(TAG, "applySettings failed", e); }
    // Fan out to any registered per-feature listeners (e.g. mount/unmount on `enabled`).
    for (const cb of onSettingsCbs) { try { cb(s); } catch {} }
  }

  // Message bridge for the popup: it lives in a separate context and can't touch window.__catan3d,
  // so it round-trips through chrome.runtime messaging handled here in the content script.
  function installPopupBridge(settingsMod) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "CATAN3D_GET_STATUS": {
          let wd = null;
          try { wd = window.__catan3d && window.__catan3d.desyncReport && window.__catan3d.desyncReport(); } catch {}
          const gs = gameState;
          sendResponse({
            connected: !!(gs && gs.ready),
            mounted: !!board,
            us: gs?.us ?? null,
            turnColor: gs?.currentTurnColor ?? null,
            yourTurn: !!(gs && gs.ready && gs.currentTurnColor === gs.us),
            completedTurns: gs?.completedTurns ?? 0,
            sync: wd ? { checks: wd.checks, desyncs: wd.desyncs, clean: wd.clean } : null,
            settings,
          });
          return true; // async-capable response
        }
        case "CATAN3D_RESET_CAMERA": {
          try { board?.scene?.resetCamera(); } catch {}
          sendResponse({ ok: true });
          return true;
        }
        case "CATAN3D_APPLY_SETTINGS": {
          // Popup already persisted to storage; this is just a nudge to apply immediately
          // (the storage.onChanged listener also fires, so this is belt-and-suspenders).
          if (msg.settings) { settings = msg.settings; applySettings(settings); }
          sendResponse({ ok: true });
          return true;
        }
      }
    });
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
