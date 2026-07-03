/**
 * MAIN-world WebSocket interceptor.
 *
 * Runs at document_start in the PAGE's world (world: "MAIN") so it can monkey-patch
 * window.WebSocket BEFORE Colonist constructs its game socket. Captures BOTH directions
 * (outgoing .send and incoming 'message') with a timestamp + direction, and bridges each
 * frame to the isolated-world content script via window.postMessage.
 *
 * The isolated content-script world CANNOT see the page's WebSocket instance directly,
 * so this postMessage bridge is mandatory.
 *
 * This file is intentionally protocol-AGNOSTIC: it forwards raw frames only. All decoding
 * lives in src/protocol/decode.js (isolated world). The one protocol-adjacent thing we do
 * here is opportunistically locate Colonist's OWN encode/decode inside its webpack runtime,
 * because that runs in this world — but that is a best-effort fallback, gated behind a flag.
 */
(() => {
  "use strict";
  // Colonist's game runs in the top frame; skip ad/analytics iframes.
  try { if (window.top !== window.self) return; } catch { return; }

  const BRIDGE = "CATAN3D_FRAME"; // postMessage type for captured frames
  const TAG = "[catan3d/interceptor]";

  // Monotonic-ish timestamp. performance.now() is high-res; pair with a wall-clock origin.
  const T0 = Date.now();
  const now = () => T0 + performance.now();

  // --- base64 helpers for binary frames (ArrayBuffer/typed array) ---
  function bytesToB64(bytes) {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  let seq = 0;
  function post(dir, payload) {
    // payload: { kind: 'text'|'binary', text?, b64?, byteLength? }
    window.postMessage(
      {
        source: BRIDGE,
        dir, // 'in' (server->client) or 'out' (client->server)
        seq: seq++,
        t: now(),
        ...payload,
      },
      window.location.origin
    );
  }

  function normalizeAndPost(dir, data) {
    try {
      if (typeof data === "string") {
        post(dir, { kind: "text", text: data });
        return;
      }
      if (data instanceof ArrayBuffer) {
        post(dir, {
          kind: "binary",
          b64: bytesToB64(new Uint8Array(data)),
          byteLength: data.byteLength,
        });
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        post(dir, { kind: "binary", b64: bytesToB64(view), byteLength: data.byteLength });
        return;
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        // Blob is async; read then post preserving order best-effort via seq.
        data.arrayBuffer().then((buf) => {
          post(dir, {
            kind: "binary",
            b64: bytesToB64(new Uint8Array(buf)),
            byteLength: buf.byteLength,
            wasBlob: true,
          });
        });
        return;
      }
      // Unknown type — stringify a description so we at least see it in dumps.
      post(dir, { kind: "text", text: `[unknown ${Object.prototype.toString.call(data)}]` });
    } catch (e) {
      // Never let capture break the game.
      console.warn(TAG, "capture error", e);
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) {
    console.warn(TAG, "no native WebSocket found; aborting");
    return;
  }

  function PatchedWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    try {
      const url = args[0];
      console.debug(TAG, "socket opened:", url);
      // Capture incoming frames (server -> client)
      socket.addEventListener("message", (ev) => normalizeAndPost("in", ev.data));
    } catch (e) {
      console.warn(TAG, "attach listener failed", e);
    }

    // Wrap send (client -> server)
    const nativeSend = socket.send;
    socket.send = function (data) {
      normalizeAndPost("out", data);
      return nativeSend.apply(this, arguments);
    };
    return socket;
  }

  // Preserve statics/prototype so page code that reads WebSocket.OPEN etc. still works.
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => {
    try {
      PatchedWebSocket[k] = NativeWebSocket[k];
    } catch {}
  });

  window.WebSocket = PatchedWebSocket;
  console.info(TAG, "WebSocket patched at document_start");

  // ------------------------------------------------------------------
  // Best-effort: expose Colonist's own decode via the webpack runtime.
  // This lets decode.js fall back to the game's native decoder if our own
  // reverse-engineered decoder ever fails. Gated + wrapped so it can never throw.
  // We DON'T call it here; we just try to surface a decode() we can invoke on demand.
  // ------------------------------------------------------------------
  window.__CATAN3D__ = window.__CATAN3D__ || {};
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "CATAN3D_REQ") return;
    // reserved for future request/response (e.g. "decode this via native module")
  });
})();
