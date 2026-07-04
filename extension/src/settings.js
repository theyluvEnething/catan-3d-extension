/**
 * src/settings.js — the single source of truth for user-configurable settings.
 *
 * Persisted in chrome.storage.sync (so they follow the user across machines). Every surface
 * — content script, 3D scene, HUD, popup — reads defaults from here and listens for changes,
 * so a toggle in the popup applies live to the running game with no reload.
 */

export const SETTINGS_KEY = "catan3d.settings";

export const DEFAULT_SETTINGS = {
  enabled: true,          // master switch — show the 3D board at all
  opacity: 1,             // 0..1 overlay opacity
  transparentBg: false,   // let the page show through around the island
  autoRotate: false,      // slow idle camera orbit
  showHud: false,         // debug state HUD (Alt+H also toggles)
  showMarkers: true,      // faint legal-target rings on your turn
};

/** Read the full settings object (defaults merged with anything stored). */
export async function loadSettings() {
  try {
    const got = await chrome.storage.sync.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(got?.[SETTINGS_KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge a partial patch into stored settings and persist. Returns the new full object. */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  try { await chrome.storage.sync.set({ [SETTINGS_KEY]: next }); } catch {}
  return next;
}

/**
 * Subscribe to settings changes. `cb(newSettings, oldSettings)` fires whenever any surface
 * writes new settings. Returns an unsubscribe fn.
 */
export function onSettingsChanged(cb) {
  const handler = (changes, area) => {
    if (area !== "sync" || !changes[SETTINGS_KEY]) return;
    const nv = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    const ov = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].oldValue || {}) };
    cb(nv, ov);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
