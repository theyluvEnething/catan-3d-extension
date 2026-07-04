/**
 * src/state/gameModel.js — the faithful "internal copy" of the game, on top of GameState.
 *
 * GameState reconstructs Colonist's raw gameState tree from frames (source of truth for the
 * wire). GameModel is a clean, typed VIEW over it for the HUD, the interaction layer and any
 * strategy code: players, resources, dev cards, bank, awards, and a running dev-card play log —
 * everything the protocol reveals, with hidden opponent info kept as COUNTS only (exactly as
 * Colonist's own UI does: opponents' resourceCards.cards is an array of 0s = card backs, and
 * their dev-card hand shows id 10 = hidden back).
 *
 * All enums here are VERIFIED against a live half-game capture (debug/hud/, see NOTES.md):
 *   resource ids: 0 = hidden, 1 wood, 2 brick, 3 sheep, 4 wheat, 5 ore
 *   dev-card ids: 10 = hidden/back; 15 ≈ Year-of-Plenty; 12 = (second real type, TBD);
 *                 the full 5-id map is filled defensively (unknowns render as generic dev).
 *
 * GameModel is READ-ONLY: it derives everything from GameState and never sends. It subscribes
 * to GameState and re-derives on each change, emitting to its own subscribers.
 */

// Resource ids ----------------------------------------------------------------------------------
export const RES = { HIDDEN: 0, WOOD: 1, BRICK: 2, SHEEP: 3, WHEAT: 4, ORE: 5 };
export const RES_NAME = { 0: "hidden", 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore" };
export const RES_ORDER = [1, 2, 3, 4, 5]; // display order (wood,brick,sheep,wheat,ore)

// Dev-card ids ----------------------------------------------------------------------------------
// 10 = hidden back. Others from live capture + standard Colonist ordering; unknown ids fall back
// to "dev" so the HUD/model never crash on an unseen id.
export const DEV = { HIDDEN: 10, KNIGHT: 11, VP: 14, ROAD_BUILDING: 13, YEAR_OF_PLENTY: 15, MONOPOLY: 12 };
export const DEV_NAME = {
  10: "hidden", 11: "knight", 12: "monopoly", 13: "roadBuilding", 14: "victoryPoint", 15: "yearOfPlenty",
};
// Asset key per dev id (for the HUD; unknown -> devcardback).
export const DEV_ASSET = {
  10: "card_devcardback", 11: "card_knight", 12: "card_monopoly",
  13: "card_roadbuilding", 14: "card_vp", 15: "card_yearofplenty",
};
export const RES_ASSET = { 1: "card_lumber", 2: "card_brick", 3: "card_wool", 4: "card_grain", 5: "card_ore" };

// Player display colors (hex) keyed by Colonist color id. Matches board piece colors.
export const PLAYER_HEX = {
  1: "#e23b3b", 2: "#3f7fd6", 3: "#e08a2e", 4: "#3aa84f",
  11: "#8a5cd1", 12: "#37b3a3", 13: "#d94f9a", 14: "#c9c032",
};

function countBy(arr) {
  const m = {};
  for (const x of arr || []) m[x] = (m[x] || 0) + 1;
  return m;
}
function sumVals(o) { return o ? Object.values(o).reduce((a, x) => a + (Number(x) || 0), 0) : 0; }

export class GameModel {
  constructor(state) {
    this.state = state;                 // the underlying GameState
    this._subs = new Set();
    this.devLog = [];                   // [{ color, dev, devName, t }] append-only play history
    this._seenUsed = {};                // color -> last-seen developmentCardsUsed length (dedupe)
    this.snapshot = this._empty();
    this._unsub = state.subscribe((s, evt) => this._onChange(evt));
    this._recompute();
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit(evt) { for (const fn of this._subs) { try { fn(this.snapshot, evt, this); } catch (e) { console.warn(e); } } }
  dispose() { if (this._unsub) this._unsub(); this._subs.clear(); }

  _empty() {
    return { ready: false, us: null, turnColor: null, players: [], bank: null, devDeck: null, dice: null, phase: null };
  }

  _onChange(evt) {
    // Track dev-card PLAYS from the raw diff so the play log is precise and ordered.
    if (evt && evt.kind === "diff" && evt.diff) this._ingestDevPlays(evt.diff);
    this._recompute();
    this._emit(evt);
  }

  // Append any newly-used dev cards to the play log (append-only; diff carries the full array).
  _ingestDevPlays(diff) {
    const players = diff?.mechanicDevelopmentCardsState?.players;
    if (!players) return;
    for (const [color, p] of Object.entries(players)) {
      if (!p || !Array.isArray(p.developmentCardsUsed)) continue;
      const used = p.developmentCardsUsed;
      const prev = this._seenUsed[color] || 0;
      for (let i = prev; i < used.length; i++) {
        const dev = used[i];
        this.devLog.push({ color: Number(color), dev, devName: DEV_NAME[dev] || `dev${dev}`, t: Date.now() });
      }
      this._seenUsed[color] = used.length;
    }
  }

  _recompute() {
    const s = this.state;
    if (!s || !s.ready || !s.gameState) { this.snapshot = this._empty(); return; }
    const gs = s.gameState;
    const us = s.us;

    // Bank resources + dev deck remaining.
    const bankRes = gs.bankState?.resourceCards || {};
    const bank = { wood: bankRes[1] || 0, brick: bankRes[2] || 0, sheep: bankRes[3] || 0, wheat: bankRes[4] || 0, ore: bankRes[5] || 0 };
    bank.total = RES_ORDER.reduce((a, r) => a + (bankRes[r] || 0), 0);

    const devState = gs.mechanicDevelopmentCardsState || {};
    const devDeck = { remaining: (devState.bankDevelopmentCards?.cards || []).length };

    // Awards.
    const armyState = gs.mechanicLargestArmyState || {};
    const roadState = gs.mechanicLongestRoadState || {};
    const largestArmyHolder = this._awardHolder(armyState, "largestArmy");
    const longestRoadHolder = this._awardHolder(roadState, "longestRoad");

    // Per-player.
    const psAll = gs.playerStates || {};
    const order = (s.playOrder && s.playOrder.length) ? s.playOrder : Object.keys(psAll).map(Number);
    const players = order.filter((c) => psAll[c]).map((color) => {
      const ps = psAll[color];
      const isUs = color === us;
      const hand = ps.resourceCards?.cards || [];
      const handCount = hand.length;
      // For us the ids are real; for others they're 0 (hidden) — expose counts either way.
      const resCounts = isUs ? this._resCounts(hand) : null;

      const devP = devState.players?.[color] || {};
      const devHand = devP.developmentCards?.cards || [];
      const devUsed = devP.developmentCardsUsed || [];
      const usedCounts = countBy(devUsed);
      // VP as revealed. Colonist only reveals opponents' PUBLIC vp (settlements/cities/road/army);
      // hidden VP dev cards stay secret unless it's us. victoryPointsState sums public sources.
      const vp = sumVals(ps.victoryPointsState);

      return {
        color,
        hex: PLAYER_HEX[color] || "#888",
        name: this._name(color),
        isBot: this._isBot(color),
        isUs,
        isConnected: ps.isConnected !== false,
        isTakingAction: !!ps.isTakingAction,
        isCurrentTurn: color === s.currentTurnColor,
        vp,
        handCount,
        resCounts,                          // {wood,brick,...} for us; null for others
        devHandCount: devHand.length,
        devHand: isUs ? devHand.slice() : null,   // real ids for us; null (hidden) for others
        devHandCounts: isUs ? countBy(devHand) : null,
        knightsPlayed: usedCounts[DEV.KNIGHT] || 0,
        devUsed: devUsed.slice(),           // public play history (ids)
        devUsedCounts: usedCounts,
        longestRoadLen: roadState[color]?.longestRoad || 0,
        hasLongestRoad: longestRoadHolder === color,
        hasLargestArmy: largestArmyHolder === color,
        piecesLeft: {
          settlements: gs.mechanicSettlementState?.[color]?.bankSettlementAmount ?? null,
          cities: gs.mechanicCityState?.[color]?.bankCityAmount ?? null,
          roads: gs.mechanicRoadState?.[color]?.bankRoadAmount ?? null,
        },
        tradeRatios: ps.bankTradeRatiosState || null,
      };
    });

    const d = gs.diceState;
    const dice = d ? { thrown: !!d.diceThrown, d1: d.dice1, d2: d.dice2, sum: (d.dice1 || 0) + (d.dice2 || 0) } : null;

    this.snapshot = {
      ready: true,
      us,
      turnColor: s.currentTurnColor,
      yourTurn: s.currentTurnColor === us,
      turnState: s.turnState,
      actionState: s.actionState,
      completedTurns: s.completedTurns,
      players,
      bank,
      devDeck,
      dice,
      robberTileIndex: s.robberTileIndex,
      awards: { largestArmy: largestArmyHolder, longestRoad: longestRoadHolder },
      devLog: this.devLog.slice(-40),
    };
  }

  _resCounts(hand) {
    const c = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    for (const id of hand) {
      const n = RES_NAME[id];
      if (n && n !== "hidden") c[n]++;
    }
    return c;
  }

  // An award mechanic maps color->{...}; the holder is the one flagged as holding it. Colonist
  // marks the holder with a truthy field (isLargestArmy / count threshold). We detect via any
  // player object that has a positive/true award marker; fall back to null.
  _awardHolder(mechState, kind) {
    let best = null;
    for (const [color, v] of Object.entries(mechState || {})) {
      if (!v || typeof v !== "object") continue;
      if (v.isLargestArmy === true || v.isLongestRoad === true || v.hasAward === true || v.owner === true) return Number(color);
    }
    return best;
  }

  _name(color) {
    const u = this.state.playerUserStates;
    // playerUserStates may be an array of {color,username,...} or an object keyed by color.
    if (Array.isArray(u)) { const m = u.find((x) => x && x.color === color); if (m) return m.username || m.name || `Player ${color}`; }
    else if (u && u[color]) return u[color].username || u[color].name || `Player ${color}`;
    return `Player ${color}`;
  }
  _isBot(color) {
    const u = this.state.playerUserStates;
    const find = Array.isArray(u) ? u.find((x) => x && x.color === color) : (u && u[color]);
    if (!find) return false;
    return !!(find.isBot || find.bot || find.isBotPlayer || (typeof find.userId === "string" && find.userId.startsWith("bot")));
  }
}
