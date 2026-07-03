// Proves src/protocol/decode.js is correct by comparing it against the reference
// @msgpack/msgpack decoder over EVERY captured frame, both directions.
//
//   node harness/verify-decode.js [framesDir]
import { decode as refDecode } from "@msgpack/msgpack";
import { msgpackDecode, decodeFrame, decodeOutgoing, msgpackEncode } from "../extension/src/protocol/decode.js";
import fs from "node:fs";
import path from "node:path";

const framesRoot = path.resolve("../debug/frames");
const dir =
  process.argv[2] ||
  path.join(framesRoot, fs.readdirSync(framesRoot).filter((d) => /^\d/.test(d)).sort().pop());
const file = path.join(dir, "frames.jsonl");
console.log("Verifying", file);

const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bin = lines.filter((l) => l.kind === "binary");

let ok = 0, fail = 0;
const failures = [];
// Deep-equal that treats Uint8Array and BigInt sensibly.
function eq(a, b) {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      const A = Uint8Array.from(a), B = Uint8Array.from(b);
      return A.length === B.length && A.every((x, i) => x === B[i]);
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => eq(a[k], b[k]));
  }
  return false;
}

for (const l of bin) {
  const buf = Buffer.from(l.b64, "base64");
  try {
    if (l.dir === "in") {
      const mine = msgpackDecode(buf);
      const ref = refDecode(buf);
      if (eq(mine, ref)) ok++;
      else { fail++; failures.push({ dir: l.dir, len: buf.length, reason: "mismatch", mine: JSON.stringify(mine).slice(0, 120), ref: JSON.stringify(ref).slice(0, 120) }); }
    } else {
      // outgoing: strip framing header, compare body decode
      const strlen = buf[2];
      const body = buf.subarray(3 + strlen);
      const mine = decodeOutgoing(buf).body;
      const ref = refDecode(body);
      if (eq(mine, ref)) ok++;
      else { fail++; failures.push({ dir: l.dir, len: buf.length, reason: "mismatch", mine: JSON.stringify(mine).slice(0, 120), ref: JSON.stringify(ref).slice(0, 120) }); }
    }
  } catch (e) {
    fail++;
    failures.push({ dir: l.dir, len: buf.length, reason: "threw: " + e.message.slice(0, 80) });
  }
}

// Encoder round-trip: encode(decode(x)) should re-decode to the same value.
let encOk = 0, encFail = 0;
for (const l of bin.filter((x) => x.dir === "in")) {
  const buf = Buffer.from(l.b64, "base64");
  try {
    const obj = msgpackDecode(buf);
    const re = msgpackDecode(msgpackEncode(obj));
    if (eq(obj, re)) encOk++; else encFail++;
  } catch { encFail++; }
}

console.log(`\nDECODE  ok=${ok} fail=${fail}  (of ${bin.length} binary frames)`);
console.log(`ENCODE  round-trip ok=${encOk} fail=${encFail}`);
if (failures.length) {
  console.log("\nFAILURES (first 10):");
  for (const f of failures.slice(0, 10)) console.log("  ", JSON.stringify(f));
  process.exit(1);
}
console.log("\n✅ decode.js matches @msgpack/msgpack on ALL frames, both directions.");
