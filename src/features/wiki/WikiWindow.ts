import { config } from "../../../package.json";
import { fileLog } from "../../utils/fileLog";

export type WikiRoute =
  | { type: "home" }
  | { type: "paper"; itemKey: string }
  | { type: "concept"; conceptId: string }
  | { type: "domain"; domain: string }
  | { type: "organizer" };

const WINDOW_TYPE = "reading-assistant:knowledge-wiki";
const WINDOW_FEATURES = "chrome,titlebar,toolbar,centerscreen,resizable,dialog=no,width=1180,height=780";

export type WikiWindowRenderer = (win: Window, route?: WikiRoute) => void;

let openWin: Window | null = null;
let renderer: WikiWindowRenderer | null = null;

function isUsableWindow(win: Window | null): win is Window {
  if (!win) return false;
  try {
    if ((win as any).closed) return false;
    return !!win.document;
  } catch (_) {
    return false;
  }
}

export function setKnowledgeWikiRenderer(fn: WikiWindowRenderer): void {
  renderer = fn;
}

function findExistingWindow(): Window | null {
  if (isUsableWindow(openWin)) return openWin;
  openWin = null;
  try {
    const wm = (Services as any).wm;
    const enumerator = wm.getEnumerator(WINDOW_TYPE);
    if (enumerator?.hasMoreElements?.()) {
      openWin = enumerator.getNext() as Window;
      return openWin;
    }
    const all = wm.getEnumerator(null);
    while (all?.hasMoreElements?.()) {
      const candidate = all.getNext() as Window;
      if (!isUsableWindow(candidate)) continue;
      const href = String(candidate.document?.location?.href || "");
      const marker = String((candidate.document?.documentElement as any)?.getAttribute?.("data-ra-wiki") || "");
      if (href.includes("/content/wiki/window.xhtml") || marker === "1") {
        openWin = candidate;
        return candidate;
      }
    }
  } catch (e: any) {
    Zotero.debug("[RA] findExistingWikiWindow error: " + (e?.message || e));
  }
  return null;
}

export function openKnowledgeWikiWindow(parent?: Window, route?: WikiRoute): Window | null {
  const existing = findExistingWindow();
  if (existing) {
    fileLog("WikiWindow: focusing existing dialog");
    try { existing.focus(); } catch (_) {}
    if (renderer) {
      try { renderer(existing, route || { type: "home" }); } catch (e: any) { Zotero.debug("[RA] wiki rerender error: " + (e?.message || e)); }
    }
    return existing;
  }

  const host = parent || ((Services as any).wm.getMostRecentWindow("navigator:browser") as Window | null);
  if (!host) return null;

  let win: Window | null;
  try {
    fileLog("WikiWindow: opening dialog");
    win = host.openDialog(
      `chrome://${config.addonRef}/content/wiki/window.xhtml`,
      `${config.addonRef}-wiki-window`,
      WINDOW_FEATURES,
    ) as Window | null;
  } catch (e: any) {
    Zotero.debug("[RA] open wiki dialog failed: " + (e?.message || e));
    return null;
  }
  if (!win) return null;
  openWin = win;

  const onLoad = () => {
    try { win!.removeEventListener("load", onLoad); } catch (_) {}
    try { (win!.document.documentElement as any).setAttribute("windowtype", WINDOW_TYPE); } catch (_) {}
    scheduleRenderer(win!, route || { type: "home" }, "load");
    try {
      win!.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") { try { win!.close(); } catch (_) {} }
      });
    } catch (_) {}
  };
  win.addEventListener("load", onLoad);
  scheduleRenderer(win, route || { type: "home" }, "post-open");
  win.addEventListener("unload", () => {
    if (openWin === win) openWin = null;
  });
  return win;
}

function scheduleRenderer(win: Window, route: WikiRoute, source: string): void {
  let attempts = 0;
  const host = ((Services as any).wm.getMostRecentWindow("navigator:browser") as any) || win;
  const run = () => {
    if (!isUsableWindow(win)) return;
    attempts++;
    const done = tryRender(win, route, `${source}#${attempts}`);
    if (!done && attempts < 40) {
      try { host.setTimeout(run, 50); } catch (_) {}
    } else if (!done) {
      renderWindowError(win, "Knowledge Wiki could not find #wiki-root after window load.");
    }
  };
  try { host.setTimeout(run, 0); } catch (_) { run(); }
}

function tryRender(win: Window, route: WikiRoute, source: string): boolean {
  if (!isUsableWindow(win)) return true;
  const root = win.document.getElementById("wiki-root");
  fileLog(`WikiWindow: render check ${source}, root=${!!root}, renderer=${!!renderer}`);
  if (!root || !renderer) return false;
  try {
    try { (win.document.documentElement as any).setAttribute("data-ra-wiki", "1"); } catch (_) {}
    renderer(win, route);
    return true;
  } catch (e: any) {
    const msg = e?.message || String(e);
    fileLog(`WikiWindow: renderer threw (${source}): ${msg}`);
    renderWindowError(win, msg);
    return true;
  }
}

function renderWindowError(win: Window, message: string): void {
  try {
    const root = win.document.getElementById("wiki-root");
    if (!root) return;
    const box = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    box.setAttribute("style", "box-sizing:border-box;margin:24px;padding:16px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;color:#991b1b;font:13px system-ui,sans-serif;line-height:1.5;");
    box.textContent = "Knowledge Wiki failed to render: " + message;
    root.replaceChildren(box);
  } catch (_) {}
}

export function closeKnowledgeWikiWindow(): void {
  const w = openWin || findExistingWindow();
  if (w) {
    try { w.close(); } catch (_) {}
  }
  openWin = null;
}
