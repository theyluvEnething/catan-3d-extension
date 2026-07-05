/**
 * protocol/frames.js — Colonist.io frame framing (on top of MessagePack).
 *
 * VERIFIED framing (repo NOTES.md §2):
 *   - Handshake: 2 TEXT JSON frames ({type:"Connected"...}, {type:"SessionEstablished"}).
 *   - Incoming binary: bare MessagePack  ->  { id, data:{ type, payload, sequence? } }.
 *   - Outgoing binary: [b0][seq][strlen][channel(strlen)][msgpack body].
 *       b0=0x02 channel message, body = { action, payload }.
 *       b0=0x03 GAME-channel message, body = { action, payload, sequence } (direct-send).
 *       b0=0x04 direct  message, body = { id, data }.
 *
 * `encodeChannel` produces the byte-exact game-channel frame verified against captured build
 * frames: [0x03][0x01][strlen][channel bytes][msgpack {action, payload, sequence}].
 *
 * Pure ESM. base64 helpers feature-detect atob/btoa (present in browsers AND Node 16+) with a
 * pure fallback, so this module carries no hidden environment dependency.
 */
import { MsgpackDecoder, msgpackDecode } from "./decode.js";
import { msgpackEncode, utf8Encode } from "./encode.js";

/**
 * Decode a captured/bridged frame into a normalized structure.
 * `frame` = { dir, kind, text?, b64?, bytes? }.
 *   dir  : "in" (server->client) | "out" (client->server)
 *   kind : "text" | "binary"
 * Returns { dir, transport, ...decoded } or a text wrapper.
 */
export function decodeFrame(frame) {
  if (frame.kind === "text") {
    let json = null;
    try { json = JSON.parse(frame.text); } catch {}
    return { dir: frame.dir, transport: "text", json, raw: frame.text };
  }
  const bytes = frame.bytes != null ? toU8(frame.bytes) : b64ToU8(frame.b64);
  if (frame.dir === "in") {
    // bare msgpack
    const obj = msgpackDecode(bytes);
    return {
      dir: "in",
      transport: "msgpack",
      id: obj && obj.id,
      type: obj && obj.data && obj.data.type,
      payload: obj && obj.data && obj.data.payload,
      sequence: obj && obj.data && obj.data.sequence,
      msg: obj,
    };
  }
  // outgoing: [b0][seq][strlen][channel][msgpack body]
  return decodeOutgoing(bytes);
}

/** Decode an OUTGOING frame's header + msgpack body. */
export function decodeOutgoing(bytes) {
  const u8 = toU8(bytes);
  const b0 = u8[0];
  const seq = u8[1];
  const strlen = u8[2];
  const channel = strlen ? new MsgpackDecoder(u8.subarray(3, 3 + strlen))._str(strlen) : "";
  const body = msgpackDecode(u8.subarray(3 + strlen));
  return {
    dir: "out",
    transport: "colonist-out",
    b0,
    seq,
    channel,
    kind: b0 === 0x02 ? "channel" : b0 === 0x03 ? "game" : b0 === 0x04 ? "direct" : "unknown(" + b0 + ")",
    action: body && body.action,
    payload: body && body.payload,
    body,
  };
}

/**
 * Encode an OUTGOING game-channel message. VERIFIED byte-exact against captured build frames:
 *   [0x03][0x01][strlen][channel bytes][msgpack {action, payload, sequence}]
 * The frame header byte is 0x03 (game channel) and byte[1] is 0x01 (constant on captured
 * frames). `sequence` is the per-channel client counter and MUST be inside the msgpack body.
 *
 * @param channel  game serverId string (e.g. "012B34")
 * @param action   action id (15=settlement, 11=road, ...)
 * @param payload  board index (cornerIndex / edgeIndex), boolean, object, or null
 * @param sequence per-channel outgoing counter (next value)
 */
export function encodeChannel(channel, action, payload, sequence, b0 = 0x03, hdr1 = 0x01) {
  const chan = utf8Encode(channel);
  const body = msgpackEncode({ action, payload, sequence });
  const out = new Uint8Array(3 + chan.length + body.length);
  out[0] = b0; out[1] = hdr1; out[2] = chan.length;
  out.set(chan, 3);
  out.set(body, 3 + chan.length);
  return out;
}

// ----------------------------- helpers -------------------------------------

// base64 -> Uint8Array. Uses atob when present (browser + Node), else a pure decoder.
export function b64ToU8(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return _b64DecodePure(b64);
}

// Uint8Array -> base64. Uses btoa when present, else a pure encoder.
export function u8ToB64(bytes) {
  const u8 = toU8(bytes);
  if (typeof btoa === "function") {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  return _b64EncodePure(u8);
}

export function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return Uint8Array.from(x);
}

// --- pure base64 (only used when atob/btoa are unavailable) ---
const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _b64EncodePure(u8) {
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const b0 = u8[i], b1 = u8[i + 1], b2 = u8[i + 2];
    out += _B64[b0 >> 2];
    out += _B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : _B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : _B64[b2 & 63];
  }
  return out;
}
function _b64DecodePure(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const u8 = new Uint8Array(len);
  let p = 0, acc = 0, accBits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | _B64.indexOf(clean[i]);
    accBits += 6;
    if (accBits >= 8) { accBits -= 8; u8[p++] = (acc >> accBits) & 0xff; }
  }
  return u8;
}
