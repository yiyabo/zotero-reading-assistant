import { getLLMManager } from "../../modules/llm/LLMManager";
import type { StreamCallback } from "../../modules/llm/types";
import { renderMarkdown } from "../../modules/utils/markdown";
import { getPDFMetadata, getPDFSelection } from "../../modules/zotero/PDFReader";
import { aiNotesStore } from "./AINotesStore";
import type { NoteAiAction, NoteAiContext } from "./noteAiPrompts";
import { buildNoteAiMessages, stripCodeFence } from "./noteAiPrompts";
import { buildOverlayCss } from "./overlayCss";
import type { AINote } from "./types";
import { DEFAULT_NOTE_COLOR, DEFAULT_NOTE_HEIGHT, DEFAULT_NOTE_WIDTH } from "./types";

const PREFIX = "ra-ainote";
const STYLE_ID = `${PREFIX}-style`;

type ReaderBinding = {
  reader: any;
  attachmentKey: string;
  parentItemKey: string;
  itemID: number;
  cleanup: () => void;
  placeMode: boolean;
  editingId: string | null;
};

/** One in-flight AI request for the fixed editor. Only ever one at a time. */
type AiRun = {
  noteId: string;
  action: NoteAiAction;
  /** Cleared when the editor closes — callbacks must no-op after that. */
  alive: boolean;
  /** User pressed 停止: keep whatever streamed in, do not treat as an error. */
  stopped: boolean;
};

type AiTone = "" | "busy" | "ok" | "warn" | "err";

/** Fixed-editor layout: textarea only / textarea + live preview / preview only. */
type EditorView = "edit" | "split" | "preview";

const EDITOR_VIEWS: Array<{ mode: EditorView; label: string; title: string }> = [
  { mode: "edit", label: "编辑", title: "只显示编辑框" },
  { mode: "split", label: "分栏", title: "编辑框 + 实时预览" },
  { mode: "preview", label: "预览", title: "只显示渲染结果" },
];

/**
 * Note content is authored by the user *or* produced by the LLM from PDF page
 * text, and markdown-it runs with `html: true`. A crafted PDF could therefore
 * talk the model into emitting markup, so strip the active bits before it goes
 * anywhere near innerHTML.
 */
const UNSAFE_TAGS = new Set([
  "SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON",
]);

type AiUndoSnapshot = { text: string; start: number; end: number };

const AI_BUSY_LABEL: Record<NoteAiAction, string> = {
  generate: "正在生成便签…",
  format: "正在整理格式…",
  rewrite: "正在改写选中片段…",
};

const AI_DONE_LABEL: Record<NoteAiAction, string> = {
  generate: "已生成",
  format: "已整理格式",
  rewrite: "已改写选中片段",
};

function unwrapWin(win: any): any {
  if (!win) return null;
  try {
    return win.wrappedJSObject || win;
  } catch (_) {
    return win;
  }
}

/** Outer reader chrome window (toolbar / UI shell). */
function getReaderChromeWindow(reader: any): any | null {
  try {
    return reader?._iframeWindow || reader?._iframe?.contentWindow || null;
  } catch (_) {
    return null;
  }
}

/**
 * Zotero 7 nests PDF.js inside the reader iframe. Prefer primary/secondary
 * view windows, then walk nested iframes for PDFViewerApplication.
 */
function getPdfViewWindows(reader: any): any[] {
  const out: any[] = [];
  const seen = new Set<any>();
  const push = (w: any) => {
    if (!w || seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };

  push(getReaderChromeWindow(reader));
  try {
    const ir = reader?._internalReader;
    push(ir?._primaryView?._iframeWindow);
    push(ir?._secondaryView?._iframeWindow);
    push(ir?._lastView?._iframeWindow);
  } catch (_) {}

  // One level of nested iframes (PDF.js viewer lives here on Zotero 7).
  for (const w of [...out]) {
    try {
      const doc = w.document;
      if (!doc) continue;
      const iframes = doc.querySelectorAll("iframe, browser");
      for (let i = 0; i < iframes.length; i++) {
        try {
          push((iframes[i] as any).contentWindow);
        } catch (_) {}
      }
    } catch (_) {}
  }
  return out;
}

function getPdfAppFromWindow(win: any): any | null {
  const w = unwrapWin(win);
  if (!w) return null;
  try {
    if (w.PDFViewerApplication) return w.PDFViewerApplication;
  } catch (_) {}
  return null;
}

function getPdfApp(reader: any): any | null {
  for (const win of getPdfViewWindows(reader)) {
    const app = getPdfAppFromWindow(win);
    if (app?.pdfViewer) return app;
  }
  return null;
}

function getAttachmentMeta(itemID: number): { attachmentKey: string; parentItemKey: string } | null {
  try {
    const item = Zotero.Items.get(itemID) as any;
    if (!item) return null;
    const attachmentKey = String(item.key || "");
    let parentItemKey = attachmentKey;
    if (item.parentItemKey) parentItemKey = String(item.parentItemKey);
    else if (item.parentID) {
      const parent = Zotero.Items.get(item.parentID) as any;
      if (parent?.key) parentItemKey = String(parent.key);
    }
    if (!attachmentKey) return null;
    return { attachmentKey, parentItemKey };
  } catch (_) {
    return null;
  }
}

function pdfRectToCss(pageView: any, rect: [number, number, number, number]): { left: number; top: number; width: number; height: number } {
  const viewport = pageView.viewport;
  const [x1, y1, x2, y2] = rect;
  const a = viewport.convertToViewportPoint(x1, y2);
  const b = viewport.convertToViewportPoint(x2, y1);
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const width = Math.max(48, Math.abs(b[0] - a[0]));
  const height = Math.max(36, Math.abs(b[1] - a[1]));
  return { left, top, width, height };
}

function cssBoxToPdfRect(pageView: any, left: number, top: number, width: number, height: number): [number, number, number, number] {
  const viewport = pageView.viewport;
  const p1 = viewport.convertToPdfPoint(left, top + height);
  const p2 = viewport.convertToPdfPoint(left + width, top);
  const x1 = Math.min(p1[0], p2[0]);
  const y1 = Math.min(p1[1], p2[1]);
  const x2 = Math.max(p1[0], p2[0]);
  const y2 = Math.max(p1[1], p2[1]);
  return [x1, y1, x2, y2];
}

function ensureStyle(doc: Document): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    (doc.head || doc.documentElement).appendChild(style);
  }
  // Always refresh so CSS edits apply without full reader reload.
  style.textContent = buildOverlayCss(PREFIX);
}

function ensurePageRoot(pageDiv: HTMLElement, pageIndex: number): HTMLElement {
  const id = `${PREFIX}-root-${pageIndex}`;
  let root = pageDiv.querySelector(`#${id}`) as HTMLElement | null;
  if (root) return root;
  root = pageDiv.ownerDocument.createElement("div");
  root.id = id;
  root.className = `${PREFIX}-root`;
  root.dataset.pageIndex = String(pageIndex);
  pageDiv.style.position = pageDiv.style.position || "relative";
  pageDiv.appendChild(root);
  return root;
}

export class AINotesOverlay {
  private bindings = new Map<number, ReaderBinding>();
  private pollTimer: any = null;
  private storeUnsub: (() => void) | null = null;
  private placingItemID: number | null = null;
  private aiRun: AiRun | null = null;
  /** Remembered for the session so the editor reopens in the same layout. */
  private editorView: EditorView = "split";

  start(): void {
    if (this.pollTimer) return;
    this.storeUnsub = aiNotesStore.subscribe((attachmentKey) => {
      for (const b of this.bindings.values()) {
        if (b.attachmentKey === attachmentKey) this.renderReader(b);
      }
    });
    this.pollTimer = setInterval(() => this.syncReaders(), 1200);
    this.syncReaders();
  }

  stop(): void {
    this.cancelAiRun();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }
    for (const b of this.bindings.values()) {
      try { b.cleanup(); } catch (_) {}
    }
    this.bindings.clear();
    this.placingItemID = null;
  }

  beginPlaceMode(itemID?: number): void {
    const readers = this.listReaders();
    const target = itemID
      ? readers.find((r) => Number(r.itemID) === Number(itemID))
      : readers[0];
    if (!target) {
      try {
        const win = (Services as any).wm.getMostRecentWindow("navigator:browser");
        win?.alert?.("请先打开一篇 PDF 再添加 AI 便签。");
      } catch (_) {}
      return;
    }
    this.placingItemID = Number(target.itemID);
    // Rebind so nested PDF iframe listeners attach after the viewer is ready.
    const existing = this.bindings.get(this.placingItemID);
    if (existing) {
      try { existing.cleanup(); } catch (_) {}
      this.bindings.delete(this.placingItemID);
    }
    this.bindReader(target);
    const binding = this.bindings.get(this.placingItemID);
    if (binding) {
      binding.placeMode = true;
      this.showPlaceBanner(binding, true);
      this.renderReader(binding);
    }
  }

  private listReaders(): any[] {
    try {
      return ([...((Zotero.Reader as any)._readers || [])] as any[]).filter((r) => r && r.itemID);
    } catch (_) {
      return [];
    }
  }

  private syncReaders(): void {
    const readers = this.listReaders();
    const live = new Set<number>();
    for (const reader of readers) {
      const itemID = Number(reader.itemID);
      if (!itemID) continue;
      live.add(itemID);
      if (!this.bindings.has(itemID)) this.bindReader(reader);
      else {
        const b = this.bindings.get(itemID)!;
        this.removeBrokenToolbarChips(b);
        this.renderReader(b);
      }
    }
    for (const [id, b] of this.bindings) {
      if (!live.has(id)) {
        try { b.cleanup(); } catch (_) {}
        this.bindings.delete(id);
      }
    }
  }

  private bindReader(reader: any): void {
    const itemID = Number(reader.itemID);
    const meta = getAttachmentMeta(itemID);
    if (!meta) return;

    const viewWins = getPdfViewWindows(reader);
    if (!viewWins.length) return;

    // Inject CSS into every reachable document (chrome + nested PDF iframe).
    for (const w of viewWins) {
      try {
        if (w?.document) ensureStyle(w.document);
      } catch (_) {}
    }

    const onPointer = (ev: MouseEvent) => {
      const binding = this.bindings.get(itemID);
      if (!binding?.placeMode) return;
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.(`.${PREFIX}-note, .${PREFIX}-toolbar-btn, .${PREFIX}-place-banner`)) return;

      const app = getPdfApp(reader);
      const pages = app?.pdfViewer?._pages;
      if (!pages?.length) {
        Zotero.debug("[RA] AINotes place: no pdf pages");
        return;
      }

      // Hit-test with event coordinates against each page div.
      let pageIndex = -1;
      let pageView: any = null;
      for (let i = 0; i < pages.length; i++) {
        const div = pages[i]?.div as HTMLElement | undefined;
        if (!div?.getBoundingClientRect) continue;
        const r = div.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          pageIndex = i;
          pageView = pages[i];
          break;
        }
      }

      // Fallback: current page if click is anywhere in the viewer.
      if (pageIndex < 0) {
        const cur = Math.max(0, (app.pdfViewer.currentPageNumber || 1) - 1);
        if (pages[cur]?.div) {
          pageIndex = cur;
          pageView = pages[cur];
        }
      }
      if (pageIndex < 0 || !pageView?.div) {
        Zotero.debug("[RA] AINotes place: page hit failed");
        return;
      }

      const rect = pageView.div.getBoundingClientRect();
      let x = ev.clientX - rect.left;
      let y = ev.clientY - rect.top;
      // Clamp into page; if fallback current-page, place near center-top.
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        x = Math.min(rect.width * 0.1, 40);
        y = Math.min(rect.height * 0.1, 40);
      }

      let pdfRect: [number, number, number, number];
      try {
        pdfRect = cssBoxToPdfRect(pageView, x, y, DEFAULT_NOTE_WIDTH, DEFAULT_NOTE_HEIGHT);
      } catch (e: any) {
        Zotero.debug("[RA] AINotes place coord fail: " + (e?.message || e));
        // Last resort: fixed PDF-space box.
        pdfRect = [72, 600, 72 + DEFAULT_NOTE_WIDTH, 600 + DEFAULT_NOTE_HEIGHT];
      }

      const note = aiNotesStore.createNote({
        attachmentKey: binding.attachmentKey,
        parentItemKey: binding.parentItemKey,
        pageIndex,
        rect: pdfRect,
        content: "",
      });
      binding.placeMode = false;
      this.placingItemID = null;
      this.showPlaceBanner(binding, false);
      binding.editingId = note.id;
      this.renderReader(binding);
      try {
        ev.preventDefault();
        ev.stopPropagation();
      } catch (_) {}
      Zotero.debug(`[RA] AINotes placed #${note.number} page=${pageIndex + 1}`);
    };

    const cleanups: Array<() => void> = [];
    for (const w of viewWins) {
      try {
        const doc = w.document;
        if (!doc) continue;
        doc.addEventListener("pointerdown", onPointer, true);
        doc.addEventListener("click", onPointer, true);
        cleanups.push(() => {
          try { doc.removeEventListener("pointerdown", onPointer, true); } catch (_) {}
          try { doc.removeEventListener("click", onPointer, true); } catch (_) {}
        });
      } catch (_) {}
    }

    const cleanup = () => {
      for (const fn of cleanups) {
        try { fn(); } catch (_) {}
      }
      const wins = [...getPdfViewWindows(reader), getReaderChromeWindow(reader)];
      for (const w of wins) {
        try {
          w?.document
            ?.querySelectorAll?.(
              `.${PREFIX}-root, .${PREFIX}-place-banner, .${PREFIX}-fixed-editor, #${STYLE_ID}, #${PREFIX}-toolbar-btn, #${PREFIX}-toolbar-host, .${PREFIX}-toolbar-btn, .${PREFIX}-toolbar-host`,
            )
            .forEach((el: Element) => el.remove());
        } catch (_) {}
      }
    };

    const binding: ReaderBinding = {
      reader,
      attachmentKey: meta.attachmentKey,
      parentItemKey: meta.parentItemKey,
      itemID,
      cleanup,
      placeMode: this.placingItemID === itemID,
      editingId: null,
    };
    this.bindings.set(itemID, binding);
    // Do NOT inject into reader toolbar — Zotero page-number cluster is fragile
    // and our chip was landing inside "1 / N". Placement is via sidebar only.
    this.removeBrokenToolbarChips(binding);
    this.renderReader(binding);
    if (binding.placeMode) this.showPlaceBanner(binding, true);
  }

  private removeBrokenToolbarChips(binding: ReaderBinding): void {
    const wins = [
      ...getPdfViewWindows(binding.reader),
      getReaderChromeWindow(binding.reader),
    ];
    for (const win of wins) {
      if (!win?.document) continue;
      try {
        win.document
          .querySelectorAll(
            `#${PREFIX}-toolbar-btn, #${PREFIX}-toolbar-host, .${PREFIX}-toolbar-btn, .${PREFIX}-toolbar-host, [id*="ainote-toolbar"], [class*="ainote-toolbar"]`,
          )
          .forEach((el: Element) => el.remove());
      } catch (_) {}
      try {
        const candidates = win.document.querySelectorAll("button, span, div, a, toolbarbutton, label");
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i] as HTMLElement;
          if (el.closest?.(`.${PREFIX}-note, .${PREFIX}-place-banner, .${PREFIX}-fixed-editor, .${PREFIX}-root`)) {
            continue;
          }
          const txt = (el.textContent || "").replace(/\s+/g, "");
          if (
            txt !== "AI便签" &&
            txt !== "+便签" &&
            txt !== "+AI便签" &&
            txt !== "放置中…" &&
            txt !== "AI便签×" &&
            !/^AI便签\d*$/.test(txt)
          ) {
            continue;
          }
          try { el.remove(); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  private pageIndexFromDiv(pageDiv: HTMLElement): number {
    const raw = pageDiv.dataset?.pageNumber || pageDiv.getAttribute("data-page-number");
    if (raw) return Math.max(0, parseInt(raw, 10) - 1);
    const id = pageDiv.id || "";
    const m = id.match(/(\d+)/);
    if (m) return Math.max(0, parseInt(m[1], 10) - 1);
    return -1;
  }

  private showPlaceBanner(binding: ReaderBinding, on: boolean): void {
    try {
      const wins = getPdfViewWindows(binding.reader);
      for (const win of wins) {
        try {
          win.document?.querySelectorAll?.(`.${PREFIX}-place-banner`).forEach((el: Element) => el.remove());
        } catch (_) {}
      }
      if (!on) return;
      const win = getReaderChromeWindow(binding.reader) || wins[0];
      const doc = win?.document;
      if (!doc) return;
      try { ensureStyle(doc); } catch (_) {}
      const banner = doc.createElement("div");
      banner.className = `${PREFIX}-place-banner`;
      banner.textContent = "点击 PDF 页面放置 AI 便签 · Esc 取消";
      (doc.body || doc.documentElement).appendChild(banner);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          binding.placeMode = false;
          this.placingItemID = null;
          this.showPlaceBanner(binding, false);
          for (const w of getPdfViewWindows(binding.reader)) {
            try { w.document?.removeEventListener?.("keydown", onKey, true); } catch (_) {}
          }
        }
      };
      for (const w of wins) {
        try { w.document?.addEventListener?.("keydown", onKey, true); } catch (_) {}
      }
    } catch (_) {}
  }

  private renderReader(binding: ReaderBinding): void {
    const app = getPdfApp(binding.reader);
    const pages = app?.pdfViewer?._pages;
    if (!pages || !pages.length) return;

    try {
      const pageDoc = pages[0]?.div?.ownerDocument;
      if (pageDoc) ensureStyle(pageDoc);
      const chrome = getReaderChromeWindow(binding.reader);
      if (chrome?.document) ensureStyle(chrome.document);
    } catch (_) {}

    if (!binding.placeMode) this.showPlaceBanner(binding, false);

    const notes = aiNotesStore.getNotes(binding.attachmentKey, binding.parentItemKey);
    const editingAlive = binding.editingId
      ? notes.some((n) => n.id === binding.editingId)
      : false;
    if (binding.editingId && !editingAlive) {
      binding.editingId = null;
      this.removeFixedEditor(binding);
    }

    for (let i = 0; i < pages.length; i++) {
      const pageView = pages[i];
      const pageDiv = pageView?.div as HTMLElement | undefined;
      if (!pageDiv) continue;
      try {
        pageDiv.style.overflow = "visible";
      } catch (_) {}
      const root = ensurePageRoot(pageDiv, i);
      const pageNotes = notes.filter((n) => n.pageIndex === i);
      const keep = new Set(pageNotes.map((n) => n.id));
      root.querySelectorAll(`.${PREFIX}-note`).forEach((el: Element) => {
        const id = (el as HTMLElement).dataset.noteId || "";
        if (keep.has(id)) return;
        // Drop the window-level drag listeners with the element they served.
        try { (el as any).__raUnbind?.(); } catch (_) {}
        el.remove();
      });
      for (const note of pageNotes) {
        this.renderNote(binding, pageView, root, note);
      }
    }

    if (!binding.editingId) this.removeFixedEditor(binding);
  }

  private renderNote(binding: ReaderBinding, pageView: any, root: HTMLElement, note: AINote): void {
    const doc = root.ownerDocument;
    const editing = binding.editingId === note.id;

    if (editing) {
      let el = root.querySelector(`.${PREFIX}-note[data-note-id="${note.id}"]`) as HTMLElement | null;
      if (el) el.style.display = "none";
      this.renderFixedEditor(binding, note);
      return;
    }

    let el = root.querySelector(`.${PREFIX}-note[data-note-id="${note.id}"]`) as HTMLElement | null;
    if (!el) {
      el = doc.createElement("div");
      el.className = `${PREFIX}-note`;
      el.dataset.noteId = note.id;
      root.appendChild(el);
      this.bindNoteInteractions(binding, pageView, el, note.id);
    }
    el.style.display = "";

    if (!(el as any).__raDragging) {
      const box = pdfRectToCss(pageView, note.rect);
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${Math.max(96, box.width)}px`;
      el.style.height = `${Math.max(72, box.height)}px`;
    }
    el.style.minWidth = "96px";
    el.style.minHeight = "72px";
    el.style.setProperty("--ra-note-color", note.color || DEFAULT_NOTE_COLOR);
    el.classList.remove("is-editing");
    const sig = `${note.number}\0${note.updatedAt}\0${note.content || ""}`;
    if (el.dataset.contentSig !== sig) {
      el.dataset.contentSig = sig;
      this.renderPreview(el, note);
    }
  }

  private sanitizeNoteContent(raw: string): string {
    const t = (raw || "").trim();
    // Strip legacy placeholder text that was accidentally saved as content.
    if (!t) return "";
    if (/^支持\s*Markdown/i.test(t)) return "";
    if (/侧栏里可用\s*#\d+\s*引用/.test(t) && t.length < 80) return "";
    return raw;
  }

  /** Render markdown into `host`, dropping scripts and event handlers. */
  private setRenderedMarkdown(host: HTMLElement, markdown: string, streaming = false): void {
    const doc = host.ownerDocument;
    host.textContent = "";
    if (!markdown.trim()) return;
    try {
      const tpl = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "template",
      ) as HTMLTemplateElement;
      // Parsed inert: no network requests, no handlers wired up.
      tpl.innerHTML = renderMarkdown(markdown, streaming);
      const walker = doc.createTreeWalker(tpl.content, 1 /* SHOW_ELEMENT */);
      const drop: Element[] = [];
      let node = walker.nextNode() as Element | null;
      while (node) {
        if (UNSAFE_TAGS.has(node.tagName.toUpperCase())) {
          drop.push(node);
        } else {
          const attrs = node.attributes;
          for (let i = attrs.length - 1; i >= 0; i--) {
            const name = attrs[i].name;
            const lower = name.toLowerCase();
            if (lower.startsWith("on")) node.removeAttribute(name);
            else if (
              (lower === "href" || lower === "src" || lower === "xlink:href") &&
              /^\s*(javascript|data):/i.test(attrs[i].value || "")
            ) {
              node.removeAttribute(name);
            }
          }
        }
        node = walker.nextNode() as Element | null;
      }
      for (const bad of drop) {
        try { bad.remove(); } catch (_) {}
      }
      host.appendChild(tpl.content);
    } catch (e: any) {
      Zotero.debug("[RA] AINotes markdown render failed: " + (e?.message || e));
      host.textContent = markdown;
    }
  }

  private renderPreview(el: HTMLElement, note: AINote): void {
    const content = this.sanitizeNoteContent(note.content || "");
    // Persist cleanup if we stripped bad placeholder.
    if (content !== (note.content || "") && note.content) {
      aiNotesStore.updateNote(note.attachmentKey, note.id, { content });
    }
    el.innerHTML = `
      <div class="${PREFIX}-head" data-drag="1">
        <span class="${PREFIX}-badge">#${note.number}</span>
        <span class="${PREFIX}-title">AI 便签</span>
        <span class="${PREFIX}-actions">
          <button type="button" class="${PREFIX}-btn" data-act="edit" title="编辑">✎</button>
          <button type="button" class="${PREFIX}-btn danger" data-act="del" title="删除">×</button>
        </span>
      </div>
      <div class="${PREFIX}-body markdown-body"></div>
      <div class="${PREFIX}-resize" data-resize="1" title="拖拽缩放"></div>
    `;
    const body = el.querySelector(`.${PREFIX}-body`) as HTMLElement | null;
    if (body) {
      if (content.trim()) {
        this.setRenderedMarkdown(body, content);
      } else {
        body.innerHTML = `<div class="${PREFIX}-empty">双击编辑<br/><em>#${note.number}</em> · Markdown<br/>聊天用 #${note.number} 引用</div>`;
      }
    }
    this.resetDeleteArmed(el);
  }

  private resetDeleteArmed(el: HTMLElement): void {
    el.dataset.delArmed = "";
    const btn = el.querySelector(`.${PREFIX}-btn[data-act="del"]`) as HTMLElement | null;
    if (btn) {
      btn.textContent = "×";
      btn.classList.remove("is-armed");
      btn.title = "删除";
    }
  }

  private armDelete(el: HTMLElement): void {
    el.dataset.delArmed = "1";
    const btn = el.querySelector(`.${PREFIX}-btn[data-act="del"]`) as HTMLElement | null;
    if (btn) {
      btn.textContent = "删?";
      btn.classList.add("is-armed");
      btn.title = "再次点击确认删除";
    }
  }

  private removeFixedEditor(binding: ReaderBinding, noteId?: string): void {
    // Single choke point for editor teardown — kill any AI stream writing into it.
    this.cancelAiRun(noteId);
    const sel = noteId
      ? `.${PREFIX}-fixed-editor[data-note-id="${noteId}"]`
      : `.${PREFIX}-fixed-editor`;
    const wins = [
      ...getPdfViewWindows(binding.reader),
      getReaderChromeWindow(binding.reader),
    ];
    for (const w of wins) {
      try {
        w?.document?.querySelectorAll?.(sel).forEach((el: Element) => el.remove());
      } catch (_) {}
    }
  }

  private findFixedEditor(binding: ReaderBinding, noteId: string): HTMLElement | null {
    const sel = `.${PREFIX}-fixed-editor[data-note-id="${noteId}"]`;
    const wins = [
      ...getPdfViewWindows(binding.reader),
      getReaderChromeWindow(binding.reader),
    ];
    for (const w of wins) {
      try {
        const el = w?.document?.querySelector?.(sel) as HTMLElement | null;
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  private closeEditor(binding: ReaderBinding, noteId?: string): void {
    binding.editingId = null;
    this.removeFixedEditor(binding, noteId);
    this.renderReader(binding);
  }

  private renderFixedEditor(binding: ReaderBinding, note: AINote): void {
    if (this.findFixedEditor(binding, note.id)) return;

    const wins = getPdfViewWindows(binding.reader);
    const chrome = getReaderChromeWindow(binding.reader) || wins[0];
    const doc = chrome?.document;
    if (!doc) return;
    try { ensureStyle(doc); } catch (_) {}

    this.removeFixedEditor(binding);

    const content = this.sanitizeNoteContent(note.content || "");
    const wrap = doc.createElement("div");
    wrap.className = `${PREFIX}-fixed-editor`;
    wrap.dataset.noteId = note.id;
    const viewTabs = EDITOR_VIEWS.map(
      (v) =>
        `<button type="button" class="${PREFIX}-viewtab${v.mode === this.editorView ? " is-active" : ""}" data-view-mode="${v.mode}" title="${v.title}">${v.label}</button>`,
    ).join("");

    wrap.innerHTML = `
      <div class="${PREFIX}-fixed-card" data-view="${this.editorView}">
        <div class="${PREFIX}-fixed-head">
          <span class="${PREFIX}-badge">#${note.number}</span>
          <span class="${PREFIX}-title">编辑 AI 便签</span>
          <span class="${PREFIX}-viewtabs">${viewTabs}</span>
          <button type="button" class="${PREFIX}-btn danger" data-act="cancel" title="关闭">×</button>
        </div>
        <div class="${PREFIX}-fixed-main">
          <textarea class="${PREFIX}-fixed-textarea" placeholder="输入内容，支持 Markdown（**粗体**、列表、代码块…）&#10;保存后，在侧栏对话里用 #${note.number} 引用">${this.escapeText(content)}</textarea>
          <div class="${PREFIX}-preview markdown-body"></div>
        </div>
        <div class="${PREFIX}-ai-bar">
          <button type="button" class="${PREFIX}-ai-btn" data-ai="generate" title="根据本页 PDF 内容生成便签（会替换文本框全部内容，可撤销）">✨ 生成</button>
          <button type="button" class="${PREFIX}-ai-btn" data-ai="format" title="把草稿整理成结构清晰的 Markdown">整理格式</button>
          <button type="button" class="${PREFIX}-ai-btn" data-ai="rewrite" title="只改写在文本框里选中的片段" disabled>重写选中</button>
          <button type="button" class="${PREFIX}-ai-btn ghost" data-ai="undo" title="撤销上一次 AI 修改" hidden>撤销</button>
          <span class="${PREFIX}-ai-status"></span>
          <button type="button" class="${PREFIX}-ai-btn stop" data-ai="stop" title="停止生成" hidden>停止</button>
        </div>
        <div class="${PREFIX}-fixed-footer">
          <button type="button" class="${PREFIX}-footer-btn danger" data-act="del">删除</button>
          <div class="${PREFIX}-fixed-spacer"></div>
          <button type="button" class="${PREFIX}-footer-btn" data-act="cancel">取消</button>
          <button type="button" class="${PREFIX}-footer-btn primary" data-act="save">保存</button>
        </div>
      </div>
    `;
    (doc.body || doc.documentElement).appendChild(wrap);

    const ta = wrap.querySelector("textarea") as HTMLTextAreaElement | null;
    const bar = wrap.querySelector(`.${PREFIX}-ai-bar`) as HTMLElement | null;
    try {
      ta?.focus();
      const len = ta?.value.length || 0;
      ta?.setSelectionRange(len, len);
    } catch (_) {}

    // MUST be registered before trapKey below: trapKey calls
    // stopImmediatePropagation(), which swallows every listener added after it
    // on this same node — including the keyup we need for Shift+Arrow selection.
    if (ta && bar) {
      const syncSelection = () => this.syncRewriteEnabled(bar, ta);
      for (const type of ["keyup", "mouseup", "select", "input", "focus", "click"]) {
        ta.addEventListener(type, syncSelection);
      }
      syncSelection();
    }

    if (ta) {
      ta.addEventListener("input", () => this.schedulePreview(wrap));
      ta.addEventListener("scroll", () => this.syncPreviewScroll(wrap));
      this.renderEditorPreview(wrap);
    }

    const tabs = wrap.querySelector(`.${PREFIX}-viewtabs`) as HTMLElement | null;
    if (tabs) {
      tabs.addEventListener("click", (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement)?.closest?.("[data-view-mode]") as HTMLElement | null;
        const mode = btn?.getAttribute("data-view-mode") as EditorView | null;
        if (!mode) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.setEditorView(wrap, mode);
      });
    }

    if (ta) {
      const trapKey = (ev: Event) => {
        ev.stopImmediatePropagation();
      };
      for (const type of ["keydown", "keyup", "keypress"]) {
        ta.addEventListener(type, trapKey);
      }
    }

    if (bar) {
      bar.addEventListener("click", (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement)?.closest?.("[data-ai]") as HTMLElement | null;
        const action = btn?.getAttribute("data-ai") || "";
        if (!action) return;
        ev.preventDefault();
        ev.stopPropagation();
        if ((btn as HTMLButtonElement | null)?.disabled) return;
        if (action === "stop") {
          this.stopAiRun();
          return;
        }
        if (action === "undo") {
          this.undoAi(wrap);
          return;
        }
        void this.runNoteAi(binding, note, wrap, action as NoteAiAction);
      });
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.closeEditor(binding, note.id);
      try { doc.removeEventListener("keydown", onKey, true); } catch (_) {}
    };
    try { doc.addEventListener("keydown", onKey, true); } catch (_) {}

    wrap.addEventListener("click", (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      const act = t?.closest?.("[data-act]")?.getAttribute("data-act");
      if (!act) {
        if (t === wrap) this.closeEditor(binding, note.id);
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (act === "cancel") {
        this.closeEditor(binding, note.id);
        return;
      }
      if (act === "save") {
        const val = (wrap.querySelector("textarea") as HTMLTextAreaElement | null)?.value || "";
        binding.editingId = null;
        this.removeFixedEditor(binding, note.id);
        aiNotesStore.updateNote(binding.attachmentKey, note.id, { content: val });
        this.renderReader(binding);
        return;
      }
      if (act === "del") {
        const btn = t?.closest?.("[data-act='del']") as HTMLElement | null;
        if (btn && btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.textContent = "确认删除?";
          return;
        }
        binding.editingId = null;
        this.removeFixedEditor(binding, note.id);
        aiNotesStore.deleteNote(binding.attachmentKey, note.id);
        this.renderReader(binding);
      }
    });
  }

  private setEditorView(wrap: HTMLElement, mode: EditorView): void {
    this.editorView = mode;
    const card = wrap.querySelector(`.${PREFIX}-fixed-card`) as HTMLElement | null;
    if (card) card.dataset.view = mode;
    const tabs = wrap.querySelectorAll(`.${PREFIX}-viewtab`);
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i] as HTMLElement;
      tab.classList.toggle("is-active", tab.getAttribute("data-view-mode") === mode);
    }
    this.renderEditorPreview(wrap);
    this.syncPreviewScroll(wrap);
    if (mode !== "preview") {
      try { (wrap.querySelector(`.${PREFIX}-fixed-textarea`) as HTMLTextAreaElement | null)?.focus(); } catch (_) {}
    }
  }

  /** Throttled so streaming tokens can't trigger a re-render per token. */
  private schedulePreview(wrap: HTMLElement): void {
    if (this.editorView === "edit") return;
    const win = wrap.ownerDocument?.defaultView as any;
    if (!win) return;
    const state =
      (wrap as any).__raPreview || ((wrap as any).__raPreview = { timer: null, last: 0 });
    if (state.timer) return;
    const wait = Math.max(0, 140 - (Date.now() - state.last));
    try {
      state.timer = win.setTimeout(() => {
        state.timer = null;
        state.last = Date.now();
        this.renderEditorPreview(wrap);
      }, wait);
    } catch (_) {}
  }

  private renderEditorPreview(wrap: HTMLElement): void {
    if (this.editorView === "edit") return;
    const ta = wrap.querySelector(`.${PREFIX}-fixed-textarea`) as HTMLTextAreaElement | null;
    const view = wrap.querySelector(`.${PREFIX}-preview`) as HTMLElement | null;
    if (!ta || !view) return;
    const text = ta.value || "";
    if (!text.trim()) {
      view.innerHTML = `<div class="${PREFIX}-preview-empty">左侧输入 Markdown，这里实时预览</div>`;
      return;
    }
    // Balance unclosed fences/emphasis while text is still arriving.
    this.setRenderedMarkdown(view, text, !!this.aiRun?.alive);
  }

  private syncPreviewScroll(wrap: HTMLElement): void {
    if (this.editorView !== "split") return;
    const ta = wrap.querySelector(`.${PREFIX}-fixed-textarea`) as HTMLTextAreaElement | null;
    const view = wrap.querySelector(`.${PREFIX}-preview`) as HTMLElement | null;
    if (!ta || !view) return;
    const from = ta.scrollHeight - ta.clientHeight;
    const to = view.scrollHeight - view.clientHeight;
    if (from <= 0 || to <= 0) return;
    view.scrollTop = (ta.scrollTop / from) * to;
  }

  /** User pressed 停止 — keep the partial text the provider already streamed. */
  private stopAiRun(): void {
    const run = this.aiRun;
    if (!run?.alive) return;
    run.stopped = true;
    try { getLLMManager().abort(); } catch (_) {}
    Zotero.debug("[RA] AINotes AI stop requested");
  }

  /** Editor went away — silence the callbacks and drop the request. */
  private cancelAiRun(noteId?: string): void {
    const run = this.aiRun;
    if (!run?.alive) return;
    if (noteId && run.noteId !== noteId) return;
    run.alive = false;
    this.aiRun = null;
    try { getLLMManager().abort(); } catch (_) {}
    Zotero.debug("[RA] AINotes AI run cancelled");
  }

  private syncRewriteEnabled(bar: HTMLElement, ta: HTMLTextAreaElement): void {
    if (bar.classList.contains("is-busy")) return;
    const btn = bar.querySelector(`[data-ai="rewrite"]`) as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = (ta.selectionStart || 0) === (ta.selectionEnd || 0);
  }

  private setAiBusy(bar: HTMLElement, busy: boolean, action?: NoteAiAction): void {
    bar.classList.toggle("is-busy", busy);
    const btns = bar.querySelectorAll(`.${PREFIX}-ai-btn`);
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i] as HTMLButtonElement;
      const kind = btn.getAttribute("data-ai") || "";
      if (kind === "stop") {
        btn.hidden = !busy;
        btn.disabled = false;
        continue;
      }
      btn.disabled = busy;
      btn.classList.toggle("is-running", busy && kind === action);
    }
  }

  private setAiStatus(bar: HTMLElement, text: string, tone: AiTone): void {
    const el = bar.querySelector(`.${PREFIX}-ai-status`) as HTMLElement | null;
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
    el.title = text;
    const token = String((Number(el.dataset.statusToken) || 0) + 1);
    el.dataset.statusToken = token;
    if (!text || tone === "busy") return;
    try {
      bar.ownerDocument?.defaultView?.setTimeout(() => {
        if (el.dataset.statusToken !== token) return;
        el.textContent = "";
        el.title = "";
        el.dataset.tone = "";
      }, tone === "err" ? 9000 : 4500);
    } catch (_) {}
  }

  private setUndoVisible(bar: HTMLElement, on: boolean): void {
    const btn = bar.querySelector(`[data-ai="undo"]`) as HTMLButtonElement | null;
    if (btn) btn.hidden = !on;
  }

  private undoAi(wrap: HTMLElement): void {
    const snap = (wrap as any).__raAiUndo as AiUndoSnapshot | undefined;
    const ta = wrap.querySelector(`.${PREFIX}-fixed-textarea`) as HTMLTextAreaElement | null;
    const bar = wrap.querySelector(`.${PREFIX}-ai-bar`) as HTMLElement | null;
    if (!snap || !ta || !bar) return;
    ta.value = snap.text;
    (wrap as any).__raAiUndo = undefined;
    this.setUndoVisible(bar, false);
    try {
      ta.focus();
      ta.setSelectionRange(snap.start, snap.end);
    } catch (_) {}
    this.syncRewriteEnabled(bar, ta);
    this.renderEditorPreview(wrap);
    this.setAiStatus(bar, "已撤销 AI 修改", "ok");
  }

  /** Text layer of the page this note sits on (same approach as PDFReader). */
  private async readPageText(binding: ReaderBinding, pageIndex: number): Promise<string> {
    try {
      const app = getPdfApp(binding.reader);
      if (!app) return "";
      let pdfPage = app.pdfViewer?._pages?.[pageIndex]?.pdfPage;
      if (!pdfPage && app.pdfDocument?.getPage) {
        pdfPage = await app.pdfDocument.getPage(pageIndex + 1);
      }
      if (!pdfPage?.getTextContent) return "";
      const content = await pdfPage.getTextContent();
      const items = (content?.items || []) as any[];
      const parts: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const str = items[i]?.str;
        if (str) parts.push(String(str));
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    } catch (e: any) {
      Zotero.debug("[RA] AINotes page text failed: " + (e?.message || e));
      return "";
    }
  }

  private async buildNoteAiContext(
    binding: ReaderBinding,
    note: AINote,
    input: { draft: string; selectedSpan: string },
  ): Promise<NoteAiContext> {
    let item: Zotero.Item | null = null;
    try {
      item = (Zotero.Items.get(binding.itemID) as Zotero.Item) || null;
    } catch (_) {}

    let paperTitle = "";
    try {
      paperTitle = getPDFMetadata(item)?.title || "";
    } catch (_) {}

    let pdfSelection = "";
    try {
      pdfSelection = (await getPDFSelection(item)) || "";
    } catch (e: any) {
      Zotero.debug("[RA] AINotes selection read failed: " + (e?.message || e));
    }

    return {
      noteNumber: note.number,
      pageNumber: note.pageIndex + 1,
      paperTitle,
      pageText: await this.readPageText(binding, note.pageIndex),
      pdfSelection,
      draft: input.draft,
      selectedSpan: input.selectedSpan,
    };
  }

  private async runNoteAi(
    binding: ReaderBinding,
    note: AINote,
    wrap: HTMLElement,
    action: NoteAiAction,
  ): Promise<void> {
    const ta = wrap.querySelector(`.${PREFIX}-fixed-textarea`) as HTMLTextAreaElement | null;
    const bar = wrap.querySelector(`.${PREFIX}-ai-bar`) as HTMLElement | null;
    if (!ta || !bar) return;
    if (this.aiRun?.alive) return;

    const original = ta.value;
    // The span the AI output replaces. Generate/format own the whole box;
    // rewrite touches only the user's selection.
    let start = 0;
    let end = original.length;

    if (action === "rewrite") {
      start = Math.min(ta.selectionStart || 0, ta.selectionEnd || 0);
      end = Math.max(ta.selectionStart || 0, ta.selectionEnd || 0);
      if (start >= end) {
        this.setAiStatus(bar, "请先在文本框里选中要改写的文字", "warn");
        return;
      }
    } else if (action === "format" && !original.trim()) {
      this.setAiStatus(bar, "文本框是空的，先写点草稿再整理格式", "warn");
      return;
    }

    const mgr = getLLMManager();
    if (!mgr.isReady()) {
      mgr.showConfigError();
      this.setAiStatus(bar, "尚未配置 LLM，请先在插件设置里填写 API Key", "err");
      return;
    }

    const run: AiRun = { noteId: note.id, action, alive: true, stopped: false };
    this.aiRun = run;
    const isLive = () => run.alive && this.aiRun === run && !!wrap.isConnected;

    const before = original.slice(0, start);
    const after = original.slice(end);
    const paint = (body: string) => {
      ta.value = before + body + after;
      const caret = before.length + body.length;
      try { ta.setSelectionRange(caret, caret); } catch (_) {}
      // Rewrite edits mid-document; yanking the scroll to the bottom is wrong there.
      if (action !== "rewrite") {
        try { ta.scrollTop = ta.scrollHeight; } catch (_) {}
      }
      // Programmatic value writes fire no `input` event — drive it by hand.
      this.schedulePreview(wrap);
    };
    const finish = (status: string, tone: AiTone) => {
      run.alive = false;
      if (this.aiRun === run) this.aiRun = null;
      if (!wrap.isConnected) return;
      ta.readOnly = false;
      this.setAiBusy(bar, false);
      this.syncRewriteEnabled(bar, ta);
      // Final pass: throttle may have dropped the tail, and this one renders
      // with streaming=false so nothing stays artificially balanced.
      this.renderEditorPreview(wrap);
      this.setAiStatus(bar, status, tone);
    };

    // Each token repaints from the `before`/`after` snapshot, so anything the
    // user typed mid-stream would be silently discarded. Lock the box instead
    // (readOnly, not disabled — keeps focus, selection and scrolling alive).
    ta.readOnly = true;
    this.setAiBusy(bar, true, action);
    this.setAiStatus(bar, AI_BUSY_LABEL[action], "busy");
    Zotero.debug(`[RA] AINotes AI ${action} start note=#${note.number} page=${note.pageIndex + 1}`);

    try {
      const ctx = await this.buildNoteAiContext(binding, note, {
        draft: original,
        selectedSpan: original.slice(start, end),
      });
      if (!isLive()) return;

      let acc = "";
      await mgr.chat(buildNoteAiMessages(action, ctx), {
        onToken: (token: string) => {
          if (!isLive()) return;
          acc += token;
          paint(acc);
        },
        onComplete: (full: string) => {
          if (!isLive()) return;
          const text = stripCodeFence(String(full || acc)).trim();
          if (!text) {
            paint(original.slice(start, end));
            finish(run.stopped ? "已停止，未生成内容" : "AI 没有返回内容，请重试", "warn");
            return;
          }
          paint(text);
          (wrap as any).__raAiUndo = { text: original, start, end } as AiUndoSnapshot;
          this.setUndoVisible(bar, true);
          try {
            ta.focus();
            // Highlight the rewritten span so the change is obvious. For the
            // whole-box actions leave the caret collapsed at the end — selecting
            // everything would let the next keystroke wipe the note.
            if (action === "rewrite") {
              ta.setSelectionRange(before.length, before.length + text.length);
            }
          } catch (_) {}
          finish(
            run.stopped
              ? "已停止，保留已生成的内容"
              : `${AI_DONE_LABEL[action]} · 记得点“保存”`,
            "ok",
          );
        },
        onError: (err: Error) => {
          if (!isLive()) return;
          ta.value = original;
          try { ta.setSelectionRange(start, end); } catch (_) {}
          Zotero.debug("[RA] AINotes AI error: " + (err?.message || err));
          finish("AI 调用失败：" + (err?.message || "未知错误"), "err");
        },
      } as StreamCallback);
    } catch (e: any) {
      // chat() rejects after firing onError; isLive() is already false by then.
      if (!isLive()) return;
      ta.value = original;
      Zotero.debug("[RA] AINotes AI failed: " + (e?.message || e));
      finish("AI 调用失败：" + (e?.message || "未知错误"), "err");
    }
  }

  private escapeText(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private createDragShield(doc: Document | null, isResize: boolean): HTMLElement | null {
    if (!doc) return null;
    try {
      const shield = doc.createElement("div");
      shield.className = `${PREFIX}-drag-shield`;
      shield.style.cursor = isResize ? "nwse-resize" : "grabbing";
      (doc.body || doc.documentElement).appendChild(shield);
      return shield;
    } catch (_) {
      return null;
    }
  }

  private bindNoteInteractions(binding: ReaderBinding, pageView: any, el: HTMLElement, noteId: string): void {
    el.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      binding.editingId = noteId;
      this.renderReader(binding);
    });

    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const act = t?.closest?.("[data-act]")?.getAttribute("data-act");
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (act === "edit") {
        binding.editingId = noteId;
        this.renderReader(binding);
        return;
      }
      if (act === "del") {
        if (el.dataset.delArmed !== "1") {
          this.armDelete(el);
          return;
        }
        binding.editingId = null;
        this.removeFixedEditor(binding, noteId);
        aiNotesStore.deleteNote(binding.attachmentKey, noteId);
      }
    });

    if ((el as any).__raBound) return;
    (el as any).__raBound = true;

    let drag: null | {
      mode: "move" | "resize";
      startX: number;
      startY: number;
      origLeft: number;
      origTop: number;
      origW: number;
      origH: number;
      pointerId: number;
      /** Selection that existed before the gesture — must not be wiped. */
      hadSelection: boolean;
      shield: HTMLElement | null;
    } = null;
    (el as any).__raDragging = false;

    const win = el.ownerDocument?.defaultView;
    const isDragTarget = (t: HTMLElement | null): "move" | "resize" | null => {
      if (!t || !el.contains(t)) return null;
      if (t.closest("textarea") || t.closest("button") || t.closest(`.${PREFIX}-body`)) return null;
      if (t.closest("[data-resize]")) return "resize";
      if (t.closest("[data-drag]")) return "move";
      return null;
    };

    const hasTextSelection = (): boolean => {
      for (const w of getPdfViewWindows(binding.reader)) {
        try {
          const sel = w?.getSelection?.();
          if (sel && !sel.isCollapsed && String(sel).trim()) return true;
        } catch (_) {}
      }
      return false;
    };

    const clearTextSelection = (): void => {
      for (const w of getPdfViewWindows(binding.reader)) {
        try { w?.getSelection?.()?.removeAllRanges?.(); } catch (_) {}
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (!drag) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (drag.mode === "move") {
        el.style.left = `${drag.origLeft + dx}px`;
        el.style.top = `${drag.origTop + dy}px`;
      } else {
        el.style.width = `${Math.max(96, drag.origW + dx)}px`;
        el.style.height = `${Math.max(72, drag.origH + dy)}px`;
      }
    };

    const endDrag = () => {
      if (!drag) return;
      const gesture = drag;
      const left = parseFloat(el.style.left || "0");
      const top = parseFloat(el.style.top || "0");
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const rect = cssBoxToPdfRect(pageView, left, top, width, height);
      drag = null;
      (el as any).__raDragging = false;
      try { gesture.shield?.remove(); } catch (_) {}
      try { el.releasePointerCapture?.(gesture.pointerId); } catch (_) {}
      try {
        win?.removeEventListener("pointermove", onMove, true);
        win?.removeEventListener("pointerup", onUp, true);
        win?.removeEventListener("pointercancel", onUp, true);
      } catch (_) {}
      if (!gesture.hadSelection) {
        clearTextSelection();
        // The trailing mouseup can still open a fresh range; sweep once more.
        try {
          win?.setTimeout(() => {
            if (!drag) clearTextSelection();
          }, 0);
        } catch (_) {}
      }
      aiNotesStore.updateNote(binding.attachmentKey, noteId, { rect });
    };

    const onUp = (_ev: Event) => {
      if (!drag) return;
      // This handler must stay fully transparent — no preventDefault, and in
      // particular no stopPropagation. Zotero's PDFView (reader.js `_init`)
      // wires text selection up like this:
      //
      //   iframeWindow.addEventListener('mousedown',   _handlePointerDown, true)
      //   iframeWindow.addEventListener('pointermove', _handlePointerMove, {passive:true})
      //   iframeWindow.addEventListener('pointerup',   _handlePointerUp)
      //
      // Arming happens on **mousedown at window capture**, registered before
      // ours, so grabbing the note header always sets `action = selectText`
      // and we cannot stop it. Nothing is visibly selected while dragging
      // because we do swallow pointermove. But `_handlePointerUp` — the only
      // thing that clears `action` — listens at window **bubble**, so any
      // stopPropagation here kept it from ever running. The action stayed
      // armed, and once our own pointermove listener was removed every later
      // mouse move extended a PDF selection with no button held.
      endDrag();
    };

    const onDown = (ev: PointerEvent) => {
      const mode = isDragTarget(ev.target as HTMLElement | null);
      if (!mode) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      drag = {
        mode,
        startX: ev.clientX,
        startY: ev.clientY,
        origLeft: parseFloat(el.style.left || "0"),
        origTop: parseFloat(el.style.top || "0"),
        origW: el.offsetWidth,
        origH: el.offsetHeight,
        pointerId: ev.pointerId,
        hadSelection: hasTextSelection(),
        // Transparent full-viewport overlay so the text layer underneath sees
        // no pointer traffic at all for the duration of the gesture.
        shield: this.createDragShield(el.ownerDocument, mode === "resize"),
      };
      (el as any).__raDragging = true;
      // Retarget every follow-up pointer event to the note itself.
      try { el.setPointerCapture?.(ev.pointerId); } catch (_) {}
      try {
        win?.addEventListener("pointermove", onMove, true);
        win?.addEventListener("pointerup", onUp, true);
        win?.addEventListener("pointercancel", onUp, true);
      } catch (_) {}
    };

    // Safety net: without a pointerup (window blur, element detached) the
    // shield would stay up and swallow every click on the PDF.
    const onInterrupt = () => endDrag();
    el.addEventListener("lostpointercapture", onInterrupt);
    try { win?.addEventListener("blur", onInterrupt); } catch (_) {}

    const onSuppress = (ev: Event) => {
      if (!drag) {
        // Only meaningful mid-gesture, and it fires constantly — bail cheaply.
        if (ev.type === "mousemove") return;
        if (!isDragTarget(ev.target as HTMLElement | null)) return;
      }
      // Mid-gesture the pointer travels over the PDF text layer, so gating on
      // the event target is not enough: block outright while `drag` is set.
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };

    try {
      win?.addEventListener("pointerdown", onDown, true);
      win?.addEventListener("mousedown", onSuppress, true);
      win?.addEventListener("mousemove", onSuppress, true);
      win?.addEventListener("selectstart", onSuppress, true);
      win?.addEventListener("dragstart", onSuppress, true);
    } catch (_) {}

    (el as any).__raUnbind = () => {
      try { drag?.shield?.remove(); } catch (_) {}
      drag = null;
      try {
        win?.removeEventListener("blur", onInterrupt);
        win?.removeEventListener("pointerdown", onDown, true);
        win?.removeEventListener("mousedown", onSuppress, true);
        win?.removeEventListener("mousemove", onSuppress, true);
        win?.removeEventListener("selectstart", onSuppress, true);
        win?.removeEventListener("dragstart", onSuppress, true);
        win?.removeEventListener("pointermove", onMove, true);
        win?.removeEventListener("pointerup", onUp, true);
        win?.removeEventListener("pointercancel", onUp, true);
      } catch (_) {}
    };
  }
}

export const aiNotesOverlay = new AINotesOverlay();
