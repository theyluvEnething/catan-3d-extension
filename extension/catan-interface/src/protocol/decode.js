/**
 * protocol/decode.js — MessagePack DECODER for the Colonist.io wire protocol.
 *
 * VERIFIED (see the repo NOTES.md §2): Colonist's socket carries bare MessagePack after a
 * two-frame TEXT JSON handshake. This module is a compact, dependency-free MessagePack
 * implementation covering exactly the types Colonist uses (maps, arrays, strings, ints,
 * floats, bool, null, bin, and the timestamp ext). It was validated byte-for-byte against
 * the reference @msgpack/msgpack decoder over every captured frame (see test/).
 *
 * Pure ESM. No DOM, no Node, no browser globals — runs identically in both. When Colonist
 * changes its wire format, THIS file (and encode.js / frames.js) is what needs updating.
 */

// TextDecoder is available in both modern browsers and Node (globalThis). Feature-detect so we
// still work if it's somehow absent (fallback hand-decodes UTF-8-ish bytes).
const _textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

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
    try { return decodeURIComponent(escape(out)); } catch { return out; }
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

/** Decode a single MessagePack value from `buf` (ArrayBuffer | TypedArray | Buffer). */
export function msgpackDecode(buf) {
  return new MsgpackDecoder(buf).decode();
}
