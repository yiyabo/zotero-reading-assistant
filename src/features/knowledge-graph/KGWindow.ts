/**
 * Knowledge Graph dialog window — open/close lifecycle.
 *
 * This module is intentionally stateless about the *content* of the window.
 * It only knows how to:
 *   1. Open `chrome://<addonRef>/content/knowledge-graph/window.xhtml` as
 *      a standalone dialog.
 *   2. Wait until the dialog's DOM is ready, then hand off to the renderer
 *      (which is registered by the caller).
 *   3. Re-focus the dialog if it's already open instead of stacking.
 *   4. Track the window reference for clean shutdown.
 *
 * The renderer is injected as a callback so we don't pull all of the
 * paper-picker / graph-view code into the main-window's startup path.
 * Only when the user actually opens the window do we wire those in.
 */
import { config } from "../../../package.json";
import { fileLog } from "../../utils/fileLog";

const WINDOW_TYPE = "reading-assistant:knowledge-graph";
const WINDOW_FEATURES =
  "chrome,titlebar,toolbar,centerscreen,resizable,dialog=no,width=1200,height=800";

export type KGWindowRenderer = (win: Window) => void;

let openWin: Window | null = null;
let renderer: KGWindowRenderer | null = null;

function isUsableWindow(win: Window | null): win is Window {
  if (!win) return false;
  try {
    if ((win as any).closed) return false;
    return !!win.document;
  } catch (_) {
    return false;
  }
}

/**
 * Register the renderer that will be called every time the window is
 * (re-)opened with a fresh DOM. The renderer receives the dialog Window
 * after the `load` event has fired so `win.document.getElementById(...)`
 * is safe to use.
 */
export function setKnowledgeGraphRenderer(fn: KGWindowRenderer): void {
  renderer = fn;
}

/**
 * Find an already-open KG window in any open Zotero browser session.
 * Used both for re-focus on launch and for shutdown cleanup.
 */
function findExistingWindow(): Window | null {
  if (isUsableWindow(openWin)) return openWin;
  openWin = null;
  try {
    const wm = (Services as any).wm;
    const enumerator = wm.getEnumerator(WINDOW_TYPE);
    if (enumerator?.hasMoreElements?.()) {
      const found = enumerator.getNext() as Window;
      openWin = found;
      return found;
    }
    const all = wm.getEnumerator(null);
    while (all?.hasMoreElements?.()) {
      const candidate = all.getNext() as Window;
      if (!isUsableWindow(candidate)) continue;
      const href = String(candidate.document?.location?.href || "");
      const marker = String((candidate.document?.documentElement as any)?.getAttribute?.("data-ra-kg") || "");
      if (href.includes("/content/knowledge-graph/window.xhtml") || marker === "1") {
        openWin = candidate;
        return candidate;
      }
    }
  } catch (e: any) {
    Zotero.debug("[RA] findExistingWindow error: " + (e?.message || e));
  }
  return null;
}

/**
 * Open the KG dialog. If one is already open, focus it instead.
 * Returns the window reference (existing or newly opened).
 */
export function openKnowledgeGraphWindow(parent?: Window): Window | null {
  const existing = findExistingWindow();
  if (existing) {
    fileLog("KGWindow: focusing existing dialog");
    try { existing.focus(); } catch (_) {}
    const doc = existing.document;
    if ((doc.documentElement as any).getAttribute("data-ra-kg-rendered") !== "1") {
      void scheduleRenderer(existing, "existing");
    }
    return existing;
  }

  const host =
    parent || ((Services as any).wm.getMostRecentWindow("navigator:browser") as Window | null);
  if (!host) {
    Zotero.debug("[RA] openKnowledgeGraphWindow: no host window");
    return null;
  }

  let win: Window | null;
  try {
    fileLog("KGWindow: opening dialog");
    win = host.openDialog(
      `chrome://${config.addonRef}/content/knowledge-graph/window.xhtml`,
      `${config.addonRef}-kg-window`,
      WINDOW_FEATURES,
    ) as Window | null;
  } catch (e: any) {
    Zotero.debug("[RA] openDialog failed: " + (e?.message || e));
    return null;
  }
  if (!win) return null;

  openWin = win;

  const onLoad = () => {
    try { win!.removeEventListener("load", onLoad); } catch (_) {}
    try { (win!.document.documentElement as any).setAttribute("windowtype", WINDOW_TYPE); } catch (_) {}
    void scheduleRenderer(win!, "load");
  };
  win.addEventListener("load", onLoad);
  void scheduleRenderer(win, "post-open");

  win.addEventListener("unload", () => {
    if (openWin === win) openWin = null;
  });

  return win;
}

function scheduleRenderer(win: Window, source: string): void {
  let attempts = 0;
  const host = ((Services as any).wm.getMostRecentWindow("navigator:browser") as any) || win;
  const run = () => {
    if (!isUsableWindow(win)) return;
    attempts++;
    const done = tryRender(win, `${source}#${attempts}`);
    if (!done && attempts < 40) {
      try { host.setTimeout(run, 50); } catch (_) {}
    } else if (!done) {
      renderWindowError(win, "Knowledge Graph could not find #kg-root after window load.");
    }
  };
  try { host.setTimeout(run, 0); } catch (_) { run(); }
}

function tryRender(win: Window, source: string): boolean {
  if (!isUsableWindow(win)) return true;
  const doc = win.document;
  const root = doc.getElementById("kg-root");
  fileLog(
    `KGWindow: render check ${source}, ready=${doc.readyState}, root=${!!root}, renderer=${!!renderer}`,
  );
  if (!root || !renderer) return false;
  if ((doc.documentElement as any).getAttribute("data-ra-kg-rendered") === "1") {
    fileLog(`KGWindow: render skipped (${source}); already rendered`);
    return true;
  }
  try {
    try { (doc.documentElement as any).setAttribute("data-ra-kg", "1"); } catch (_) {}
    try { (doc.documentElement as any).setAttribute("data-ra-kg-rendered", "1"); } catch (_) {}
    renderer(win);
    fileLog(`KGWindow: renderer returned (${source})`);
    return true;
  } catch (e: any) {
    const msg = e?.message || String(e);
    fileLog(`KGWindow: renderer threw (${source}): ${msg}`);
    Zotero.debug("[RA] KG renderer threw: " + msg);
    renderWindowError(win, msg);
    return true;
  }
}

function renderWindowError(win: Window, message: string): void {
  try {
    const doc = win.document;
    const root = doc.getElementById("kg-root");
    if (!root) return;
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const box = doc.createElementNS(HTML_NS, "div");
    box.setAttribute(
      "style",
      "box-sizing:border-box;margin:24px;padding:16px;border:1px solid #fecaca;border-radius:10px;background:#fef2f2;color:#991b1b;font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;",
    );
    box.textContent = "Knowledge Graph failed to render: " + message;
    root.replaceChildren(box);
  } catch (_) {}
}

/**
 * Close the KG window if open. Safe to call during plugin shutdown.
 */
export function closeKnowledgeGraphWindow(): void {
  const w = openWin || findExistingWindow();
  if (w) {
    try { w.close(); } catch (_) {}
  }
  openWin = null;
}
