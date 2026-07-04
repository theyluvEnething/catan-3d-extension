/* popup.js — the Catan 3D control panel.
 *
 * Reads/writes settings in chrome.storage.sync, applies them live to the active Colonist tab via
 * a message round-trip (content.js -> window.__catan3d), and polls live game status for the
 * header pill + footer stats. Written defensively so it also renders in a plain preview (no
 * chrome.* APIs) — every chrome call is guarded. */

const HAS_CHROME = typeof chrome !== "undefined" && !!chrome.storage;

const DEFAULTS = {
  enabled: true, opacity: 1, transparentBg: false,
  autoRotate: false, showHud: false, showMarkers: true,
};
const KEY = "catan3d.settings";

// Colonist player-color id -> CSS (for the "turn" swatch).
const COLOR_HEX = { 1:"#e0524b", 2:"#4189e0", 3:"#e8863a", 4:"#3aa85a", 11:"#8a5cd1", 12:"#38b6a6", 13:"#d94f9a", 14:"#c9c032" };

let settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);
const els = {
  master: $("masterCard"), masterSub: $("masterSub"), settings: $("settings"),
  opacity: $("opacity"), opacityVal: $("opacityVal"),
  transparentBg: $("transparentBg"), autoRotate: $("autoRotate"),
  showMarkers: $("showMarkers"), showHud: $("showHud"), resetCam: $("resetCam"),
  statusPill: $("statusPill"), statusText: $("statusText"),
  statTurn: $("statTurn"), statSync: $("statSync"),
};

// ---- storage ------------------------------------------------------------------------------
async function loadSettings() {
  if (!HAS_CHROME) return { ...DEFAULTS };
  try { const g = await chrome.storage.sync.get(KEY); return { ...DEFAULTS, ...(g?.[KEY] || {}) }; }
  catch { return { ...DEFAULTS }; }
}
async function persist(patch) {
  settings = { ...settings, ...patch };
  if (HAS_CHROME) { try { await chrome.storage.sync.set({ [KEY]: settings }); } catch {} }
  nudgeTab();
}

// ---- active-tab messaging -----------------------------------------------------------------
async function activeTabId() {
  if (!HAS_CHROME || !chrome.tabs) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && /https:\/\/(www\.)?colonist\.io/.test(tab.url || "") ? tab.id : null;
  } catch { return null; }
}
async function sendTab(message) {
  const id = await activeTabId();
  if (id == null) return null;
  return new Promise((res) => {
    try { chrome.tabs.sendMessage(id, message, (r) => { void chrome.runtime.lastError; res(r || null); }); }
    catch { res(null); }
  });
}
function nudgeTab() { sendTab({ type: "CATAN3D_APPLY_SETTINGS", settings }); }

// ---- render -------------------------------------------------------------------------------
function renderControls() {
  els.master.setAttribute("aria-pressed", String(!!settings.enabled));
  els.masterSub.textContent = settings.enabled ? "Overlay is on" : "Overlay is off";
  els.settings.classList.toggle("is-disabled", !settings.enabled);
  els.resetCam.classList.toggle("is-disabled", !settings.enabled);

  const pct = Math.round(settings.opacity * 100);
  els.opacity.value = String(pct);
  els.opacityVal.textContent = `${pct}%`;
  els.opacity.style.setProperty("--fill", `${((pct - 20) / 80) * 100}%`);

  els.transparentBg.checked = !!settings.transparentBg;
  els.autoRotate.checked = !!settings.autoRotate;
  els.showMarkers.checked = !!settings.showMarkers;
  els.showHud.checked = !!settings.showHud;
}

function setPill(kind, text) {
  els.statusPill.className = `pill pill-${kind}`;
  els.statusText.textContent = text;
}

function renderStatus(st) {
  if (!st || !st.connected) { setPill("idle", "No game"); els.statTurn.textContent = "—"; els.statSync.textContent = "—"; els.statSync.className = "stat-value"; return; }
  if (st.yourTurn) setPill("live", "Your turn");
  else setPill("wait", "Live");

  // turn swatch
  const c = st.turnColor;
  els.statTurn.innerHTML = c != null
    ? `<span class="swatch" style="background:${COLOR_HEX[c] || "#888"}"></span>${st.yourTurn ? "You" : `P${c}`}`
    : "—";

  if (st.sync && st.sync.checks > 0) {
    const ok = st.sync.clean;
    els.statSync.className = `stat-value ${ok ? "ok" : "bad"}`;
    els.statSync.textContent = ok ? `✓ ${st.sync.checks}` : `✕ ${st.sync.desyncs}`;
  } else { els.statSync.className = "stat-value"; els.statSync.textContent = "—"; }
}

async function pollStatus() {
  const st = await sendTab({ type: "CATAN3D_GET_STATUS" });
  renderStatus(st);
}

// ---- wire events --------------------------------------------------------------------------
function wire() {
  els.master.addEventListener("click", () => { persist({ enabled: !settings.enabled }); renderControls(); });

  els.opacity.addEventListener("input", () => {
    const pct = +els.opacity.value;
    els.opacityVal.textContent = `${pct}%`;
    els.opacity.style.setProperty("--fill", `${((pct - 20) / 80) * 100}%`);
    persist({ opacity: pct / 100 });
  });

  const bind = (el, key) => el.addEventListener("change", () => persist({ [key]: el.checked }));
  bind(els.transparentBg, "transparentBg");
  bind(els.autoRotate, "autoRotate");
  bind(els.showMarkers, "showMarkers");
  bind(els.showHud, "showHud");

  els.resetCam.addEventListener("click", () => {
    if (!settings.enabled) return;
    els.resetCam.animate([{ transform: "scale(.96)" }, { transform: "scale(1)" }], { duration: 160 });
    sendTab({ type: "CATAN3D_RESET_CAMERA" });
  });
}

// ---- boot ---------------------------------------------------------------------------------
(async () => {
  settings = await loadSettings();
  renderControls();
  wire();
  pollStatus();
  if (HAS_CHROME) setInterval(pollStatus, 1200);
})();
