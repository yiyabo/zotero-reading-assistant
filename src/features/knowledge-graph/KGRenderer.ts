/**
 * Knowledge Graph window renderer (M2.5).
 *
 * The dialog is a 2-state machine:
 *
 *   ┌─────────────┐  add-papers     ┌──────────────────┐
 *   │   current   │ ───────────►    │ library-browser  │
 *   │   graph     │ ◄────────────   │                  │
 *   └─────────────┘   cancel/done   └──────────────────┘
 *
 * - `current-graph` (default): shows whatever is in `kgStore`. Empty state
 *   if no papers, otherwise a status list. From M5+ this becomes the
 *   cytoscape canvas; the structure stays identical.
 * - `library-browser`: full-window picker for adding papers from the user's
 *   Zotero collections. Commits to KGStore on close.
 *
 * Style injection lives here too so the dialog is fully self-contained.
 */
import { config } from "../../../package.json";
import { fileLog } from "../../utils/fileLog";
import { buildCurrentGraphView } from "./CurrentGraphView";
import { kgStore } from "./KGStore";
import { buildLibraryBrowser } from "./LibraryBrowser";

const ACTIVE_VIEW_DISPOSE_KEY = "__readingAssistantKgDispose";
const RENDER_TOKEN_KEY = "__readingAssistantKgRenderToken";

/**
 * Public entry: called by `KGWindow` once the dialog DOM has loaded. Safe to
 * call multiple times (e.g. dialog re-open) — each call resets to the
 * current-graph view.
 */
export function renderKnowledgeGraph(win: Window): void {
  const doc = win.document;
  const root = doc.getElementById("kg-root");
  fileLog(`KGRenderer: start root=${!!root}`);
  if (!root) {
    Zotero.debug("[RA] KG renderer: #kg-root not found");
    return;
  }
  const w = win as any;
  const renderToken = (Number(w[RENDER_TOKEN_KEY]) || 0) + 1;
  w[RENDER_TOKEN_KEY] = renderToken;
  try {
    injectStyles(doc);
    ensureWindowCleanup(win);
    disposeActiveView(win);
    renderLoading(root as HTMLElement);
  } catch (e: any) {
    fileLog("KGRenderer: pre-render error: " + (e?.message || e));
  }
  // Make sure the store is loaded before painting. If it's already initialized
  // this resolves immediately. Critically: catch every async render error so
  // a failed graph mount cannot leave the dialog as a silent blank window.
  kgStore
    .init()
    .then(() => {
      try {
        if ((win as any).closed || (win as any)[RENDER_TOKEN_KEY] !== renderToken) return;
        if (shouldRenderSafeProgress()) {
          mountSafeProgress(win, root as HTMLElement);
          fileLog("KGRenderer: mounted safe progress");
          return;
        }
        mountCurrentGraph(win, root as HTMLElement);
        fileLog("KGRenderer: mounted current graph");
      } catch (e: any) {
        const msg = e?.message || String(e);
        fileLog("KGRenderer: mountCurrentGraph threw: " + msg);
        if (e?.stack) fileLog("KGRenderer: stack: " + String(e.stack).split("\n").slice(0, 8).join(" | "));
        renderRenderError(win.document, root as HTMLElement, msg);
      }
    })
    .catch((e: any) => {
      if ((win as any).closed || (win as any)[RENDER_TOKEN_KEY] !== renderToken) return;
      const msg = e?.message || String(e);
      fileLog("KGRenderer: kgStore init rejected: " + msg);
      renderRenderError(win.document, root as HTMLElement, msg);
    });
}

function ensureWindowCleanup(win: Window): void {
  const w = win as any;
  if (w.__readingAssistantKgUnloadCleanupInstalled) return;
  w.__readingAssistantKgUnloadCleanupInstalled = true;
  try {
    win.addEventListener("unload", () => {
      disposeActiveView(win);
    }, { once: true } as any);
  } catch (_) {}
}

function disposeActiveView(win: Window): void {
  const w = win as any;
  const dispose = w[ACTIVE_VIEW_DISPOSE_KEY];
  if (typeof dispose !== "function") return;
  w[ACTIVE_VIEW_DISPOSE_KEY] = null;
  try {
    dispose();
  } catch (e: any) {
    fileLog("KGRenderer: active view dispose failed: " + (e?.message || e));
  }
}

function setActiveViewDispose(win: Window, dispose: () => void): void {
  (win as any)[ACTIVE_VIEW_DISPOSE_KEY] = dispose;
}

function shouldRenderSafeProgress(): boolean {
  const state = kgStore.getState();
  const ready = state.papers.filter((p) => p.status === "ready");
  return ready.length > 0 && ready.some((p) => p.relationsAt == null);
}

function getSafeProgress(): {
  papers: number;
  ready: number;
  errors: number;
  edges: number;
  done: number;
  total: number;
} {
  const state = kgStore.getState();
  const ready = state.papers.filter((p) => p.status === "ready");
  return {
    papers: state.papers.length,
    ready: ready.length,
    errors: state.papers.filter((p) => p.status === "error").length,
    edges: state.edges.length,
    done: ready.filter((p) => p.relationsAt != null).length,
    total: ready.length,
  };
}

function mountSafeProgress(win: Window, root: HTMLElement): void {
  disposeActiveView(win);
  const doc = win.document;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const box = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const title = doc.createElementNS(HTML_NS, "h1") as HTMLElement;
  const text = doc.createElementNS(HTML_NS, "p") as HTMLElement;
  const stats = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const bar = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const fill = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const hint = doc.createElementNS(HTML_NS, "p") as HTMLElement;
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;

  box.setAttribute(
    "style",
    "box-sizing:border-box;margin:32px auto;padding:28px;max-width:720px;border:1px solid rgba(99,102,241,.18);border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 20px 60px rgba(15,23,42,.08);font:14px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.6;color:#1f2937;",
  );
  title.setAttribute("style", "margin:0 0 10px;font-size:22px;line-height:1.3;color:#111827;");
  text.setAttribute("style", "margin:0 0 18px;color:#4b5563;");
  stats.setAttribute("style", "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0;");
  bar.setAttribute("style", "height:10px;border-radius:999px;background:#e5e7eb;overflow:hidden;margin:14px 0 12px;");
  fill.setAttribute("style", "height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width .2s ease;");
  hint.setAttribute("style", "margin:12px 0 18px;color:#6b7280;");
  button.setAttribute(
    "style",
    "border:0;border-radius:999px;padding:10px 16px;background:#4f46e5;color:white;font-weight:700;cursor:pointer;",
  );

  title.textContent = "知识图谱正在安全重建";
  text.textContent = "为了避免 Zotero 在关系分析期间渲染 Canvas 崩溃，当前窗口只显示轻量进度。后台分析会继续运行。";
  bar.appendChild(fill);
  box.append(title, text, stats, bar, hint, button);
  root.replaceChildren(box);

  const update = () => {
    const p = getSafeProgress();
    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    stats.replaceChildren(
      buildSafeStat(doc, "论文", String(p.papers)),
      buildSafeStat(doc, "Profile", `${p.ready}/${p.papers}`),
      buildSafeStat(doc, "关系", `${p.done}/${p.total}`),
      buildSafeStat(doc, "边", String(p.edges)),
    );
    hint.textContent =
      p.done < p.total
        ? `还剩 ${p.total - p.done} 篇论文的关系分析未完成。请先不要打开完整图谱 Canvas。`
        : `关系分析已完成。你可以加载完整图谱；如果 Zotero 仍不稳定，请关闭此窗口后再打开。`;
    button.disabled = p.done < p.total;
    button.style.opacity = button.disabled ? "0.55" : "1";
    button.style.cursor = button.disabled ? "not-allowed" : "pointer";
    button.textContent = p.done < p.total ? "等待关系分析完成" : "加载完整图谱";
  };

  const unsubscribe = kgStore.subscribe(update);
  setActiveViewDispose(win, unsubscribe);
  button.addEventListener("click", () => {
    if (shouldRenderSafeProgress()) {
      update();
      return;
    }
    disposeActiveView(win);
    mountCurrentGraph(win, root);
  });
  update();
}

function buildSafeStat(doc: Document, label: string, value: string): HTMLElement {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const box = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const v = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const l = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  box.setAttribute("style", "padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;");
  v.setAttribute("style", "font-size:18px;font-weight:800;color:#111827;");
  l.setAttribute("style", "font-size:12px;color:#6b7280;");
  v.textContent = value;
  l.textContent = label;
  box.append(v, l);
  return box;
}

function mountCurrentGraph(win: Window, root: HTMLElement): void {
  fileLog("KGRenderer: mountCurrentGraph begin");
  disposeActiveView(win);
  const view = buildCurrentGraphView({
    doc: win.document,
    onAddPapers: () => mountLibraryBrowser(win, root),
  });
  setActiveViewDispose(win, () => view.destroy());
  root.replaceChildren();
  root.appendChild(view.root);
  fileLog("KGRenderer: mountCurrentGraph appended");
}

function mountLibraryBrowser(win: Window, root: HTMLElement): void {
  fileLog("KGRenderer: mountLibraryBrowser begin");
  disposeActiveView(win);
  const browser = buildLibraryBrowser({
    doc: win.document,
    onClose: async (commit, items) => {
      disposeActiveView(win);
      if (commit && items.length > 0) {
        try {
          await kgStore.addPapers(items);
        } catch (e: any) {
          Zotero.debug("[RA] addPapers failed: " + (e?.message || e));
        }
      }
      mountCurrentGraph(win, root);
    },
  });
  setActiveViewDispose(win, () => browser.destroy());
  root.replaceChildren();
  root.appendChild(browser.root);
  fileLog("KGRenderer: mountLibraryBrowser appended");
}

function renderLoading(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  box.setAttribute(
    "style",
    "box-sizing:border-box;padding:24px;color:#6b7280;font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;",
  );
  box.textContent = "Loading Knowledge Graph...";
  root.replaceChildren(box);
}

function renderRenderError(doc: Document, root: HTMLElement, message: string): void {
  const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  box.setAttribute(
    "style",
    "box-sizing:border-box;margin:24px;padding:16px;border:1px solid #fecaca;border-radius:10px;background:#fef2f2;color:#991b1b;font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;white-space:pre-wrap;",
  );
  box.textContent = "Knowledge Graph render error:\n" + message;
  root.replaceChildren(box);
}

// ---------------------------------------------------------------------------
// Style injection
// ---------------------------------------------------------------------------

function injectStyles(doc: Document): void {
  const styleId = `${config.addonRef}-kg-style`;
  if (doc.getElementById(styleId)) return;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.id = styleId;
  style.textContent = buildKGStyles(config.addonRef);
  doc.documentElement.appendChild(style);
}

/**
 * Inline KG window styles. Reads as a single CSS sheet templated with the
 * plugin's class prefix. Will move to its own module in M8 once it grows
 * past ~500 lines.
 */
function buildKGStyles(ref: string): string {
  return `
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif;
      color: #1f2937;
      background:
        radial-gradient(rgba(139, 92, 246, 0.05) 1px, transparent 1px) 0 0 / 22px 22px,
        linear-gradient(135deg, #FAF8FF 0%, #F5F3FF 50%, #FAFAFF 100%);
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
    }
    body * { box-sizing: border-box; }

    /* ===== App shell ===== */
    .${ref}-kg-app {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 18px 22px 20px;
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ===== Top bar ===== */
    .${ref}-kg-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex: 0 0 auto;
    }
    .${ref}-kg-topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .${ref}-kg-logo {
      flex: 0 0 auto;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366F1, #8B5CF6);
      color: #fff;
      font-size: 18px;
      box-shadow: 0 6px 16px rgba(139, 92, 246, 0.35);
    }
    .${ref}-kg-title-block { display: flex; flex-direction: column; min-width: 0; }
    .${ref}-kg-app-title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.1px;
      color: #1f2937;
    }
    .${ref}-kg-app-subtitle {
      margin: 2px 0 0;
      font-size: 12px;
      line-height: 1.45;
      color: #6b7280;
      max-width: 600px;
    }
    .${ref}-kg-topbar-right {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ===== Buttons ===== */
    .${ref}-kg-primary-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 18px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366F1, #8B5CF6);
      color: #fff;
      font-family: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.32);
      transition: transform 0.12s ease, filter 0.15s ease, box-shadow 0.15s ease;
    }
    .${ref}-kg-primary-btn:hover { transform: translateY(-1px); filter: brightness(1.05); box-shadow: 0 8px 22px rgba(139, 92, 246, 0.45); }
    .${ref}-kg-primary-btn svg { display: block; }

    .${ref}-kg-icon-btn {
      flex: 0 0 auto;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      border: 1px solid rgba(99, 102, 241, 0.18);
      background: #ffffff;
      color: #4b5563;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
      transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
    }
    .${ref}-kg-icon-btn:hover { background: #F5F3FF; border-color: rgba(99, 102, 241, 0.35); color: #6366F1; transform: translateY(-1px); }
    .${ref}-kg-icon-btn svg { display: block; }

    /* Generic action buttons used inside the detail card */
    .${ref}-kg-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border: 1px solid #E5E7EB;
      border-radius: 9px;
      background: #ffffff;
      color: #1f2937;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .${ref}-kg-action-btn:hover { background: #F5F3FF; border-color: rgba(99, 102, 241, 0.4); color: #4338CA; }
    .${ref}-kg-action-btn-danger:hover { background: #FEF2F2; border-color: rgba(220, 38, 38, 0.35); color: #B91C1C; }
    .${ref}-kg-action-btn svg { display: block; flex: 0 0 auto; }
    .${ref}-kg-action-btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Legacy generic-action button kept for LibraryBrowser etc. */
    .${ref}-kg-generate-btn {
      padding: 9px 20px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366F1, #8B5CF6);
      color: #fff;
      font-family: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.28);
      transition: transform 0.12s ease, filter 0.15s ease, box-shadow 0.15s ease;
    }
    .${ref}-kg-generate-btn:hover:not(:disabled) {
      transform: translateY(-1px); filter: brightness(1.05);
      box-shadow: 0 6px 18px rgba(139, 92, 246, 0.4);
    }
    .${ref}-kg-generate-btn:disabled { cursor: default; opacity: 0.45; box-shadow: none; transform: none; }
    .${ref}-kg-back-btn {
      padding: 8px 18px;
      border: 1px solid #E5E7EB;
      border-radius: 10px;
      background: #ffffff;
      color: inherit;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .${ref}-kg-back-btn:hover { background: rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.4); }

    /* ===== Stat pills row ===== */
    .${ref}-kg-stat-search-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 0 0 auto;
      flex-wrap: wrap;
    }
    .${ref}-kg-stat-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      flex: 1 1 auto;
      min-width: 0;
    }

    /* Stage-3 progress banner: shown only while concept canonicalization
       is running. Tinted indigo to match the rest of the v2 palette. */
    .${ref}-kg-pipeline-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      border-radius: 10px;
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.10), rgba(99, 102, 241, 0.05));
      border: 1px solid rgba(99, 102, 241, 0.28);
      color: #4338CA;
      font-size: 12px;
      font-weight: 600;
      flex: 0 0 auto;
    }
    .${ref}-kg-pipeline-banner-spinner {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(99, 102, 241, 0.25);
      border-top-color: #6366F1;
      animation: ${ref}-kg-banner-spin 0.9s linear infinite;
    }
    .${ref}-kg-pipeline-banner-text { letter-spacing: 0.2px; }
    @keyframes ${ref}-kg-banner-spin {
      to { transform: rotate(360deg); }
    }
    .${ref}-kg-stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 13px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: #ffffff;
      border: 1px solid #E5E7EB;
      color: #4b5563;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .${ref}-kg-stat-pill-icon { font-size: 13px; line-height: 1; }
    .${ref}-kg-stat-pill-papers { background: #EEF2FF; border-color: rgba(99, 102, 241, 0.28); color: #4338CA; }
    .${ref}-kg-stat-pill-edges  { background: #F5F3FF; border-color: rgba(139, 92, 246, 0.28); color: #6D28D9; }
    .${ref}-kg-stat-pill-ok     { background: #ECFDF5; border-color: rgba(34, 197, 94, 0.32);  color: #15803D; }
    .${ref}-kg-stat-pill-warn   { background: #FFFBEB; border-color: rgba(245, 158, 11, 0.32); color: #B45309; }
    .${ref}-kg-stat-pill-err    { background: #FEF2F2; border-color: rgba(220, 38, 38, 0.32);  color: #B91C1C; }

    /* ===== Search input (top-right of stat row) ===== */
    .${ref}-kg-search-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      flex: 0 1 320px;
      width: min(320px, 100%);
      min-width: 240px;
      height: 40px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(226, 232, 240, 0.95);
      border-radius: 999px;
      padding: 0 10px 0 34px;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
      transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }
    .${ref}-kg-search-wrap:focus-within {
      background: #ffffff;
      border-color: rgba(99, 102, 241, 0.38);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.08), 0 6px 16px rgba(15, 23, 42, 0.06);
    }
    .${ref}-kg-search-icon {
      position: absolute;
      left: 13px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 12px;
      color: #94a3b8;
      pointer-events: none;
    }
    .${ref}-kg-search-wrap .${ref}-kg-search-input {
      flex: 1 1 auto;
      min-width: 0;
      width: auto;
      height: 100%;
      border: 0;
      outline: none;
      box-shadow: none;
      background: transparent;
      border-radius: 0;
      font-size: 12.5px;
      padding: 0;
      color: #1f2937;
    }
    .${ref}-kg-search-wrap .${ref}-kg-search-input:focus {
      border: 0;
      outline: none;
      box-shadow: none;
    }
    .${ref}-kg-search-wrap .${ref}-kg-search-input::placeholder { color: #9ca3af; }
    .${ref}-kg-search-clear {
      display: none;
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.12);
      color: #4338CA;
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
    }
    .${ref}-kg-search-clear:hover { background: rgba(99, 102, 241, 0.22); }
    .${ref}-kg-search-clear-visible { display: inline-flex; align-items: center; justify-content: center; }

    /* ===== Edge-type filter chip row ===== */
    .${ref}-kg-chip-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      flex-wrap: wrap;
      padding: 4px 0 2px;
    }
    .${ref}-kg-chip {
      --chip-color: #94a3b8;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      color: #6b7280;
      background: #ffffff;
      border: 1px solid #E5E7EB;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
    }
    .${ref}-kg-chip:hover { border-color: var(--chip-color); }
    .${ref}-kg-chip-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--chip-color);
    }
    .${ref}-kg-chip-count {
      font-size: 10.5px;
      color: #9ca3af;
      font-weight: 500;
      padding: 0 2px;
    }
    /* Active chip: light tint background + colored border + text in the
       chip's color. */
    .${ref}-kg-chip-active {
      background: color-mix(in srgb, var(--chip-color) 12%, white);
      border-color: color-mix(in srgb, var(--chip-color) 45%, transparent);
      color: color-mix(in srgb, var(--chip-color) 75%, #1f2937);
    }
    .${ref}-kg-chip-active .${ref}-kg-chip-count { color: inherit; }
    /* Empty (no edges of this type) — half-opacity but still clickable. */
    .${ref}-kg-chip-empty { opacity: 0.45; }
    /* v7 per-type colors. Mirrors GraphCanvas EDGE palette. */
    .${ref}-kg-chip-cites               { --chip-color: #ec4899; }
    .${ref}-kg-chip-similar-method      { --chip-color: #f59e0b; }
    .${ref}-kg-chip-contrasts           { --chip-color: #ef4444; }
    .${ref}-kg-chip-uses-same-data      { --chip-color: #3b82f6; }
    .${ref}-kg-chip-solves-same-problem { --chip-color: #22c55e; }
    .${ref}-kg-chip-method-link         { --chip-color: #F97316; }
    .${ref}-kg-chip-dataset-link        { --chip-color: #2563EB; }

    /* Chip-group container: subtle separator label in front of each cluster. */
    .${ref}-kg-chip-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px 0 0;
      border-right: 1px solid rgba(99, 102, 241, 0.15);
      margin-right: 4px;
    }
    .${ref}-kg-chip-group:last-child { border-right: none; margin-right: 0; padding-right: 0; }
    .${ref}-kg-chip-group-label {
      font-size: 10.5px;
      font-weight: 700;
      color: #6b7280;
      letter-spacing: 0.4px;
      padding-right: 2px;
    }

    /* View-mode segmented control. */
    .${ref}-kg-view-mode-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0 6px;
      flex-wrap: wrap;
    }
    .${ref}-kg-view-mode-label {
      font-size: 11px;
      font-weight: 700;
      color: #6b7280;
      letter-spacing: 0.4px;
    }
    .${ref}-kg-segmented {
      display: inline-flex;
      border: 1px solid rgba(99, 102, 241, 0.28);
      border-radius: 999px;
      overflow: hidden;
      background: #ffffff;
    }
    .${ref}-kg-segmented-btn {
      appearance: none;
      border: none;
      background: transparent;
      padding: 4px 12px;
      font-size: 11.5px;
      font-weight: 600;
      color: #4b5563;
      cursor: pointer;
      border-right: 1px solid rgba(99, 102, 241, 0.15);
      transition: background 0.12s ease, color 0.12s ease;
    }
    .${ref}-kg-segmented-btn:last-child { border-right: none; }
    .${ref}-kg-segmented-btn:hover { background: rgba(99, 102, 241, 0.08); color: #4338CA; }
    .${ref}-kg-segmented-active {
      background: #6366F1;
      color: #ffffff;
    }
    .${ref}-kg-segmented-active:hover { background: #4338CA; color: #ffffff; }

    /* ===== Main grid: graph + detail ===== */
    .${ref}-kg-main {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr 380px;
      gap: 16px;
    }
    .${ref}-kg-canvas-wrap {
      position: relative;
      min-height: 0;
      border: 1px solid rgba(99, 102, 241, 0.16);
      border-radius: 16px;
      background:
        radial-gradient(rgba(139, 92, 246, 0.10) 1px, transparent 1px) 0 0 / 22px 22px,
        linear-gradient(135deg, #FBFAFF 0%, #F5F3FF 100%);
      box-shadow: 0 8px 28px rgba(99, 102, 241, 0.06);
      overflow: hidden;
    }
    .${ref}-kg-graph-host {
      position: absolute;
      inset: 0;
    }

    /* ===== Vertical toolbar inside canvas ===== */
    .${ref}-kg-vtoolbar {
      position: absolute;
      top: 14px;
      left: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid #E5E7EB;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
      backdrop-filter: blur(6px);
      z-index: 5;
    }
    .${ref}-kg-vtool-btn {
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: #4b5563;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .${ref}-kg-vtool-btn:hover { background: #F5F3FF; color: #6366F1; }
    .${ref}-kg-vtool-btn svg { display: block; }

    /* ===== Detail card ===== */
    .${ref}-kg-detail-card {
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 18px 18px 18px;
      border: 1px solid #EDE9FE;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 8px 28px rgba(99, 102, 241, 0.07);
      overflow-y: auto;
      gap: 12px;
    }
    .${ref}-kg-detail-card::-webkit-scrollbar { width: 8px; }
    .${ref}-kg-detail-card::-webkit-scrollbar-thumb { background: #E5E7EB; border-radius: 4px; }
    .${ref}-kg-detail-card::-webkit-scrollbar-thumb:hover { background: #C4B5FD; }

    /* Detail empty */
    .${ref}-kg-detail-empty {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-align: center;
      padding: 22px;
      border: 1px dashed rgba(139, 92, 246, 0.3);
      border-radius: 12px;
      background: linear-gradient(180deg, #FBFAFF, #F5F3FF);
    }
    .${ref}-kg-detail-empty-icon {
      width: 48px; height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, #EEF2FF, #F5F3FF);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      color: #6366F1;
    }
    .${ref}-kg-detail-empty-heading {
      font-size: 13.5px;
      font-weight: 700;
      color: #4338CA;
    }
    .${ref}-kg-detail-empty-desc {
      max-width: 280px;
      font-size: 12px;
      line-height: 1.55;
      color: #6b7280;
    }

    /* Detail content */
    .${ref}-kg-detail-content {
      display: flex;
      flex-direction: column;
      gap: 12px;
      animation: ${ref}-kg-fade 220ms ease-out both;
    }
    @keyframes ${ref}-kg-fade {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .${ref}-kg-detail-title {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.35;
      color: #1f2937;
    }
    .${ref}-kg-detail-meta {
      font-size: 11.5px;
      color: #6b7280;
      line-height: 1.5;
    }
    .${ref}-kg-detail-pillrow {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .${ref}-kg-detail-actions {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .${ref}-kg-detail-actions .${ref}-kg-action-btn { justify-content: center; }

    /* Status pills (shared) */
    .${ref}-kg-status-pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: 0.2px;
      line-height: 1.6;
      white-space: nowrap;
    }
    .${ref}-kg-status-pending { background: rgba(148, 163, 184, 0.18); color: #475569; }
    .${ref}-kg-status-analyzing {
      background: rgba(139, 92, 246, 0.16);
      color: #6D28D9;
      animation: ${ref}-kg-pulse 1.4s ease-in-out infinite;
    }
    @keyframes ${ref}-kg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
    .${ref}-kg-status-ready { background: rgba(34, 197, 94, 0.16); color: #15803D; }
    .${ref}-kg-status-error { background: rgba(220, 38, 38, 0.16); color: #B91C1C; }

    /* Domain tag */
    .${ref}-kg-domain-tag {
      flex: 0 0 auto;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: 0.2px;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.18));
      color: #4338CA;
      border: 1px solid rgba(99, 102, 241, 0.25);
    }

    /* Summary panel (sections) */
    .${ref}-kg-summary-panel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 0;
      background: transparent;
      border: none;
    }
    .${ref}-kg-summary-block { display: flex; flex-direction: column; gap: 5px; }
    .${ref}-kg-summary-label {
      font-size: 11px;
      font-weight: 700;
      color: #4338CA;
      letter-spacing: 0.1px;
    }
    .${ref}-kg-summary-text {
      margin: 0;
      font-size: 12.5px;
      line-height: 1.6;
      color: #374151;
    }
    .${ref}-kg-summary-list {
      margin: 0;
      padding-left: 18px;
      font-size: 12.5px;
      line-height: 1.6;
      color: #374151;
    }
    .${ref}-kg-summary-list li { margin-bottom: 3px; }
    .${ref}-kg-summary-empty {
      margin: 0;
      font-size: 11.5px;
      color: #6b7280;
      font-style: italic;
    }

    /* Keyword pills */
    .${ref}-kg-keyword-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 2px;
    }
    .${ref}-kg-keyword-pill {
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: linear-gradient(135deg, #EEF2FF, #F5F3FF);
      color: #4338CA;
      border: 1px solid rgba(99, 102, 241, 0.22);
    }

    /* Connections list */
    .${ref}-kg-connections-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .${ref}-kg-connection-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      background: #FAFAFA;
      border: 1px solid #F3F4F6;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .${ref}-kg-connection-row:hover { background: #F5F3FF; border-color: rgba(99, 102, 241, 0.25); }
    .${ref}-kg-connection-row-clickable { cursor: pointer; }
    .${ref}-kg-connection-row-clickable:hover { background: #EEF2FF; border-color: rgba(99, 102, 241, 0.45); }
    .${ref}-kg-connection-row-clickable:focus-visible {
      outline: 2px solid #6366F1;
      outline-offset: 1px;
      background: #EEF2FF;
    }
    .${ref}-kg-connection-row-clickable:active { transform: scale(0.985); }
    .${ref}-kg-connection-body {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .${ref}-kg-connection-peer {
      font-weight: 600;
      font-size: 12px;
      line-height: 1.4;
      color: #1f2937;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${ref}-kg-connection-label {
      font-size: 11px;
      color: #6b7280;
      line-height: 1.5;
    }
    .${ref}-kg-edge-type {
      flex: 0 0 auto;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 650;
      letter-spacing: 0.2px;
      white-space: nowrap;
    }
    .${ref}-kg-edge-type-similar-method  { background: rgba(245,158,11,0.16);  color: #B45309; }
    .${ref}-kg-edge-type-contrasts       { background: rgba(239,68,68,0.16);   color: #B91C1C; }
    .${ref}-kg-edge-type-cites           { background: rgba(236,72,153,0.16);  color: #BE185D; }
    .${ref}-kg-edge-type-uses-same-data  { background: rgba(59,130,246,0.16);  color: #1D4ED8; }
    .${ref}-kg-edge-type-solves-same-problem { background: rgba(34,197,94,0.16); color: #15803D; }
    .${ref}-kg-edge-type-method-link     { background: rgba(249,115,22,0.16);  color: #C2410C; }
    .${ref}-kg-edge-type-dataset-link    { background: rgba(37,99,235,0.16);   color: #1D4ED8; }
    /* Legacy edge-type pills retained for migration window. */
    .${ref}-kg-edge-type-shares-domain   { background: rgba(20,184,166,0.16);  color: #0F766E; }
    .${ref}-kg-edge-type-shares-result   { background: rgba(34,197,94,0.16);   color: #15803D; }
    .${ref}-kg-edge-type-other           { background: rgba(148,163,184,0.18); color: #475569; }

    /* Concept hot-list (empty detail panel). */
    .${ref}-kg-hotlist {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 18px;
    }
    .${ref}-kg-hotlist-heading {
      font-size: 12px;
      font-weight: 700;
      color: #4b5563;
      letter-spacing: 0.4px;
    }
    .${ref}-kg-hotlist-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .${ref}-kg-hotlist-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: #ffffff;
      border: 1px solid rgba(99, 102, 241, 0.14);
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      color: #1f2937;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .${ref}-kg-hotlist-row:hover {
      background: rgba(99, 102, 241, 0.06);
      border-color: rgba(99, 102, 241, 0.42);
    }
    .${ref}-kg-hotlist-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${ref}-kg-hotlist-type {
      flex: 0 0 auto;
      padding: 1px 8px;
      font-size: 10.5px;
      font-weight: 700;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.10);
      color: #4338CA;
    }
    .${ref}-kg-hotlist-method .${ref}-kg-hotlist-type { background: rgba(249,115,22,0.16); color: #C2410C; }
    .${ref}-kg-hotlist-dataset .${ref}-kg-hotlist-type { background: rgba(37,99,235,0.16); color: #1D4ED8; }
    .${ref}-kg-hotlist-task .${ref}-kg-hotlist-type { background: rgba(124,58,237,0.16); color: #6D28D9; }
    .${ref}-kg-hotlist-degree {
      flex: 0 0 auto;
      min-width: 22px;
      text-align: center;
      padding: 1px 6px;
      font-size: 10.5px;
      font-weight: 700;
      border-radius: 6px;
      background: #f1f5f9;
      color: #475569;
    }

    /* ReferencedItem list (paper detail panel: methods/datasets with role). */
    .${ref}-kg-referenced-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .${ref}-kg-referenced-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(241, 245, 249, 0.55);
    }
    .${ref}-kg-referenced-name { flex: 1 1 auto; font-size: 12px; color: #1f2937; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${ref}-kg-referenced-role {
      flex: 0 0 auto;
      padding: 1px 8px;
      font-size: 10.5px;
      font-weight: 700;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.12);
      color: #4338CA;
    }
    .${ref}-kg-referenced-role-extended         { background: rgba(99,102,241,0.16); color: #4338CA; }
    .${ref}-kg-referenced-role-compared-baseline{ background: rgba(239,68,68,0.16);  color: #B91C1C; }
    .${ref}-kg-referenced-role-cited-only       { background: rgba(148,163,184,0.20); color: #475569; }
    .${ref}-kg-referenced-role-used             { background: rgba(34,197,94,0.16);  color: #15803D; }

    /* Concept detail: clickable "首次出现于" pill that focuses the source
       paper node on the canvas. */
    .${ref}-kg-detail-rep-paper {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      padding: 5px 11px;
      margin-top: 3px;
      font-size: 12px;
      font-weight: 600;
      color: #4338CA;
      background: rgba(99, 102, 241, 0.08);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 999px;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .${ref}-kg-detail-rep-paper:hover {
      background: rgba(99, 102, 241, 0.16);
      border-color: rgba(99, 102, 241, 0.5);
    }

    /* Error block (legacy) */
    .${ref}-kg-current-row-error {
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(220, 38, 38, 0.08);
      border: 1px solid rgba(220, 38, 38, 0.2);
      color: #B91C1C;
      font-size: 11.5px;
    }

    /* Empty state (no papers yet) */
    .${ref}-kg-current-empty {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 40px;
      text-align: center;
    }
    .${ref}-kg-current-empty-badge { font-size: 38px; line-height: 1; }
    .${ref}-kg-current-empty-heading { margin: 0; font-size: 18px; font-weight: 700; color: #1f2937; }
    .${ref}-kg-current-empty-desc {
      margin: 0;
      max-width: 460px;
      font-size: 12.5px;
      line-height: 1.6;
      color: #6b7280;
    }

    /* ===== Picker / search reused styles (legacy) ===== */
    .${ref}-kg-picker-title { margin: 0 0 4px; font-size: 20px; font-weight: 700; }
    .${ref}-kg-picker-subtitle { margin: 0; font-size: 12.5px; line-height: 1.55; color: #6b7280; }
    .${ref}-kg-search-input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 14px;
      font-size: 13px;
      border: 1px solid #E5E7EB;
      border-radius: 10px;
      background: #ffffff;
      color: inherit;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .${ref}-kg-search-input:focus { border-color: #6366F1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18); }
    .${ref}-kg-search-empty { padding: 14px; font-size: 12.5px; color: #6b7280; text-align: center; }
    .${ref}-kg-search-result {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #E5E7EB;
      border-radius: 8px;
      background: #ffffff;
      color: inherit;
      text-align: left;
      font-family: inherit;
      font-size: 12.5px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .${ref}-kg-search-result:hover:not(.${ref}-kg-search-result-disabled) { background: rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.4); }
    .${ref}-kg-search-result-check {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      margin-top: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid rgba(107, 114, 128, 0.35);
      border-radius: 6px;
      background: #ffffff;
      color: #6b7280;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .${ref}-kg-search-result:hover:not(.${ref}-kg-search-result-disabled) .${ref}-kg-search-result-check { border-color: #6366F1; color: #6366F1; }
    .${ref}-kg-search-result-body { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
    .${ref}-kg-search-result-title { font-weight: 600; line-height: 1.35; }
    .${ref}-kg-search-result-meta { color: #6b7280; font-size: 11.5px; }
    .${ref}-kg-search-result-selected { background: rgba(99, 102, 241, 0.10); border-color: rgba(99, 102, 241, 0.5); }
    .${ref}-kg-search-result-selected .${ref}-kg-search-result-check { background: linear-gradient(135deg, #6366F1, #8B5CF6); border-color: transparent; color: #fff; }
    .${ref}-kg-search-result-check-existing { background: rgba(22, 163, 74, 0.8); border-color: transparent; color: #fff; }
    .${ref}-kg-search-result-disabled { opacity: 0.55; cursor: default; }

    /* ----------------------------------------------------- *
     *  LibraryBrowser                                       *
     * ----------------------------------------------------- */
    .${ref}-kg-browser {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px 22px;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }
    .${ref}-kg-browser-header {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .${ref}-kg-browser-title {
      flex: 0 0 auto;
      margin: 0;
      font-size: 17px;
      font-weight: 700;
    }
    .${ref}-kg-browser-header .${ref}-kg-search-input {
      flex: 1 1 auto;
    }
    .${ref}-kg-browser-main {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 14px;
    }
    .${ref}-kg-browser-tree {
      overflow-y: auto;
      padding: 6px 4px;
      border: 1px solid var(--color-border, #e5e7eb);
      border-radius: 10px;
      background: var(--material-background, #ffffff);
    }
    .${ref}-kg-tree-row {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: inherit;
      font-family: inherit;
      font-size: 12.5px;
      text-align: left;
      cursor: pointer;
      border-radius: 6px;
      transition: background 0.12s ease;
    }
    .${ref}-kg-tree-row:hover {
      background: rgba(99,102,241,0.08);
    }
    .${ref}-kg-tree-row-active {
      background: color-mix(in srgb, #6366F1 12%, transparent);
      font-weight: 600;
    }
    .${ref}-kg-tree-icon {
      flex: 0 0 auto;
      font-size: 13px;
    }
    .${ref}-kg-tree-label {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${ref}-kg-browser-items {
      display: flex;
      flex-direction: column;
      min-height: 0;
      gap: 8px;
    }
    .${ref}-kg-browser-items-header {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--fill-secondary, #6b7280);
      padding: 0 4px;
    }
    .${ref}-kg-browser-items-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-right: 4px;
    }
    .${ref}-kg-browser-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--color-border, #e5e7eb);
    }
    .${ref}-kg-browser-footer-hint {
      flex: 1 1 auto;
      font-size: 12px;
      color: var(--fill-secondary, #6b7280);
    }
  `;
}
