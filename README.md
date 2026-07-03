# Catan 3D — Colonist.io 3D Board (MV3 extension)

Replaces Colonist.io's 2D board with a real-time 3D board rendered in Three.js, driven purely
by intercepted WebSocket traffic. Personal visualization/enhancement tool.

Status: **Phase 1 complete (Gate 1 passed)** — live, provably-accurate game-state
reconstruction + on-page debug HUD. Phases 2 (3D render) and 3 (interactions) are next.

## Repo layout
```
extension/                 unpacked MV3 extension (load this in Chrome)
  manifest.json
  src/protocol/interceptor.js   MAIN-world WebSocket patch (document_start)
  src/protocol/decode.js        MessagePack + Colonist framing codec (the protocol module)
  src/state/gameState.js        snapshot + diff -> full reconstructed game state
  src/render/hud.js             on-page debug HUD (Alt+H to toggle)
  src/render/boardGeometry.js   hex-grid math (axial/corner/edge) for 3D + interactions
  src/content.js                isolated-world bootstrap (loads the modules)
harness/                   Playwright dev harness (drives real Chrome)
NOTES.md                   SOURCE OF TRUTH: protocol schema, coordinates, gate evidence
debug/frames/              captured WebSocket frame dumps (JSONL)
debug/screenshots/         gate screenshots (HUD vs board)
```

## Load the extension (your normal Chrome)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open https://colonist.io and start a game. The debug HUD appears top-left (toggle **Alt+H**).

> Note: command-line `--load-extension` is blocked on Chrome 137+ (stable). "Load unpacked"
> from the Extensions page is the supported way and works fine. The dev harness therefore
> injects the same runtime via Playwright (see below) instead of relying on `--load-extension`.

## Run the harness (development)
Prereqs: Node 22+, the dedicated profile logged into Colonist.
```
cd harness
npm install
node login-once.js        # ONE TIME: log into Colonist in the dedicated ./.colonist-profile
node capture.js           # start a bot game and dump every WebSocket frame to debug/frames/
node verify-decode.js     # prove decode.js matches @msgpack/msgpack on captured frames
node analyze.js           # decode a capture into readable JSON (debug/frames/<run>/decoded)
node replay.js            # replay a capture through the state model, print reconstructed board
node validate-live.js     # start a game, checkpoint HUD-vs-board agreement (Gate-1 evidence)
node autoplay.js          # minimal auto-player that drives a bot game (for full-game capture)
```

## How it works
- **Interceptor** (MAIN world, `document_start`) monkey-patches `window.WebSocket` before
  Colonist opens its socket, capturing both directions and bridging frames to the isolated
  world via `postMessage`.
- **Protocol** (`src/protocol/decode.js`): Colonist speaks **MessagePack**. Incoming frames are
  bare msgpack `{id, data:{type, payload}}`; outgoing frames are `[b0][seq][strlen][channel]`
  + msgpack body. All protocol-specific logic is isolated here.
- **State** (`src/state/gameState.js`): applies the type-4 full snapshot, then deep-merges
  type-91 incremental diffs, maintaining the full board + players + turn/phase model.
- **HUD** (`src/render/hud.js`): renders the reconstructed state live for verification.

See `NOTES.md` for the full discovered schema, coordinate system, and gate evidence.

## Known limitations (Phase 1)
- No 3D rendering yet (Phase 2) and no interaction/placement via a 3D view yet (Phase 3).
- Resource color↔type: desert/brick/ore verified; wood/sheep/wheat read from screenshots
  (to be confirmed when Phase-2 tiles render side-by-side).
- The dev harness injects the runtime (Chrome blocks CLI `--load-extension`); the shipped
  extension loads normally via "Load unpacked".
- Auto-player plays minimally (passes turns), so captured games end via bot victory over a long
  horizon rather than a quick finish; enough to validate reconstruction across all phases.
