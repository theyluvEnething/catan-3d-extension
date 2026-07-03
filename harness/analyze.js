// Decodes a captured frames.jsonl and writes a human-readable analysis + full decoded
// dumps of key game messages, to help build the state model.
//   node harness/analyze.js [framesDir]
import { msgpackDecode, decodeOutgoing } from "../extension/src/protocol/decode.js";
import fs from "node:fs";
import path from "node:path";

const framesRoot = path.resolve("../debug/frames");
const dir =
  process.argv[2] ||
  path.join(framesRoot, fs.readdirSync(framesRoot).filter((d) => /^\d/.test(d)).sort().pop());
const outDir = path.join(dir, "decoded");
fs.mkdirSync(outDir, { recursive: true });
console.log("Analyzing", dir);

const lines = fs.readFileSync(path.join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const incoming = [];
const outgoing = [];
for (const l of lines) {
  if (l.kind !== "binary") {
    if (l.kind === "text") incoming.push({ dir: l.dir, t: l.t, text: l.text, transport: "text" });
    continue;
  }
  const buf = Buffer.from(l.b64, "base64");
  try {
    if (l.dir === "in") {
      const m = msgpackDecode(buf);
      incoming.push({ t: l.t, id: m.id, type: m.data && m.data.type, payload: m.data && m.data.payload, sequence: m.data && m.data.sequence });
    } else {
      const d = decodeOutgoing(buf);
      outgoing.push({ t: l.t, ...d });
    }
  } catch (e) {
    console.warn("decode fail", l.dir, buf.length, e.message);
  }
}

// Full decoded streams (game only: id 130) for eyeballing.
const game = incoming.filter((m) => m.id === "130");
fs.writeFileSync(path.join(outDir, "incoming-game.json"), JSON.stringify(game, null, 2));
fs.writeFileSync(path.join(outDir, "incoming-all.json"), JSON.stringify(incoming, null, 2));
fs.writeFileSync(path.join(outDir, "outgoing-all.json"), JSON.stringify(outgoing, null, 2), (k, v) =>
  v instanceof Uint8Array ? Array.from(v) : v
);

// Type histogram for the game stream.
const hist = {};
for (const m of game) {
  const k = "type" + m.type;
  hist[k] = (hist[k] || 0) + 1;
}
console.log("game(id130) type histogram:", hist);
console.log("wrote", outDir);
export {};
