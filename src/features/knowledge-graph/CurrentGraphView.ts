/**
 * Current-Graph view — the main "what's in my KG" surface.
 * ----------------------------------------------------------------------------
 * Lives at the heart of the KG dialog. Until M5 wires up cytoscape, this is
 * a list-style stand-in that shows the user's persistent graph state and
 * lets them grow / prune it.
 *
 * Responsibilities (M2.5):
 *   - Subscribe to KGStore and re-render on state change.
 *   - Show empty state when no papers are present.
 *   - List each paper with a status pill (pending / analyzing / ready / error).
 *   - "+ 加入更多论文" button → caller swaps to LibraryBrowser.
 *   - Per-paper "×" → KGStore.removePaper, with a confirm guard.
 *
 * Note: This view never calls the LLM. M3 will introduce a separate
 * `KGPipeline` module that observes KGStore for `pending` papers and runs
 * the analysis. This view will continue to just reflect status.
 */
import { config } from "../../../package.json";
import { createHTMLElement, t } from "../../sidebar/domUtils";
import { openKnowledgeWikiWindow } from "../wiki";
import { buildGraphCanvas, type GraphCanvasHandle, type ViewMode } from "./GraphCanvas";
import { enqueueRetry } from "./KGPipeline";
import { kgStore, type KGConceptNode, type KGEdge, type KGEdgeRole, type KGEdgeType, type KGPaperState, type KGState, type PaperReference, type ReferencedItem } from "./KGStore";

const CONCEPT_DEGREE_THRESHOLD = 2;

/**
 * Edge-type chip row, grouped by semantic family. Order within a group
 * matters: chips render left-to-right.
 */
const CHIP_GROUPS: { id: string; label: string; types: KGEdgeType[] }[] = [
  { id: "citation", label: "引用", types: ["cites"] },
  { id: "relation", label: "相似", types: ["similar-method", "solves-same-problem"] },
  { id: "contrast", label: "对比", types: ["contrasts"] },
  { id: "data", label: "数据", types: ["uses-same-data"] },
  { id: "concept", label: "概念连接", types: ["method-link", "dataset-link"] },
];

export type CurrentGraphViewOptions = {
  doc: Document;
  /** Caller wires this to "swap to LibraryBrowser". */
  onAddPapers: () => void;
};

export type CurrentGraphViewHandle = {
  root: HTMLElement;
  destroy: () => void;
};

export function buildCurrentGraphView(opts: CurrentGraphViewOptions): CurrentGraphViewHandle {
  const { doc, onAddPapers } = opts;
  const ref = config.addonRef;

  // Currently-selected paper key (driven by clicks on the graph). Reflected
  // into the right-hand detail panel.
  let selectedKey: string | null = null;
  // Cytoscape canvas handle; null while empty-state is showing.
  let canvas: GraphCanvasHandle | null = null;
  // Whether the body is currently rendering the empty state, so we can
  // avoid re-creating the canvas every notify.
  let bodyMode: "unmounted" | "empty" | "graph" = "unmounted";
  let graphHost: HTMLElement | null = null;
  let detailHost: HTMLElement | null = null;

  const root = createHTMLElement(doc, "div", `${ref}-kg-app`);

  // ---- Top bar: logo + title block + action buttons ----
  const topbar = createHTMLElement(doc, "div", `${ref}-kg-topbar`);
  const tbLeft = createHTMLElement(doc, "div", `${ref}-kg-topbar-left`);
  const logo = createHTMLElement(doc, "div", `${ref}-kg-logo`);
  // network / nodes glyph (3 connected circles) — replaces the old books emoji
  logo.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 7l3 9"/><path d="M16 7l-3 9"/><path d="M8 6h8"/></svg>';
  const titleBlock = createHTMLElement(doc, "div", `${ref}-kg-title-block`);
  const titleEl = createHTMLElement(doc, "h1", `${ref}-kg-app-title`);
  titleEl.textContent = t("kg-current-title");
  const subtitleEl = createHTMLElement(doc, "p", `${ref}-kg-app-subtitle`);
  subtitleEl.textContent = t("kg-current-subtitle");
  titleBlock.append(titleEl, subtitleEl);
  tbLeft.append(logo, titleBlock);

  const tbRight = createHTMLElement(doc, "div", `${ref}-kg-topbar-right`);
  const addBtn = createHTMLElement(doc, "button", `${ref}-kg-primary-btn`);
  addBtn.type = "button";
  addBtn.innerHTML = `${ICON.plus}<span>${t("kg-current-add-btn").replace(/^\+\s*/, "")}</span>`;
  addBtn.addEventListener("click", () => onAddPapers());

  const relayoutBtn = createIconButton(doc, ref, ICON.refresh, t("kg-action-relayout"));
  relayoutBtn.addEventListener("click", () => canvas?.relayout());
  const fitBtn = createIconButton(doc, ref, ICON.fit, t("kg-action-fit"));
  fitBtn.addEventListener("click", () => canvas?.fit());
  const exportJsonBtn = createIconButton(doc, ref, ICON.upload, t("kg-action-export-json"));
  exportJsonBtn.addEventListener("click", () => exportGraphState(doc.defaultView));
  tbRight.append(addBtn, relayoutBtn, fitBtn, exportJsonBtn);
  topbar.append(tbLeft, tbRight);

  // ---- Stat pills row + search input on the right ----
  const statRow = createHTMLElement(doc, "div", `${ref}-kg-stat-row`);

  const searchWrap = createHTMLElement(doc, "div", `${ref}-kg-search-wrap`);
  const searchIcon = createHTMLElement(doc, "span", `${ref}-kg-search-icon`);
  // simple magnifier outline (no emoji presentation)
  searchIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
  searchIcon.setAttribute("aria-hidden", "true");
  const searchInput = createHTMLElement(doc, "input", `${ref}-kg-search-input`);
  searchInput.type = "text";
  searchInput.placeholder = t("kg-graph-search-placeholder");
  searchInput.setAttribute("aria-label", t("kg-graph-search-placeholder"));
  const searchClear = createHTMLElement(doc, "button", `${ref}-kg-search-clear`);
  searchClear.type = "button";
  searchClear.title = t("kg-search-clear");
  searchClear.setAttribute("aria-label", t("kg-search-clear"));
  searchClear.textContent = "\u2715"; // multiplication x — used as clear glyph
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    canvas?.setSearchFilter("");
    searchClear.classList.remove(`${ref}-kg-search-clear-visible`);
    searchInput.focus();
  });
  searchInput.addEventListener("input", () => {
    const v = searchInput.value;
    canvas?.setSearchFilter(v);
    searchClear.classList.toggle(`${ref}-kg-search-clear-visible`, v.length > 0);
  });
  searchInput.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      searchInput.value = "";
      canvas?.setSearchFilter("");
      searchClear.classList.remove(`${ref}-kg-search-clear-visible`);
    }
  });
  searchWrap.append(searchIcon, searchInput, searchClear);

  // statRow holds the pills (left) + search box (right). We wrap them in a
  // flex container so the search ends up flush-right on wide windows but
  // wraps gracefully on narrow ones.
  const statSearchRow = createHTMLElement(doc, "div", `${ref}-kg-stat-search-row`);
  statSearchRow.append(statRow, searchWrap);

  // Stage-3 progress banner. Hidden by default; rerender() flips visibility
  // based on `state.pipelinePhase`. Concept canonicalization can take 1-2
  // minutes (LLM merge of all candidates), and during that time the graph
  // shows zero concept nodes — without this banner the user would assume
  // the system is broken.
  const stage3Banner = createHTMLElement(doc, "div", `${ref}-kg-pipeline-banner`);
  stage3Banner.style.display = "none";
  const stage3BannerSpinner = createHTMLElement(
    doc,
    "span",
    `${ref}-kg-pipeline-banner-spinner`,
  );
  const stage3BannerText = createHTMLElement(
    doc,
    "span",
    `${ref}-kg-pipeline-banner-text`,
  );
  stage3BannerText.textContent = "正在规范化概念图（合并别名、生成跨文献连接）…";
  stage3Banner.append(stage3BannerSpinner, stage3BannerText);

  // ---- Edge-type filter chip row (grouped) ----
  // v7: 8 edge types organized into 5 semantic groups. State is local to
  // this view; users get a fresh unfiltered view each open.
  const ALL_EDGE_TYPES: KGEdgeType[] = CHIP_GROUPS.flatMap((g) => g.types);
  const visibleEdgeTypes = new Set<string>(ALL_EDGE_TYPES);

  type ChipRefs = { btn: HTMLButtonElement; count: HTMLElement };
  const chipRefs = new Map<string, ChipRefs>();
  const chipRow = createHTMLElement(doc, "div", `${ref}-kg-chip-row`);

  const refreshEdgeFilter = (): void => {
    const filter =
      visibleEdgeTypes.size === ALL_EDGE_TYPES.length
        ? null
        : new Set(visibleEdgeTypes);
    canvas?.setEdgeTypeFilter(filter);
  };

  for (const group of CHIP_GROUPS) {
    const groupEl = createHTMLElement(doc, "div", `${ref}-kg-chip-group`);
    const groupLbl = createHTMLElement(doc, "span", `${ref}-kg-chip-group-label`);
    groupLbl.textContent = group.label;
    groupEl.appendChild(groupLbl);
    for (const type of group.types) {
      const chip = createHTMLElement(doc, "button", `${ref}-kg-chip`);
      chip.type = "button";
      chip.classList.add(`${ref}-kg-chip-${type}`);
      chip.classList.add(`${ref}-kg-chip-active`);
      const dot = createHTMLElement(doc, "span", `${ref}-kg-chip-dot`);
      const lbl = createHTMLElement(doc, "span", `${ref}-kg-chip-label`);
      lbl.textContent = labelForEdgeType(type);
      const cnt = createHTMLElement(doc, "span", `${ref}-kg-chip-count`);
      cnt.textContent = "0";
      chip.append(dot, lbl, cnt);
      chip.addEventListener("click", () => {
        if (visibleEdgeTypes.has(type)) visibleEdgeTypes.delete(type);
        else visibleEdgeTypes.add(type);
        chip.classList.toggle(`${ref}-kg-chip-active`, visibleEdgeTypes.has(type));
        refreshEdgeFilter();
      });
      groupEl.appendChild(chip);
      chipRefs.set(type, { btn: chip, count: cnt });
    }
    chipRow.appendChild(groupEl);
  }

  // ---- View-mode segmented control ----
  // Three-tier visibility: papers only / papers+datasets / full. Default is
  // "full" so the user sees the freshly-canonicalized concept layer right
  // away; they can fold it down if they want a sparser map.
  const viewModeRow = createHTMLElement(doc, "div", `${ref}-kg-view-mode-row`);
  const viewModeLabel = createHTMLElement(doc, "span", `${ref}-kg-view-mode-label`);
  viewModeLabel.textContent = "视图范围";
  viewModeRow.appendChild(viewModeLabel);
  const viewModeGroup = createHTMLElement(doc, "div", `${ref}-kg-segmented`);
  const viewModeButtons = new Map<ViewMode, HTMLButtonElement>();
  let currentViewMode: ViewMode = "full";
  const viewModeOptions: { id: ViewMode; label: string; tip: string }[] = [
    { id: "papers-only", label: "仅论文", tip: "只看论文与论文间关系" },
    { id: "papers+datasets", label: "+ 数据集", tip: "论文 + 共享的数据集概念" },
    { id: "full", label: "全部概念", tip: "论文 + 数据集 + 方法概念" },
  ];
  for (const opt of viewModeOptions) {
    const btn = createHTMLElement(doc, "button", `${ref}-kg-segmented-btn`);
    btn.type = "button";
    btn.title = opt.tip;
    btn.textContent = opt.label;
    if (opt.id === currentViewMode) btn.classList.add(`${ref}-kg-segmented-active`);
    btn.addEventListener("click", () => {
      if (opt.id === currentViewMode) return;
      currentViewMode = opt.id;
      viewModeButtons.forEach((b, id) => {
        b.classList.toggle(`${ref}-kg-segmented-active`, id === currentViewMode);
      });
      canvas?.setViewMode(currentViewMode);
    });
    viewModeButtons.set(opt.id, btn);
    viewModeGroup.appendChild(btn);
  }
  viewModeRow.appendChild(viewModeGroup);

  // ---- Body (graph + detail card) ----
  const body = createHTMLElement(doc, "div", `${ref}-kg-main`);

  root.append(topbar, statSearchRow, stage3Banner, chipRow, viewModeRow, body);

  let destroyed = false;
  const unsub = kgStore.subscribe((state) => rerender(state));
  const initialTimer = doc.defaultView?.setTimeout(() => {
    if (!destroyed) rerender(kgStore.getState());
  }, 0);

  function rerender(state: KGState): void {
    // Stage-3 banner: ephemeral visual indicator while concept
    // canonicalization runs. Set by KGPipeline.processCanonicalize via
    // kgStore.setPipelinePhase, never persisted.
    stage3Banner.style.display = state.pipelinePhase === "stage3" ? "" : "none";

    const n = state.papers.length;
    const ready = state.papers.filter((p) => p.status === "ready").length;
    const analyzing = state.papers.filter((p) => p.status === "analyzing").length;
    const errored = state.papers.filter((p) => p.status === "error").length;
    const edgeCount = state.edges.length;
    const bridgeConceptCount = (state.concepts || []).filter(
      (c) => (c.degree || 0) >= CONCEPT_DEGREE_THRESHOLD,
    ).length;

    // ---- stat pills ----
    statRow.replaceChildren();
    // SVG glyph fragments for the stat pills (book / link icons).
    const PILL_BOOK = svg('<path d="M4 4h7a3 3 0 0 1 3 3v13"/><path d="M20 4h-7a3 3 0 0 0-3 3v13"/><path d="M4 4v15h7"/><path d="M20 4v15h-7"/>');
    const PILL_LINK = svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>');
    if (n === 0) {
      statRow.appendChild(buildStatPill(doc, ref, PILL_BOOK, t("kg-current-stat-empty"), "neutral"));
    } else {
      statRow.appendChild(
        buildStatPill(doc, ref, PILL_BOOK, `${n} ${t("kg-current-stat-papers")}`, "papers"),
      );
      statRow.appendChild(
        buildStatPill(doc, ref, PILL_LINK, `${edgeCount} ${t("kg-current-stat-connections")}`, "edges"),
      );
      // v2: only show "bridge concepts" (degree >= 2) — single-source concepts
      // are persisted but invisible to the user, so don't expose them as a
      // misleading total count.
      if (bridgeConceptCount > 0) {
        statRow.appendChild(buildStatPill(doc, ref, PILL_LINK, `${bridgeConceptCount} 桥接概念`, "papers"));
      }
      let summary: string;
      let tone: "ok" | "warn" | "err";
      if (errored > 0) {
        summary = `${errored} ${t("kg-status-error")}`;
        tone = "err";
      } else if (analyzing > 0) {
        summary = `${analyzing} ${t("kg-status-analyzing")}`;
        tone = "warn";
      } else {
        summary = `${ready === n ? t("kg-status-all-analyzed") : `${ready} ${t("kg-status-ready")}`}`;
        tone = "ok";
      }
      const PILL_OK   = svg('<path d="M5 13l4 4L19 7"/>');
      const PILL_WARN = svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
      const PILL_ERR  = svg('<path d="M12 4l10 17H2L12 4z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".4"/>');
      statRow.appendChild(
        buildStatPill(doc, ref, tone === "ok" ? PILL_OK : tone === "warn" ? PILL_WARN : PILL_ERR, summary, tone),
      );
    }

    // ---- chip counts (edges-by-type) ----
    const counts = new Map<string, number>();
    for (const e of state.edges) {
      counts.set(e.type, (counts.get(e.type) || 0) + 1);
    }
    for (const [type, refs] of chipRefs.entries()) {
      const c = counts.get(type) || 0;
      refs.count.textContent = String(c);
      // Greyed-out chip for types with no current edges (not disabled —
      // user can still click but it has no visible effect).
      refs.btn.classList.toggle(`${ref}-kg-chip-empty`, c === 0);
    }

    // ---- body ----
    if (n === 0) {
      switchBodyToEmpty();
    } else {
      switchBodyToGraph();
      renderDetailPanel(state);
    }
  }

  function switchBodyToEmpty(): void {
    if (bodyMode === "empty") return;
    if (canvas) {
      try { canvas.destroy(); } catch (_) {}
      canvas = null;
    }
    body.replaceChildren();
    body.appendChild(buildEmptyState(doc, ref, () => onAddPapers()));
    selectedKey = null;
    bodyMode = "empty";
  }

  // Created lazily on first transition to graph mode and reused thereafter.

  function switchBodyToGraph(): void {
    if (bodyMode === "graph") return;
    body.replaceChildren();

    const canvasWrap = createHTMLElement(doc, "div", `${ref}-kg-canvas-wrap`);
    graphHost = createHTMLElement(doc, "div", `${ref}-kg-graph-host`);
    canvasWrap.appendChild(graphHost);
    canvasWrap.appendChild(buildVerticalToolbar(doc, ref, {
      onPan: () => canvas?.fit(),
      onZoomIn: () => canvas?.zoomBy(1.2),
      onZoomOut: () => canvas?.zoomBy(1 / 1.2),
      onLock: () => canvas?.relayout(),
    }));

    detailHost = createHTMLElement(doc, "div", `${ref}-kg-detail-card`);

    body.append(canvasWrap, detailHost);

    canvas = buildGraphCanvas({
      doc,
      container: graphHost,
      onSelect: (key) => {
        selectedKey = key;
        renderDetailPanel(kgStore.getState());
      },
    });
    renderDetailPanel(kgStore.getState());
    bodyMode = "graph";
  }

  function renderDetailPanel(state: KGState): void {
    if (!detailHost) return;
    detailHost.replaceChildren();
    if (!selectedKey) {
      // Hot-list of bridge concepts (degree >= threshold) so the empty
      // detail panel is discoverable rather than a dead-end.
      const hotList = buildConceptHotList(doc, ref, state, (id) => {
        if (canvas) {
          try { canvas.focusNode(id); } catch (_) {}
        }
      });
      if (hotList) detailHost.appendChild(hotList);
      detailHost.appendChild(buildDetailEmpty(doc, ref));
      return;
    }
    const paper = state.papers.find((p) => p.itemKey === selectedKey);
    const concept = (state.concepts || []).find((c) => c.id === selectedKey);
    if (concept) {
      detailHost.appendChild(
        buildConceptDetailContent(doc, ref, concept, state, (peerKey: string) => {
          if (canvas && peerKey) {
            try { canvas.focusNode(peerKey); } catch (_) {}
          }
        }),
      );
      detailHost.scrollTop = 0;
      return;
    }
    if (!paper) {
      selectedKey = null;
      renderDetailPanel(state);
      return;
    }
    detailHost.appendChild(
      buildDetailContent(
        doc,
        ref,
        paper,
        state,
        () => {
          rerender(kgStore.getState());
        },
        (peerKey) => {
          // Jump-to-peer: drives the cytoscape view to highlight + center
          // the clicked paper, so the connection-list acts as a navigator.
          if (canvas && peerKey) {
            try { canvas.focusNode(peerKey); } catch (_) {}
          }
        },
      ),
    );
    detailHost.scrollTop = 0;
  }

  return {
    root,
    destroy: () => {
      destroyed = true;
      if (initialTimer != null) {
        try { doc.defaultView?.clearTimeout(initialTimer); } catch (_) {}
      }
      try { unsub(); } catch (_) {}
      if (canvas) { try { canvas.destroy(); } catch (_) {} canvas = null; }
    },
  };
}

// ---------------------------------------------------------------------------
// Detail-panel content (formerly the per-row expand UI). Reuses
// buildSummaryPanel + the retry / remove handlers.
// ---------------------------------------------------------------------------

function buildDetailContent(
  doc: Document,
  ref: string,
  paper: KGPaperState,
  state: KGState,
  forceRerender: () => void,
  onSelectPeer: (itemKey: string) => void,
): HTMLElement {
  const wrap = createHTMLElement(doc, "div", `${ref}-kg-detail-content`);

  // Title
  const titleEl = createHTMLElement(doc, "div", `${ref}-kg-detail-title`);
  titleEl.textContent = paper.title || t("kg-untitled");
  titleEl.title = paper.title;
  wrap.appendChild(titleEl);

  // Meta line
  const metaEl = createHTMLElement(doc, "div", `${ref}-kg-detail-meta`);
  metaEl.textContent = paper.metaLine || "";
  wrap.appendChild(metaEl);

  // Badges row: status + domain
  const headerRow = createHTMLElement(doc, "div", `${ref}-kg-detail-pillrow`);
  const statusEl = createHTMLElement(doc, "span", `${ref}-kg-status-pill`);
  statusEl.classList.add(`${ref}-kg-status-${paper.status}`);
  statusEl.textContent = labelForStatus(paper.status);
  headerRow.appendChild(statusEl);
  if (paper.summary?.domain) {
    const dom = createHTMLElement(doc, "span", `${ref}-kg-domain-tag`);
    dom.textContent = paper.summary.domain;
    headerRow.appendChild(dom);
  }
  wrap.appendChild(headerRow);

  // Action row
  const actionRow = createHTMLElement(doc, "div", `${ref}-kg-detail-actions`);
  const openBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
  openBtn.type = "button";
  openBtn.innerHTML = `${ICON.external}<span>${t("kg-current-open-in-zotero")}</span>`;
  openBtn.addEventListener("click", () => openItemInZotero(paper.itemID));
  actionRow.appendChild(openBtn);

  const wikiBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
  wikiBtn.type = "button";
  wikiBtn.innerHTML = `${ICON.book}<span>Wiki</span>`;
  wikiBtn.addEventListener("click", () => {
    const win = doc.defaultView || ((Services as any).wm.getMostRecentWindow("navigator:browser") as Window | null);
    if (win) openKnowledgeWikiWindow(win, { type: "paper", itemKey: paper.itemKey });
  });
  actionRow.appendChild(wikiBtn);

  // "在 PDF 中阅读": only show when the paper actually has a PDF attachment.
  // Looking it up is cheap (Zotero caches getAttachments) so we do it during
  // every detail-panel build.
  if (hasPdfAttachment(paper.itemID)) {
    const readPdfBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
    readPdfBtn.type = "button";
    readPdfBtn.innerHTML = `${ICON.book}<span>${t("kg-current-read-pdf")}</span>`;
    readPdfBtn.title = t("kg-current-read-pdf-tip");
    readPdfBtn.addEventListener("click", () => void openItemInReader(paper.itemID));
    actionRow.appendChild(readPdfBtn);
  }

  const retryBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
  retryBtn.type = "button";
  retryBtn.innerHTML = `${ICON.refresh}<span>${t("kg-current-retry")}</span>`;
  retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    try {
      await kgStore.updatePaper(paper.itemKey, { status: "pending", errorMsg: undefined });
      enqueueRetry(paper.itemKey);
    } catch (_) {}
  });
  actionRow.appendChild(retryBtn);

  const removeBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
  removeBtn.type = "button";
  removeBtn.classList.add(`${ref}-kg-action-btn-danger`);
  removeBtn.innerHTML = `${ICON.trash}<span>${t("kg-current-remove").replace(/从图谱中/, "").replace(/from graph/i, "")}</span>`;
  removeBtn.addEventListener("click", async () => {
    if (!confirmRemoval(doc.defaultView, paper.title)) return;
    try { await kgStore.removePaper(paper.itemKey); } catch (_) {}
  });
  actionRow.appendChild(removeBtn);
  wrap.appendChild(actionRow);

  // Error block (if any)
  if (paper.status === "error" && paper.errorMsg) {
    const errBlock = createHTMLElement(doc, "div", `${ref}-kg-current-row-error`);
    errBlock.textContent = paper.errorMsg;
    wrap.appendChild(errBlock);
  }

  // Summary sections
  if (paper.status === "ready" && paper.summary) {
    wrap.appendChild(buildSummaryPanel(doc, ref, paper, state, onSelectPeer));
  }

  return wrap;
}

function buildConceptDetailContent(
  doc: Document,
  ref: string,
  concept: KGConceptNode,
  state: KGState,
  onSelectPeer?: (itemKey: string) => void,
): HTMLElement {
  const wrap = createHTMLElement(doc, "div", `${ref}-kg-detail-content`);
  const titleEl = createHTMLElement(doc, "div", `${ref}-kg-detail-title`);
  const display = concept.canonicalLabel || concept.label || concept.id;
  titleEl.textContent = display;
  titleEl.title = display;
  wrap.appendChild(titleEl);

  const metaEl = createHTMLElement(doc, "div", `${ref}-kg-detail-meta`);
  metaEl.textContent = `概念节点 · ${conceptTypeLabel(concept.type)}`;
  wrap.appendChild(metaEl);

  const actionRow = createHTMLElement(doc, "div", `${ref}-kg-detail-actions`);
  const wikiBtn = createHTMLElement(doc, "button", `${ref}-kg-action-btn`);
  wikiBtn.type = "button";
  wikiBtn.innerHTML = `${ICON.book}<span>Wiki</span>`;
  wikiBtn.addEventListener("click", () => {
    const win = doc.defaultView || ((Services as any).wm.getMostRecentWindow("navigator:browser") as Window | null);
    if (win) openKnowledgeWikiWindow(win, { type: "concept", conceptId: concept.id });
  });
  actionRow.appendChild(wikiBtn);
  wrap.appendChild(actionRow);

  const panel = createHTMLElement(doc, "div", `${ref}-kg-summary-panel`);
  appendConceptBlock(doc, ref, panel, "类型", conceptTypeLabel(concept.type));
  // "首次出现于" — render as a clickable pill that focuses the source paper
  // on the canvas. Falls back silently if the paper is no longer in state
  // (e.g. removed since the last canonicalize pass).
  if (concept.representativePaperKey) {
    const repPaper = state.papers.find((p) => p.itemKey === concept.representativePaperKey);
    if (repPaper) {
      const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
      const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
      label.textContent = "首次出现于";
      const repBtn = createHTMLElement(doc, "button", `${ref}-kg-detail-rep-paper`);
      repBtn.type = "button";
      repBtn.textContent = repPaper.title || repPaper.itemKey;
      repBtn.title = repPaper.title || "";
      repBtn.addEventListener("click", () => {
        if (onSelectPeer) onSelectPeer(repPaper.itemKey);
      });
      block.append(label, repBtn);
      panel.appendChild(block);
    }
  }
  appendConceptBlock(doc, ref, panel, "别名", concept.aliases);
  appendConceptBlock(
    doc,
    ref,
    panel,
    "来源论文",
    (concept.sourcePaperKeys || [])
      .map((key) => state.papers.find((p) => p.itemKey === key)?.title || key)
      .filter(Boolean),
  );

  const incident = state.edges.filter((e) => e.from === concept.id || e.to === concept.id);
  if (incident.length > 0) {
    const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
    const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
    label.textContent = `相关连接 · ${incident.length}`;
    block.appendChild(label);
    const list = createHTMLElement(doc, "div", `${ref}-kg-connections-list`);
    for (const edge of incident.slice(0, 80)) {
      const otherKey = edge.from === concept.id ? edge.to : edge.from;
      const other = state.papers.find((p) => p.itemKey === otherKey) ||
        (state.concepts || []).find((c) => c.id === otherKey);
      list.appendChild(
        buildConnectionRow(doc, ref, edge, other, edge.from === concept.id ? "out" : "in", () => {
          if (onSelectPeer) onSelectPeer(otherKey);
        }),
      );
    }
    block.appendChild(list);
    panel.appendChild(block);
  }

  if (panel.children.length === 0) {
    const empty = createHTMLElement(doc, "p", `${ref}-kg-summary-empty`);
    empty.textContent = t("kg-summary-empty");
    panel.appendChild(empty);
  }
  wrap.appendChild(panel);
  return wrap;
}

function appendReferencedItemBlock(
  doc: Document,
  ref: string,
  panel: HTMLElement,
  labelText: string,
  values: ReferencedItem[] | undefined,
): void {
  if (!values || values.length === 0) return;
  const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
  const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
  label.textContent = labelText;
  block.appendChild(label);
  const list = createHTMLElement(doc, "div", `${ref}-kg-referenced-list`);
  for (const item of values) {
    if (!item || !item.name) continue;
    const row = createHTMLElement(doc, "div", `${ref}-kg-referenced-row`);
    const name = createHTMLElement(doc, "span", `${ref}-kg-referenced-name`);
    name.textContent = item.name;
    const roleEl = createHTMLElement(doc, "span", `${ref}-kg-referenced-role`);
    roleEl.classList.add(`${ref}-kg-referenced-role-${item.role}`);
    roleEl.textContent = roleLabel(item.role);
    row.append(name, roleEl);
    if (item.evidence) row.title = item.evidence;
    list.appendChild(row);
  }
  block.appendChild(list);
  panel.appendChild(block);
}

function roleLabel(role: ReferencedItem["role"]): string {
  switch (role) {
    case "extended": return "发展";
    case "compared-baseline": return "对比 baseline";
    case "cited-only": return "仅引用";
    default: return "使用";
  }
}

function appendConceptBlock(
  doc: Document,
  ref: string,
  panel: HTMLElement,
  labelText: string,
  value: string | string[] | undefined,
): void {
  if (!value || (Array.isArray(value) && value.length === 0)) return;
  const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
  const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
  label.textContent = labelText;
  block.appendChild(label);
  if (Array.isArray(value)) {
    const ul = createHTMLElement(doc, "ul", `${ref}-kg-summary-list`);
    for (const v of value) {
      const li = createHTMLElement(doc, "li");
      li.textContent = v;
      ul.appendChild(li);
    }
    block.appendChild(ul);
  } else {
    const p = createHTMLElement(doc, "p", `${ref}-kg-summary-text`);
    p.textContent = value;
    block.appendChild(p);
  }
  panel.appendChild(block);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function buildEmptyState(doc: Document, ref: string, onAdd: () => void): HTMLElement {
  const wrap = createHTMLElement(doc, "div", `${ref}-kg-current-empty`);
  const badge = createHTMLElement(doc, "span", `${ref}-kg-current-empty-badge`);
  badge.textContent = "\u2728";
  const heading = createHTMLElement(doc, "h2", `${ref}-kg-current-empty-heading`);
  heading.textContent = t("kg-current-empty-heading");
  const desc = createHTMLElement(doc, "p", `${ref}-kg-current-empty-desc`);
  desc.textContent = t("kg-current-empty-desc");
  const button = createHTMLElement(doc, "button", `${ref}-kg-generate-btn`);
  button.type = "button";
  button.textContent = t("kg-current-empty-cta");
  button.addEventListener("click", () => onAdd());
  wrap.append(badge, heading, desc, button);
  return wrap;
}

/** Legacy row builder kept for completeness; no longer mounted in M5. */
function buildPaperRow(
  doc: Document,
  ref: string,
  paper: KGPaperState,
  expandedKeys: Set<string>,
  forceRerender: () => void,
): HTMLElement {
  const row = createHTMLElement(doc, "div", `${ref}-kg-current-row`);

  const statusEl = createHTMLElement(doc, "span", `${ref}-kg-status-pill`);
  statusEl.classList.add(`${ref}-kg-status-${paper.status}`);
  statusEl.textContent = labelForStatus(paper.status);

  const body = createHTMLElement(doc, "div", `${ref}-kg-current-row-body`);
  const titleEl = createHTMLElement(doc, "div", `${ref}-kg-current-row-title`);
  titleEl.textContent = paper.title || t("kg-untitled");
  titleEl.title = paper.title;
  const metaEl = createHTMLElement(doc, "div", `${ref}-kg-current-row-meta`);
  metaEl.textContent = paper.metaLine || "";
  body.append(titleEl, metaEl);

  // When analysis is ready, surface the domain inline as a colored chip and
  // offer an expander to reveal the full summary.
  if (paper.status === "ready" && paper.summary) {
    const tagsRow = createHTMLElement(doc, "div", `${ref}-kg-current-row-tags`);
    if (paper.summary.domain) {
      const dom = createHTMLElement(doc, "span", `${ref}-kg-domain-tag`);
      dom.textContent = paper.summary.domain;
      tagsRow.appendChild(dom);
    }
    const isExpanded = expandedKeys.has(paper.itemKey);
    const toggle = createHTMLElement(doc, "button", `${ref}-kg-summary-toggle`);
    toggle.type = "button";
    toggle.textContent = isExpanded ? t("kg-summary-hide") : t("kg-summary-show");
    toggle.addEventListener("click", () => {
      if (expandedKeys.has(paper.itemKey)) {
        expandedKeys.delete(paper.itemKey);
      } else {
        expandedKeys.add(paper.itemKey);
      }
      forceRerender();
    });
    tagsRow.appendChild(toggle);
    body.appendChild(tagsRow);

    if (isExpanded) {
      body.appendChild(buildSummaryPanel(doc, ref, paper, kgStore.getState()));
    }
  }

  if (paper.status === "error" && paper.errorMsg) {
    const errBlock = createHTMLElement(doc, "div", `${ref}-kg-current-row-error`);
    errBlock.textContent = paper.errorMsg;
    body.appendChild(errBlock);

    const retryRow = createHTMLElement(doc, "div", `${ref}-kg-current-row-actions`);

    // Special case: deterministic "no content" failure. Retrying without
    // changing the underlying data fails again instantly, which is
    // confusing. Surface a button that opens the item in Zotero so the
    // user can attach/replace the PDF or let Zotero rebuild full-text
    // indexing before retrying.
    const isNoContent = /no abstract|no pdf attachment|no.*full text|pdf attachment exists|pdf text extraction/i.test(paper.errorMsg);
    if (isNoContent) {
      const openBtn = createHTMLElement(doc, "button", `${ref}-kg-back-btn`);
      openBtn.type = "button";
      openBtn.textContent = t("kg-current-open-in-zotero");
      openBtn.title = t("kg-current-open-in-zotero-tip");
      openBtn.addEventListener("click", () => openItemInZotero(paper.itemID));
      retryRow.appendChild(openBtn);
    }

    const retryBtn = createHTMLElement(doc, "button", `${ref}-kg-back-btn`);
    retryBtn.type = "button";
    retryBtn.textContent = t("kg-current-retry");
    retryBtn.addEventListener("click", async () => {
      // Disable while the click handler runs so users don't double-fire
      // and end up with multiple "pending" entries before the persist
      // round-trip lands.
      retryBtn.disabled = true;
      try {
        // Reset state, then jump the queue so the pipeline picks this up
        // immediately even if it's mid-way through other papers.
        await kgStore.updatePaper(paper.itemKey, {
          status: "pending",
          errorMsg: undefined,
        });
        enqueueRetry(paper.itemKey);
      } catch (e: any) {
        Zotero.debug("[RA] retry failed: " + (e?.message || e));
      }
    });
    retryRow.appendChild(retryBtn);
    body.appendChild(retryRow);
  }

  const removeBtn = createHTMLElement(doc, "button", `${ref}-kg-current-row-remove`);
  removeBtn.type = "button";
  removeBtn.textContent = "\u00d7";
  removeBtn.title = t("kg-current-remove");
  removeBtn.setAttribute("aria-label", t("kg-current-remove"));
  removeBtn.addEventListener("click", async () => {
    // No native `confirm()` inside Zotero chrome; use Services.prompt for a
    // proper modal that respects the parent window. Falls back to direct
    // removal if the prompt API is unavailable.
    if (!confirmRemoval(doc.defaultView, paper.title)) return;
    try {
      await kgStore.removePaper(paper.itemKey);
    } catch (e: any) {
      Zotero.debug("[RA] removePaper failed: " + (e?.message || e));
    }
  });

  row.append(statusEl, body, removeBtn);
  return row;
}

/** Render the expandable detail panel showing all summary fields + relationships. */
function buildSummaryPanel(
  doc: Document,
  ref: string,
  paper: KGPaperState,
  state: KGState,
  onSelectPeer?: (itemKey: string) => void,
): HTMLElement {
  const panel = createHTMLElement(doc, "div", `${ref}-kg-summary-panel`);
  const summary = paper.summary || {};

  const append = (labelKey: string, value: string | string[] | undefined) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return;
    const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
    const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
    label.textContent = t(labelKey);
    block.appendChild(label);
    if (Array.isArray(value)) {
      const ul = createHTMLElement(doc, "ul", `${ref}-kg-summary-list`);
      for (const v of value) {
        const li = createHTMLElement(doc, "li");
        li.textContent = v;
        ul.appendChild(li);
      }
      block.appendChild(ul);
    } else {
      const p = createHTMLElement(doc, "p", `${ref}-kg-summary-text`);
      p.textContent = value;
      block.appendChild(p);
    }
    panel.appendChild(block);
  };
  const appendRaw = (labelText: string, value: string | string[] | undefined) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return;
    const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
    const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
    label.textContent = labelText;
    block.appendChild(label);
    if (Array.isArray(value)) {
      const ul = createHTMLElement(doc, "ul", `${ref}-kg-summary-list`);
      for (const v of value) {
        const li = createHTMLElement(doc, "li");
        li.textContent = v;
        ul.appendChild(li);
      }
      block.appendChild(ul);
    } else {
      const p = createHTMLElement(doc, "p", `${ref}-kg-summary-text`);
      p.textContent = value;
      block.appendChild(p);
    }
    panel.appendChild(block);
  };

  append("kg-summary-problem", summary.problem);
  appendRaw("任务", summary.targetTask);
  append("kg-summary-contributions", summary.contributions);
  appendRaw("本文提出的方法/模型", summary.ownedMethodNames);
  appendRaw("本文发布的数据/Benchmark", summary.proposedDatasets);
  appendReferencedItemBlock(doc, ref, panel, "引用方法", summary.referencedMethods);
  appendReferencedItemBlock(doc, ref, panel, "引用数据集", summary.referencedDatasets);
  appendRaw("参考文献", (summary.references || []).slice(0, 20).map(referenceLine));
  appendRaw("局限", summary.limitations);
  // Legacy v6/v8 fields rendered if present (during migration window).
  append("kg-summary-methods", summary.methods);
  append("kg-summary-conclusions", summary.conclusions);
  appendRaw("数据集", summary.datasets);
  appendRaw("Benchmark", summary.benchmarks);
  appendRaw("Baseline", summary.baselines);
  appendRaw("发展自", summary.extendsFrom);
  appendRaw("比较对象", summary.comparedAgainst);
  appendRaw("对比技术路线", summary.contrastingApproaches);
  appendRaw("关键主张", summary.keyClaims);

  // Keywords as pills (overrides default list rendering above)
  if (summary.keywords && summary.keywords.length > 0) {
    const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
    const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
    label.textContent = t("kg-summary-keywords");
    block.appendChild(label);
    const pills = createHTMLElement(doc, "div", `${ref}-kg-keyword-pills`);
    for (const kw of summary.keywords) {
      const pill = createHTMLElement(doc, "span", `${ref}-kg-keyword-pill`);
      pill.textContent = kw;
      pills.appendChild(pill);
    }
    block.appendChild(pills);
    panel.appendChild(block);
  }

  // Connections section: show every edge incident to this paper, in either
  // direction. Outgoing edges came from this paper's relations pass;
  // incoming edges came from later papers when they were added.
  const incident = collectIncidentEdges(paper.itemKey, state);
  if (incident.length > 0) {
    const block = createHTMLElement(doc, "div", `${ref}-kg-summary-block`);
    const label = createHTMLElement(doc, "div", `${ref}-kg-summary-label`);
    label.textContent = `${t("kg-summary-connections")} \u00b7 ${incident.length}`;
    block.appendChild(label);
    const list = createHTMLElement(doc, "div", `${ref}-kg-connections-list`);
    for (const { edge, otherKey, direction } of incident) {
      const other = state.papers.find((p) => p.itemKey === otherKey) ||
        (state.concepts || []).find((c) => c.id === otherKey);
      list.appendChild(
        buildConnectionRow(doc, ref, edge, other, direction, () => {
          if (onSelectPeer) onSelectPeer(otherKey);
        }),
      );
    }
    block.appendChild(list);
    panel.appendChild(block);
  }

  if (panel.children.length === 0) {
    const empty = createHTMLElement(doc, "p", `${ref}-kg-summary-empty`);
    empty.textContent = t("kg-summary-empty");
    panel.appendChild(empty);
  }

  return panel;
}

/**
 * Collect every edge touching `itemKey`, deduped per peer paper. When both
 * directions exist between the same pair of papers, prefer the outgoing
 * edge (which was usually computed against fresher context).
 */
function collectIncidentEdges(
  itemKey: string,
  state: KGState,
): { edge: KGEdge; otherKey: string; direction: "out" | "in" }[] {
  const byPeer = new Map<string, { edge: KGEdge; otherKey: string; direction: "out" | "in" }>();
  for (const e of state.edges) {
    if (e.from === itemKey) {
      byPeer.set(`${e.to}\u0000${e.type}`, { edge: e, otherKey: e.to, direction: "out" });
    }
  }
  for (const e of state.edges) {
    const k = `${e.from}\u0000${e.type}`;
    if (e.to === itemKey && !byPeer.has(k)) {
      byPeer.set(k, { edge: e, otherKey: e.from, direction: "in" });
    }
  }
  // Sort by strength desc.
  return [...byPeer.values()].sort((a, b) => (b.edge.strength || 0) - (a.edge.strength || 0));
}

function buildConnectionRow(
  doc: Document,
  ref: string,
  edge: KGEdge,
  other: KGPaperState | KGConceptNode | undefined,
  direction: "out" | "in",
  onClick?: () => void,
): HTMLElement {
  const row = createHTMLElement(doc, "div", `${ref}-kg-connection-row`);
  const typePill = createHTMLElement(doc, "span", `${ref}-kg-edge-type`);
  typePill.classList.add(`${ref}-kg-edge-type-${edge.type}`);
  typePill.textContent = labelForEdgeType(edge.type);

  const body = createHTMLElement(doc, "div", `${ref}-kg-connection-body`);
  const peerLine = createHTMLElement(doc, "div", `${ref}-kg-connection-peer`);
  const arrow = direction === "out" ? "\u2192" : "\u2190";
  const otherTitle = other ? ("title" in other ? other.title : other.label) : edge.to;
  peerLine.textContent = `${arrow} ${otherTitle}`;
  if (otherTitle) peerLine.title = `${otherTitle}\n${t("kg-connection-jump-hint") || ""}`.trim();
  const lbl = createHTMLElement(doc, "div", `${ref}-kg-connection-label`);
  // v7 KGEdge.label is optional; prefer rationale, then explicit label, then
  // empty (the type pill alone already conveys semantics).
  lbl.textContent = edge.rationale || edge.label || "";
  body.append(peerLine, lbl);

  row.append(typePill, body);
  if (onClick) {
    row.classList.add(`${ref}-kg-connection-row-clickable`);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.title = t("kg-connection-jump-hint") || "";
    row.addEventListener("click", onClick);
    row.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
  }
  return row;
}

function labelForEdgeType(type: KGEdgeType | string, role?: string): string {
  // v7 paper→concept edges: role discriminates the displayed phrase.
  if (type === "method-link") {
    switch (role) {
      case "proposed": return "提出方法";
      case "extended": return "发展方法";
      case "compared-baseline": return "对比 baseline";
      default: return "使用方法";
    }
  }
  if (type === "dataset-link") {
    switch (role) {
      case "introduced": return "发布数据";
      case "compared-baseline": return "对比数据";
      default: return "使用数据";
    }
  }
  switch (type) {
    case "similar-method": return t("kg-edge-similar-method");
    case "contrasts": return t("kg-edge-contrasts");
    case "cites": return t("kg-edge-cites");
    case "uses-same-data": return t("kg-edge-uses-same-data");
    case "solves-same-problem": return t("kg-edge-solves-same-problem");
    // Legacy values that may still appear in persisted state mid-migration.
    case "shares-domain": return t("kg-edge-shares-domain");
    case "shares-result": return t("kg-edge-shares-result");
    default: return t("kg-edge-other");
  }
}

function labelForStatus(status: KGPaperState["status"]): string {
  switch (status) {
    case "pending":
      return t("kg-status-pending");
    case "analyzing":
      return t("kg-status-analyzing");
    case "ready":
      return t("kg-status-ready");
    case "error":
      return t("kg-status-error");
  }
}

function conceptTypeLabel(type: string): string {
  switch (type) {
    case "method": return "方法";
    case "dataset": return "数据";
    case "task": return "任务";
    default: return "概念";
  }
}

function referenceLine(r: PaperReference): string {
  return [r.title || r.raw, r.authors, r.year, r.doi].filter(Boolean).join(" | ");
}

/**
 * Bring the user back to Zotero's main window with the given item selected,
 * so they can attach a PDF, fill in an abstract, or just trigger Zotero's
 * fulltext indexing by opening the PDF. After they're done they can come
 * back to the KG window and click "重试" with usable content.
 */
// ---------------------------------------------------------------------------
// New helpers for M5+ design
// ---------------------------------------------------------------------------

function createIconButton(doc: Document, ref: string, svgIcon: string, title: string): HTMLButtonElement {
  const btn = createHTMLElement(doc, "button", `${ref}-kg-icon-btn`);
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = svgIcon;
  return btn;
}

/**
 * Inline SVG icon set. Each entry is a self-contained SVG element
 * with `xmlns` so XHTML's parser keeps it in the correct namespace, a
 * 24-unit viewBox, no fill, and `stroke="currentColor"` so the icon
 * inherits the button's text colour. Width/height = 16 by default; CSS
 * may override via `width`/`height` attributes on `.kg-icon`.
 *
 * (Earlier versions used color emoji because we believed inline SVG was
 * unreliable in the Zotero dialog. We've since confirmed XHTML+xmlns SVG
 * renders fine, and the visual consistency is much better.)
 */
const SVG_PREFIX =
  '<svg xmlns="http://www.w3.org/2000/svg" class="kg-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const SVG_SUFFIX = "</svg>";
const svg = (body: string) => SVG_PREFIX + body + SVG_SUFFIX;
const ICON = {
  // plus — used by the primary "+ 加入论文" button
  plus:     svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  // circular arrows — "重新布局" / "重试分析"
  refresh:  svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  // expand-to-fit (4 corner arrows)
  fit:      svg('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  // clipboard — "复制 JSON 到剪贴板"
  upload:   svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>'),
  // arrow up-right out of a box — "在 Zotero 中打开"
  external: svg('<path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  // trash can — "移除"
  trash:    svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  // image (mountain + sun) — "导出 PNG"
  image:    svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="M21 16l-5-5L5 21"/>'),
  // open book — "在 PDF 中阅读"
  book:     svg('<path d="M4 4h7a3 3 0 0 1 3 3v13"/><path d="M20 4h-7a3 3 0 0 0-3 3v13"/><path d="M4 4v15h7"/><path d="M20 4v15h-7"/>'),
  // plus glyph for the vertical toolbar zoom-in
  zoomIn:   svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  // minus glyph for zoom-out
  zoomOut:  svg('<path d="M5 12h14"/>'),
  // grid / re-layout (4 small squares)
  layout:   svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
};

function buildStatPill(
  doc: Document,
  ref: string,
  glyph: string,
  text: string,
  tone: string,
): HTMLElement {
  const pill = createHTMLElement(doc, "div", `${ref}-kg-stat-pill`);
  pill.classList.add(`${ref}-kg-stat-pill-${tone}`);
  const ic = createHTMLElement(doc, "span", `${ref}-kg-stat-pill-icon`);
  // `glyph` may be an inline SVG string or a plain character; both are
  // safe to insert via innerHTML because we own all callers.
  ic.innerHTML = glyph;
  const lbl = createHTMLElement(doc, "span", `${ref}-kg-stat-pill-text`);
  lbl.textContent = text;
  pill.append(ic, lbl);
  return pill;
}

function buildVerticalToolbar(
  doc: Document,
  ref: string,
  handlers: { onPan: () => void; onZoomIn: () => void; onZoomOut: () => void; onLock: () => void },
): HTMLElement {
  const bar = createHTMLElement(doc, "div", `${ref}-kg-vtoolbar`);
  const make = (svg: string, label: string, fn: () => void) => {
    const btn = createHTMLElement(doc, "button", `${ref}-kg-vtool-btn`);
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.addEventListener("click", fn);
    return btn;
  };
  bar.appendChild(make(ICON.fit, t("kg-action-fit"), handlers.onPan));
  bar.appendChild(make(ICON.zoomIn, t("kg-action-zoom-in"), handlers.onZoomIn));
  bar.appendChild(make(ICON.zoomOut, t("kg-action-zoom-out"), handlers.onZoomOut));
  bar.appendChild(make(ICON.layout, t("kg-action-relayout"), handlers.onLock));
  return bar;
}

/**
 * Render an at-a-glance "图谱关键概念" panel listing the top bridge concepts
 * by degree (sourcePaperKeys count). Empty result returns null so the caller
 * can omit the section entirely on graphs without canonical concepts yet.
 */
function buildConceptHotList(
  doc: Document,
  ref: string,
  state: KGState,
  onSelectConcept: (id: string) => void,
): HTMLElement | null {
  const concepts = (state.concepts || [])
    .filter((c) => (c.degree || 0) >= CONCEPT_DEGREE_THRESHOLD)
    .sort((a, b) => (b.degree || 0) - (a.degree || 0))
    .slice(0, 12);
  if (concepts.length === 0) return null;
  const wrap = createHTMLElement(doc, "div", `${ref}-kg-hotlist`);
  const heading = createHTMLElement(doc, "div", `${ref}-kg-hotlist-heading`);
  heading.textContent = "图谱关键概念";
  wrap.appendChild(heading);
  const list = createHTMLElement(doc, "div", `${ref}-kg-hotlist-list`);
  for (const c of concepts) {
    const row = createHTMLElement(doc, "button", `${ref}-kg-hotlist-row`);
    row.type = "button";
    row.classList.add(`${ref}-kg-hotlist-${c.type}`);
    const name = createHTMLElement(doc, "span", `${ref}-kg-hotlist-name`);
    name.textContent = c.canonicalLabel || c.label || c.id;
    const typeChip = createHTMLElement(doc, "span", `${ref}-kg-hotlist-type`);
    typeChip.textContent = conceptTypeLabel(c.type);
    const deg = createHTMLElement(doc, "span", `${ref}-kg-hotlist-degree`);
    deg.textContent = String(c.degree || 0);
    row.append(name, typeChip, deg);
    row.title = c.description || c.aliases?.slice(0, 5).join(" | ") || "";
    row.addEventListener("click", () => onSelectConcept(c.id));
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

function buildDetailEmpty(doc: Document, ref: string): HTMLElement {
  const wrap = createHTMLElement(doc, "div", `${ref}-kg-detail-empty`);
  const icon = createHTMLElement(doc, "div", `${ref}-kg-detail-empty-icon`);
  // pointer-on-paper glyph instead of the document emoji
  icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13l3 4 4-4"/></svg>';
  const heading = createHTMLElement(doc, "div", `${ref}-kg-detail-empty-heading`);
  heading.textContent = t("kg-detail-empty-heading");
  const desc = createHTMLElement(doc, "div", `${ref}-kg-detail-empty-desc`);
  desc.textContent = t("kg-detail-empty");
  wrap.append(icon, heading, desc);
  return wrap;
}

function exportGraphState(win: Window | null): void {
  try {
    const state = kgStore.getState();
    const payload = {
      papers: state.papers.map((p) => ({
        itemKey: p.itemKey,
        title: p.title,
        metaLine: p.metaLine,
        status: p.status,
        summary: p.summary,
      })),
      concepts: state.concepts || [],
      edges: state.edges,
    };
    const json = JSON.stringify(payload, null, 2);
    const cb = (Services as any).clipboard;
    const SupportsString = (Components as any).Constructor(
      "@mozilla.org/supports-string;1",
      "nsISupportsString",
    );
    const xfer = (Components as any).classes["@mozilla.org/widget/transferable;1"].createInstance(
      (Components as any).interfaces.nsITransferable,
    );
    xfer.init(null);
    xfer.addDataFlavor("text/unicode");
    const ss = new SupportsString();
    ss.data = json;
    xfer.setTransferData("text/unicode", ss, json.length * 2);
    cb.setData(xfer, null, cb.kGlobalClipboard);
    if (win) {
      try { (win as any).alert(t("kg-action-export-done")); } catch (_) {}
    }
  } catch (e: any) {
    Zotero.debug("[RA] exportGraphState failed: " + (e?.message || e));
  }
}

function openItemInZotero(itemID: number): void {
  try {
    const win = (Services as any).wm.getMostRecentWindow("navigator:browser") as any;
    if (!win?.ZoteroPane) return;
    win.ZoteroPane.selectItem(itemID);
    try { win.focus(); } catch (_) {}
  } catch (e: any) {
    Zotero.debug("[RA] openItemInZotero error: " + (e?.message || e));
  }
}

/**
 * Find the first PDF attachment id of a regular item, or null if none.
 * Synchronous because Zotero.Items / item.getAttachments are sync once the
 * item is loaded — which is always the case here since the user just
 * clicked a node corresponding to a paper already in the store.
 */
function findPdfAttachmentID(itemID: number): number | null {
  try {
    const item = Zotero.Items.get(itemID) as any;
    if (!item) return null;
    const attIds: number[] = item.getAttachments?.() || [];
    for (const aid of attIds) {
      const att = Zotero.Items.get(aid) as any;
      if (!att) continue;
      const ct = att.attachmentContentType || att.getField?.("contentType");
      if (ct === "application/pdf") return aid;
    }
  } catch (e: any) {
    Zotero.debug("[RA] findPdfAttachmentID error: " + (e?.message || e));
  }
  return null;
}

/** Cheap predicate — used to decide whether to render the "阅读 PDF" button. */
function hasPdfAttachment(itemID: number): boolean {
  return findPdfAttachmentID(itemID) != null;
}

/** Open the PDF attachment of a paper in Zotero's built-in reader. */
async function openItemInReader(itemID: number): Promise<void> {
  const pdfId = findPdfAttachmentID(itemID);
  if (pdfId == null) return;
  try {
    await (Zotero.Reader as any).open(pdfId);
    try {
      const win = (Services as any).wm.getMostRecentWindow("navigator:browser") as any;
      win?.focus?.();
    } catch (_) {}
  } catch (e: any) {
    Zotero.debug("[RA] openItemInReader error: " + (e?.message || e));
  }
}

/**
 * Shows a system modal asking the user to confirm. Returns true if the user
 * confirmed, false otherwise. If the prompt API isn't reachable (very old
 * Zotero / sandboxing), defaults to returning true to keep the action usable.
 */
function confirmRemoval(win: Window | null, title: string): boolean {
  try {
    const Svc: any = (Services as any).prompt;
    if (!Svc?.confirm) return true;
    const message = `${t("kg-current-remove-confirm")}\n\n${title || ""}`;
    return Svc.confirm(win, t("kg-current-remove-title"), message);
  } catch (_) {
    return true;
  }
}
