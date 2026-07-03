/**
 * src/render/hud.js — on-page debug HUD (plain DOM overlay).
 *
 * Renders the reconstructed GameState live so it can be eyeballed against the real board.
 * This is the Phase-1 verification surface (GATE 1). Toggle with Alt+H.
 */

// Hex type -> resource, pinned by matching decoded (x,y,dice) to board screenshots.
// (type 0 desert = robber start = cactus hex: verified. 2=brick,5=ore: verified by texture.
//  1/3/4 = wood/sheep/wheat: read off board, confirm in Phase 2.)
export const RESOURCE_NAMES = {
  0: "desert", 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore",
};

export class DebugHUD {
  constructor() {
    this.el = null;
    this.visible = true;
    this._build();
    window.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "h" || e.key === "H")) this.toggle();
    });
  }

  _build() {
    const el = document.createElement("div");
    el.id = "catan3d-hud";
    Object.assign(el.style, {
      position: "fixed", top: "8px", left: "8px", zIndex: 2147483647,
      font: "11px/1.35 ui-monospace,Menlo,Consolas,monospace",
      color: "#e8eef6", background: "rgba(12,18,28,0.86)",
      border: "1px solid #2b3a52", borderRadius: "8px",
      padding: "8px 10px", maxWidth: "340px", maxHeight: "82vh", overflow: "auto",
      boxShadow: "0 6px 24px rgba(0,0,0,0.5)", pointerEvents: "auto",
      backdropFilter: "blur(4px)",
    });
    el.innerHTML = `<div style="font-weight:700;color:#7fd1ff;margin-bottom:4px">
      CATAN 3D · state HUD <span style="opacity:.5;font-weight:400">(Alt+H)</span></div>
      <div id="catan3d-hud-body">waiting for game frames…</div>`;
    (document.body || document.documentElement).appendChild(el);
    this.el = el;
    this.body = el.querySelector("#catan3d-hud-body");
  }

  toggle() { this.visible = !this.visible; if (this.el) this.el.style.display = this.visible ? "block" : "none"; }

  render(gs) {
    if (!this.body) return;
    if (!gs.ready) { this.body.textContent = "connected — awaiting snapshot…"; return; }
    const b = gs.buildings();
    const dice = gs.dice;
    const turn = gs.currentTurnColor;
    const players = gs.playerColors;

    const row = (label, val) => `<div><span style="color:#8aa0bd">${label}:</span> ${val}</div>`;
    const chip = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colorHex(c)};margin-right:3px;vertical-align:middle"></span>`;

    let html = "";
    html += row("us", `${chip(gs.us)}color ${gs.us}`);
    html += row("turn", `${chip(turn)}color ${turn} ${turn === gs.us ? "<b style='color:#7fd1ff'>(you)</b>" : ""}`);
    html += row("phase", `turnState=${gs.turnState} actionState=${gs.actionState} completedTurns=${gs.completedTurns}`);
    html += row("dice", dice ? (dice.thrown ? `${dice.d1}+${dice.d2}=<b>${dice.sum}</b>` : "not thrown") : "—");
    html += row("robber", `tile ${gs.robberTileIndex}`);
    html += row("order", (gs.playOrder || []).map((c) => chip(c) + c).join(" "));

    html += `<div style="margin-top:5px;color:#8aa0bd">buildings</div>`;
    html += row("settlements", b.settlements.map((s) => chip(s.color) + `c${s.cornerIndex}`).join(" ") || "—");
    html += row("cities", b.cities.map((s) => chip(s.color) + `c${s.cornerIndex}`).join(" ") || "—");
    html += row("roads", b.roads.map((s) => chip(s.color) + `e${s.edgeIndex}`).join(" ") || "—");

    html += `<div style="margin-top:5px;color:#8aa0bd">players</div>`;
    for (const c of players) {
      const ps = gs.playerState(c);
      const vp = ps?.victoryPointsState ? Object.values(ps.victoryPointsState).reduce((a, x) => a + x, 0) : 0;
      html += `<div>${chip(c)}c${c} · VP ${vp}</div>`;
    }

    html += `<div style="margin-top:5px;color:#8aa0bd">board</div>`;
    html += row("hexes/corners/edges/ports", `${gs.hexes.length}/${gs.corners.length}/${gs.edges.length}/${gs.ports.length}`);
    const robHex = gs.hexes.find((h) => h.index === gs.robberTileIndex);
    if (robHex) html += row("robber on", `${RESOURCE_NAMES[robHex.type] || robHex.type} (dice ${robHex.diceNumber})`);

    html += `<div style="margin-top:5px;color:#8aa0bd">recent events</div>`;
    const recent = gs.log.slice(-6).reverse();
    html += recent.map((l) => `<div style="opacity:.85">· ${l.kind}: ${fmt(l.data)}</div>`).join("") || "—";

    this.body.innerHTML = html;
  }
}

function fmt(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.join(",");
  return JSON.stringify(d).slice(0, 80);
}

// Colonist player color id -> approximate CSS color (for HUD chips only; refined in Phase 2).
function colorHex(c) {
  return ({
    1: "#d94141", 2: "#3b7fd4", 3: "#e8863a", 4: "#3aa85a",
    11: "#8a5cd1", 12: "#38b6a6", 13: "#d94f9a", 14: "#c9c032",
  })[c] || "#888";
}
