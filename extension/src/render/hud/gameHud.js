/**
 * src/render/hud/gameHud.js — faithful rebuild of Colonist's in-game HUD, over the 3D overlay.
 *
 * Renders three regions pinned to the overlay box (= #ui-game rect): a top-left icon rail, a
 * right column (bank bar + one panel per player), and a bottom card tray with the action
 * buttons. Driven entirely by the GameModel snapshot; updates reactively. The action buttons
 * emit through opts.onAction(kind) so the interaction layer can arm placement / open flows —
 * this HUD never sends game actions itself.
 *
 * Assets are Colonist's own SVGs (src/render/assets.js). Player pieces are recolored per player.
 */
import { assetUrl, pieceDataUrl, svgText, diceAsset, PLAYER_HEX } from "../assets.js";
import { RES_ORDER, RES_ASSET, DEV_ASSET } from "../../state/gameModel.js";

// action id -> asset name for tray buttons.
const RES_LABEL = { 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore" };

// The HUD is styled entirely by gameHud.css. In the extension the content script runs in the
// ISOLATED world but appends the HUD into the page DOM, so the stylesheet must be injected as a
// <style> tag (a content_scripts.css entry wouldn't apply to the isolated-world-inserted nodes
// reliably, and a <link> to a web-accessible URL is fetch-gated). We fetch the CSS text once and
// inline it. Idempotent — guarded by a marker id.
let _cssPromise = null;
function ensureHudCss() {
  if (typeof document === "undefined") return;
  if (document.getElementById("c3d-hud-css")) return;
  const cssUrl = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
    ? chrome.runtime.getURL("src/render/hud/gameHud.css")
    : new URL("./gameHud.css", import.meta.url).href;
  // Insert a placeholder immediately (marks as loading; prevents duplicate fetches).
  const style = document.createElement("style");
  style.id = "c3d-hud-css";
  (document.head || document.documentElement).appendChild(style);
  if (!_cssPromise) {
    _cssPromise = fetch(cssUrl).then((r) => r.text()).then((css) => { style.textContent = css; })
      .catch((e) => { console.warn("[catan3d/hud] failed to load gameHud.css", e); });
  }
}

export class GameHud {
  /**
   * @param {HTMLElement} host  the overlay element (position:absolute inset:0 within it).
   * @param {object} [opts]
   * @param {(kind:string)=>void} [opts.onAction]  fired when a tray/action button is clicked
   *   (kind ∈ 'trade'|'dev'|'road'|'settlement'|'city'|'endturn'|'settings'|'book'|'fullscreen'|'info').
   * @param {string} [opts.boxPngUrl]  URL of the light-blue button plate (box.png).
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.onAction = opts.onAction || (() => {});
    this.plateUrl = opts.boxPngUrl || (typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL("assets/box.png") : "../../assets/box.png");
    this.armed = null;       // currently-armed action ('settlement'|'road'|'city'|null)
    this._pieceCache = new Map();
    this.el = null;
    ensureHudCss();          // the HUD is styled entirely via gameHud.css — inject it once.
    this._build();
  }

  _build() {
    const el = document.createElement("div");
    el.className = "c3d-hud";
    el.innerHTML = `
      <div class="c3d-rail">
        ${this._railBtn("settings", "icon_settings")}
        ${this._railBtn("book", "icon_book")}
        ${this._railBtn("fullscreen", "icon_fullscreen_expand")}
        ${this._railBtn("info", "icon_info")}
      </div>
      <div class="c3d-right">
        <div class="c3d-bank pe"></div>
        <div class="c3d-players"></div>
      </div>
      <div class="c3d-bottom">
        <div class="c3d-status">
          <div class="c3d-pill pe"><span class="who"></span><span class="txt">Waiting…</span></div>
          <div class="c3d-dice" hidden><img class="d1" alt="die"><img class="d2" alt="die"></div>
          <div class="c3d-timer">–:––</div>
        </div>
        <div class="c3d-tray">
          <div class="c3d-hand pe"></div>
          <div class="c3d-actions pe">
            ${this._rollBtn()}
            ${this._actBtn("trade", "icon_trade")}
            ${this._actBtn("dev", null, "card_devcardback")}
            ${this._actBtn("road", null, null, "road")}
            ${this._actBtn("settlement", null, null, "settlement")}
            ${this._actBtn("city", null, null, "city")}
            ${this._actBtn("endturn", "icon_pass_turn")}
          </div>
        </div>
      </div>`;
    this.host.appendChild(el);
    this.el = el;

    // Resolve refs.
    this.bankEl = el.querySelector(".c3d-bank");
    this.playersEl = el.querySelector(".c3d-players");
    this.pillEl = el.querySelector(".c3d-pill");
    this.diceEl = el.querySelector(".c3d-dice");
    this.timerEl = el.querySelector(".c3d-timer");
    this.handEl = el.querySelector(".c3d-hand");
    this.actionsEl = el.querySelector(".c3d-actions");

    // Icon-rail images (Colonist SVGs).
    el.querySelectorAll("[data-ico]").forEach((n) => { n.querySelector("img").src = assetUrl(n.dataset.ico) || ""; });
    // Action-button plates + icons.
    el.querySelectorAll(".c3d-act").forEach((b) => {
      b.style.setProperty("--plate", `url("${this.plateUrl}")`);
      const iconName = b.dataset.icon;
      if (iconName) { const img = b.querySelector("img"); if (img) img.src = assetUrl(iconName) || ""; }
    });

    // Wire clicks.
    el.querySelector(".c3d-rail").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ico]"); if (b) this.onAction(b.dataset.ico);
    });
    this.actionsEl.addEventListener("click", (e) => {
      const b = e.target.closest(".c3d-act"); if (b && !b.hasAttribute("disabled")) this.onAction(b.dataset.act);
    });
  }

  _railBtn(kind, ico) { return `<div class="ico pe" data-ico="${ico}" title="${kind}"><img alt="${kind}"></div>`; }

  // The roll-dice button: a die on the light-blue plate. Only shown when it's our turn and the
  // dice have not been thrown (hidden otherwise). Clicking it drives Colonist's own roll control.
  _rollBtn() {
    return `<button class="c3d-act c3d-roll pe" data-act="roll" title="Roll dice" hidden>
      <img class="roll-die" alt="roll"><span class="roll-lbl">Roll</span></button>`;
  }

  // Action button: either an icon (icon_*), a dev-card back, or a recolored piece (filled in update()).
  _actBtn(act, icon, cardAsset, piece) {
    const inner = icon ? `<img alt="${act}">` : (cardAsset ? `<img data-cardback="1" alt="${act}">` : `<img data-piece="${piece}" alt="${act}">`);
    return `<button class="c3d-act pe" data-act="${act}"${icon ? ` data-icon="${icon}"` : ""}>
      ${inner}<span class="badge" hidden></span><span class="cost"></span></button>`;
  }

  /** Highlight the armed action button (called by the interaction layer). */
  setArmed(kind) {
    this.armed = kind;
    this.actionsEl.querySelectorAll(".c3d-act").forEach((b) => b.classList.toggle("armed", b.dataset.act === kind));
  }

  async _pieceSrc(kind, colorId) {
    const key = `${kind}:${colorId}`;
    if (!this._pieceCache.has(key)) this._pieceCache.set(key, await pieceDataUrl(kind, colorId));
    return this._pieceCache.get(key);
  }

  // ---- render from a GameModel snapshot -------------------------------------------------------
  async update(snap) {
    if (!snap || !snap.ready) return;
    const you = snap.players.find((p) => p.isUs);

    // Bank bar.
    this._renderBank(snap);
    // Player panels.
    this._renderPlayers(snap);
    // Status pill + timer.
    this._renderStatus(snap);
    // Your hand (cards).
    this._renderHand(you);
    // Action button costs/badges/enabled.
    this._renderActions(snap, you);
    // Fill piece icons on the tray buttons in your colour.
    if (you) {
      for (const [act, kind] of [["road", "road"], ["settlement", "settlement"], ["city", "city"]]) {
        const img = this.actionsEl.querySelector(`.c3d-act[data-act="${act}"] img[data-piece]`);
        if (img && !img.dataset.done) { img.src = await this._pieceSrc(kind, you.color); img.dataset.done = "1"; }
      }
    }
    // Dev-card back on the dev button.
    const devImg = this.actionsEl.querySelector('.c3d-act[data-act="dev"] img[data-cardback]');
    if (devImg && !devImg.src) devImg.src = assetUrl("card_devcardback") || "";
  }

  _renderBank(snap) {
    const b = snap.bank;
    const res = RES_ORDER.map((r) => `<span class="res"><img src="${assetUrl(RES_ASSET[r])}" alt="${RES_LABEL[r]}">${b[RES_LABEL[r]]}</span>`).join("");
    this.bankEl.innerHTML =
      `<img class="bank-ico" src="${assetUrl("bank")}" alt="bank">${res}` +
      `<span class="devcount"><img src="${assetUrl("card_devcardback")}" alt="dev">${snap.devDeck.remaining}</span>`;
  }

  _renderPlayers(snap) {
    // Order: opponents first (as Colonist stacks them), you handled inline too. Keep play order.
    const rows = snap.players.map((p) => this._playerRow(p)).join("");
    this.playersEl.innerHTML = rows;
  }

  _playerRow(p) {
    const cls = ["c3d-player", "pe"];
    if (p.isUs) cls.push("you");
    if (p.isCurrentTurn) cls.push("turn");
    if (!p.isConnected) cls.push("disc");
    const avatarIco = p.isBot ? "icon_bot" : "icon_player";
    const botTag = p.isBot ? `<span class="bot"><img src="${assetUrl("icon_bot")}" alt="bot">BOT</span>` : "";
    const road = `<span class="c3d-chip small" title="roads/longest road"><img class="c3d-award ${p.hasLongestRoad ? "" : "off"}" src="${assetUrl("icon_longest_road")}" alt="road">${p.longestRoadLen}</span>`;
    const army = `<img class="c3d-award ${p.hasLargestArmy ? "" : "off"}" src="${assetUrl("icon_largest_army")}" alt="army" title="largest army (${p.knightsPlayed} knights)">`;
    return `<div class="${cls.join(" ")}" style="--pc:${p.hex}">
      <div class="c3d-avatar"><img src="${assetUrl(avatarIco)}" alt=""></div>
      <div class="c3d-pname"><div class="nm">${escapeHtml(p.name)}</div>${botTag}</div>
      <div class="c3d-counts">
        <span class="c3d-chip" title="dev cards"><img src="${assetUrl("card_devcardback")}" alt="dev">${p.devHandCount}</span>
        <span class="c3d-chip" title="resource cards"><img src="${assetUrl("card_rescardback")}" alt="cards">${p.handCount}</span>
        ${road}${army}
        <span class="c3d-vp" title="victory points">${p.vp}</span>
      </div>
    </div>`;
  }

  _renderStatus(snap) {
    const cur = snap.players.find((p) => p.color === snap.turnColor);
    this.pillEl.style.setProperty("--pc", cur?.hex || "#888");
    this._renderDice(snap.dice);
    const txt = this.pillEl.querySelector(".txt");
    if (snap.yourTurn) {
      const map = { 0: "Place Settlement", 1: "Your turn", 2: "Build or trade" };
      // turnState 0 setup, actionState 3 = place road
      let label = "Your turn";
      if (snap.turnState === 0) label = snap.actionState === 3 ? "Place Road" : "Place Settlement";
      else if (this.armed) label = `Place ${this.armed[0].toUpperCase()}${this.armed.slice(1)}`;
      txt.textContent = label;
    } else {
      txt.textContent = `${cur ? cur.name : "Opponent"}'s turn`;
    }
  }

  // Show the two rolled dice next to the status pill. Hidden until the dice are thrown; the faces
  // update whenever d1/d2 change (only re-set the <img> src when the value changes to avoid churn).
  _renderDice(dice) {
    if (!this.diceEl) return;
    if (!dice || !dice.thrown || !dice.d1 || !dice.d2) { this.diceEl.hidden = true; return; }
    this.diceEl.hidden = false;
    const set = (cls, val) => {
      const img = this.diceEl.querySelector(cls);
      if (!img) return;
      if (img.dataset.face !== String(val)) { img.src = assetUrl(diceAsset(val)) || ""; img.dataset.face = String(val); img.alt = `die ${val}`; }
    };
    set(".d1", dice.d1);
    set(".d2", dice.d2);
  }

  async _renderHand(you) {
    if (!you) { this.handEl.innerHTML = ""; return; }
    // Build from your exact resource counts (wood,brick,sheep,wheat,ore), grouped like Colonist.
    const cards = [];
    for (const r of RES_ORDER) {
      const n = you.resCounts ? you.resCounts[RES_LABEL[r]] : 0;
      for (let i = 0; i < n; i++) cards.push(r);
    }
    const url = (r) => assetUrl(RES_ASSET[r]);
    this.handEl.innerHTML = cards.map((r) => `<div class="card" style="background-image:url('${url(r)}')" title="${RES_LABEL[r]}"></div>`).join("");
  }

  _renderActions(snap, you) {
    const canAfford = affordability(you);
    const setBtn = (act, enabled, badge) => {
      const b = this.actionsEl.querySelector(`.c3d-act[data-act="${act}"]`);
      if (!b) return;
      b.toggleAttribute("disabled", !enabled);
      const bd = b.querySelector(".badge");
      if (badge != null) { bd.hidden = false; bd.textContent = badge; } else { bd.hidden = true; }
    };
    const yourTurn = snap.yourTurn;
    const setup = snap.turnState === 0;
    const mainPhase = yourTurn && !setup; // not during setup
    // "Roll" phase = our turn, main game (not setup), dice not yet thrown.
    const needRoll = yourTurn && !setup && snap.dice && snap.dice.thrown === false;
    // After rolling (or in setup) the build/trade/dev actions apply.
    const canBuild = yourTurn && (setup || (snap.dice && snap.dice.thrown));

    this._renderRollBtn(needRoll, snap);

    // During setup you place a settlement/road for FREE (ignore affordability); in the main phase
    // gate on resources. Only enable build actions once you've rolled (or in setup).
    setBtn("trade", mainPhase && snap.dice && snap.dice.thrown);
    setBtn("dev", mainPhase && snap.dice && snap.dice.thrown && canAfford.dev, you ? you.devHandCount : null);
    setBtn("road", canBuild && (setup || canAfford.road));
    setBtn("settlement", canBuild && (setup || canAfford.settlement));
    setBtn("city", mainPhase && snap.dice && snap.dice.thrown && canAfford.city);
    setBtn("endturn", mainPhase && snap.dice && snap.dice.thrown);
    // cost hints
    this._setCost("road", "🪵1 🧱1");
    this._setCost("settlement", "🪵1 🧱1 🐑1 🌾1");
    this._setCost("city", "🌾2 ⛏3");
    this._setCost("dev", "🐑1 🌾1 ⛏1");
  }

  // Show/hide + fill the roll button. When it's time to roll we surface it (with a random-ish die
  // face) and pulse it; otherwise hide it.
  _renderRollBtn(needRoll, snap) {
    const b = this.actionsEl.querySelector('.c3d-act[data-act="roll"]');
    if (!b) return;
    b.hidden = !needRoll;
    b.classList.toggle("pulse", !!needRoll);
    b.style.setProperty("--plate", `url("${this.plateUrl}")`);
    const img = b.querySelector(".roll-die");
    if (img && !img.dataset.filled) {
      // a static die face for the button (the real rolled faces show in the status row)
      img.src = assetUrl(diceAsset(5)) || "";
      img.dataset.filled = "1";
    }
  }

  _setCost(act, txt) { const c = this.actionsEl.querySelector(`.c3d-act[data-act="${act}"] .cost`); if (c) c.textContent = txt; }

  /** Update the turn timer (seconds remaining), driven externally each tick. */
  setTimer(secs) {
    if (secs == null || secs < 0 || !isFinite(secs)) { this.timerEl.textContent = "–:––"; return; }
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    this.timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  setVisible(v) { if (this.el) this.el.style.display = v ? "" : "none"; }

  dispose() { if (this.el) this.el.remove(); }
}

// Rough affordability from your resource counts (for enabling build buttons).
function affordability(you) {
  const c = (you && you.resCounts) || { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  return {
    road: c.wood >= 1 && c.brick >= 1,
    settlement: c.wood >= 1 && c.brick >= 1 && c.sheep >= 1 && c.wheat >= 1,
    city: c.wheat >= 2 && c.ore >= 3,
    dev: c.sheep >= 1 && c.wheat >= 1 && c.ore >= 1,
  };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
