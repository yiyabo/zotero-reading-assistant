import { config } from "../../package.json";
import { kgStore } from "../features/knowledge-graph/KGStore";
import { openKnowledgeGraphWindow } from "../features/knowledge-graph";
import { getLLMManager } from "../modules/llm/LLMManager";
import { Message, MessageContentPart } from "../modules/llm/types";
import { getString } from "../modules/utils/locale";
import { getPref, setPref, PrefKeys } from "../modules/utils/prefs";
import { buildCurrentPaperContext, PaperContextResult, navigateToPDFPage } from "../modules/zotero/PDFReader";
import { buildSidebarStyles } from "./styles";
import { buildEmptyState as buildEmptyStateDom } from "./EmptyState";
import {
  buildInputDock,
  addImagePreview as addImagePreviewDom,
  clearImagePreview as clearImagePreviewDom,
} from "./InputDock";
import {
  loadConversation as loadConversationFromStore,
  saveConversation as saveConversationToStore,
} from "./ConversationStore";
import {
  appendMessage as appendMessageDom,
  createMessagePlaceholder as createMessagePlaceholderDom,
  updateMessageContent as updateMessageContentDom,
  updateReasoningContent as updateReasoningContentDom,
  formatErrorMessage as formatErrorMessageHelper,
  splitReasoningContent,
} from "./MessageList";

const HTML_NS = "http://www.w3.org/1999/xhtml";

type SectionProps = {
  doc: Document;
  body: HTMLElement;
  item?: any;
  tabType?: string;
  setEnabled?: (enabled: boolean) => void;
  setSectionSummary?: (summary: string) => void;
};

function _log(msg: string) {
  Zotero.debug("[RA] " + msg);
}

function showToast(headline: string, text: string, timeout: number = 3000) {
  try {
    const pw = new Zotero.ProgressWindow({});
    pw.changeHeadline(headline);
    (pw as any).addLines([text]);
    pw.show();
    pw.startCloseTimer(timeout);
  } catch (e) {}
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const elem = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) {
    elem.className = className;
  }
  return elem;
}

function constrainInlineSize(element: HTMLElement): void {
   element.style.minWidth = "0";
   element.style.maxWidth = "100%";
   element.style.overflowX = "hidden";
 }

function t(key: string): string {
  return getString(key);
}

export default class SidebarView {
  private body: HTMLElement | null = null;
  private messagesContainer: HTMLDivElement | null = null;
  private inputElement: HTMLTextAreaElement | null = null;
  private inputDockElement: HTMLDivElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private statusElement: HTMLDivElement | null = null;
  private currentMessageDiv: HTMLElement | null = null;
  private currentItem: any = null;
  private currentTabType: string | undefined;
  private paneKey: string = "";
  private busy = false;
  private currentConversationKey = "global";
  private pendingImages: string[] = [];
  private userScrolledUp = false;
  private maxHeightCleanup: (() => void) | null = null;
  private secretKeyObserverID: any = null;
  // KG context bar — sits between the messages and the input dock and lets
  // the user push the currently-active paper into the knowledge graph or
  // jump straight to the graph window.
  private contextBarElement: HTMLDivElement | null = null;
  private kgAddBtn: HTMLButtonElement | null = null;
  private kgOpenBtn: HTMLButtonElement | null = null;
  private kgUnsubscribe: (() => void) | null = null;

  public messages: Message[] = [];

  constructor() {
    _log("SidebarView constructor");
    this.registerSection();
    this.observeSecretKey();
  }

  // Re-render the empty state automatically when the user finishes
  // configuring the API key in Preferences, so they don't have to
  // switch items to see the suggestion cards appear.
  private observeSecretKey(): void {
    try {
      const prefsApi = (Zotero as any)?.Prefs;
      if (!prefsApi?.registerObserver) return;
      const fullKey = `extensions.zotero.${PrefKeys.SECRET_KEY}`;
      this.secretKeyObserverID = prefsApi.registerObserver(
        fullKey,
        () => {
          if (this.messages.length === 0) {
            try { this.renderMessages(); } catch (_) { /* ignore */ }
          }
        },
        true,
      );
    } catch (e: any) {
      _log("observeSecretKey failed: " + (e?.message || e));
    }
  }

  private registerSection() {
    _log("registerSection called");

    if (!(Zotero as any).ItemPaneManager?.registerSection) {
      _log("ItemPaneManager.registerSection NOT available");
      showToast("Error", "ItemPaneManager not available");
      return;
    }

    this.injectLocalizationLinks();
    this.injectChromeStyles();

    const self = this;

    try {
      const key = (Zotero as any).ItemPaneManager.registerSection({
        paneID: `${config.addonRef}-chat`,
        pluginID: config.addonID || "reading-assistant@zotero-llm.org",
        header: {
          l10nID: `${config.addonRef}-chat-header`,
          icon: `chrome://${config.addonRef}/content/icons/logo-64.png`,
        },
        sidenav: {
          l10nID: `${config.addonRef}-chat-sidenav`,
          icon: `chrome://${config.addonRef}/content/icons/logo-64.png`,
          orderable: true,
        },
        onInit: ({ item }: { item: any }) => {
          _log("onInit called, item=" + (item?.id || "none"));
        },
        onItemChange: (props: SectionProps) => {
          self.currentItem = props.item || null;
          self.currentTabType = props.tabType;
          const enabled = !!props.item && !props.item.isNote?.();
          props.setEnabled?.(enabled);
          props.setSectionSummary?.(self.getSectionSummary(props.item, props.tabType));
          self.switchConversation(props.item);
          self.updateStatus(props.item, props.tabType);
        },
        onRender: (props: SectionProps) => {
          _log("onRender called, item=" + (props.item?.id || "none"));
          self.mount(props);
        },
        onDestroy: () => {
          self.maxHeightCleanup?.();
          self.maxHeightCleanup = null;
          if (self.kgUnsubscribe) {
            try { self.kgUnsubscribe(); } catch (_) {}
            self.kgUnsubscribe = null;
          }
          self.contextBarElement = null;
          self.kgAddBtn = null;
          self.kgOpenBtn = null;
          self.body = null;
          self.messagesContainer = null;
          self.inputElement = null;
          self.inputDockElement = null;
          self.sendButton = null;
          self.statusElement = null;
        },
      });

      _log("registerSection returned: " + key);

      if (key) {
        this.paneKey = key;
        _log("Sidebar registered OK");
      } else {
        _log("Sidebar registration FAILED (returned false)");
        showToast("Error", "Sidebar registration failed", 3000);
      }
    } catch (e: any) {
      _log("registerSection THREW: " + e.message);
      showToast("Error", "Sidebar error: " + e.message, 3000);
    }
  }

  private injectLocalizationLinks(): void {
    try {
      const wins = Services.wm.getEnumerator("navigator:browser");
      while (wins.hasMoreElements()) {
        const win = wins.getNext() as any;
        const doc = win?.document as Document | undefined;
        if (!doc) continue;

        const linkId = `${config.addonRef}-ftl`;
        if (doc.getElementById(linkId)) continue;

        const link = doc.createElementNS(HTML_NS, "link");
        link.setAttribute("rel", "localization");
        link.setAttribute("href", `${config.addonRef}-addon.ftl`);
        link.id = linkId;
        doc.documentElement.appendChild(link);
      }
    } catch (e: any) {
      _log("FTL injection error: " + e.message);
    }
  }

  // Zotero renders our sidenav button via:
  //   background-image: var(--custom-sidenav-icon-light);
  //   background-size: auto;     /* <-- shows the icon at NATURAL size */
  // Inside a 28x28 button with 4px padding, an oversized PNG (e.g. the
  // legacy 96x96 favicon.png that may still be in a cached bundle) gets
  // clipped to a small portion of itself and looks like a tall purple
  // bar. Force `background-size: contain` so the icon scales to fit the
  // button regardless of the source PNG dimensions.
  private injectChromeStyles(): void {
    try {
      const wins = Services.wm.getEnumerator("navigator:browser");
      while (wins.hasMoreElements()) {
        const win = wins.getNext() as any;
        const doc = win?.document as Document | undefined;
        if (!doc) continue;

        const styleId = `${config.addonRef}-chrome-style`;
        if (doc.getElementById(styleId)) continue;

        // The data-pane attribute Zotero assigns ends with our paneID
        // (e.g. "reading-assistant\@zotero-llm\.org-readingassistant-chat"),
        // so an [data-pane$="readingassistant-chat"] selector matches us
        // without needing to know the escaped plugin-id prefix.
        const css = `
          .btn[data-pane$="readingassistant-chat"] {
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
          }
        `;
        const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
        style.id = styleId;
        style.textContent = css;
        doc.documentElement.appendChild(style);
      }
    } catch (e: any) {
      _log("Chrome style injection error: " + e.message);
    }
  }

  private mount({ doc, body, item, tabType }: SectionProps): void {
    this.body = body;
    this.currentItem = item || null;
    this.currentTabType = tabType;

    // Content-driven sizing: just give the section body a flex column so our internal
    // layout (messages + input dock) stacks correctly. We deliberately do NOT touch
    // ancestor elements or pin the body height to the viewport — that would override
    // Zotero's natural section flow and squash sibling sections (Translate, etc.).
    body.classList.add(`${config.addonRef}-panel-host`);
    this.applyBodyHostStyles(body);

    this.ensureStyles(doc);
    this.switchConversation(item);

    let root = body.querySelector(`#${config.addonRef}-panel`) as HTMLDivElement | null;
    const hasLegacyTools = !!root?.querySelector(
      `.${config.addonRef}-quick-actions, .${config.addonRef}-context-meta, .${config.addonRef}-suggestions`
    );
    if (!root || hasLegacyTools) {
      root = this.buildPanel(doc);
      body.replaceChildren(root);
    }

    this.messagesContainer = root.querySelector(`#${config.addonRef}-messages`);
    this.inputElement = root.querySelector(`#${config.addonRef}-input`);
    this.inputDockElement = root.querySelector(`#${config.addonRef}-input-dock`);
    this.sendButton = root.querySelector(`#${config.addonRef}-send`);
    this.statusElement = root.querySelector(`#${config.addonRef}-status`);

    if (this.messagesContainer) {
      this.messagesContainer.addEventListener("scroll", () => {
        if (!this.messagesContainer) return;
        const el = this.messagesContainer;
        this.userScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 30;
        const scrollBtn = this.body?.querySelector(`.${config.addonRef}-scroll-bottom-btn`);
        if (scrollBtn) {
          if (this.userScrolledUp) {
            scrollBtn.classList.add("visible");
          } else {
            scrollBtn.classList.remove("visible");
          }
        }
      });
      this.messagesContainer.addEventListener("click", (e: Event) => {
        const target = (e.target as HTMLElement).closest?.(`.${config.addonRef}-page-citation`);
        if (!target) return;
        const page = parseInt((target as HTMLElement).getAttribute("data-page") || "0");
        if (page > 0) navigateToPDFPage(page);
      });
    }

    this.updateStatus(item, tabType);
    this.refreshContextBar();
    this.renderMessages();
    this.setBusy(this.busy);
    this.updateInputDockMetrics();
    this.setupPanelMaxHeight(body, root);
  }

  private setupPanelMaxHeight(body: HTMLElement, root: HTMLElement): void {
    // Force the panel height to exactly (viewport_bottom − panel_top), so the
    // panel always extends from its registered position down to the bottom of
    // the visible viewport. This:
    //   1. Anchors the input dock at viewport-bottom regardless of chat length.
    //   2. Eliminates the empty space below the panel that appears when the
    //      chat is short and the panel sized to its content instead.
    //   3. Forces messages to scroll INTERNALLY when chats are longer than the
    //      available height, instead of growing the panel and triggering the
    //      OUTER right-pane scroll (which would carry the input dock away).
    // Trade-off: any sibling sections registered AFTER ours get pushed below
    // the viewport. The user's setup currently shows no visible siblings, so
    // this is acceptable; revisit with JS-detected mode switching if needed.
    this.maxHeightCleanup?.();
    this.maxHeightCleanup = null;

    const win = body.ownerDocument.defaultView;
    if (!win) return;

    let frame = 0;
    let logged = 0;
    const update = () => {
      frame = 0;
      try {
        if (!root.isConnected) return;
        const rect = root.getBoundingClientRect();
        const viewportH = Math.max(
          win.innerHeight || 0,
          body.ownerDocument.documentElement?.clientHeight || 0
        );
        // 8px breathing room so the dock isn't flush against the pane edge.
        // Don't clamp rect.top to 0: when the right pane scrolls so the panel
        // top is above the viewport, a NEGATIVE top yields a LARGER height,
        // which is correct — the panel still ends at viewport bottom.
        const available = Math.max(280, Math.floor(viewportH - rect.top - 8));
        root.style.setProperty("--ra-panel-height", `${available}px`);
        // Log the first few measurements so we can diagnose sizing issues
        // without spamming the console on every scroll/resize.
        if (logged < 4) {
          logged++;
          _log(
            `panel-height update#${logged}: rect.top=${rect.top.toFixed(1)}, ` +
            `viewportH=${viewportH}, available=${available}px, ` +
            `winInner=${win.innerHeight}, docCH=${body.ownerDocument.documentElement?.clientHeight}`
          );
        }
      } catch (e: any) {
        _log("panel-height update failed: " + (e?.message || e));
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(update);
    };

    const ResizeObserverCtor = win.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(schedule) : null;
    // Watching body covers panel size changes; watching documentElement covers
    // viewport resizes. We deliberately do NOT mutate any of these elements —
    // we only read their geometry.
    observer?.observe(body);
    if (body.ownerDocument.documentElement) {
      observer?.observe(body.ownerDocument.documentElement);
    }

    // Capture-phase scroll listener catches scrolls of any ancestor (e.g. the
    // right-pane scroll container collapsing/expanding sibling sections), which
    // shifts our panel-top without firing a ResizeObserver callback.
    const onScroll = (e: Event) => {
      try {
        const target = e.target as any;
        // Duck-type the Node check via nodeType (Element nodes have nodeType=1).
        // We deliberately AVOID `instanceof Element` because the `Element`
        // global isn't defined in every Zotero context (item pane, certain
        // overlays, etc.) and threw 100+ ReferenceErrors per scroll session.
        if (target && target.nodeType === 1 && root.contains(target)) return;
      } catch (_) { /* fall through to schedule */ }
      schedule();
    };
    win.addEventListener("resize", schedule);
    win.addEventListener("scroll", onScroll, true);

    // Initial pass + a few delayed retries since Zotero finishes laying out the
    // right pane asynchronously — the first measurement is often premature.
    schedule();
    const t1 = win.setTimeout(schedule, 50);
    const t2 = win.setTimeout(schedule, 250);
    const t3 = win.setTimeout(schedule, 600);

    this.maxHeightCleanup = () => {
      if (frame) win.cancelAnimationFrame(frame);
      win.clearTimeout(t1);
      win.clearTimeout(t2);
      win.clearTimeout(t3);
      observer?.disconnect();
      win.removeEventListener("resize", schedule);
      win.removeEventListener("scroll", onScroll, true);
    };
  }

  private applyBodyHostStyles(body: HTMLElement): void {
    // Dual-mode sizing without JS detection:
    //   - flex: 1 1 auto + min-height: 0 → if parent IS a flex column (focus/single-
    //     section mode), we stretch to fill; if parent is NOT flex (multi-section
    //     stacked mode), flex degrades to content-driven sizing.
    //   - We do NOT touch ancestor styles, so sibling sections (Translate, Tags, …)
    //     keep their natural layout.
    body.classList.add(`${config.addonRef}-panel-host`);
    body.style.setProperty("display", "flex", "important");
    body.style.setProperty("flex", "1 1 auto", "important");
    body.style.setProperty("flex-direction", "column", "important");
    body.style.setProperty("min-height", "0", "important");
    body.style.setProperty("min-width", "0", "important");
    body.style.setProperty("max-width", "100%", "important");
    body.style.setProperty("padding", "0", "important");
    body.style.setProperty("box-sizing", "border-box", "important");
  }

  private updateInputDockMetrics(): void {
    if (!this.inputDockElement) return;
    const root = this.inputDockElement.closest(`.${config.addonRef}-panel`) as HTMLElement | null;
    if (!root) return;
    root.style.setProperty(
      "--readingassistant-input-dock-height",
      `${Math.ceil(this.inputDockElement.getBoundingClientRect().height)}px`
    );
  }

  private getConversationKey(item?: any): string {
    try {
      const target = item || this.currentItem;
      if (!target) return "global";
      const parentID = target.parentID;
      const parent = parentID ? Zotero.Items.get(parentID) : target;
      return String(parent?.key || target.key || target.id || "global");
    } catch (e) {
      return "global";
    }
  }

  private switchConversation(item?: any): void {
    const key = this.getConversationKey(item);
    if (key === this.currentConversationKey) return;

    this.saveConversation();
    this.currentConversationKey = key;
    this.messages = this.loadConversation(key);
    this.currentMessageDiv = null;
    this.renderMessages();
  }

  private loadConversation(key: string): Message[] {
    return loadConversationFromStore(config.addonRef, key);
  }

  private saveConversation(): void {
    saveConversationToStore(
      config.addonRef,
      this.currentConversationKey,
      this.messages,
    );
  }

  private buildPanel(doc: Document): HTMLDivElement {
    const root = createHTMLElement(doc, "div", `${config.addonRef}-panel`);
    root.id = `${config.addonRef}-panel`;

    const messages = createHTMLElement(doc, "div", `${config.addonRef}-messages`);
    messages.id = `${config.addonRef}-messages`;

    const scrollBtn = createHTMLElement(doc, "button", `${config.addonRef}-scroll-bottom-btn`);
    scrollBtn.title = t("scroll-bottom");
    scrollBtn.setAttribute("aria-label", t("scroll-bottom"));
    const SVG_NS = "http://www.w3.org/2000/svg";
    const scrollIcon = doc.createElementNS(SVG_NS, "svg");
    scrollIcon.setAttribute("viewBox", "0 0 24 24");
    scrollIcon.setAttribute("fill", "none");
    scrollIcon.setAttribute("stroke", "currentColor");
    scrollIcon.setAttribute("stroke-width", "2.4");
    scrollIcon.setAttribute("stroke-linecap", "round");
    scrollIcon.setAttribute("stroke-linejoin", "round");
    scrollIcon.setAttribute("width", "15");
    scrollIcon.setAttribute("height", "15");
    scrollIcon.setAttribute("aria-hidden", "true");
    const scrollPath = doc.createElementNS(SVG_NS, "path");
    scrollPath.setAttribute("d", "m7 10 5 5 5-5");
    scrollIcon.appendChild(scrollPath);
    scrollBtn.appendChild(scrollIcon);
    scrollBtn.addEventListener("click", () => {
      this.userScrolledUp = false;
      this.scrollMessagesToBottom();
      scrollBtn.classList.remove("visible");
    });

    const { root: inputDock } = buildInputDock({
      doc,
      addonRef: config.addonRef,
      onSubmit: () => this.handleUserInput(),
      onStop: () => this.stopGeneration(),
      onClearImages: () => {
        this.pendingImages = [];
        this.clearImagePreview();
      },
      onPaste: (e) => this.handlePaste(e),
      onInput: () => this.autoGrowInput(),
      isBusy: () => this.busy,
      hasPendingImages: () => this.pendingImages.length > 0,
    });

    const contextBar = this.buildContextBar(doc);
    root.append(messages, contextBar, inputDock, scrollBtn);

    return root;
  }

  /**
   * Build the context bar that lives between the messages and the input dock.
   * Two buttons:
   *   - "📌 加入到知识图谱" — adds the currently-active paper to the KG.
   *     Disabled (with explanatory text) when no item is selected, when the
   *     active item isn't a regular item, or when the paper is already in
   *     the graph.
   *   - "🧠 打开图谱" — opens the KG window. Always enabled.
   *
   * The bar subscribes to KGStore so it auto-refreshes when the user adds
   * the same paper from inside the KG dialog (or via Tools menu).
   */
  private buildContextBar(doc: Document): HTMLDivElement {
    const bar = createHTMLElement(doc, "div", `${config.addonRef}-context-bar`);
    bar.id = `${config.addonRef}-context-bar`;

    const addBtn = createHTMLElement(doc, "button", `${config.addonRef}-context-bar-btn`);
    addBtn.type = "button";
    addBtn.classList.add(`${config.addonRef}-context-bar-add`);
    addBtn.innerHTML = `<span class="${config.addonRef}-context-bar-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span><span class="${config.addonRef}-context-bar-label">${t("kg-sidebar-add-btn")}</span>`;
    addBtn.addEventListener("click", () => void this.addCurrentPaperToKG());

    const openBtn = createHTMLElement(doc, "button", `${config.addonRef}-context-bar-btn`);
    openBtn.type = "button";
    openBtn.classList.add(`${config.addonRef}-context-bar-open`);
    openBtn.innerHTML = `<span class="${config.addonRef}-context-bar-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 7l3 9"/><path d="M16 7l-3 9"/><path d="M8 6h8"/></svg></span><span class="${config.addonRef}-context-bar-label">${t("kg-sidebar-open-btn")}</span>`;
    openBtn.title = t("kg-sidebar-open-tip");
    openBtn.addEventListener("click", () => {
      try {
        const win = doc.defaultView || (Services as any).wm.getMostRecentWindow("navigator:browser");
        if (win) openKnowledgeGraphWindow(win as Window);
      } catch (e: any) {
        _log("openKnowledgeGraphWindow failed: " + (e?.message || e));
      }
    });

    bar.append(addBtn, openBtn);

    this.contextBarElement = bar;
    this.kgAddBtn = addBtn;
    this.kgOpenBtn = openBtn;

    // Re-render the bar whenever the KG state changes (so the "add" button
    // flips to "已在图谱中" the instant the paper lands in KGStore — even if
    // the user added it from another route).
    if (!this.kgUnsubscribe) {
      this.kgUnsubscribe = kgStore.subscribe(() => this.refreshContextBar());
    }
    return bar;
  }

  /**
   * Resolve a Zotero item into the regular item that should land in the KG.
   * Attachments (PDF readers) are mapped to their parent regular item.
   * Returns null if no usable regular item is in scope.
   */
  private resolveRegularItem(item: any): any | null {
    if (!item) return null;
    try {
      if (item.isRegularItem?.()) return item;
      if (item.parentItem) return item.parentItem;
      if (item.parentID) {
        return Zotero.Items.get(item.parentID);
      }
    } catch (_) {}
    return null;
  }

  /** Refresh the add-to-KG button label/disabled state from the current item. */
  private refreshContextBar(): void {
    const addBtn = this.kgAddBtn;
    if (!addBtn) return;
    const labelEl = addBtn.querySelector(`.${config.addonRef}-context-bar-label`) as HTMLElement | null;
    const setLabel = (text: string, disabled: boolean, tip?: string) => {
      if (labelEl) labelEl.textContent = text;
      addBtn.disabled = disabled;
      addBtn.classList.toggle(`${config.addonRef}-context-bar-btn-disabled`, disabled);
      addBtn.title = tip || text;
    };
    const regular = this.resolveRegularItem(this.currentItem);
    if (!regular) {
      setLabel(t("kg-sidebar-add-need-paper"), true, t("kg-sidebar-add-need-paper-tip"));
      return;
    }
    const key = (regular as any).key;
    if (key && kgStore.hasPaper(key)) {
      setLabel(t("kg-sidebar-add-already"), true, t("kg-sidebar-add-already-tip"));
      return;
    }
    setLabel(t("kg-sidebar-add-btn"), false, t("kg-sidebar-add-tip"));
  }

  /** Click handler for "📌 加入到知识图谱". */
  private async addCurrentPaperToKG(): Promise<void> {
    const regular = this.resolveRegularItem(this.currentItem);
    if (!regular) return;
    try {
      // Make sure the store is initialized — in normal flow it is, but the
      // first sidebar interaction may race startup on a slow disk.
      await kgStore.init();
      const added = await kgStore.addPapers([regular]);
      if (added.length > 0) {
        showToast(
          t("kg-sidebar-add-toast-headline"),
          regular.getDisplayTitle?.() || regular.getField?.("title") || "",
          2400,
        );
      } else {
        showToast(
          t("kg-sidebar-add-already"),
          regular.getDisplayTitle?.() || "",
          1800,
        );
      }
      this.refreshContextBar();
    } catch (e: any) {
      _log("addCurrentPaperToKG failed: " + (e?.message || e));
      showToast(t("kg-sidebar-add-error"), String(e?.message || e), 3000);
    }
  }

  private ensureStyles(doc: Document): void {
    const styleId = `${config.addonRef}-sidebar-style`;
    if (doc.getElementById(styleId)) return;

    const style = createHTMLElement(doc, "style");
    style.id = styleId;
    style.textContent = buildSidebarStyles(config.addonRef);
    doc.documentElement.appendChild(style);
  }

  private getSectionSummary(item?: any, tabType?: string): string {
    if (!item) return t("summary-select-item");
    if (tabType === "reader") return t("summary-pdf-reader");
    const title = String(item.getField?.("title") || item.getDisplayTitle?.() || t("summary-ready"));
    return title.length > 42 ? `${title.slice(0, 39)}...` : title;
  }

  private updateStatus(item?: any, tabType?: string): void {
    if (!this.statusElement) return;
    if (this.busy) {
      this.statusElement.textContent = t("status-generating");
      return;
    }
    this.statusElement.textContent = "";
  }

  private async handleUserInput() {
    if (!this.inputElement || this.busy) return;

    const userText = this.inputElement.value.trim();
    const images = [...this.pendingImages];
    if (!userText && images.length === 0) return;

    this.inputElement.value = "";
    this.pendingImages = [];
    this.clearImagePreview();
    this.autoGrowInput();
    this.userScrolledUp = false;
    this.body?.querySelector(`.${config.addonRef}-scroll-bottom-btn`)?.classList.remove("visible");

    let content: string | MessageContentPart[];
    if (images.length > 0) {
      const parts: MessageContentPart[] = [];
      if (userText) {
        parts.push({ type: "text", text: userText });
      }
      for (const img of images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      content = parts;
    } else {
      content = userText;
    }

    this.messages.push({
      role: "user",
      content,
    });
    this.saveConversation();
    this.appendMessage("user", content);

    const llmManager = getLLMManager();

    if (!llmManager.isReady()) {
      this.appendMessage(
        "assistant",
        t("message-llm-not-configured")
      );
      this.messages.pop();
      this.saveConversation();
      return;
    }

    const assistantMessageDiv = this.createMessagePlaceholder();
    this.currentMessageDiv = assistantMessageDiv;
    this.setBusy(true);

    let fullResponse = "";
    let completed = false;

    try {
      const paperContext = await buildCurrentPaperContext({
        query: typeof content === "string" ? content : content.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("\n") || t("prompt-describe-image"),
        item: this.currentItem,
        deepRead: false,
      });
      const messagesForRequest = this.buildMessagesForRequest(paperContext);

      await llmManager.chat(messagesForRequest, {
        onStart: () => {},
        onToken: (token: string) => {
          fullResponse += token;
          this.updateMessageContent(assistantMessageDiv, fullResponse);
        },
        onReasoningToken: (token: string) => {
          this.updateReasoningContent(assistantMessageDiv, token);
        },
        onComplete: (text: string) => {
          completed = true;
          fullResponse = text;
          this.updateMessageContent(assistantMessageDiv, fullResponse, true);
          const parsed = splitReasoningContent(fullResponse);
          this.messages.push({
            role: "assistant",
            content: parsed.answer || fullResponse,
          });
          this.saveConversation();
        },
        onError: (error: Error) => {
          completed = true;
          this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message), true);
        },
      });

      if (!completed && fullResponse) {
        this.updateMessageContent(assistantMessageDiv, fullResponse, true);
        const parsed = splitReasoningContent(fullResponse);
        this.messages.push({
          role: "assistant",
          content: parsed.answer || fullResponse,
        });
        this.saveConversation();
      }
    } catch (error: any) {
      this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message || String(error)), true);
    } finally {
      this.currentMessageDiv = null;
      this.setBusy(false);
    }
  }

  private buildMessagesForRequest(paperContext: PaperContextResult): Message[] {
    const { text, images } = paperContext;
    if (!text && images.length === 0) {
      return this.messages;
    }

    const result: Message[] = [
      {
        role: "system",
        content: [
          "You are a reading assistant inside Zotero. The full paper text and rendered page images are provided below.",
          "Use Markdown for prose and LaTeX ($...$ inline, $$...$$ display) for math equations.",
          "Base your answer on the provided paper content. Cite page numbers when referencing specific claims.",
          "Analyze both the text excerpts and the page images — images capture original layout, figures, and tables.",
          "Current paper:",
          text || "[No text content available]",
        ].join("\n"),
      },
      ...this.messages,
    ];

    if (images.length > 0) {
      const lastMsgIndex = result.length - 1;
      const lastMsg = result[lastMsgIndex];
      if (lastMsg && lastMsg.role === "user") {
        const contentParts: MessageContentPart[] = [];
        if (typeof lastMsg.content === "string") {
          contentParts.push({ type: "text", text: lastMsg.content });
        } else if (Array.isArray(lastMsg.content)) {
          contentParts.push(...lastMsg.content);
        }
        for (const img of images) {
          contentParts.push({ type: "image_url", image_url: { url: img } });
        }
        lastMsg.content = contentParts;
      }
    }

    return result;
  }

  private async retryLastMessage(): Promise<void> {
    if (this.busy) return;
    const summaryKeywords = "comprehensive analysis research problem methodology key results conclusions";
    if (this.messages.length === 1 && this.messages[0].role === "user" &&
        typeof this.messages[0].content === "string" &&
        this.messages[0].content.includes("comprehensive analysis")) {
      this.startDeepRead();
      return;
    }
    this.regenerateLastResponse();
  }

  private async regenerateLastResponse(): Promise<void> {
    if (this.busy) return;

    while (this.messages.length > 0 && this.messages[this.messages.length - 1].role === "assistant") {
      this.messages.pop();
    }

    if (this.messages.length === 0 || this.messages[this.messages.length - 1].role !== "user") {
      return;
    }

    this.saveConversation();
    this.renderMessages();

    const lastUserMsg = this.messages[this.messages.length - 1];
    const userText = typeof lastUserMsg.content === "string" ? lastUserMsg.content : lastUserMsg.content.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("\n") || t("prompt-describe-image");

    const llmManager = getLLMManager();
    if (!llmManager.isReady()) {
      this.appendMessage("assistant", t("message-llm-not-configured"));
      return;
    }

    const assistantMessageDiv = this.createMessagePlaceholder();
    this.currentMessageDiv = assistantMessageDiv;
    this.setBusy(true);

    let fullResponse = "";
    let completed = false;

    try {
      const paperContext = await buildCurrentPaperContext({
        query: userText,
        item: this.currentItem,
        deepRead: false,
      });
      const messagesForRequest = this.buildMessagesForRequest(paperContext);

      await llmManager.chat(messagesForRequest, {
        onStart: () => {},
        onToken: (token: string) => {
          fullResponse += token;
          this.updateMessageContent(assistantMessageDiv, fullResponse);
        },
        onReasoningToken: (token: string) => {
          this.updateReasoningContent(assistantMessageDiv, token);
        },
        onComplete: (text: string) => {
          completed = true;
          fullResponse = text;
          this.updateMessageContent(assistantMessageDiv, fullResponse, true);
          const parsed = splitReasoningContent(fullResponse);
          this.messages.push({
            role: "assistant",
            content: parsed.answer || fullResponse,
          });
          this.saveConversation();
        },
        onError: (error: Error) => {
          completed = true;
          this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message), true);
        },
      });

      if (!completed && fullResponse) {
        this.updateMessageContent(assistantMessageDiv, fullResponse, true);
        const parsed = splitReasoningContent(fullResponse);
        this.messages.push({
          role: "assistant",
          content: parsed.answer || fullResponse,
        });
        this.saveConversation();
      }
    } catch (error: any) {
      this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message || String(error)), true);
    } finally {
      this.currentMessageDiv = null;
      this.setBusy(false);
    }
  }

  private async startDeepRead(): Promise<void> {
    if (this.busy) return;
    const llmManager = getLLMManager();
    if (!llmManager.isReady()) {
      showToast("Error", t("message-llm-not-configured"), 3000);
      return;
    }

    this.setBusy(true);
    this.showProgress("Extracting paper content\u2026");

    try {
      const paperContext = await buildCurrentPaperContext({
        query: "deep read",
        item: this.currentItem,
        deepRead: true,
        renderImages: true,
        onProgress: (stage: string, current: number, total: number) => {
          if (total > 1) {
            this.updateProgress(`${stage} (${current}/${total})`);
          } else {
            this.updateProgress(stage);
          }
        },
      });

      if (!paperContext.text && paperContext.images.length === 0) {
        this.hideProgress();
        this.setBusy(false);
        showToast("Upload Failed", "Could not extract any content from this paper. Make sure the PDF is available and try again.", 5000);
        return;
      }

      this.updateProgress("Submitting to AI for analysis\u2026");

      const summaryPrompt =
        "Please provide a comprehensive analysis of this paper: research problem, methodology, key results, and conclusions. Reference specific pages when citing content.";
      this.messages.push({ role: "user", content: summaryPrompt });
      this.saveConversation();
      this.appendMessage("user", summaryPrompt);

      const assistantMessageDiv = this.createMessagePlaceholder();
      this.currentMessageDiv = assistantMessageDiv;
      this.hideProgress();

      let fullResponse = "";
      let completed = false;
      let failedDueToImages = false;
      const hadImages = paperContext.images.length > 0;

      const messagesForRequest = this.buildMessagesForRequest(paperContext);

      await llmManager.chat(messagesForRequest, {
        onStart: () => {},
        onToken: (token: string) => {
          fullResponse += token;
          this.updateMessageContent(assistantMessageDiv, fullResponse);
        },
        onReasoningToken: (token: string) => {
          this.updateReasoningContent(assistantMessageDiv, token);
        },
        onComplete: (text: string) => {
          const lower = text.toLowerCase();
          if (hadImages && (lower.includes("does not support image") || lower.includes("cannot read"))) {
            failedDueToImages = true;
            completed = false;
            fullResponse = "";
          } else {
            completed = true;
            fullResponse = text;
            this.updateMessageContent(assistantMessageDiv, fullResponse, true);
            const parsed = splitReasoningContent(fullResponse);
            this.messages.push({
              role: "assistant",
              content: parsed.answer || fullResponse,
            });
            this.saveConversation();
          }
        },
        onError: (error: Error) => {
          const msg = error.message.toLowerCase();
          if (hadImages && (msg.includes("image") || msg.includes("vision"))) {
            failedDueToImages = true;
          } else {
            completed = true;
            this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message), true);
          }
        },
      });

      // Auto-retry without images if image was rejected by the model
      if (failedDueToImages && !completed) {
        this.updateMessageContent(assistantMessageDiv, "Images not supported, retrying with text only\u2026", false);
        paperContext.images = [];
        const textOnlyMessages = this.buildMessagesForRequest(paperContext);
        fullResponse = "";
        completed = false;

        await llmManager.chat(textOnlyMessages, {
          onStart: () => {},
          onToken: (token: string) => {
            fullResponse += token;
            this.updateMessageContent(assistantMessageDiv, fullResponse);
          },
          onReasoningToken: (token: string) => {
            this.updateReasoningContent(assistantMessageDiv, token);
          },
          onComplete: (text: string) => {
            completed = true;
            fullResponse = text;
            this.updateMessageContent(assistantMessageDiv, fullResponse, true);
            const parsed = splitReasoningContent(fullResponse);
            this.messages.push({
              role: "assistant",
              content: parsed.answer || fullResponse,
            });
            this.saveConversation();
          },
          onError: (error: Error) => {
            completed = true;
            this.updateMessageContent(assistantMessageDiv, this.formatErrorMessage(error.message), true);
          },
        });
      }

      if (!completed && fullResponse) {
        this.updateMessageContent(assistantMessageDiv, fullResponse, true);
        const parsed = splitReasoningContent(fullResponse);
        this.messages.push({
          role: "assistant",
          content: parsed.answer || fullResponse,
        });
        this.saveConversation();
      }
    } catch (error: any) {
      this.hideProgress();
      showToast("Error", this.formatErrorMessage(error.message || String(error)), 5000);
    } finally {
      this.currentMessageDiv = null;
      this.setBusy(false);
    }
  }

  private showProgress(message: string): void {
    if (!this.messagesContainer) return;
    const doc = this.messagesContainer.ownerDocument;
    this.messagesContainer.querySelector(`.${config.addonRef}-empty`)?.remove();

    let progress = this.messagesContainer.querySelector(`.${config.addonRef}-deep-read-progress`) as HTMLElement | null;
    if (!progress) {
      progress = createHTMLElement(doc, "div", `${config.addonRef}-deep-read-progress`);
      const spinner = createHTMLElement(doc, "div", `${config.addonRef}-deep-read-spinner`);
      const label = createHTMLElement(doc, "div", `${config.addonRef}-deep-read-progress-text`);
      progress.append(spinner, label);
      this.messagesContainer.appendChild(progress);
    }
    const label = progress.querySelector(`.${config.addonRef}-deep-read-progress-text`);
    if (label) label.textContent = message;
  }

  private updateProgress(message: string): void {
    this.showProgress(message);
  }

  private hideProgress(): void {
    this.messagesContainer?.querySelector(`.${config.addonRef}-deep-read-progress`)?.remove();
  }

  private renderMessages(): void {
    if (!this.messagesContainer) return;

    this.messagesContainer.replaceChildren();

    if (this.messages.length === 0) {
      this.messagesContainer.appendChild(this.buildEmptyState(this.messagesContainer.ownerDocument));
      return;
    }

    for (const message of this.messages) {
      if (message.role === "user" || message.role === "assistant") {
        this.appendMessage(message.role, message.content);
      }
    }
  }

  private appendMessage(
    role: "user" | "assistant",
    content: string | MessageContentPart[],
  ): HTMLElement | null {
    if (!this.messagesContainer) return null;
    return appendMessageDom({
      container: this.messagesContainer,
      addonRef: config.addonRef,
      role,
      content,
      onRetry: () => this.retryLastMessage(),
      onRegenerate: () => this.regenerateLastResponse(),
      onScroll: () => this.scrollMessagesToBottom(),
    });
  }

  private buildEmptyState(doc: Document): HTMLElement {
    const apiKey = String(getPref(PrefKeys.SECRET_KEY) || "").trim();
    return buildEmptyStateDom({
      doc,
      addonRef: config.addonRef,
      hasApiKey: apiKey.length > 0,
      onSuggestionClick: (text) => this.applySuggestion(text),
      onSetupClick: () => this.openPreferences(),
    });
  }

  private applySuggestion(text: string): void {
    if (!this.inputElement || !text) return;
    this.inputElement.value = text;
    this.autoGrowInput();
    try {
      this.inputElement.focus();
      const len = this.inputElement.value.length;
      this.inputElement.setSelectionRange(len, len);
    } catch (_) { /* ignore */ }
  }

  private openPreferences(): void {
    try {
      const paneID =
        (addon as any)?.data?.preferencePaneID || `${config.addonRef}-preferences`;
      const internal = (Zotero as any)?.Utilities?.Internal;
      if (internal?.openPreferences) {
        internal.openPreferences(paneID);
        return;
      }
      // Fallback for older / unexpected runtimes
      const win = (Services as any).wm.getMostRecentWindow("navigator:browser");
      win?.openDialog?.(
        "chrome://zotero/content/preferences/preferences.xhtml",
        "zotero-prefs",
        "chrome,titlebar,toolbar,centerscreen,dialog=no",
        { pane: paneID },
      );
    } catch (e: any) {
      _log("openPreferences error: " + (e?.message || e));
    }
  }

  private createMessagePlaceholder(): HTMLElement {
    if (!this.messagesContainer) {
      throw new Error("Messages container not found");
    }
    return createMessagePlaceholderDom({
      container: this.messagesContainer,
      addonRef: config.addonRef,
      onScroll: () => this.scrollMessagesToBottom(),
    });
  }

  private updateReasoningContent(messageDiv: HTMLElement, token: string): void {
    updateReasoningContentDom({
      messageDiv,
      token,
      addonRef: config.addonRef,
      onScroll: () => this.scrollMessagesToBottom(),
    });
  }

  private updateMessageContent(
    messageDiv: HTMLElement,
    content: string,
    isComplete: boolean = false,
  ): void {
    updateMessageContentDom({
      messageDiv,
      addonRef: config.addonRef,
      content,
      isComplete,
      onScroll: () => this.scrollMessagesToBottom(),
    });
  }

  private autoGrowInput(): void {
    if (!this.inputElement) return;
    this.inputElement.style.height = "auto";
    this.inputElement.style.height = `${Math.min(this.inputElement.scrollHeight, 180)}px`;
    this.updateInputDockMetrics();
  }

  private handlePaste(e: Event): void {
    const pasteEvent = e as ClipboardEvent;
    const items = pasteEvent.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile?.();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          this.pendingImages.push(base64);
          this.addImagePreview(base64);
        };
        reader.readAsDataURL(file);
      }
    }
  }

  private addImagePreview(base64: string): void {
    const previewContainer = this.body?.querySelector(
      `#${config.addonRef}-image-preview`,
    ) as HTMLElement | null;
    if (!previewContainer) return;

    addImagePreviewDom({
      container: previewContainer,
      addonRef: config.addonRef,
      base64,
      onRemove: () => {
        const idx = this.pendingImages.indexOf(base64);
        if (idx !== -1) this.pendingImages.splice(idx, 1);
        this.updateInputDockMetrics();
      },
    });
    this.updateInputDockMetrics();
  }

  private clearImagePreview(): void {
    const previewContainer = this.body?.querySelector(
      `#${config.addonRef}-image-preview`,
    ) as HTMLElement | null;
    if (previewContainer) {
      clearImagePreviewDom(previewContainer);
    }
    this.updateInputDockMetrics();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.sendButton) {
      this.sendButton.disabled = false;
      const sendIcon = this.sendButton.querySelector(`.${config.addonRef}-send-icon`);
      const stopIcon = this.sendButton.querySelector(`.${config.addonRef}-stop-icon`);
      if (sendIcon) (sendIcon as HTMLElement).style.display = busy ? "none" : "";
      if (stopIcon) (stopIcon as HTMLElement).style.display = busy ? "" : "none";
      const label = busy ? t("stop") : t("send");
      this.sendButton.title = label;
      this.sendButton.setAttribute("aria-label", label);
    }
    if (this.inputElement && !busy) {
      this.inputElement.disabled = false;
    }
    if (this.statusElement) {
      if (busy) {
        this.statusElement.textContent = t("status-generating");
      } else {
        this.updateStatus(this.currentItem, this.currentTabType);
      }
    }
  }

  private formatErrorMessage(errMsg: string): string {
    return formatErrorMessageHelper(errMsg);
  }

  private stopGeneration(): void {
    const llmManager = getLLMManager();
    llmManager.abort();
    if (this.currentMessageDiv) {
      const contentDiv = this.currentMessageDiv.querySelector(`.${config.addonRef}-message-content`) as HTMLElement | null;
      if (contentDiv && contentDiv.classList.contains("streaming")) {
        contentDiv.classList.remove("streaming");
        const text = contentDiv.textContent || "";
        if (text === t("assistant-thinking")) {
          contentDiv.textContent = t("stopped");
        }
      }
    }
    this.setBusy(false);
  }

  private scrollMessagesToBottom(): void {
    if (!this.messagesContainer || this.userScrolledUp) return;
    this.messagesContainer.scrollTo({
      top: this.messagesContainer.scrollHeight,
      behavior: "smooth",
    });
  }

  public isVisible(): boolean {
    return true;
  }

  public show(): void {}

  public hide(): void {}

  public destroy(): void {
    _log("SidebarView destroy called");
    this.saveConversation();
    if (this.secretKeyObserverID && (Zotero as any).Prefs?.unregisterObserver) {
      try { (Zotero as any).Prefs.unregisterObserver(this.secretKeyObserverID); } catch (e) {}
      this.secretKeyObserverID = null;
    }
    if (this.paneKey && (Zotero as any).ItemPaneManager?.unregisterSection) {
      try {
        (Zotero as any).ItemPaneManager.unregisterSection(this.paneKey);
      } catch (e) {}
    }
  }
}
