/**
 * src/protocol/decode.js — Colonist.io wire protocol (isolated).
 *
 * VERIFIED encoding (see NOTES.md §2):
 *   - Handshake: 2 TEXT JSON frames ({type:"Connected"...}, {type:"SessionEstablished"}).
 *   - Incoming binary: bare MessagePack  ->  { id, data:{ type, payload, sequence? } }.
 *   - Outgoing binary: [b0][seq][strlen][channel(strlen)][msgpack body].
 *       b0=0x02 channel message, body = { action, payload }.
 *       b0=0x04 direct  message, body = { id, data }.
 *
 * This module is dependency-free (no remote code, MV3-safe). It contains a compact
 * MessagePack implementation covering exactly the types Colonist uses (maps, arrays,
 * strings, ints, floats, bool, null, bin). Validated byte-for-byte against
 * @msgpack/msgpack over every captured frame (harness/verify-decode.js).
 *
 * When Colonist changes its wire format, THIS is the file to update.
 */

// ----------------------------- MessagePack ---------------------------------
const _textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const _textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export class MsgpackDecoder {
  constructor(buf) {
    // Accept ArrayBuffer, TypedArray, or Node Buffer.
    if (buf instanceof ArrayBuffer) this.u8 = new Uint8Array(buf);
    else if (ArrayBuffer.isView(buf)) this.u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    else this.u8 = Uint8Array.from(buf);
    this.view = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.pos = 0;
  }
  _u8() { return this.u8[this.pos++]; }
  _str(len) {
    const s = this.u8.subarray(this.pos, this.pos + len);
    this.pos += len;
    if (_textDecoder) return _textDecoder.decode(s);
    let out = "";
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
    return decodeURIComponent(escape(out));
  }
  _bin(len) {
    const b = this.u8.slice(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  decode() {
    const v = this.view;
    const c = this._u8();
    // positive fixint
    if (c < 0x80) return c;
    // fixmap
    if (c >= 0x80 && c <= 0x8f) return this._map(c & 0x0f);
    // fixarray
    if (c >= 0x90 && c <= 0x9f) return this._arr(c & 0x0f);
    // fixstr
    if (c >= 0xa0 && c <= 0xbf) return this._str(c & 0x1f);
    // negative fixint
    if (c >= 0xe0) return c - 0x100;
    switch (c) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = this._u8(); return this._bin(n); }              // bin8
      case 0xc5: { const n = v.getUint16(this.pos); this.pos += 2; return this._bin(n); } // bin16
      case 0xc6: { const n = v.getUint32(this.pos); this.pos += 4; return this._bin(n); } // bin32
      case 0xca: { const f = v.getFloat32(this.pos); this.pos += 4; return f; }
      case 0xcb: { const f = v.getFloat64(this.pos); this.pos += 8; return f; }
      case 0xcc: return this._u8();                                          // uint8
      case 0xcd: { const n = v.getUint16(this.pos); this.pos += 2; return n; }
      case 0xce: { const n = v.getUint32(this.pos); this.pos += 4; return n; }
      case 0xcf: { const n = v.getBigUint64(this.pos); this.pos += 8; return _bigToNum(n); }
      case 0xd0: { const n = v.getInt8(this.pos); this.pos += 1; return n; }
      case 0xd1: { const n = v.getInt16(this.pos); this.pos += 2; return n; }
      case 0xd2: { const n = v.getInt32(this.pos); this.pos += 4; return n; }
      case 0xd3: { const n = v.getBigInt64(this.pos); this.pos += 8; return _bigToNum(n); }
      case 0xd9: { const n = this._u8(); return this._str(n); }              // str8
      case 0xda: { const n = v.getUint16(this.pos); this.pos += 2; return this._str(n); } // str16
      case 0xdb: { const n = v.getUint32(this.pos); this.pos += 4; return this._str(n); } // str32
      case 0xdc: { const n = v.getUint16(this.pos); this.pos += 2; return this._arr(n); } // array16
      case 0xdd: { const n = v.getUint32(this.pos); this.pos += 4; return this._arr(n); } // array32
      case 0xde: { const n = v.getUint16(this.pos); this.pos += 2; return this._map(n); } // map16
      case 0xdf: { const n = v.getUint32(this.pos); this.pos += 4; return this._map(n); } // map32
      // fixext / ext (timestamp etc.) — Colonist sends ISO strings, but handle ext1..8 defensively
      case 0xd4: return this._ext(1);
      case 0xd5: return this._ext(2);
      case 0xd6: return this._ext(4);
      case 0xd7: return this._ext(8);
      case 0xd8: return this._ext(16);
      case 0xc7: { const n = this._u8(); return this._ext(n); }
      case 0xc8: { const n = v.getUint16(this.pos); this.pos += 2; return this._ext(n); }
      case 0xc9: { const n = v.getUint32(this.pos); this.pos += 4; return this._ext(n); }
      default:
        throw new Error("msgpack: unknown byte 0x" + c.toString(16) + " @" + (this.pos - 1));
    }
  }
  _ext(len) {
    const type = this.view.getInt8(this.pos); this.pos += 1;
    const data = this._bin(len);
    // Timestamp extension (-1) — spec §timestamp. Decode to a JS Date (matches the
    // reference @msgpack/msgpack, and Colonist uses these for date fields).
    if (type === -1) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (len === 4) {
        // timestamp32: seconds since epoch (uint32)
        return new Date(dv.getUint32(0) * 1000);
      }
      if (len === 8) {
        // timestamp64: 30-bit nanoseconds + 34-bit seconds packed into 64 bits
        const lo = dv.getUint32(0); // high 32
        const hi = dv.getUint32(4); // low 32
        const combined = BigInt(lo) * 4294967296n + BigInt(hi);
        const nsec = Number(combined >> 34n);
        const sec = Number(combined & 0x3ffffffffn);
        return new Date(sec * 1000 + Math.floor(nsec / 1e6));
      }
      if (len === 12) {
        // timestamp96: 32-bit nanoseconds + 64-bit seconds
        const nsec = dv.getUint32(0);
        const sec = Number(dv.getBigInt64(4));
        return new Date(sec * 1000 + Math.floor(nsec / 1e6));
      }
    }
    return { __ext: type, data };
  }
  _arr(n) { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = this.decode(); return out; }
  _map(n) {
    const out = {};
    for (let i = 0; i < n; i++) {
      const k = this.decode();
      out[typeof k === "string" ? k : String(k)] = this.decode();
    }
    return out;
  }
}

function _bigToNum(b) {
  return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(b) : b;
}

export function msgpackDecode(buf) {
  return new MsgpackDecoder(buf).decode();
}

// Minimal MessagePack ENCODER (used for Phase-3 direct-send fallback).
export function msgpackEncode(value) {
  const bytes = [];
  const enc = _textEncoder || { encode: (s) => Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)) };
  const pushU8 = (n) => bytes.push(n & 0xff);
  const pushBE = (n, size) => { for (let i = size - 1; i >= 0; i--) bytes.push((n >>> (8 * i)) & 0xff); };
  function w(v) {
    if (v === null || v === undefined) return pushU8(0xc0);
    if (v === true) return pushU8(0xc3);
    if (v === false) return pushU8(0xc2);
    if (typeof v === "number") {
      if (Number.isInteger(v)) {
        if (v >= 0 && v < 0x80) return pushU8(v);
        if (v < 0 && v >= -32) return pushU8(0x100 + v);
        if (v > 0) {
          if (v <= 0xff) { pushU8(0xcc); return pushU8(v); }
          if (v <= 0xffff) { pushU8(0xcd); return pushBE(v, 2); }
          if (v <= 0xffffffff) { pushU8(0xce); return pushBE(v, 4); }
        } else {
          if (v >= -128) { pushU8(0xd0); return pushU8(0x100 + v); }
          if (v >= -32768) { pushU8(0xd1); return pushBE(0x10000 + v, 2); }
          if (v >= -2147483648) { pushU8(0xd2); return pushBE((v >>> 0), 4); }
        }
        // fall through to float64 for very large ints
      }
      pushU8(0xcb);
      const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v);
      for (let i = 0; i < 8; i++) bytes.push(dv.getUint8(i));
      return;
    }
    if (typeof v === "string") {
      const s = enc.encode(v); const n = s.length;
      if (n < 32) pushU8(0xa0 | n);
      else if (n <= 0xff) { pushU8(0xd9); pushU8(n); }
      else if (n <= 0xffff) { pushU8(0xda); pushBE(n, 2); }
      else { pushU8(0xdb); pushBE(n, 4); }
      for (let i = 0; i < n; i++) bytes.push(s[i]);
      return;
    }
    if (v instanceof Date) {
      // timestamp64 ext (-1)
      const ms = v.getTime();
      const sec = Math.floor(ms / 1000);
      const nsec = (ms % 1000) * 1e6;
      const combined = (BigInt(nsec) << 34n) | BigInt(sec);
      pushU8(0xd7); pushU8(0xff); // fixext8, type -1
      const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, combined);
      for (let i = 0; i < 8; i++) bytes.push(dv.getUint8(i));
      return;
    }
    if (v instanceof Uint8Array) {
      const n = v.length;
      if (n <= 0xff) { pushU8(0xc4); pushU8(n); }
      else if (n <= 0xffff) { pushU8(0xc5); pushBE(n, 2); }
      else { pushU8(0xc6); pushBE(n, 4); }
      for (let i = 0; i < n; i++) bytes.push(v[i]);
      return;
    }
    if (Array.isArray(v)) {
      const n = v.length;
      if (n < 16) pushU8(0x90 | n);
      else if (n <= 0xffff) { pushU8(0xdc); pushBE(n, 2); }
      else { pushU8(0xdd); pushBE(n, 4); }
      for (const item of v) w(item);
      return;
    }
    // object -> map
    const keys = Object.keys(v);
    const n = keys.length;
    if (n < 16) pushU8(0x80 | n);
    else if (n <= 0xffff) { pushU8(0xde); pushBE(n, 2); }
    else { pushU8(0xdf); pushBE(n, 4); }
    for (const k of keys) { w(k); w(v[k]); }
  }
  w(value);
  return Uint8Array.from(bytes);
}

// ----------------------------- Colonist framing ----------------------------

/**
 * Decode a captured frame (from the interceptor bridge or the harness) into a normalized
 * structure. `frame` = { dir, kind, text?, b64?/bytes? }.
 * Returns { dir, transport, ...decoded } or null if it can't be decoded.
 */
export function decodeFrame(frame) {
  if (frame.kind === "text") {
    let json = null;
    try { json = JSON.parse(frame.text); } catch {}
    return { dir: frame.dir, transport: "text", json, raw: frame.text };
  }
  const bytes = frame.bytes ? toU8(frame.bytes) : b64ToU8(frame.b64);
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
    kind: b0 === 0x02 ? "channel" : b0 === 0x04 ? "direct" : "unknown(" + b0 + ")",
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
 * @param payload  board index (cornerIndex / edgeIndex) or null
 * @param sequence per-channel outgoing counter (next value)
 */
export function encodeChannel(channel, action, payload, sequence, b0 = 0x03, hdr1 = 0x01) {
  const chan = (_textEncoder || { encode: (s) => Uint8Array.from(s, (c) => c.charCodeAt(0)) }).encode(channel);
  const body = msgpackEncode({ action, payload, sequence });
  const out = new Uint8Array(3 + chan.length + body.length);
  out[0] = b0; out[1] = hdr1; out[2] = chan.length;
  out.set(chan, 3);
  out.set(body, 3 + chan.length);
  return out;
}

// ----------------------------- helpers -------------------------------------
function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return Uint8Array.from(x);
}
