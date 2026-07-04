/**
 * src/render/assets.js — loads Colonist's bundled SVG assets and recolors piece icons per player.
 *
 * All SVGs live under extension/assets/colonist/ (downloaded from Colonist's CDN, see NOTES.md)
 * and are exposed via web_accessible_resources. We fetch them as TEXT so the HUD can inline them
 * (crisp at any size, themeable) and so we can recolor the red settlement/city/road pieces into
 * each player's colour by remapping the gradient stops.
 *
 * Logical name -> file. Cards/icons are used as-is; the three *_red pieces are recolored.
 */

const FILES = {
  bank: "bank.svg",
  card_lumber: "card_lumber.svg", card_brick: "card_brick.svg", card_wool: "card_wool.svg",
  card_grain: "card_grain.svg", card_ore: "card_ore.svg",
  card_devcardback: "card_devcardback.svg", card_rescardback: "card_rescardback.svg",
  card_knight: "card_knight.svg", card_yearofplenty: "card_yearofplenty.svg", card_vp: "card_vp.svg",
  card_monopoly: "card_monopoly.svg", card_roadbuilding: "card_roadbuilding.svg",
  icon_bot: "icon_bot.svg", icon_player: "icon_player.svg", icon_trade: "icon_trade.svg",
  icon_largest_army: "icon_largest_army.svg", icon_longest_road: "icon_longest_road.svg",
  icon_hourglass: "icon_hourglass.svg", icon_trophy: "icon_trophy.svg",
  icon_settings: "icon_settings.svg", icon_book: "icon_book.svg",
  icon_fullscreen_expand: "icon_fullscreen_expand.svg", icon_info: "icon_info.svg",
  settlement_red: "settlement_red.svg", city_red: "city_red.svg", road_red: "road_red.svg",
};

// Player colour hex per Colonist colour id (piece / panel accent).
export const PLAYER_HEX = {
  1: "#e23b3b", 2: "#3f7fd6", 3: "#e08a2e", 4: "#3aa84f",
  11: "#8a5cd1", 12: "#37b3a3", 13: "#d94f9a", 14: "#c9c032",
};

const _textCache = new Map();  // name -> Promise<string>
const _url = (file) => (typeof chrome !== "undefined" && chrome.runtime?.getURL)
  ? chrome.runtime.getURL(`assets/colonist/${file}`)
  : `../../assets/colonist/${file}`;

/** Fetch the raw SVG text for a logical asset name (cached). */
export function svgText(name) {
  if (_textCache.has(name)) return _textCache.get(name);
  const file = FILES[name];
  if (!file) return Promise.reject(new Error(`unknown asset ${name}`));
  const p = fetch(_url(name in FILES ? file : name)).then((r) => r.text());
  _textCache.set(name, p);
  return p;
}

/** A resolvable URL for the asset (for <img src>). */
export function assetUrl(name) { const f = FILES[name]; return f ? _url(f) : null; }

// --- recolor helpers --------------------------------------------------------------------------
function hexToRgb(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function luminance([r, g, b]) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

/**
 * Remap a red gradient colour onto a target hue while preserving how light/dark it is.
 * The piece SVGs shade from #FF0000 (light) to #B30000 (dark) plus a #8C0039 base outline.
 * We take each source colour's luminance and rebuild it as the target colour scaled to the same
 * relative brightness — so blue/orange/green pieces keep the same 3D shading as the red original.
 */
function remapStop(srcHex, targetRgb) {
  const src = hexToRgb(srcHex);
  const srcMax = Math.max(...src) || 1;
  const rel = srcMax / 255;                 // how bright this stop is (1 at the lightest red)
  // Darken the target proportionally to the source's darkness, and drop the outline base darker.
  const isBase = srcHex.toUpperCase() === "#8C0039";
  const k = isBase ? rel * 0.62 : rel;      // outline base a touch darker than a plain scale
  return rgbToHex(targetRgb[0] * k, targetRgb[1] * k, targetRgb[2] * k);
}

/**
 * Return the SVG text for a piece ("settlement" | "city" | "road") recolored to a Colonist
 * colour id. Colour id 1 (red) returns the original untouched.
 */
export async function pieceSvg(kind, colorId) {
  const name = `${kind}_red`;
  let text = await svgText(name);
  const hex = PLAYER_HEX[colorId] || PLAYER_HEX[1];
  if (colorId === 1) return text;           // already red
  const target = hexToRgb(hex);
  // Replace every #RRGGBB used in the file (all reds + the base) with the remapped colour.
  text = text.replace(/#([0-9a-fA-F]{6})/g, (m) => remapStop(m, target));
  return text;
}

/** Convenience: an <img>-ready data URL for a recolored piece. */
export async function pieceDataUrl(kind, colorId) {
  const svg = await pieceSvg(kind, colorId);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
