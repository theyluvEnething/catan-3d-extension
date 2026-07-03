/**
 * src/render/materials.js — procedural "realistic diorama" materials (Phase 2, style C).
 *
 * No external asset files: every texture is drawn to an offscreen canvas at load time, plus a
 * derived normal map for surface relief. Each resource gets a distinct naturalistic look:
 *   wood=forest, brick=hills(reddish soil), sheep=pasture(grass), wheat=fields, ore=mountains,
 *   desert=sand. Tuned for MeshStandardMaterial under the scene's key+hemi lighting.
 */
import * as THREE from "../../vendor/three.module.js";

export const RESOURCE = { DESERT: 0, WOOD: 1, BRICK: 2, SHEEP: 3, WHEAT: 4, ORE: 5 };

// Base palette per resource (top face tint).
const PALETTE = {
  [RESOURCE.DESERT]: { base: "#d9c18a", accent: "#c8a862", relief: 0.25 },
  [RESOURCE.WOOD]:   { base: "#2f6b34", accent: "#1e4a24", relief: 0.9 },
  [RESOURCE.BRICK]:  { base: "#b45b36", accent: "#8f3f22", relief: 0.7 },
  [RESOURCE.SHEEP]:  { base: "#7cc04a", accent: "#5aa033", relief: 0.35 },
  [RESOURCE.WHEAT]:  { base: "#e0b53c", accent: "#c79320", relief: 0.5 },
  [RESOURCE.ORE]:    { base: "#8b93a0", accent: "#5f6874", relief: 1.0 },
};

const TEX = 256;
function canvas(size = TEX) { const c = document.createElement("canvas"); c.width = c.height = size; return c; }
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function drawResourceTexture(type) {
  const c = canvas(); const g = c.getContext("2d");
  const p = PALETTE[type]; const rand = rng(1000 + type * 97);
  g.fillStyle = p.base; g.fillRect(0, 0, TEX, TEX);

  // subtle mottling for all
  for (let i = 0; i < 900; i++) {
    const x = rand() * TEX, y = rand() * TEX, r = 1 + rand() * 3;
    g.globalAlpha = 0.05 + rand() * 0.08;
    g.fillStyle = rand() > 0.5 ? p.accent : "#ffffff";
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  g.globalAlpha = 1;

  if (type === RESOURCE.WOOD) {
    // scattered conifer blobs
    for (let i = 0; i < 26; i++) {
      const x = 20 + rand() * (TEX - 40), y = 20 + rand() * (TEX - 40), s = 10 + rand() * 10;
      g.fillStyle = "#173a1c"; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.7, y + s); g.lineTo(x - s * 0.7, y + s); g.closePath(); g.fill();
      g.fillStyle = "#2b5e30"; g.beginPath(); g.moveTo(x, y - s * 0.5); g.lineTo(x + s * 0.55, y + s * 0.6); g.lineTo(x - s * 0.55, y + s * 0.6); g.closePath(); g.fill();
    }
  } else if (type === RESOURCE.WHEAT) {
    // furrow rows
    g.strokeStyle = "#b8871a"; g.lineWidth = 2;
    for (let y = 8; y < TEX; y += 12) { g.globalAlpha = 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(TEX, y + (rand() - 0.5) * 4); g.stroke(); }
    g.globalAlpha = 1;
  } else if (type === RESOURCE.SHEEP) {
    // grass tufts + a couple of light sheep dots
    g.strokeStyle = "#4f9330"; g.lineWidth = 1.5;
    for (let i = 0; i < 260; i++) { const x = rand() * TEX, y = rand() * TEX; g.globalAlpha = 0.4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 3, y - 4 - rand() * 3); g.stroke(); }
    g.globalAlpha = 1;
  } else if (type === RESOURCE.BRICK) {
    // terraced reddish soil bands
    for (let y = 0; y < TEX; y += 22) { g.globalAlpha = 0.12; g.fillStyle = rand() > 0.5 ? "#9a4527" : "#c56a40"; g.fillRect(0, y, TEX, 11); }
    g.globalAlpha = 1;
  } else if (type === RESOURCE.ORE) {
    // rocky facets
    for (let i = 0; i < 40; i++) {
      const x = rand() * TEX, y = rand() * TEX, s = 8 + rand() * 18;
      g.fillStyle = rand() > 0.5 ? "#6b7480" : "#a7afba"; g.globalAlpha = 0.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + s, y + s * 0.4); g.lineTo(x + s * 0.3, y + s); g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
  } else if (type === RESOURCE.DESERT) {
    // dunes + a cactus
    for (let i = 0; i < 6; i++) { g.globalAlpha = 0.1; g.strokeStyle = "#b89a5e"; g.lineWidth = 6; g.beginPath(); g.moveTo(0, 40 * i + rand() * 20); g.bezierCurveTo(TEX / 3, 40 * i - 10, 2 * TEX / 3, 40 * i + 20, TEX, 40 * i); g.stroke(); }
    g.globalAlpha = 1; g.fillStyle = "#3f7d3a"; g.fillRect(TEX / 2 - 4, TEX / 2 - 20, 8, 34); g.fillRect(TEX / 2 - 16, TEX / 2 - 6, 12, 6); g.fillRect(TEX / 2 + 4, TEX / 2 - 12, 12, 6);
  }
  return c;
}

// Derive a cheap normal map from a texture's luminance (Sobel).
function normalFromCanvas(srcCanvas, strength = 1) {
  const s = srcCanvas.width; const src = srcCanvas.getContext("2d").getImageData(0, 0, s, s).data;
  const out = canvas(s); const octx = out.getContext("2d"); const img = octx.createImageData(s, s);
  const lum = (x, y) => { const i = ((y + s) % s * s + (x + s) % s) * 4; return (src[i] * 0.3 + src[i + 1] * 0.59 + src[i + 2] * 0.11) / 255; };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
    const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
    const nz = 1; const inv = 1 / Math.hypot(dx, dy, nz);
    const i = (y * s + x) * 4;
    img.data[i] = ((-dx * inv) * 0.5 + 0.5) * 255;
    img.data[i + 1] = ((-dy * inv) * 0.5 + 0.5) * 255;
    img.data[i + 2] = (nz * inv) * 0.5 * 255 + 127;
    img.data[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Earthy side color per resource (the exposed "soil" band under the tile top).
const SIDE_COLOR = {
  [RESOURCE.DESERT]: 0xb89a5e, [RESOURCE.WOOD]: 0x5b4327, [RESOURCE.BRICK]: 0x7a3b22,
  [RESOURCE.SHEEP]: 0x6b5a34, [RESOURCE.WHEAT]: 0x8a6a2a, [RESOURCE.ORE]: 0x545a63,
};

const _cache = new Map();
/**
 * Returns [topMaterial, sideMaterial] for a hex prism. ExtrudeGeometry assigns group 0 to the
 * top/bottom caps (textured resource) and group 1 to the extruded sides (clean earth band),
 * which removes the ugly bevel-stripe banding from the sides.
 */
export function makeTileMaterial(type) {
  if (!_cache.has(type)) {
    const texCanvas = drawResourceTexture(type);
    const map = new THREE.CanvasTexture(texCanvas);
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
    const normalMap = new THREE.CanvasTexture(normalFromCanvas(texCanvas, PALETTE[type].relief * 2.2));
    const top = new THREE.MeshStandardMaterial({
      map, normalMap, normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: type === RESOURCE.ORE ? 0.62 : 0.92,
      metalness: type === RESOURCE.ORE ? 0.12 : 0.02,
    });
    const side = new THREE.MeshStandardMaterial({ color: SIDE_COLOR[type], roughness: 0.98, metalness: 0.02 });
    _cache.set(type, [top, side]);
  }
  const [t, s] = _cache.get(type);
  return [t.clone(), s.clone()];
}

export function makeNumberTexture(n, isHot) {
  const c = canvas(128); const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = "#efe6cf"; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
  g.fillStyle = isHot ? "#c0392b" : "#3a3a3a";
  g.font = "bold 64px Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(String(n), 64, 60);
  // pip count (probability dots)
  const pips = 6 - Math.abs(7 - n);
  g.fillStyle = isHot ? "#c0392b" : "#3a3a3a";
  for (let i = 0; i < pips; i++) g.beginPath(), g.arc(64 - (pips - 1) * 5 + i * 10, 104, 2.6, 0, 7), g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function makeSandMaterial() {
  const c = canvas(256); const g = c.getContext("2d"); const rand = rng(31);
  g.fillStyle = "#dcc793"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2200; i++) { g.globalAlpha = 0.05 + rand() * 0.08; g.fillStyle = rand() > 0.5 ? "#c9b27a" : "#eaddb6"; g.beginPath(); g.arc(rand() * 256, rand() * 256, 0.6 + rand() * 1.6, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(3, 3);
  const normalMap = new THREE.CanvasTexture(normalFromCanvas(c, 0.6)); normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.repeat.set(3, 3);
  return new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 1, metalness: 0 });
}

export function makeWaterMaterial() {
  // Rippled sea. Brighter base + slight emissive so it reads as lit water (a plain PBR blue
  // comes out near-black under grazing light). Normal map gives sparkle.
  const c = canvas(256); const g = c.getContext("2d"); const rand = rng(7);
  g.fillStyle = "#2f7bb0"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1600; i++) { g.globalAlpha = 0.06 + rand() * 0.07; g.fillStyle = rand() > 0.5 ? "#4f9dcf" : "#1f5f8c"; g.beginPath(); g.arc(rand() * 256, rand() * 256, 1 + rand() * 2.4, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  const map = new THREE.CanvasTexture(c); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(12, 12); map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(normalFromCanvas(c, 1.6)); normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.repeat.set(12, 12);
  return new THREE.MeshStandardMaterial({
    map, normalMap, normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 0.35, metalness: 0.1, color: 0x3f8fc4,
    emissive: 0x14384f, emissiveIntensity: 0.55,
  });
}

// Colonist player color id -> a nice PBR color for pieces.
export const PLAYER_COLORS = {
  1: 0xd23b3b, 2: 0x3b74d2, 3: 0xe0842e, 4: 0x37a24e,
  11: 0x8a4fd0, 12: 0x2bb6a6, 13: 0xd44f9a, 14: 0xc9b52f,
};
export function playerColor(c) { return PLAYER_COLORS[c] ?? 0x999999; }
