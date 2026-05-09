import Addon from "./addon";
import { config } from "../package.json";

try {
  // Always create a fresh Addon instance on startup.
  // The old one may be a stale fallback from a previous install.
  _globalThis.addon = new Addon();
  Zotero[config.addonInstance] = _globalThis.addon;
} catch (e: any) {
  try {
    Zotero.logError(new Error(`[${config.addonName}] Init error: ${e.message}`));
  } catch (e2) {}

  // Provide a fallback so bootstrap.js doesn't crash
  const fallback = {
    data: { alive: true, env: __env__ },
    hooks: {
      onStartup: async () => {},
      onMainWindowLoad: async (_win: Window) => {},
      onMainWindowUnload: async (_win: Window) => {},
      onShutdown: () => {},
    },
    api: {},
  };
  (Zotero as any)[config.addonInstance] = fallback;
}
