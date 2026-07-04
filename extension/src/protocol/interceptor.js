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

  // --- DIRECT-SEND wiring (MAIN world owns the real socket) --------------------------------
  // The isolated content script (Forwarder) can't touch the page socket, so it posts a
  // CATAN3D_SEND request and we emit the real build message here. We sniff outgoing game
  // frames just enough to learn the channel (serverId) + latest sequence, without a full
  // decoder: game frame = [0x03][0x01][strlen][channel bytes][msgpack {action,payload,sequence}].
  const wire = { socket: null, channel: null, sequence: 0 };

  function sniffOutgoing(u8, socket) {
    try {
      if (!u8 || u8.length < 4 || u8[0] !== 0x03) return;
      const strlen = u8[2];
      let channel = "";
      for (let i = 0; i < strlen; i++) channel += String.fromCharCode(u8[3 + i]);
      wire.channel = channel; wire.socket = socket;
      // find "sequence" fixstr key then its uint value in the msgpack tail (best-effort).
      const tail = u8.subarray(3 + strlen);
      // scan for the 8-byte "sequence" fixstr (0xa8 + 'sequence')
      for (let i = 0; i + 9 < tail.length; i++) {
        if (tail[i] === 0xa8 && tail[i + 1] === 0x73 && tail[i + 2] === 0x65 && tail[i + 3] === 0x71) {
          const vb = tail[i + 9]; // value byte after the 8-char key
          if (vb < 0x80) { wire.sequence = vb; }
          else if (vb === 0xcc) wire.sequence = tail[i + 10];
          else if (vb === 0xcd) wire.sequence = (tail[i + 10] << 8) | tail[i + 11];
          break;
        }
      }
    } catch {}
  }

  // Minimal msgpack encoder for {action, payload, sequence} where values are small ints / null
  // / true / false. Sufficient for build/roll/robber/etc. actions.
  function mpEncodeBuildBody(action, payload, sequence) {
    const bytes = [];
    const pushInt = (n) => {
      if (n >= 0 && n < 0x80) bytes.push(n);
      else if (n >= 0 && n <= 0xff) bytes.push(0xcc, n);
      else if (n >= 0 && n <= 0xffff) bytes.push(0xcd, (n >> 8) & 0xff, n & 0xff);
      else bytes.push(0xce, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    };
    const pushStr = (s) => { bytes.push(0xa0 | s.length); for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
    const pushVal = (v) => {
      if (v === null || v === undefined) bytes.push(0xc0);
      else if (v === true) bytes.push(0xc3);
      else if (v === false) bytes.push(0xc2);
      else if (typeof v === "number") pushInt(v);
      else pushStr(String(v));
    };
    bytes.push(0x83); // fixmap of 3
    pushStr("action"); pushVal(action);
    pushStr("payload"); pushVal(payload);
    pushStr("sequence"); pushVal(sequence);
    return Uint8Array.from(bytes);
  }

  function sendGameAction(action, payload) {
    if (!wire.socket || !wire.channel) return { ok: false, error: "no game socket/channel" };
    if (wire.socket.readyState !== 1) return { ok: false, error: "socket not open" };
    const sequence = (wire.sequence || 0) + 1;
    const chan = Uint8Array.from(wire.channel, (c) => c.charCodeAt(0));
    const body = mpEncodeBuildBody(action, payload, sequence);
    const out = new Uint8Array(3 + chan.length + body.length);
    out[0] = 0x03; out[1] = 0x01; out[2] = chan.length;
    out.set(chan, 3); out.set(body, 3 + chan.length);
    try { wire._nativeSend.call(wire.socket, out); wire.sequence = sequence; return { ok: true, action, payload, sequence }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
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
      try {
        let u8 = null;
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (u8) { sniffOutgoing(u8, socket); wire._nativeSend = nativeSend; }
      } catch {}
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
  // Also expose direct-send in the MAIN world for debugging / the harness.
  window.__CATAN3D__.sendGameAction = sendGameAction;
  window.__CATAN3D__.buildSettlement = (i) => sendGameAction(15, i);
  window.__CATAN3D__.buildRoad = (i) => sendGameAction(11, i);
  window.__CATAN3D__.wire = () => ({ channel: wire.channel, sequence: wire.sequence, open: wire.socket && wire.socket.readyState === 1 });

  // Bridge: isolated content script posts { source:'CATAN3D_SEND', action, payload, reqId };
  // we perform the real send and post back { source:'CATAN3D_SEND_RESULT', reqId, result }.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.source === "CATAN3D_SEND") {
      const result = sendGameAction(d.action, d.payload);
      window.postMessage({ source: "CATAN3D_SEND_RESULT", reqId: d.reqId, result }, window.location.origin);
    }
  });
})();
