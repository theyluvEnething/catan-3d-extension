// Replays a captured frames.jsonl through the ACTUAL state model (extension/src/state)
// and prints the reconstructed board/players — proving the model applies snapshot+diffs
// correctly. This is the offline half of GATE 1.
//   node harness/replay.js [framesDir]
import { decodeFrame } from "../extension/src/protocol/decode.js";
import { GameState } from "../extension/src/state/gameState.js";
import fs from "node:fs";
import path from "node:path";

const framesRoot = path.resolve("../debug/frames");
const dir =
  process.argv[2] ||
  path.join(framesRoot, fs.readdirSync(framesRoot).filter((d) => /^\d/.test(d)).sort().pop());
console.log("Replaying", dir);

const lines = fs.readFileSync(path.join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const gs = new GameState();

let applied = 0, diffs = 0, snaps = 0;
for (const l of lines) {
  if (l.dir !== "in") continue;
  const frame = { dir: "in", kind: l.kind, text: l.text, b64: l.b64 };
  let decoded;
  try { decoded = decodeFrame(frame); } catch { continue; }
  if (l.kind === "text") continue;
  if (decoded.id !== "130") continue;
  if (decoded.type === 4) snaps++;
  if (decoded.type === 91) diffs++;
  gs.applyIncoming(decoded);
  applied++;
}

console.log(`\napplied ${applied} game msgs (${snaps} snapshots, ${diffs} diffs)`);
console.log("ready:", gs.ready, "us:", gs.us, "playOrder:", gs.playOrder);
console.log("turn:", gs.currentTurnColor, "completedTurns:", gs.completedTurns, "actionState:", gs.actionState);
console.log("robber tile:", gs.robberTileIndex);
console.log("dice:", JSON.stringify(gs.dice));

const b = gs.buildings();
console.log(`\nBUILDINGS: ${b.settlements.length} settlements, ${b.cities.length} cities, ${b.roads.length} roads`);
for (const s of b.settlements) console.log(`  settlement color${s.color} @corner${s.cornerIndex}`);
for (const c of b.cities) console.log(`  city color${c.color} @corner${c.cornerIndex}`);
for (const r of b.roads) console.log(`  road color${r.color} @edge${r.edgeIndex}`);

console.log(`\nHEXES: ${gs.hexes.length}, CORNERS: ${gs.corners.length}, EDGES: ${gs.edges.length}, PORTS: ${gs.ports.length}`);
console.log("player colors:", gs.playerColors);

// Dump the fully-reconstructed final gameState for inspection.
fs.writeFileSync(path.join(dir, "reconstructed.json"), JSON.stringify(gs.gameState, null, 2));
console.log("\nwrote reconstructed.json");
