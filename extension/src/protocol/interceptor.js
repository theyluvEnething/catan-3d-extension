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
 * SEQUENCE OWNERSHIP (the reconnect fix) ─────────────────────────────────────────────────────
 * Colonist's game-channel frames ([0x03][0x01][strlen][channel][msgpack {action,payload,sequence}])
 * carry a single per-game `sequence` counter that the SERVER enforces as strictly monotonic and
 * gap-free. Colonist's own untouched client streams frames on that counter CONSTANTLY (mostly
 * action-66 hover/preview echoes). When our extension also injects frames on the same channel, we
 * and Colonist's client become TWO independent writers to one counter — Colonist's client never
 * sees our sends, so its next frame reuses a sequence we already consumed → duplicate/gap → the
 * server forces a reconnect. (Verified from a full-game capture: sequence 2,3,4,…,27 gap-free,
 * 18/26 game frames were action-66.)
 *
 * FIX: this MAIN-world choke point takes FULL OWNERSHIP of `sequence`. EVERY outgoing 0x03 frame —
 * Colonist's own frames AND our injected ones — is renumbered here from ONE authoritative counter
 * right before it hits the wire. One writer ⇒ always gap-free ⇒ no reconnect. Because `sequence`
 * is always the LAST field of the msgpack body (key order action, payload, sequence — verified),
 * we don't re-encode the whole body: we find the trailing `"sequence"` key and rewrite just the
 * integer after it. action/payload/channel/headers stay byte-for-byte identical. The engine's own
 * sequence guess becomes irrelevant — MAIN overwrites it.
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
  function b64ToU8(b64) {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ── Sequence rewriting ──────────────────────────────────────────────────────────────────────
  // The msgpack key "sequence" as fixstr(8): 0xa8 'sequence'. It is always the LAST field of a
  // game-frame body, so everything after this marker is the sequence value (and nothing else).
  const SEQ_KEY = [0xa8, 0x73, 0x65, 0x71, 0x75, 0x65, 0x6e, 0x63, 0x65]; // 0xa8 + "sequence"

  // Encode one non-negative integer as MessagePack (fixint / uint8 / uint16 / uint32).
  function encodeUintMsgpack(n) {
    if (n < 0x80) return [n & 0xff];                                  // positive fixint
    if (n <= 0xff) return [0xcc, n & 0xff];                            // uint8
    if (n <= 0xffff) return [0xcd, (n >> 8) & 0xff, n & 0xff];         // uint16
    return [0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; // uint32
  }

  // Find the byte index where the "sequence" KEY starts in a 0x03 frame body region. Searches from
  // the end (the key is near the tail) for the 9-byte marker. Returns -1 if not found.
  function findSeqKey(u8) {
    outer:
    for (let i = u8.length - SEQ_KEY.length; i >= 0; i--) {
      for (let j = 0; j < SEQ_KEY.length; j++) if (u8[i + j] !== SEQ_KEY[j]) continue outer;
      return i;
    }
    return -1;
  }

  // Rewrite the trailing sequence of a 0x03 game frame to `seq`. Returns a NEW Uint8Array (or the
  // original if this isn't a rewritable game frame). The value sits immediately after the key and
  // runs to the end of the frame, so we splice [head .. keyEnd] + freshly-encoded seq.
  function rewriteSequence(u8, seq) {
    if (!u8 || u8[0] !== 0x03) return u8;
    const keyStart = findSeqKey(u8);
    if (keyStart < 0) return u8; // not the shape we expect — leave untouched
    const head = u8.subarray(0, keyStart + SEQ_KEY.length); // up to and including the key bytes
    const val = encodeUintMsgpack(seq);
    const out = new Uint8Array(head.length + val.length);
    out.set(head, 0);
    out.set(val, head.length);
    return out;
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

  // --- SOCKET + AUTHORITATIVE SEQUENCE (MAIN world owns the real socket) ---------------------
  // `outSeq` is the single source of truth for the game-channel sequence. It advances by exactly 1
  // per outgoing 0x03 frame regardless of who authored it (Colonist's client or us), so the wire
  // counter is always gap-free. Reset to 0 whenever a fresh game socket opens.
  const wire = { socket: null, outSeq: 0 };

  // Serialize ONE outgoing frame: if it's a 0x03 game frame, stamp it with the next authoritative
  // sequence (rewriting the trailing sequence field) before it goes on the wire. Non-game frames
  // (0x02 lobby / 0x04 direct / text) pass through untouched. `raw` is the bytes as produced by the
  // caller (Colonist or our engine). Returns the exact bytes that were/should be sent.
  function stampGameFrame(raw) {
    try {
      let u8 = null;
      if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
      else if (ArrayBuffer.isView(raw)) u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      if (u8 && u8[0] === 0x03) {
        const next = wire.outSeq + 1;
        const stamped = rewriteSequence(u8, next);
        wire.outSeq = next;
        return stamped;
      }
    } catch (e) { console.warn(TAG, "stamp failed", e); }
    return raw;
  }

  function PatchedWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    try {
      console.debug(TAG, "socket opened:", args[0]);
      socket.addEventListener("message", (ev) => normalizeAndPost("in", ev.data));
    } catch (e) {
      console.warn(TAG, "attach listener failed", e);
    }

    const nativeSend = socket.send;

    // Wrap send (client -> server). For 0x03 game frames we RENUMBER the sequence from our single
    // authoritative counter, then forward a copy of the FINAL (renumbered) bytes to ISOLATED so the
    // engine sees exactly what went on the wire, then send those final bytes. Non-game frames are
    // captured + sent unchanged.
    socket.send = function (data) {
      let outData = data;
      try {
        let u8 = null;
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (u8 && u8[0] === 0x03) {
          wire.socket = socket; wire._nativeSend = nativeSend;
          outData = stampGameFrame(u8);
        }
      } catch {}
      normalizeAndPost("out", outData);
      return nativeSend.call(this, outData);
    };

    // Track the socket + RESET the sequence as soon as a fresh socket opens (new game/session).
    try {
      socket.addEventListener("open", () => {
        wire.socket = socket; wire._nativeSend = nativeSend; wire.outSeq = 0;
        console.debug(TAG, "socket open — sequence counter reset to 0");
      });
    } catch {}
    return socket;
  }

  // Preserve statics/prototype so page code that reads WebSocket.OPEN etc. still works.
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => {
    try { PatchedWebSocket[k] = NativeWebSocket[k]; } catch {}
  });

  window.WebSocket = PatchedWebSocket;
  console.info(TAG, "WebSocket patched at document_start (MAIN owns game sequence)");

  // Transmit bytes the engine encoded. These are ALSO renumbered through the same authoritative
  // counter (so the engine's own sequence guess is irrelevant — MAIN is the single writer). We
  // forward the FINAL bytes to ISOLATED for decoding, matching the send-wrapper behavior.
  function transmitBytes(u8) {
    if (!wire.socket || wire.socket.readyState !== 1) return { ok: false, error: "socket not open" };
    try {
      const outData = stampGameFrame(u8);
      normalizeAndPost("out", outData);
      (wire._nativeSend || wire.socket.send).call(wire.socket, outData);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  window.__CATAN3D__ = window.__CATAN3D__ || {};
  window.__CATAN3D__.transmit = (u8) => transmitBytes(u8);
  window.__CATAN3D__.wire = () => ({ open: wire.socket && wire.socket.readyState === 1, outSeq: wire.outSeq });

  // Bridge: isolated posts { source:'CATAN3D_TRANSMIT', b64 } → we renumber + send those bytes.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.source === "CATAN3D_TRANSMIT" && d.b64) {
      transmitBytes(b64ToU8(d.b64));
    }
  });
})();
