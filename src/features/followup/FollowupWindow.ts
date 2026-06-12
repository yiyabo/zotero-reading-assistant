import { config } from "../../../package.json";
import { fileLog } from "../../utils/fileLog";

export type FollowupWindowContext = {
  historyMessages: Array<{ role: string; content: string; messageIndex: number }>;
  anchorText: string;
  parentMessageIndex: number;
  paperKey: string;
  conversationId: string;
};

const WINDOW_TYPE = "reading-assistant:followup";
const WINDOW_FEATURES = "chrome,titlebar,toolbar,centerscreen,resizable,dialog=no,width=1100,height=720";

export type FollowupWindowRenderer = (win: Window, ctx: FollowupWindowContext) => void;

let openWin: Window | null = null;
let renderer: FollowupWindowRenderer | null = null;

function isUsableWindow(win: Window | null): win is Window {
  if (!win) return false;
  try {
    if ((win as any).closed) return false;
    return !!win.document;
  } catch (_) {
    return false;
  }
}

export function setFollowupWindowRenderer(fn: FollowupWindowRenderer): void {
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
  } catch (e: any) {
    Zotero.debug("[RA] findExistingFollowupWindow error: " + (e?.message || e));
  }
  return null;
}

export function openFollowupWindow(parent: Window | null, ctx: FollowupWindowContext): Window | null {
  const existing = findExistingWindow();
  if (existing) {
    fileLog("FollowupWindow: focusing existing dialog");
    try { existing.focus(); } catch (_) {}
    if (renderer) {
      try { renderer(existing, ctx); } catch (e: any) { Zotero.debug("[RA] followup rerender error: " + (e?.message || e)); }
    }
    return existing;
  }

  const host = parent || ((Services as any).wm.getMostRecentWindow("navigator:browser") as Window | null);
  if (!host) return null;

  let win: Window | null;
  try {
    fileLog("FollowupWindow: opening dialog");
    win = host.openDialog(
      `chrome://${config.addonRef}/content/followup/window.xhtml`,
      `${config.addonRef}-followup-window`,
      WINDOW_FEATURES,
    ) as Window | null;
  } catch (e: any) {
    Zotero.debug("[RA] open followup dialog failed: " + (e?.message || e));
    return null;
  }
  if (!win) return null;
  openWin = win;

  const onLoad = () => {
    try { win!.removeEventListener("load", onLoad); } catch (_) {}
    try { (win!.document.documentElement as any).setAttribute("windowtype", WINDOW_TYPE); } catch (_) {}
    scheduleRenderer(win!, ctx, "load");
    try {
      win!.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") { try { win!.close(); } catch (_) {} }
      });
    } catch (_) {}
  };
  win.addEventListener("load", onLoad);
  scheduleRenderer(win, ctx, "post-open");
  win.addEventListener("unload", () => {
    if (openWin === win) openWin = null;
  });
  return win;
}

function scheduleRenderer(win: Window, ctx: FollowupWindowContext, source: string): void {
  let attempts = 0;
  const host = ((Services as any).wm.getMostRecentWindow("navigator:browser") as any) || win;
  const run = () => {
    if (!isUsableWindow(win)) return;
    attempts++;
    const done = tryRender(win, ctx, `${source}#${attempts}`);
    if (!done && attempts < 40) {
      try { host.setTimeout(run, 50); } catch (_) {}
    } else if (!done) {
      renderWindowError(win, "Follow-up window could not find #followup-root after window load.");
    }
  };
  try { host.setTimeout(run, 0); } catch (_) { run(); }
}

function tryRender(win: Window, ctx: FollowupWindowContext, source: string): boolean {
  if (!isUsableWindow(win)) return true;
  const doc = win.document;
  const root = getFollowupRoot(doc);
  fileLog(
    `FollowupWindow: render check ${source}, ready=${doc.readyState}, ` +
      `href=${String(doc.location?.href || "")}, body=${!!doc.body}, ` +
      `root=${!!root}, renderer=${!!renderer}`,
  );
  if (!root || !renderer) return false;
  try {
    try { (doc.documentElement as any).setAttribute("data-ra-followup", "1"); } catch (_) {}
    renderer(win, ctx);
    return true;
  } catch (e: any) {
    const msg = e?.message || String(e);
    fileLog(`FollowupWindow: renderer threw (${source}): ${msg}`);
    renderWindowError(win, msg);
    return true;
  }
}

function renderWindowError(win: Window, message: string): void {
  try {
    const root = getFollowupRoot(win.document);
    if (!root) return;
    const box = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    box.setAttribute("style", "box-sizing:border-box;margin:24px;padding:16px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;color:#991b1b;font:13px system-ui,sans-serif;line-height:1.5;");
    box.textContent = "Follow-up window failed to render: " + message;
    root.replaceChildren(box);
  } catch (_) {}
}

function getFollowupRoot(doc: Document): HTMLElement | null {
  const explicit = doc.getElementById("followup-root") as HTMLElement | null;
  if (explicit) return explicit;
  const body = doc.body as HTMLElement | null;
  if (!body) return null;
  try {
    body.id = "followup-root";
    body.style.margin = "0";
    body.style.width = "100%";
    body.style.height = "100%";
    body.style.minHeight = "0";
    body.style.display = "flex";
    body.style.flexDirection = "column";
  } catch (_) {}
  return body;
}

export function closeFollowupWindow(): void {
  const w = openWin || findExistingWindow();
  if (w) {
    try { w.close(); } catch (_) {}
  }
  openWin = null;
}
