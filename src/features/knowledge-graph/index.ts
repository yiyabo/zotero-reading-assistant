/**
 * Knowledge Graph feature — public entry points.
 *
 * Lifecycle:
 *   - `initKnowledgeGraph()` is called once per plugin startup. It registers
 *     the dialog renderer (so future opens know what to render).
 *   - `attachToMainWindow(win)` is called on every chrome window load to
 *     inject the Tools-menu item into that specific window.
 *   - `detachFromMainWindow(win)` is called on chrome window unload.
 *   - `shutdownKnowledgeGraph()` is called on plugin shutdown to close any
 *     still-open dialog and clear any global state.
 *
 * The feature is fully decoupled from `SidebarView`. Nothing in this folder
 * imports from `src/sidebar/` except shared dom utils (and locale via `t`).
 */
import {
  openKnowledgeGraphWindow,
  closeKnowledgeGraphWindow,
  setKnowledgeGraphRenderer,
} from "./KGWindow";
import { renderKnowledgeGraph } from "./KGRenderer";
import { kgStore } from "./KGStore";
import { startKGPipeline, stopKGPipeline } from "./KGPipeline";
import { registerToolsMenuItem, unregisterToolsMenuItem } from "./ToolsMenu";

export function initKnowledgeGraph(): void {
  setKnowledgeGraphRenderer((win) => renderKnowledgeGraph(win));
  // Load persistent state eagerly so first dialog open is instant, then
  // start the analysis pipeline so any leftover `pending` papers from a
  // previous session get processed immediately.
  kgStore
    .init()
    .then(() => {
      startKGPipeline();
    })
    .catch((e: any) => {
      Zotero.debug("[RA] kgStore eager init failed: " + (e?.message || e));
    });
}

export function attachToMainWindow(win: Window): void {
  registerToolsMenuItem(win, (host) => {
    openKnowledgeGraphWindow(host);
  });
}

export function detachFromMainWindow(win: Window): void {
  unregisterToolsMenuItem(win);
}

export function shutdownKnowledgeGraph(): void {
  try { stopKGPipeline(); } catch (_) {}
  closeKnowledgeGraphWindow();
}

// Re-export window helpers for callers that want direct control
// (e.g. a future right-click context menu).
export { openKnowledgeGraphWindow, closeKnowledgeGraphWindow };
