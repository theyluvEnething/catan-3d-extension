/**
 * seq-rewrite.test.js — proves the MAIN-world sequence-rewriting logic (the reconnect fix) is
 * byte-safe: rewriting the trailing `sequence` field of a 0x03 game frame changes ONLY the
 * sequence and preserves action + payload exactly, and a stream of frames renumbered through one
 * authoritative counter comes out strictly monotonic and gap-free.
 *
 * The rewrite functions live inlined in extension/src/protocol/interceptor.js (a MAIN-world
 * classic script that can't import). This test re-implements the SAME small algorithm and checks
 * it against the real capture — if the algorithm here diverges from the interceptor, update both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MsgpackDecoder } from "../src/protocol/decode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures", "fullgame.jsonl");
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

// ---- the algorithm under test (mirror of interceptor.js) ------------------------------------
const SEQ_KEY = [0xa8, 0x73, 0x65, 0x71, 0x75, 0x65, 0x6e, 0x63, 0x65]; // 0xa8 + "sequence"

function encodeUintMsgpack(n) {
  if (n < 0x80) return [n & 0xff];
  if (n <= 0xff) return [0xcc, n & 0xff];
  if (n <= 0xffff) return [0xcd, (n >> 8) & 0xff, n & 0xff];
  return [0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function findSeqKey(u8) {
  outer:
  for (let i = u8.length - SEQ_KEY.length; i >= 0; i--) {
    for (let j = 0; j < SEQ_KEY.length; j++) if (u8[i + j] !== SEQ_KEY[j]) continue outer;
    return i;
  }
  return -1;
}
function rewriteSequence(u8, seq) {
  if (!u8 || u8[0] !== 0x03) return u8;
  const keyStart = findSeqKey(u8);
  if (keyStart < 0) return u8;
  const head = u8.subarray(0, keyStart + SEQ_KEY.length);
  const val = encodeUintMsgpack(seq);
  const out = new Uint8Array(head.length + val.length);
  out.set(head, 0);
  out.set(val, head.length);
  return out;
}

function decodeBody(frameU8) {
  const strlen = frameU8[2];
  return new MsgpackDecoder(frameU8.subarray(3 + strlen)).decode();
}

function gameFrames() {
  const lines = fs.readFileSync(fixture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return lines
    .filter((l) => l.dir === "out" && l.kind === "binary" && l.b64)
    .map((l) => b64ToU8(l.b64))
    .filter((u8) => u8[0] === 0x03);
}

test("rewriteSequence preserves action + payload, changes only sequence", () => {
  const frames = gameFrames();
  assert.ok(frames.length >= 10, "need game frames in the fixture");
  for (const f of frames) {
    const before = decodeBody(f);
    const rewritten = rewriteSequence(f, 999);
    const after = decodeBody(rewritten);
    assert.equal(after.action, before.action, "action must be unchanged");
    assert.deepEqual(after.payload, before.payload, "payload must be unchanged");
    assert.equal(after.sequence, 999, "sequence must be the new value");
  }
});

test("rewriteSequence is byte-identical to the original except the sequence tail", () => {
  const frames = gameFrames();
  for (const f of frames) {
    const orig = decodeBody(f).sequence;
    // Rewrite to the SAME sequence value → must reproduce the original bytes exactly.
    const same = rewriteSequence(f, orig);
    assert.equal(same.length, f.length, "same-seq rewrite must not change length");
    assert.deepEqual([...same], [...f], "same-seq rewrite must be byte-identical");
  }
});

test("renumbering a stream through one counter is monotonic + gap-free", () => {
  const frames = gameFrames();
  let outSeq = 0;
  const seen = [];
  for (const f of frames) {
    const next = outSeq + 1;
    const stamped = rewriteSequence(f, next);
    outSeq = next;
    seen.push(decodeBody(stamped).sequence);
  }
  // strictly 1,2,3,...,N
  for (let i = 0; i < seen.length; i++) assert.equal(seen[i], i + 1, `frame ${i} should be seq ${i + 1}`);
});

test("wide sequence values (uint8/uint16) encode + round-trip", () => {
  const frames = gameFrames();
  const f = frames[0];
  for (const v of [1, 127, 128, 200, 255, 256, 5000, 65535, 70000]) {
    const rw = rewriteSequence(f, v);
    assert.equal(decodeBody(rw).sequence, v, `sequence ${v} must round-trip`);
  }
});
