/**
 * src/background.js — MV3 service worker.
 *
 * Responsibilities are deliberately minimal:
 *  1. Seed default settings on first install so the popup has something to render.
 *  2. Reflect connection status in the toolbar badge (green dot when a Colonist game is live).
 *
 * The popup talks to the content script directly via chrome.tabs.sendMessage; the worker only
 * needs to own install-time seeding and the badge. Settings live in chrome.storage.sync.
 */
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./settings.js";

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const got = await chrome.storage.sync.get(SETTINGS_KEY);
    if (!got?.[SETTINGS_KEY]) {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    }
  } catch {}
  chrome.action.setBadgeBackgroundColor({ color: "#1f2937" });
});

// Content scripts ping us with their live status; we paint the toolbar badge for that tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "CATAN3D_STATUS" && sender.tab?.id != null) {
    const connected = !!msg.connected;
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: connected ? "●" : "" });
    chrome.action.setBadgeBackgroundColor({
      tabId: sender.tab.id,
      color: connected ? "#22c55e" : "#6b7280",
    });
  }
});
