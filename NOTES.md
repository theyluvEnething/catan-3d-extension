# NOTES — Colonist.io reverse-engineering source of truth

> Everything here is either **VERIFIED** (checked against live captured frames) or a
> **HYPOTHESIS** (from prior art / inference, not yet confirmed). Never trust a hypothesis
> in code without a verifying capture. When Colonist changes its wire format, the
> `src/protocol/` module is the only thing that should need updating.

Legend: ✅ VERIFIED · 🟡 HYPOTHESIS · ❌ DISPROVEN

---

## 0. Prior art (hints only — must verify)

Source: `github.com/meesg/robottler` (a Colonist bot userscript, likely stale — references
webpack module index 548/540 which will not match the current build).

Key structural hints extracted:

- 🟡 The WebSocket wire format is **NOT plain JSON**. Colonist ships its own
  `encode`/`decode` functions inside a webpack chunk. robottler grabbed them via
  `window.webpackJsonp[0][1][<moduleId>]`. Frames are objects like `{ id, data }` / `{ type, payload, data }`
  serialized to a packed form. → We must discover the encoding empirically (Task 3).
- 🟡 A robust fallback for decoding: borrow Colonist's own `decode` from its webpack runtime
  at runtime instead of reimplementing it. Fragile across builds but always semantically correct.

### 🟡 Outgoing action IDs (from robottler — verify each before use in Phase 3)
| id  | action                  |
|-----|-------------------------|
| 15  | THROW_DICE              |
| 16  | MOVE_ROBBER             |
| 18  | ROB_PLAYER              |
| 19  | PASS_TURN               |
| 20  | SELECT_CARDS (discard)  |
| 21  | BUY_DEVELOPMENT_CARD    |
| 22  | WANT_BUILD_ROAD         |
| 23  | BUILD_ROAD              |
| 25  | WANT_BUILD_SETTLEMENT   |
| 26  | BUILD_SETTLEMENT        |
| 27  | WANT_BUILD_CITY         |
| 28  | BUILD_CITY              |
| 52  | PLAY_DEVELOPMENT_CARD   |
| 54  | CREATE_TRADE            |
| 55  | ACCEPT_TRADE            |
| 57  | REJECT_TRADE            |

### 🟡 Dev card enum (from robottler)
ROBBER=7, VICTORY_POINT=8, MONOPOLY=9, ROAD_BUILDING=10, YEAR_OF_PLENTY=11

---

## 1. Board coordinate system (🟡 from robottler's decoded model — verify against live)

Colonist's decoded game state exposes `board.tileState` with three parallel arrays:

- `tiles`      — hex faces. Each has `hexFace: {x, y}`, a `tileType` (resource enum),
  a `_diceProbability`, and a number token. This is an **axial** coordinate (2 components).
- `tileCorners` (vertices) — each has `hexCorner: {x, y, z}` with **z ∈ {0, 1}**
  (each hex "owns" 2 of the 6 corners; the other 4 belong to neighbours).
- `tileEdges` — each has `hexEdge: {x, y, z}` with **z ∈ {0, 1, 2}**
  (each hex "owns" 3 of its 6 edges).

### 🟡 Adjacency formulas (from robottler board.py — reproduce & verify)

**Tile (x,y) → its 6 corner coordinates:**
```
(x,   y,   0)
(x,   y,   1)
(x+1, y-1, 1)
(x,   y-1, 1)
(x,   y+1, 0)
(x-1, y+1, 0)
```

**Vertex (x,y) → adjacent tiles (which tiles produce for a settlement here):**
```
tile (x, y)
if z == 0:  tiles (x, y-1) and (x+1, y-1)
if z == 1:  tiles (x-1, y+1) and (x, y+1)
```

**Vertex (x,y,z) → its 3 incident edges:**
```
if z == 0:  edges (x, y, 0), (x+1, y-1, 1), (x+1, y-1, 2)
if z == 1:  edges (x, y+1, 0), (x, y+1, 1), (x, y, 2)
```

**Edge (x,y,z) → its 2 endpoint vertices:**
```
if z == 0:  (x, y, 0),   (x, y-1, 1)
if z == 1:  (x, y-1, 1), (x-1, y+1, 0)
if z == 2:  (x-1, y+1, 0), (x, y, 1)
```

> These will drive the 3D hex mesh placement and the raycast→coordinate mapping.
> **Status: unverified.** Confirm x/y ranges and the exact resource/number enums from
> a real initial board snapshot.

### Resource enum (🟡 order unknown — determine from live)
robottler lists WOOD, BRICK, SHEEP, WHEAT, ORE (+ DESERT). Numeric mapping TBD.

---

## 2. Wire encoding — ✅ VERIFIED (MessagePack)

Socket: `wss://socket.svr.colonist.io/?version=2`. **One socket** carries lobby AND game
traffic (no separate game socket). First two frames are plain TEXT JSON handshake:
`{"type":"Connected","userSessionId":"…"}` then `{"type":"SessionEstablished"}`.
Everything after is **binary MessagePack**.

### Incoming (server → client): bare MessagePack ✅
Decodes directly with a standard MessagePack decoder. Shape:
```
{ id: "<numeric string>", data: { type: <int>, payload: <any>, sequence?: <int> } }
```
- `id` routes to a logical stream/request (e.g. "130" = the active game stream).
- `data.type` is the **event/message type discriminator** (see §3).
- `data.payload` is the event body.
- Verified: 273/273 binary incoming frames decode cleanly (round-trip test in
  `harness/verify-decode.js`).

Example decoded incoming (the initial game snapshot):
```
{id:"130", data:{type:4, payload:{playerColor:11, playOrder:[2,11,1,3],
   gameState:{diceState:{…}, bankState:{…}, …}}}}
```

### Outgoing (client → server): channel-framed MessagePack ✅
```
[ b0 ][ seq ][ strlen ][ channel string (strlen bytes) ][ MessagePack body ]
   1     1       1            strlen                          rest
```
- `b0 = 0x02` → **channel message**. `channel` is a string ("lobby" observed). Body =
  `{ action: <int>, payload: <any> }`.
- `b0 = 0x04` → **direct message** (strlen = 0, empty channel). Body = `{ id, data }`
  (e.g. heartbeat `{id:"136", data:{timestamp:<ms>}}`).
- `seq` = per-channel routing/sequence byte (varies: 2, 7, 11…). Exact semantics TBD;
  echoing the server-provided value works.

**Confirmed outgoing examples:**
- Start bot game: channel `lobby`, `{action:2, payload:{clientVersion:311, bots:[0,0,0]}}`
  (3 bots, `0` = Easy difficulty).
- Heartbeat: `b0=4`, `{id:"136", data:{timestamp:<ms>}}` every ~1s.

> 🟡 The robottler action-ID table (§0) referred to GAME-channel actions, not lobby. The
> real game channel name + action map — CAPTURED from live play, see below.

### ✅ OUTGOING GAME ACTIONS — captured from real placement (direct-send format)
Game-channel frame: `b0=3`, `channel = <serverId>` (e.g. "012634"), body =
`{action, payload, sequence}` where `sequence` increments per client message.

| action | meaning | payload |
|--------|---------|---------|
| 66 | hover/preview a corner (mouse-move) | cornerIndex (null = un-hover) — cosmetic |
| **15** | **build settlement** | **cornerIndex** (index into tileCornerStates) |
| **11** | **build road** | **edgeIndex** (index into tileEdgeStates) |
| **2** | **discard card (on a 7)** | **`true`** — one frame per card; count = #cards discarded ✅ |
| 🟡 6 | **end turn / pass** (confidence: med) | `true` — fires on every Spacebar-pass in main phase |
| 🟡 3 | **move robber** (confidence: med) | hexIndex — captured when the robber moved (play-and-capture clone 42) |
| 🟡 67 | subscribe/keepalive (channel string payload) | serverId — NOT a gameplay action |
| ❓ city | city upgrade — still unisolated | (candidates 47/6 both overlap other actions) |

> Payload is the **board index**, NOT a pixel — direct-send needs no calibration.
> `action 2` (discard) uses payload `true`, NOT an index — it is a per-card confirm toggle.
> Roll uses the **Spacebar** UI affordance (works without a direct-send id).
> Still TODO isolate cleanly: city upgrade, steal-target, buy/play dev card, trade.
> VERIFIED end-to-end: full **initial placement** (both settlements + both roads) plays via
> our direct-send + legal-move engine with **zero desync** (harness setuptest).

### ✅ Phase (turnState/actionState) map — captured live
| turnState | actionState | phase |
|-----------|-------------|-------|
| 0 | 1 | place settlement (setup) |
| 0 | 3 | place road (setup) |
| 1 | 0 | **roll dice** (main, pre-roll) |
| 2 | 0 | **build/trade/end-turn** (main, post-roll — "your turn") |
> Use turnState to gate main-phase actions precisely (prompt text is ambiguous).
> End turn = direct-send **action 6** (pass) — Spacebar is unreliable for ending the turn.

**Capture evidence:**
- **discard = 2** ✅ (high): two isolated clone captures — `{action:2,payload:true}` appears
  only in the discard window and its count equals the cards discarded (run1 discarded 3 →
  three frames; run2 discarded 1 → one frame). The leading 15/11 frames are setup noise.
- **city** 🟡 (low): raw commit stream captured was
  `[15/30, 15/31, 11/40, 11/40, 15/50, 15/48, {2,true}, {47,true}, {6,true}]`. The 15s
  (settlement) and 11s (road) are setup noise; `{2,true}` is now known to be *discard/confirm*,
  NOT city. So the actual city-build id is one of `{47, 6}` (both payload `true`) — **not yet
  isolated**. Do NOT rely on this until a clean single-action capture confirms which.
- **roll / pass / robber / buydev** ❌ not captured — every attempt (3 each) crashed before the
  board loaded (`#game-canvas` null; lobby never cleared, "Reconnect" notification on the
  cloned profiles). No outgoing IDs observed → intentionally left out of the table (no guesses).

> ⚠️ Harness note: `capture-action.js` (~L30-33) sleeps a fixed 4500ms then dereferences
> `page.$("#game-canvas")` without gating on `startBotGame()`'s returned `inGame` flag, so a
> failed/slow board load NPEs instead of emitting a clean `{which,...,error}` line. The discard
> run applied a poll-for-canvas fix; the roll/pass/robber/buydev runs still hit the raw crash.

### Interaction strategy decision (Phase 3) — DIRECT-SEND
Synthetic in-page pointer events do **NOT** work: Colonist's WebGL input requires `isTrusted`
events (dispatchEvent can't forge them). So placing pieces uses **DIRECT WEBSOCKET SEND**
(action 15/11 with the board index), not coordinate-forwarding. The harness can still use
Playwright trusted clicks for testing. The 3D→pixel calibration (§4) is kept for hover UX but
is off the critical path.

---

## 3. Message schema — incoming events

### Streams (`id`)
- `id:"130"` = **the active game stream** (all gameplay messages).
- `id:"136"` = heartbeat ping/pong (`{timestamp}`), ~1/sec — ignore.
- `id:"133"/"135"/"139"` = lobby/account/notifications — ignore for gameplay.

### Game message types (`data.type`) — ✅ observed
| type | meaning | payload |
|------|---------|---------|
| 1  | game settings/handshake | `{gameSettingId, databaseGameId, serverId, isReconnectingSession, shouldResetGameClient}` |
| 4  | **FULL SNAPSHOT** | `{playerColor, playOrder, gameState, playerUserStates, gameDetails, gameSettings, timeLeftInState}` |
| 91 | **INCREMENTAL DIFF** | `{diff, timeLeftInState}` — the event mechanism; `diff` mutates gameState |
| 6  | (bool / misc) | e.g. `false` |
| 28 | array (empty early) | TBD |
| 30 | array[50] | TBD (map/log seed?) |
| 59 | array (empty early) | TBD |
| 78 | disable-request state | `{isActive, hasUsedDisableRequest}` |

> The full event vocabulary (dice/build/robber/steal/trade/devcard/win) is delivered via
> **type 91 `diff`** messages. `diff` is a partial mirror of `gameState`; APPLY = recursive
> deep-merge (null value = delete key). ✅ verified: applier reconstructs the board exactly
> (harness/replay.js).

### type-91 diff vocabulary — ✅ observed (opening placement)
**Build settlement** (from a real diff):
```
mapState.tileCornerStates.<cornerIdx> = { owner: <color>, buildingType: 1 }
playerStates.<color>.victoryPointsState.0 = <vp>
mechanicSettlementState.<color>.bankSettlementAmount -= 1
gameLogState.<n> = { text:{type:4, playerColor, pieceEnum:2}, from:<color> }
currentState.actionState = 3   // now expects a road
```
**Build road**:
```
mapState.tileEdgeStates.<edgeIdx> = { owner:<color>, type:1 }
mechanicRoadState.<color>.bankRoadAmount -= 1
mechanicLongestRoadState.<color>.longestRoad = <len>
currentState.{completedTurns++, currentTurnPlayerColor:<next>, actionState:1}
gameLogState.<n> = { text:{type:4, playerColor, pieceEnum:0} }   // pieceEnum 0 = road
gameLogState.<n+1> = { text:{type:44} }                          // 44 = end-of-turn marker
```

**Enums decoded so far:**
- `buildingType`: **1 = settlement, 2 = city** (verified via replay).
- `gameLogState` piece log `pieceEnum`: **2 = settlement, 0 = road** (city TBD, likely 1).
- `gameLogState text.type`: 4 = "placed a piece", 44 = end-of-turn (others TBD: dice, steal…).
- `actionState`: 1 = normal, 3 = must-place-road (post-settlement in setup).
- `currentState.currentTurnPlayerColor` cycles through `playOrder`.

### More diff content — ✅ observed during auto-played games
- **Dice roll**: `diceState.{diceThrown:true, dice1, dice2}`; turn/`currentState` updates.
  Roll is triggered client-side by **Spacebar** (Colonist shortcut).
- **Robber move**: `mechanicRobberState.locationTileIndex` changes; `actionState` 24 = moving
  robber, 27 = selecting steal target (from bot prompts).
- **Steal**: reflected in player resource counts + `gameLogState`.
- **Trade (completed)**: incoming diff carries **`type43` / gameLogState entry**
  `{givingPlayer, givingCards, receivingPlayer, receivingCards}`.
- **Trade offer (incoming)**: `tradeState` diff; UI prompt "Answer Trade"; response row is
  [counter ✏️][decline ✕][accept ✓].
- `gameLogState text.type`: 4 = placed piece, 44 = end-turn, 43 = trade executed.

> STILL TODO: resource-gain-on-roll exact shape, dev-card buy/play, city upgrade,
> game-end/victory payload. (Auto-player passes turns, so games end via bot victory.)

### `gameState` structure — ✅ VERIFIED (from a live type-4 snapshot)
```
diceState:            {diceThrown, dice1, dice2}
bankState:            {hideBankCards, resourceCards}
mapState:             {tileHexStates, tileCornerStates, tileEdgeStates, portEdgeStates}
currentState:         {completedTurns, turnState, actionState, currentTurnPlayerColor, startTime, allocatedTime}
tradeState:           {activeOffers, closedOffers, embargoState}
playerStates:         { <color>: {...} }          # per-player resources etc.
gameLogState:         { ... }
mechanicSettlementState: { <color>: {...} }       # settlements per player
mechanicCityState:       { <color>: {...} }
mechanicRoadState:       { <color>: {...} }
mechanicDevelopmentCardsState: {bankDevelopmentCards, players}
mechanicLongestRoadState:  { <color>: {...} }
mechanicLargestArmyState:  { <color>: {...} }
mechanicRobberState:  {locationTileIndex, isActive}
```
- Players are keyed by **color id** (observed: 1, 2, 3, 11). `playerColor` = us (11).
  `playOrder` = `[2,11,1,3]`.

## 2b. Board — ✅ VERIFIED (standard 19-hex Catan board)

`mapState` holds four objects keyed by index string:
- **`tileHexStates`** — 19 hexes. Each `{x, y, type, diceNumber}`. Axial `(x,y)`.
- **`tileCornerStates`** — 54 corners (vertices). Each `{x, y, z}` (z ∈ {0,1}); gains building
  fields (owner/type) once built.
- **`tileEdgeStates`** — 72 edges. Each `{x, y, z}` (z ∈ {0,1,2}); gains road owner once built.
- **`portEdgeStates`** — 9 ports. Each `{x, y, z, type}`.

Counts 19/54/72/9 = exactly a standard Catan board. ✅

### Hex resource `type` enum — ✅ (pinned vs board screenshots)
| type | count | resource |
|------|-------|----------|
| 0 | 1 | **Desert** (diceNumber 0; robber starts here) ✅ |
| 1 | 4 | **Wood** (forest) 🟡 confirm Phase 2 |
| 2 | 3 | **Brick** (hills) ✅ |
| 3 | 4 | **Sheep** (pasture) 🟡 confirm Phase 2 |
| 4 | 4 | **Wheat** (fields) 🟡 confirm Phase 2 |
| 5 | 3 | **Ore** (mountains) ✅ |

> desert/brick/ore verified by texture; wood/sheep/wheat read off board screenshots (counts
> 4/4/4 all match) — will confirm exact assignment when Phase-2 tiles render side-by-side.
> Robber `mechanicRobberState.locationTileIndex` indexes into `tileHexStates` (idx 8 = desert). ✅

### Port `type` enum — 🟡 (1 = 3:1 generic appears 4×; 2–6 = the five 2:1 resource ports)

### Example real board (game "turn3867"):
hex idx0 (0,-2) type3 dice4 · idx8 (2,0) type0 dice0 DESERT · robber@idx8.
Coordinates range roughly x∈[-2,3], y∈[-3,2].

---

## 4. 3D ↔ coordinate mapping

Board-space embedding (pointy-top), in `extension/src/render/boardGeometry.js`:
- hex center: `u = √3·(x + y/2)`, `v = 1.5·y`.
- corner/edge positions derived from incident-hex centroids (see module).

**Axial → canvas pixel** (for click-forwarding, Phase 3): a similarity transform
`pixel = s·R(θ)·boardXY + t`. First calibration attempt (`harness/calibrate.js`) is imprecise
because Colonist snaps clicks to the nearest legal spot (so the click pixel ≠ the true corner
pixel). The auto-player therefore uses a **spiral scan** of the canvas for Gate-1 capture and
defers pixel-accurate calibration to Phase 3 (where the true corner pixel can be read from a
placed-piece screenshot blob, giving clean corner→pixel pairs).

3D scene placement (Phase 2) does NOT need pixel calibration — it uses boardGeometry directly.

---

## GATE STATUS

### ✅ GATE 1 — PASSED (state reconstruction matches the live game)
Evidence:
- **Decoder**: `harness/verify-decode.js` — our `decode.js` matches @msgpack/msgpack on
  **396/396** captured frames both directions; encoder round-trips 198/198.
- **State model**: `harness/replay.js` reconstructs exact buildings/robber/turn from
  snapshot+diffs (3 settlements/3 roads at correct corner/edge indices, turn cycling).
- **Live HUD vs board** (`harness/validate-live.js`, screenshots `debug/screenshots/gate1-*.png`):
  - turns4: 4 settlements + 4 roads (round-1 setup) ✓
  - turns8: 8 settlements + 8 roads, robber on desert, dice 3+6=9, order [2,1,3,11] — matches
    board pixel-for-pixel ✓
  - turns12: 8 settlements + **9 roads** — the +1 road matches Colonist's own log
    "Shaner built a Road" and the new red road visible on the board ✓
- **Event vocabulary observed & applied**: setup placement, dice roll, robber move, steal,
  trade (offered + executed type43), discard, turn/phase transitions.

Not yet reached: the literal victory screen (auto-player passes turns; games end via bot
victory over a long horizon). Reconstruction correctness is nonetheless proven across all
phases above. Full end-to-end victory capture can be completed in Phase 3 once the auto-player
builds (spends resources) instead of passing.

### ✅ GATE 2 — PASSING (3D board mirrors the live game)
Style C "realistic diorama" built in `extension/src/render/` (scene.js, materials.js,
boardGeometry.js, mount.js). Procedural PBR tiles (per-resource canvas texture + derived
normal map), number-token discs (red 6/8, pip counts), settlement/city/road/robber meshes in
player colors, water + sandy shore, ACESFilmic + soft shadows + hemi/key/rim lights,
OrbitControls with a steep diorama framing.
- Dev-iterated via `harness/dev/` + `harness/dev-shot.js` (offline, captured state).
- **Live mount** (`harness/gate2.js`): mounts over Colonist's hidden `#game-canvas`;
  the 3D board mirrors the real board (same hex layout, number tokens, settlements/roads in
  matching colors/positions, robber on the right tile). Screenshots:
  `debug/screenshots/gate2-3d-board.png` (mirror) vs `gate2-real-board.png` (real). Reactive:
  robber move / builds update live via the state subscription.

Key implementation lesson: ExtrudeGeometry(depth d, bevel b) spans y∈[0, d+2b] then any
translate; the TOP surface is NOT at `depth` — normalize geometry so top sits at a known
`TILE_TOP`, or pieces/tokens get buried inside the tile.

Polish backlog (non-blocking): tile side shows faint extrude banding; verify wood/sheep/wheat
color mapping side-by-side; optional AO/soft contact shadows under pieces.

### ⏳ GATE 3 — Phase 3 (interactions) — not started
