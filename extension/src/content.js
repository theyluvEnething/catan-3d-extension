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
  let gameModel = null;   // faithful "internal copy" over gameState
  let gameHud = null;     // faithful rebuilt HUD
  const onSettingsCbs = [];

  // Dev-card action ids are NOT yet verified from live capture (the probe recorded only incoming
  // diffs, not our outgoing buy/play frames). Keep them null so we never emit a guessed action;
  // the confirm billboard still shows (correct UX), but the send is skipped + logged until known.
  const ACTION_BUY_DEV = null;   // TODO: capture the outgoing buy-dev frame to fill this in.

  // Handle a click on a rebuilt HUD control. Build buttons arm 3D placement (then the billboard
  // confirms); dev buys after a confirm; end-turn/trade/roll route to verified sends or shortcuts.
  function onHudAction(kind, bb) {
    if (!forwarder) return;
    switch (kind) {
      case "settlement": case "city": case "road": {
        const ok = forwarder.armBuild(kind);
        if (gameHud) gameHud.setArmed(kind);
        if (!ok) console.info(TAG, `no legal ${kind} targets right now`);
        break;
      }
      case "endturn": {
        // end-turn / pass = action 6 (verified). Clear any armed build first.
        forwarder.disarm(); if (gameHud) gameHud.setArmed(null);
        window.__catan3d.send?.sendGameAction(6, true);
        break;
      }
      case "dev": {
        // Buy a dev card — show the confirm billboard (the "are you sure" second click). Only
        // actually send once the buy-dev action id is verified; otherwise log the intent.
        if (!board?.scene) break;
        bb.show({ x: 0, y: 1.2, z: 0 }, "dev", gameModel?.snapshot?.us,
          () => {
            if (ACTION_BUY_DEV != null) window.__catan3d.send?.sendGameAction(ACTION_BUY_DEV, true);
            else console.info(TAG, "buy-dev confirmed (action id not yet verified — not sent)");
          },
          () => {});
        break;
      }
      case "trade": {
        // Trade UI is Colonist's own (unsolved bank-trade); surface Colonist's panel by
        // temporarily un-hiding its canvas UI is out of scope — log for now.
        console.info(TAG, "trade: use Colonist's native trade panel (bank-trade unsolved)");
        break;
      }
      // Icon rail — settings opens the popup conceptually; others are cosmetic no-ops here.
      case "settings": case "book": case "fullscreen": case "info": break;
      default: break;
    }
  }

  // Fire ONE synthetic click on Colonist's real #game-canvas the moment we enter a game. This
  // primes Colonist's first-interaction / pointer-capture state so the FIRST real billboard
  // placement works (the "first house won't place" bug). We aim at a hex-intersection-ish point
  // (a legal corner projected to canvas pixels when available, else the board centre) and
  // dispatch a full pointerdown→up→click gesture directly to the canvas element. Because it's a
  // synthetic (untrusted) event on empty board space, Colonist ignores it for actual placement —
  // it only warms the input path. Runs once per mount, guarded.
  let _warmedUp = false;
  function warmUpFirstClick() {
    if (_warmedUp) return; _warmedUp = true;
    const run = () => {
      try {
        const canvas = document.getElementById("game-canvas");
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        // Board centre — reliably over the middle hex, a valid intersection region. Precise
        // targeting isn't needed for a warm-up; we only need Colonist's canvas to receive a click.
        const px = rect.left + rect.width / 2, py = rect.top + rect.height / 2;
        const common = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py, screenX: px, screenY: py, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, composed: true };
        canvas.dispatchEvent(new PointerEvent("pointerover", common));
        canvas.dispatchEvent(new PointerEvent("pointerenter", common));
        canvas.dispatchEvent(new PointerEvent("pointermove", common));
        canvas.dispatchEvent(new MouseEvent("mousemove", common));
        canvas.dispatchEvent(new PointerEvent("pointerdown", common));
        canvas.dispatchEvent(new MouseEvent("mousedown", common));
        const up = { ...common, buttons: 0 };
        canvas.dispatchEvent(new PointerEvent("pointerup", up));
        canvas.dispatchEvent(new MouseEvent("mouseup", up));
        canvas.dispatchEvent(new MouseEvent("click", up));
        console.info(TAG, "warm-up click dispatched on #game-canvas @", Math.round(px), Math.round(py));
      } catch (e) { console.warn(TAG, "warm-up click failed", e); }
    };
    // Run shortly after mount so Colonist's canvas + WebGL input are ready, and once more a beat
    // later to cover slow game-load.
    setTimeout(run, 400);
    setTimeout(run, 1500);
  }
  // Re-arm the warm-up for the NEXT game (call when leaving a game / a fresh game starts).
  function rearmWarmUp() { _warmedUp = false; }

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

      // A fresh full snapshot = we entered/joined/resumed a game (even one in progress). Re-arm the
      // warm-up click so the first-placement fix applies to every game we enter, not just the first.
      gameState.subscribe((_s, evt) => {
        if (evt && evt.kind === "snapshot") { rearmWarmUp(); if (board) warmUpFirstClick(); }
      });
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

      // Build the faithful game model (the "internal copy") over the raw state — used by the HUD.
      const { GameModel } = await import(chrome.runtime.getURL("src/state/gameModel.js"));
      gameModel = new GameModel(gameState);
      window.__catan3d.model = gameModel;
      window.__catan3d.modelSnapshot = () => gameModel.snapshot;

      // Mount the 3D board + interaction layer once the game canvas exists. Gated on the
      // `enabled` setting; toggling `enabled` in the popup mounts/unmounts live.
      Promise.all([
        import(chrome.runtime.getURL("src/render/mount.js")),
        import(chrome.runtime.getURL("src/interact/forward.js")),
        import(chrome.runtime.getURL("src/interact/billboard.js")),
        import(chrome.runtime.getURL("src/render/hud/gameHud.js")),
      ]).then(([{ mountBoard }, { Forwarder }, { ConfirmBillboard }, { GameHud }]) => {
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
                // Confirmation billboard (Colonist-style "second click" popup) over the overlay.
                const bb = new ConfirmBillboard(board.overlay, board.scene);
                forwarder.setBillboard(bb);
                window.__catan3d.billboard = bb;
                // Faithful HUD rebuilt in the overlay (replaces the panels the overlay covers).
                gameHud = new GameHud(board.overlay, { onAction: (kind) => onHudAction(kind, bb) });
                window.__catan3d.gameHud = gameHud;
                gameHud.setVisible(settings.showGameHud !== false);
                const renderHud = () => { try { gameHud.update(gameModel.snapshot); } catch (e) {} };
                gameModel.subscribe(renderHud); renderHud();
                console.info(TAG, "3D board + HUD + interaction mounted");
                // WARM-UP: fire one synthetic click on Colonist's real board canvas as soon as we
                // enter a game. This primes Colonist's first-interaction input state so the FIRST
                // real billboard placement is clickable (empirically fixes the "first house won't
                // place" bug). Harmless: it's a click on empty board space, changes no game state.
                warmUpFirstClick();
              } catch (e) { console.warn(TAG, "forwarder/hud init failed", e); }
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
            try { gameHud?.dispose(); } catch {}
            try { window.__catan3d.billboard?.dispose(); } catch {}
            try { board.dispose(); } catch {}
            board = null; forwarder = null; gameHud = null;
            window.__catan3d.board = null; window.__catan3d.forwarder = null;
            window.__catan3d.gameHud = null; window.__catan3d.billboard = null;
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
      if (gameHud) gameHud.setVisible(s.showGameHud !== false);
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
