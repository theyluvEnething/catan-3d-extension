/**
 * protocol/encode.js — MessagePack ENCODER for the Colonist.io wire protocol.
 *
 * Companion to decode.js. Covers exactly the value types Colonist round-trips: null, bool,
 * int (fixint / uint8-32 / int8-32 / float64 for big ints), float64, string, Date (timestamp64
 * ext), Uint8Array (bin), array, and object (map). The encoder round-trips every captured
 * incoming frame (encode(decode(x)) re-decodes equal — see test/).
 *
 * Pure ESM. No DOM, no Node, no browser globals.
 */

const _textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

// Encode a JS string to UTF-8 bytes, with a fallback when TextEncoder is unavailable.
export function utf8Encode(s) {
  if (_textEncoder) return _textEncoder.encode(s);
  return Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
}

/** Encode a JS value to a MessagePack Uint8Array. */
export function msgpackEncode(value) {
  const bytes = [];
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
      const s = utf8Encode(v); const n = s.length;
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
