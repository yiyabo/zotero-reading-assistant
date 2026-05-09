/**
 * Cytoscape-backed graph canvas for the Knowledge Graph dialog.
 * ----------------------------------------------------------------------------
 * Owns the cytoscape instance, the per-status / per-edge-type stylesheet,
 * and the bidirectional sync between `KGStore` and the cytoscape graph.
 *
 * Sync model
 * ----------
 *   KGStore  -- subscribe -->  GraphCanvas
 *   GraphCanvas  -- dragfree -->  KGStore.setLayoutPosition
 *
 * On every store notify we run an incremental sync (`syncFromState`) that:
 *   - adds new nodes/edges
 *   - removes gone ones
 *   - patches changed status/summary on existing nodes
 *   - replaces all edges (cheap and avoids stale-edge bugs)
 *
 * Layout decisions
 * ----------------
 *   - If a node has a saved position in `state.layout`, use it.
 *   - If any node is *new* (no saved position), run fcose to lay them out
 *     while keeping pinned nodes in place.
 *   - Drag-released positions persist back to the store.
 *
 * Public API
 * ----------
 *   buildGraphCanvas({ doc, container, onSelect })
 *     → returns { destroy, focusNode, getSelectedKey }
 */
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import { t } from "../../sidebar/domUtils";
import { fileLog } from "../../utils/fileLog";
import { kgStore, type KGConceptNode, type KGEdge, type KGEdgeType, type KGPaperState, type KGPaperStatus, type KGState } from "./KGStore";

/**
 * Three-tier visibility model. The detail UI exposes a segmented control that
 * flips this; default is "full" (all canonical concepts with degree ≥ 2).
 */
export type ViewMode = "papers-only" | "papers+datasets" | "full";

/** Concepts must have at least this many source papers to render. */
const CONCEPT_DEGREE_THRESHOLD = 2;

/** Per-concept-type accent colour. */
const CONCEPT_COLOR: Record<string, string> = {
  method: "#F97316",   // orange
  dataset: "#2563EB",  // blue
  task: "#7C3AED",     // purple
  concept: "#64748B",  // slate
};

/**
 * 8-color palette assigned to domains in order of first appearance, persisted
 * in `KGState.domainPalette` so the same domain keeps its colour across
 * sessions. Pastel-friendly, lifts off the dotted-grid background.
 */
const DOMAIN_PALETTE = [
  "#6366F1", // indigo
  "#14B8A6", // teal
  "#F59E0B", // amber
  "#A855F7", // violet
  "#22C55E", // green
  "#EC4899", // pink
  "#3B82F6", // blue
  "#EAB308", // yellow
] as const;

// Register the fcose layout plugin once per process. Cytoscape silently
// no-ops if registered twice with the same name.
let fcoseRegistered = false;
function ensureFcoseRegistered(): void {
  if (fcoseRegistered) return;
  try {
    (cytoscape as any).use(fcose);
    fcoseRegistered = true;
  } catch (e: any) {
    // cytoscape throws if a plugin name is already registered — that's fine.
    fcoseRegistered = true;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GraphCanvasOptions = {
  /** Owner document of the dialog (required so we mount inside the dialog window). */
  doc: Document;
  /** Pre-created HTMLElement that will host the cytoscape canvas. Must be in the DOM and sized. */
  container: HTMLElement;
  /** Called when the user selects/deselects a node (null on deselect). */
  onSelect: (itemKey: string | null) => void;
};

export type GraphCanvasHandle = {
  /** Tear down: detaches subscriptions and destroys the cytoscape instance. */
  destroy: () => void;
  /** Programmatically select & center on a node. */
  focusNode: (itemKey: string) => void;
  /** Returns the currently-selected node id, if any. */
  getSelectedKey: () => string | null;
  /** Re-runs the layout (e.g. after the host container resizes). */
  relayout: () => void;
  /** Fit the graph to the container. */
  fit: () => void;
  /** Zoom in/out by a factor (e.g. 1.2 or 1/1.2) around the viewport center. */
  zoomBy: (factor: number) => void;
  /** Apply a free-text search filter. */
  setSearchFilter: (query: string) => void;
  /** Restrict which edge types are visible. `null` shows all. */
  setEdgeTypeFilter: (visible: Set<string> | null) => void;
  /**
   * Switch the view mode. "papers-only" hides every concept node;
   * "papers+datasets" only shows dataset concepts; "full" shows all
   * canonical concepts that meet the degree threshold.
   */
  setViewMode: (mode: ViewMode) => void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function buildGraphCanvas(opts: GraphCanvasOptions): GraphCanvasHandle {
  ensureFcoseRegistered();

  const { container, onSelect } = opts;
  // The dialog window's `btoa` is the only way to get reliable base64 for
  // SVG data URIs from inside a Zotero subscript context.
  const winRef: any = opts.doc.defaultView || (globalThis as any);
  const btoaFn: (s: string) => string =
    typeof winRef.btoa === "function" ? winRef.btoa.bind(winRef) : (s: string) => s;
  fileLog(
    `GraphCanvas: build start connected=${container.isConnected}, size=${container.clientWidth}x${container.clientHeight}`,
  );

  const cy = cytoscape({
    container,
    elements: [],
    style: buildStylesheet(),
    minZoom: 0.2,
    maxZoom: 3,
    wheelSensitivity: 0.18,
    boxSelectionEnabled: false,
    autoungrabify: false,
    // Explicit panning/zooming flags — cytoscape defaults are true, but in
    // some host environments (Zotero's XHTML pipeline) the auto-detection
    // for pointer events has flagged background drag as "unsupported" and
    // silently disabled pan. Setting these to `true` overrides that.
    panningEnabled: true,
    userPanningEnabled: true,
    zoomingEnabled: true,
    userZoomingEnabled: true,
  });

  let selectedKey: string | null = null;
  let destroyed = false;

  function isAlive(): boolean {
    try {
      return !destroyed && !(winRef as any).closed && container.isConnected;
    } catch (_) {
      return !destroyed;
    }
  }

  // Wire interactions ↓ ----------------------------------------------------

  // Node tap → selection. The cy 'tap' fires for both clicks and taps and is
  // the recommended way to handle "primary activation" — 'click' is also
  // available but tap is consistent across desktop and touch.
  cy.on("tap", "node", (evt) => {
    if (!isAlive()) return;
    const id = evt.target.id();
    fileLog(`GraphCanvas: node tap id=${id}`);
    selectNode(id);
  });

  // Background tap clears selection.
  cy.on("tap", (evt) => {
    if (!isAlive()) return;
    if (evt.target === cy) {
      fileLog("GraphCanvas: background tap");
      selectNode(null);
    }
  });

  // (Earlier versions of this view installed a capture-phase `click`
  // listener as a workaround for cytoscape's `tap` event firing
  // unreliably on the first click in Zotero's XHTML pipeline. That
  // workaround was removed because the capture handler intercepts events
  // before cytoscape's native pointer pipeline can decide whether the
  // gesture is a click, a node-drag, or a background-pan — which broke
  // panning for the user. cytoscape's `tap` on its own has since proven
  // stable.)

  // Persist node position on drag-release. Cytoscape fires 'free' on the
  // node when the user lets go of a drag.
  cy.on("free", "node", (evt) => {
    if (!isAlive()) return;
    const node = evt.target;
    const pos = node.position();
    void kgStore.setLayoutPosition(node.id(), pos.x, pos.y).catch(() => {});
  });

  // ---- Hover tooltip ---------------------------------------------------
  // We can't trust cytoscape's mouseover/out events in the Zotero/Firefox
  // XUL host (same reason `tap` was unreliable above). So we install a
  // mousemove on the container and run our own hit test against nodes
  // first, edges second. The tooltip is a plain absolute-positioned div
  // appended to the container, styled inline so it doesn't depend on
  // the renderer's stylesheet leaking through.
  const tooltipEl = (opts.doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement);
  tooltipEl.setAttribute("data-ra-kg-tooltip", "1");
  tooltipEl.style.cssText = [
    "position: absolute",
    "z-index: 1000",
    "pointer-events: none",
    "max-width: 280px",
    "padding: 10px 12px",
    "background: rgba(255,255,255,0.98)",
    "border: 1px solid rgba(99,102,241,0.25)",
    "border-radius: 10px",
    "box-shadow: 0 8px 24px rgba(15,23,42,0.12)",
    "font-size: 12px",
    "line-height: 1.5",
    "color: #1f2937",
    "display: none",
    "transition: opacity 0.08s ease",
  ].join(";");
  // Make sure container is a positioning context (we set top/left in px).
  try {
    const cs = winRef.getComputedStyle?.(container);
    if (cs && cs.position === "static") container.style.position = "relative";
  } catch (_) {
    container.style.position = "relative";
  }
  container.appendChild(tooltipEl);

  let tooltipKind: "none" | "node" | "edge" = "none";
  let tooltipKey: string = "";

  function placeTooltip(x: number, y: number): void {
    // Offset slightly down-right so the cursor doesn't cover it.
    const offsetX = 14;
    const offsetY = 14;
    const cw = container.clientWidth || 0;
    const ch = container.clientHeight || 0;
    const tw = tooltipEl.offsetWidth || 240;
    const th = tooltipEl.offsetHeight || 80;
    let left = x + offsetX;
    let top = y + offsetY;
    if (left + tw > cw - 4) left = Math.max(4, x - offsetX - tw);
    if (top + th > ch - 4) top = Math.max(4, y - offsetY - th);
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function showNodeTooltip(nodeData: any, x: number, y: number): void {
    if (tooltipKind === "node" && tooltipKey === nodeData.id) {
      placeTooltip(x, y);
      return;
    }
    tooltipKind = "node";
    tooltipKey = nodeData.id;
    const statusLabel = (() => {
      switch (nodeData.status) {
        case "concept": return "概念节点";
        case "ready": return t("kg-status-ready") || "ready";
        case "analyzing": return t("kg-status-analyzing") || "analyzing";
        case "pending": return t("kg-status-pending") || "pending";
        case "error": return t("kg-status-error") || "error";
        default: return String(nodeData.status || "");
      }
    })();
    const title = String(nodeData.fullTitle || nodeData.title || "");
    const author = String(nodeData.firstAuthor || "");
    const year = String(nodeData.year || "");
    const domain = String(nodeData.domain || "");
    const kind = String(nodeData.kind || "");
    const lines: string[] = [];
    lines.push(
      `<div style="font-weight:700;font-size:12.5px;line-height:1.35;color:#0f172a;margin-bottom:4px;word-break:break-word;">${escapeHtml(title)}</div>`,
    );
    const meta = [author, year].filter(Boolean).join(" · ");
    if (meta) {
      lines.push(`<div style="color:#6b7280;font-size:11px;margin-bottom:6px;">${escapeHtml(meta)}</div>`);
    }
    const tagBits: string[] = [];
    if (domain) {
      tagBits.push(
        `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:#EEF2FF;color:#4338CA;font-size:10.5px;font-weight:600;">${escapeHtml(domain)}</span>`,
      );
    }
    if (kind === "concept") {
      tagBits.push(
        `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:#FFF7ED;color:#C2410C;font-size:10.5px;font-weight:600;">${escapeHtml(String(nodeData.conceptType || "concept"))}</span>`,
      );
    }
    tagBits.push(
      `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:${statusBgFor(nodeData.status)};color:${statusFgFor(nodeData.status)};font-size:10.5px;font-weight:600;">${escapeHtml(statusLabel)}</span>`,
    );
    lines.push(`<div style="display:flex;flex-wrap:wrap;gap:4px;">${tagBits.join("")}</div>`);
    tooltipEl.innerHTML = lines.join("");
    tooltipEl.style.display = "block";
    placeTooltip(x, y);
  }

  function showEdgeTooltip(edgeData: any, x: number, y: number): void {
    const k = edgeData.id;
    if (tooltipKind === "edge" && tooltipKey === k) {
      placeTooltip(x, y);
      return;
    }
    tooltipKind = "edge";
    tooltipKey = k;
    const typeLabel = String(edgeData.typeLabel || edgeData.type || "");
    const desc = String(edgeData.label || "");
    const rationale = String(edgeData.rationale || "");
    const evidence = Array.isArray(edgeData.evidence) ? edgeData.evidence.slice(0, 3) : [];
    const strength = typeof edgeData.strength === "number" ? edgeData.strength : 0;
    const strengthPct = Math.round(strength * 100);
    const lines: string[] = [];
    lines.push(
      `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;"><span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:#F5F3FF;color:#6D28D9;font-size:11px;font-weight:700;">${escapeHtml(typeLabel)}</span><span style="color:#9ca3af;font-size:10.5px;">${strengthPct}%</span></div>`,
    );
    if (desc) {
      lines.push(`<div style="color:#1f2937;font-size:12px;line-height:1.55;">${escapeHtml(desc)}</div>`);
    }
    if (rationale) {
      lines.push(`<div style="color:#4b5563;font-size:11.5px;line-height:1.5;margin-top:6px;">${escapeHtml(rationale)}</div>`);
    }
    if (evidence.length) {
      lines.push(`<div style="color:#6b7280;font-size:11px;line-height:1.45;margin-top:6px;">${evidence.map((v: string) => `- ${escapeHtml(String(v))}`).join("<br/>")}</div>`);
    }
    tooltipEl.innerHTML = lines.join("");
    tooltipEl.style.display = "block";
    placeTooltip(x, y);
  }

  function hideTooltip(): void {
    if (tooltipKind === "none") return;
    tooltipKind = "none";
    tooltipKey = "";
    tooltipEl.style.display = "none";
  }

  function hitTestAtPointer(clientX: number, clientY: number): {
    type: "node" | "edge" | "none";
    data: any;
    x: number;
    y: number;
  } {
    const rect = container.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const pan = cy.pan();
    const zoom = cy.zoom();
    const mx = (px - pan.x) / zoom;
    const my = (py - pan.y) / zoom;

    // Node hit (rectangular bound is fine for ellipse — slightly generous).
    let nodeHit: any = null;
    cy.nodes().forEach((n: any) => {
      if (nodeHit) return;
      const p = n.position();
      const w = (n.width() || 130) / 2;
      const h = (n.height() || 130) / 2;
      const dx = (mx - p.x) / w;
      const dy = (my - p.y) / h;
      // Use ellipse equation for a tighter, shape-matching hit test.
      if (dx * dx + dy * dy <= 1) nodeHit = n;
    });
    if (nodeHit) return { type: "node", data: nodeHit.data(), x: px, y: py };

    // Edge hit: approximate each edge as a straight segment from source
    // node center to target node center; threshold ~8px in screen space.
    const threshold = 8 / Math.max(zoom, 0.0001);
    let edgeHit: any = null;
    let edgeBest = Infinity;
    cy.edges().forEach((e: any) => {
      const s = e.source().position();
      const tg = e.target().position();
      const d = pointToSegmentDistance(mx, my, s.x, s.y, tg.x, tg.y);
      if (d <= threshold && d < edgeBest) {
        edgeBest = d;
        edgeHit = e;
      }
    });
    if (edgeHit) return { type: "edge", data: edgeHit.data(), x: px, y: py };

    return { type: "none", data: null, x: px, y: py };
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!isAlive()) return;
    try {
      const hit = hitTestAtPointer(e.clientX, e.clientY);
      if (hit.type === "node") showNodeTooltip(hit.data, hit.x, hit.y);
      else if (hit.type === "edge") showEdgeTooltip(hit.data, hit.x, hit.y);
      else hideTooltip();
    } catch (_) {
      hideTooltip();
    }
  };
  const onMouseLeave = () => { if (isAlive()) hideTooltip(); };
  container.addEventListener("mousemove", onMouseMove);
  container.addEventListener("mouseleave", onMouseLeave);

  // ---- Manual mouse interactions (click / pan / node-drag / wheel-zoom) ---
  // Cytoscape's native pointer pipeline is unreliable inside Zotero's XHTML
  // dialog: tap, free, and background pan all fail to fire under load. We
  // therefore drive the same behaviours ourselves on top of cytoscape's
  // model API (cy.pan, cy.zoom, node.position).
  type DragKind = "pending" | "pan" | "node";
  let drag: {
    kind: DragKind;
    nodeId: string | null;
    downClientX: number;
    downClientY: number;
    // Set when we leave the "pending" state and commit to a gesture.
    panX0?: number;
    panY0?: number;
    nodePosX0?: number;
    nodePosY0?: number;
  } | null = null;
  // Pixel slack before we treat a press as a drag rather than a click.
  const CLICK_SLOP = 4;

  const onMouseDown = (e: MouseEvent) => {
    if (!isAlive()) return;
    if (e.button !== 0) return; // left button only
    let hit;
    try { hit = hitTestAtPointer(e.clientX, e.clientY); } catch (_) { hit = null; }
    drag = {
      kind: "pending",
      nodeId: hit && hit.type === "node" ? String(hit.data.id) : null,
      downClientX: e.clientX,
      downClientY: e.clientY,
    };
    // Suppress text selection / drag-image flickering inside the canvas.
    e.preventDefault();
  };

  const onDocMouseMove = (e: MouseEvent) => {
    if (!isAlive()) return;
    if (!drag) return;
    const dx = e.clientX - drag.downClientX;
    const dy = e.clientY - drag.downClientY;

    if (drag.kind === "pending") {
      if (Math.abs(dx) < CLICK_SLOP && Math.abs(dy) < CLICK_SLOP) return;
      // Promote to a real drag.
      if (drag.nodeId) {
        const node = cy.getElementById(drag.nodeId);
        if (node && node.length) {
          const pos = node.position();
          drag.kind = "node";
          drag.nodePosX0 = pos.x;
          drag.nodePosY0 = pos.y;
        } else {
          drag = null;
          return;
        }
      } else {
        const pan = cy.pan();
        drag.kind = "pan";
        drag.panX0 = pan.x;
        drag.panY0 = pan.y;
      }
    }

    if (drag.kind === "pan" && drag.panX0 != null && drag.panY0 != null) {
      cy.pan({ x: drag.panX0 + dx, y: drag.panY0 + dy });
    } else if (drag.kind === "node" && drag.nodeId && drag.nodePosX0 != null && drag.nodePosY0 != null) {
      const z = cy.zoom() || 1;
      const node = cy.getElementById(drag.nodeId);
      if (node && node.length) {
        node.position({ x: drag.nodePosX0 + dx / z, y: drag.nodePosY0 + dy / z });
      }
    }
  };

  const onDocMouseUp = (e: MouseEvent) => {
    if (!isAlive()) return;
    if (!drag) return;
    const wasDrag = drag.kind === "pan" || drag.kind === "node";
    const nodeId = drag.nodeId;
    const dragKind = drag.kind;
    drag = null;
    if (!wasDrag) {
      // Treat as a click — select the node we pressed on (or clear).
      try { selectNode(nodeId); } catch (_) {}
      return;
    }
    if (dragKind === "node" && nodeId) {
      // Persist the dropped position so the layout survives a reload.
      const node = cy.getElementById(nodeId);
      if (node && node.length) {
        const p = node.position();
        void kgStore.setLayoutPosition(nodeId, p.x, p.y).catch(() => {});
      }
    }
    e.stopPropagation();
  };

  const onWheel = (e: WheelEvent) => {
    if (!isAlive()) return;
    // Zoom around the cursor.
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy_y = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(0.2, Math.min(3, (cy.zoom() || 1) * factor));
    try {
      cy.zoom({ level: next, renderedPosition: { x: cx, y: cy_y } } as any);
    } catch (_) {}
  };

  container.addEventListener("mousedown", onMouseDown);
  // Mouse-move / mouse-up are bound on the document so that a drag started
  // inside the canvas keeps tracking even when the cursor leaves the
  // container (typical "live drag" behaviour).
  const docRef = (opts.doc as any).defaultView?.document || opts.doc;
  docRef.addEventListener("mousemove", onDocMouseMove);
  docRef.addEventListener("mouseup", onDocMouseUp);
  container.addEventListener("wheel", onWheel, { passive: false });

  // View mode is local to this canvas instance; CurrentGraphView's segmented
  // control flips it via setViewMode.
  let viewMode: ViewMode = "full";

  // Initial render from current state.
  syncFromState(kgStore.getState(), { runLayout: "if-new-nodes" });
  fileLog(`GraphCanvas: initial sync nodes=${cy.nodes().length}, edges=${cy.edges().length}`);
  // Make sure whatever positions ended up in the model are visible inside the
  // viewport. Persisted positions from a previous (smaller-node) layout may
  // sit outside the new card extents otherwise.
  try { cy.fit(undefined, 60); } catch (_) {}

  // Keep in sync with store mutations.
  const unsubscribe = kgStore.subscribe((state) => {
    if (!isAlive()) return;
    syncFromState(state, { runLayout: "if-new-nodes" });
  });

  // Helpers ↓ -------------------------------------------------------------

  function selectNode(id: string | null): void {
    if (!isAlive()) return;
    if (selectedKey === id) return;
    selectedKey = id;
    cy.elements().removeClass("ra-selected ra-active ra-faded");
    if (id) {
      const node = cy.getElementById(id);
      if (node && node.length) {
        node.addClass("ra-selected");
        const neighborhood = node.closedNeighborhood();
        neighborhood.addClass("ra-active");
        cy.elements().not(neighborhood).addClass("ra-faded");
      }
      fileLog(`GraphCanvas: selectNode set id=${id}`);
    } else {
      fileLog("GraphCanvas: selectNode cleared");
    }
    try {
      onSelect(id);
    } catch (e: any) {
      fileLog("GraphCanvas: onSelect threw: " + (e?.message || e));
    }
  }

  /**
   * Reconcile the cytoscape graph with `state`. Cheap incremental:
   *   - adds new nodes (using saved positions when available)
   *   - removes nodes no longer in state
   *   - patches data on existing nodes (status, domain, ...)
   *   - blows away & re-adds all edges (small N, makes diff trivial)
   */
  function syncFromState(
    state: KGState,
    opts: { runLayout: "always" | "if-new-nodes" | "never" },
  ): void {
    if (!isAlive()) return;
    // Resolve the live domain → colour map, persisting any newly-seen domains.
    const domainColors = ensureDomainPalette(state);
    const visibleConcepts = (state.concepts || []).filter((c) => isVisibleConceptNode(c, viewMode));
    const stateKeys = new Set([...state.papers.map((p) => p.itemKey), ...visibleConcepts.map((c) => c.id)]);
    const visibleEdges = state.edges.filter((e) => isVisibleGraphEdge(e, stateKeys));
    const cyNodeIds = new Set(cy.nodes().map((n) => n.id()));

    // 1. Remove gone nodes. (Their edges go with them automatically.)
    cy.nodes().forEach((node) => {
      if (!stateKeys.has(node.id())) node.remove();
    });

    // 2. Add new nodes.
    const newlyAdded: string[] = [];
    for (const paper of state.papers) {
      if (!cyNodeIds.has(paper.itemKey)) {
        const saved = state.layout[paper.itemKey];
        cy.add({
          group: "nodes",
          data: nodeDataFromPaper(paper, btoaFn, domainColors),
          position: saved ? { x: saved.x, y: saved.y } : undefined,
        } as any);
        if (!saved) newlyAdded.push(paper.itemKey);
      }
    }
    for (const concept of visibleConcepts) {
      if (!cyNodeIds.has(concept.id)) {
        const saved = state.layout[concept.id];
        cy.add({
          group: "nodes",
          data: nodeDataFromConcept(concept, btoaFn),
          position: saved ? { x: saved.x, y: saved.y } : undefined,
        } as any);
        if (!saved) newlyAdded.push(concept.id);
      }
    }

    // 3. Patch data on existing nodes.
    for (const paper of state.papers) {
      const node = cy.getElementById(paper.itemKey);
      if (!node || node.length === 0) continue;
      const nextData = nodeDataFromPaper(paper, btoaFn, domainColors);
      for (const k of Object.keys(nextData)) {
        if (k === "id") continue;
        if (node.data(k) !== (nextData as any)[k]) {
          node.data(k, (nextData as any)[k]);
        }
      }
    }
    for (const concept of visibleConcepts) {
      const node = cy.getElementById(concept.id);
      if (!node || node.length === 0) continue;
      const nextData = nodeDataFromConcept(concept, btoaFn);
      for (const k of Object.keys(nextData)) {
        if (k === "id") continue;
        if (node.data(k) !== (nextData as any)[k]) node.data(k, (nextData as any)[k]);
      }
    }

    // 4. Re-sync edges. Compare by composite id `${from}->${to}` since the
    // store doesn't give edges their own keys.
    const desiredEdgeIds = new Set<string>();
    for (const e of visibleEdges) {
      desiredEdgeIds.add(edgeId(e));
    }
    cy.edges().forEach((edge) => {
      if (!desiredEdgeIds.has(edge.id())) edge.remove();
    });
    const presentEdgeIds = new Set(cy.edges().map((e) => e.id()));
    for (const e of visibleEdges) {
      const id = edgeId(e);
      if (!presentEdgeIds.has(id)) {
        cy.add({
          group: "edges",
          data: edgeDataFromKGEdge(e),
        } as any);
      }
    }

    // 5. If we just added nodes without saved positions, run a layout that
    // (a) uses fcose for nice force-directed placement, (b) keeps pinned
    // nodes (those with saved positions) in place.
    const shouldLayout =
      opts.runLayout === "always" ||
      (opts.runLayout === "if-new-nodes" && newlyAdded.length > 0);
    if (shouldLayout && cy.nodes().length > 0) {
      runLayout(newlyAdded);
    }
  }

  function runLayout(newNodeIds: string[] = [], force = false): void {
    if (!isAlive()) return;
    const nodes = cy.nodes();
    if (nodes.length === 0) return;

    // Try fcose first — it does force-directed layout that pulls high-degree
    // nodes towards the center and groups tightly-connected ones, which
    // dramatically reduces edge crossings vs a fixed ring.
    if (tryFcoseLayout(force ? "all" : newNodeIds.length > 0 ? "new" : "all")) {
      try { cy.resize(); cy.fit(undefined, 48); } catch (_) {}
      // Persist the positions fcose chose.
      cy.nodes().forEach((n) => {
        const p = n.position();
        void kgStore.setLayoutPosition(n.id(), p.x, p.y).catch(() => {});
      });
      return;
    }

    // ---- Fallback: deterministic ring layout. ----
    const idsToPlace = force
      ? new Set(nodes.map((n) => n.id()))
      : newNodeIds.length > 0
        ? new Set(newNodeIds)
        : new Set(nodes.map((n) => n.id()));
    const w = Math.max(container.clientWidth || 760, 320);
    const h = Math.max(container.clientHeight || 420, 260);
    const cx = w / 2;
    const cy0 = h / 2;
    const total = nodes.length;
    const NODE_DIAM = 145;
    const minRadius = total <= 1 ? 0 : NODE_DIAM / (2 * Math.sin(Math.PI / total));
    const maxRadius = Math.max(150, Math.min(w, h) / 2 - 100);
    const radius = Math.min(Math.max(minRadius * 1.1, 190), Math.max(maxRadius, minRadius * 1.1));

    fileLog(`GraphCanvas: manual ring layout nodes=${total}, place=${idsToPlace.size}, box=${w}x${h}`);

    nodes.forEach((node, idx) => {
      if (!idsToPlace.has(node.id())) return;
      const angle = total <= 1 ? 0 : (Math.PI * 2 * idx) / total - Math.PI / 2;
      const x = total <= 1 ? cx : cx + Math.cos(angle) * radius;
      const y = total <= 1 ? cy0 : cy0 + Math.sin(angle) * radius;
      node.position({ x, y });
      void kgStore.setLayoutPosition(node.id(), x, y).catch(() => {});
    });

    try {
      cy.resize();
      cy.fit(undefined, 42);
    } catch (e: any) {
      fileLog("GraphCanvas: fit failed: " + (e?.message || e));
    }
  }

  /**
   * Run cytoscape-fcose synchronously and return whether it succeeded.
   * fcose has been known to throw on some Zotero/Firefox/XUL environments;
   * if anything blows up we fall back to the ring layout.
   */
  function tryFcoseLayout(mode: "new" | "all"): boolean {
    if (!isAlive()) return false;
    try {
      const layout = cy.layout({
        name: "fcose",
        // Use animated:false because we mount before the canvas is laid out
        // and we want positions immediately available for cy.fit().
        animate: false,
        randomize: mode === "all",
        // fcose tuning for our small (5-30 node) graphs:
        nodeRepulsion: 9000,        // stronger repulsion → more breathing room
        idealEdgeLength: 150,       // target distance between connected nodes
        edgeElasticity: 0.45,
        gravity: 0.25,
        gravityRange: 3.8,
        numIter: 2500,
        nestingFactor: 0.1,
        nodeSeparation: 90,
        // Stop fcose from re-positioning nodes the user has already placed.
        fixedNodeConstraint:
          mode === "new"
            ? cy.nodes().toArray()
                .filter((n) => {
                  const saved = kgStore.getState().layout[n.id()];
                  return !!saved;
                })
                .map((n) => {
                  const p = n.position();
                  return { nodeId: n.id(), position: { x: p.x, y: p.y } };
                })
            : undefined,
        quality: "default",
        packComponents: true,
      } as any);
      layout.run();
      fileLog(`GraphCanvas: fcose layout completed (mode=${mode})`);
      return true;
    } catch (e: any) {
      fileLog("GraphCanvas: fcose threw, falling back to ring: " + (e?.message || e));
      return false;
    }
  }

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      drag = null;
      try {
        unsubscribe();
      } catch (_) {}
      try {
        (cy as any).removeAllListeners?.();
      } catch (_) {}
      try {
        container.removeEventListener("mousemove", onMouseMove);
        container.removeEventListener("mouseleave", onMouseLeave);
        container.removeEventListener("mousedown", onMouseDown);
        container.removeEventListener("wheel", onWheel as any);
        docRef.removeEventListener("mousemove", onDocMouseMove);
        docRef.removeEventListener("mouseup", onDocMouseUp);
      } catch (_) {}
      try {
        if (tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
      } catch (_) {}
      try {
        cy.destroy();
      } catch (_) {}
    },
    focusNode: (itemKey: string) => {
      if (!isAlive()) return;
      const node = cy.getElementById(itemKey);
      if (!node || node.length === 0) return;
      cy.animate({ center: { eles: node }, zoom: 1.4, duration: 360, easing: "ease-in-out" } as any);
      selectNode(itemKey);
    },
    getSelectedKey: () => selectedKey,
    relayout: () => { if (isAlive()) runLayout([], true); },
    fit: () => {
      if (!isAlive()) return;
      try { cy.fit(undefined, 48); } catch (_) {}
    },
    zoomBy: (factor: number) => {
      if (!isAlive()) return;
      try {
        const next = Math.max(0.2, Math.min(3, cy.zoom() * factor));
        const w = container.clientWidth || 0;
        const h = container.clientHeight || 0;
        cy.zoom({ level: next, renderedPosition: { x: w / 2, y: h / 2 } } as any);
      } catch (_) {}
    },
    setSearchFilter: (query: string) => {
      if (!isAlive()) return;
      try {
        applySearchFilter(query);
      } catch (e: any) {
        fileLog("GraphCanvas: setSearchFilter failed: " + (e?.message || e));
      }
    },
    setEdgeTypeFilter: (visible: Set<string> | null) => {
      if (!isAlive()) return;
      try {
        applyEdgeTypeFilter(visible);
      } catch (e: any) {
        fileLog("GraphCanvas: setEdgeTypeFilter failed: " + (e?.message || e));
      }
    },
    setViewMode: (mode: ViewMode) => {
      if (!isAlive()) return;
      if (mode === viewMode) return;
      viewMode = mode;
      try {
        syncFromState(kgStore.getState(), { runLayout: "if-new-nodes" });
      } catch (e: any) {
        fileLog("GraphCanvas: setViewMode failed: " + (e?.message || e));
      }
    },
  };

  /**
   * Hide edges whose `type` is not in `visible`. Pass null to show all.
   * Implemented as a CSS class so toggling is O(edges) without rebuilding.
   */
  function applyEdgeTypeFilter(visible: Set<string> | null): void {
    if (!isAlive()) return;
    cy.edges().removeClass("ra-type-hidden");
    if (!visible) return;
    cy.edges().forEach((e: any) => {
      const t = e.data("type") as string;
      if (!visible.has(t)) e.addClass("ra-type-hidden");
    });
  }

  /**
   * Highlight nodes whose searchable text contains `query` (case-insensitive),
   * fade everything else. Empty query clears the filter.
   *
   * Coexists with selection: a node can be both ra-selected and ra-active.
   * We deliberately don't touch ra-selected here so the user's click survives
   * a typed search.
   */
  function applySearchFilter(rawQuery: string): void {
    if (!isAlive()) return;
    const q = String(rawQuery || "").trim().toLowerCase();
    cy.elements().removeClass("ra-search-match ra-search-miss");
    if (!q) return;
    const stateMap = new Map<string, KGPaperState>();
    for (const p of kgStore.getState().papers) stateMap.set(p.itemKey, p);
    const conceptMap = new Map<string, KGConceptNode>();
    for (const c of kgStore.getState().concepts || []) conceptMap.set(c.id, c);

    const matched = new Set<string>();
    cy.nodes().forEach((n: any) => {
      const paper = stateMap.get(n.id());
      const concept = conceptMap.get(n.id());
      if (paper && paperMatchesQuery(paper, q)) matched.add(n.id());
      else if (concept && conceptMatchesQuery(concept, q)) matched.add(n.id());
    });

    cy.nodes().forEach((n: any) => {
      if (matched.has(n.id())) n.addClass("ra-search-match");
      else n.addClass("ra-search-miss");
    });
    cy.edges().forEach((e: any) => {
      const s = e.source().id();
      const t = e.target().id();
      // Fade an edge unless BOTH endpoints match — keeps the highlighted
      // sub-graph visually crisp.
      if (matched.has(s) && matched.has(t)) e.addClass("ra-search-match");
      else e.addClass("ra-search-miss");
    });
  }
}

/** Does the paper's searchable text contain `q` (already lowercased)? */
function paperMatchesQuery(p: KGPaperState, q: string): boolean {
  const fields: string[] = [];
  if (p.title) fields.push(p.title);
  if (p.metaLine) fields.push(p.metaLine);
  const s = p.summary;
  if (s) {
    if (s.domain) fields.push(s.domain);
    if (s.problem) fields.push(s.problem);
    if (s.contributions) fields.push(...s.contributions);
    if (s.methods) fields.push(...s.methods);
    if (s.conclusions) fields.push(...s.conclusions);
    if (s.keywords) fields.push(...s.keywords);
  }
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) return true;
  }
  return false;
}

function conceptMatchesQuery(c: KGConceptNode, q: string): boolean {
  const fields = [c.label, c.description, c.type, ...(c.aliases || [])].filter(Boolean) as string[];
  return fields.some((f) => f.toLowerCase().includes(q));
}

function isVisibleConceptNode(c: KGConceptNode, viewMode: ViewMode): boolean {
  if (viewMode === "papers-only") return false;
  if ((c.degree || 0) < CONCEPT_DEGREE_THRESHOLD) return false;
  if (viewMode === "papers+datasets") return c.type === "dataset";
  return true; // "full"
}

function isVisibleGraphEdge(e: KGEdge, visibleNodeIds: Set<string>): boolean {
  return visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to);
}

/**
 * Resolve a stable colour for every paper's domain. New domains get the next
 * unused palette colour and are persisted via `kgStore.setDomainColor`. The
 * returned map is built fresh every render so the visual layer never stalls
 * on a missing entry.
 */
function ensureDomainPalette(state: KGState): Record<string, string> {
  const palette: Record<string, string> = { ...(state.domainPalette || {}) };
  const used = new Set(Object.values(palette));
  let cursor = 0;
  for (const paper of state.papers) {
    const d = (paper.domain || paper.summary?.domain || "").trim();
    if (!d || palette[d]) continue;
    while (cursor < DOMAIN_PALETTE.length && used.has(DOMAIN_PALETTE[cursor])) cursor++;
    const colour =
      cursor < DOMAIN_PALETTE.length ? DOMAIN_PALETTE[cursor] : DOMAIN_PALETTE[hashFor(d)];
    palette[d] = colour;
    used.add(colour);
    void kgStore.setDomainColor(d, colour).catch(() => {});
  }
  return palette;
}

function hashFor(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return h % DOMAIN_PALETTE.length;
}

// ---------------------------------------------------------------------------
// Cytoscape data builders
// ---------------------------------------------------------------------------

function nodeDataFromPaper(
  p: KGPaperState,
  btoaFn: (s: string) => string,
  domainColors: Record<string, string>,
) {
  const year = (p.metaLine.match(/\d{4}/) || [""])[0];
  const firstAuthor = (p.metaLine.split(" \u00b7 ")[0] || "").replace(/ et al\.?$/i, "");
  const title = shortenTitle(p.title);
  const subline = year ? `${firstAuthor || ""} ${year ? `· ${year}` : ""}`.trim() : firstAuthor;
  const label = subline ? `${title}\n${subline}` : title;
  const domain = (p.domain || p.summary?.domain || "").trim();
  const domainColor = domainColors[domain] || DOMAIN_PALETTE[0];
  return {
    id: p.itemKey,
    kind: "paper",
    label,
    title,
    fullTitle: p.title,
    status: p.status,
    domain,
    domainColor,
    year,
    firstAuthor,
    bgImage: buildPaperBgImage(p.status, domainColor, btoaFn),
  };
}

function nodeDataFromConcept(c: KGConceptNode, btoaFn: (s: string) => string) {
  const label = c.canonicalLabel || c.label || c.id;
  const conceptColor = CONCEPT_COLOR[c.type] || CONCEPT_COLOR.concept;
  // Map degree ∈ [2, 8] linearly to size ∈ [88, 150]; clamp at edges.
  const degree = Math.max(c.degree || 0, CONCEPT_DEGREE_THRESHOLD);
  const sizeNorm = Math.min(1, (degree - CONCEPT_DEGREE_THRESHOLD) / 6);
  const conceptSize = Math.round(88 + sizeNorm * 62);
  return {
    id: c.id,
    kind: "concept",
    conceptType: c.type,
    conceptColor,
    conceptSize,
    degree,
    label: `${shortenTitle(label)}\n${conceptTypeLabel(c.type)} · ${degree}`,
    title: shortenTitle(label),
    fullTitle: label,
    status: "concept",
    domain: "",
    domainColor: "",
    year: "",
    firstAuthor: conceptTypeLabel(c.type),
    bgImage: buildConceptBgImage(c.type, btoaFn),
  };
}

// Cache one tiny SVG per (status, domainColor) so we don't re-encode every render.
const _bgImageCache = new Map<string, string>();

function buildPaperBgImage(
  status: KGPaperStatus,
  domainColor: string,
  btoaFn: (s: string) => string,
): string {
  const key = `paper|${status}|${domainColor}`;
  const cached = _bgImageCache.get(key);
  if (cached) return cached;
  const STATUS_DOT: Record<string, string> = {
    pending: "#94a3b8",
    analyzing: "#8B5CF6",
    ready: "#22c55e",
    error: "#ef4444",
  };
  const dot = STATUS_DOT[status] || STATUS_DOT.pending;
  // 200x120 card with: faint domain-tinted fill + a top accent bar in the
  // domain colour + status dot in the upper-right corner.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" preserveAspectRatio="none">' +
    `<rect x="0" y="0" width="200" height="120" rx="18" ry="18" fill="${domainColor}" fill-opacity="0.07"/>` +
    '<rect x="0" y="0" width="200" height="120" rx="18" ry="18" fill="#ffffff" fill-opacity="0.85"/>' +
    `<rect x="22" y="8" width="120" height="5" rx="2.5" ry="2.5" fill="${domainColor}"/>` +
    `<circle cx="178" cy="18" r="9" fill="${dot}" fill-opacity="0.18"/>` +
    `<circle cx="178" cy="18" r="5" fill="${dot}"/>` +
    "</svg>";
  let url: string;
  try {
    url = "data:image/svg+xml;base64," + btoaFn(svg);
  } catch (_) {
    url = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  _bgImageCache.set(key, url);
  return url;
}

function buildConceptBgImage(type: string, btoaFn: (s: string) => string): string {
  const key = `concept|${type}`;
  const cached = _bgImageCache.get(key);
  if (cached) return cached;
  const color = CONCEPT_COLOR[type] || CONCEPT_COLOR.concept;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" preserveAspectRatio="none">' +
    `<rect x="0" y="0" width="200" height="120" rx="22" ry="22" fill="${color}" fill-opacity="0.08"/>` +
    '<rect x="0" y="0" width="200" height="120" rx="22" ry="22" fill="#ffffff" fill-opacity="0.86"/>' +
    `<rect x="26" y="8" width="148" height="5" rx="2.5" ry="2.5" fill="${color}"/>` +
    `<circle cx="100" cy="30" r="15" fill="${color}" fill-opacity="0.16"/>` +
    `<circle cx="100" cy="30" r="7" fill="${color}"/>` +
    "</svg>";
  let url: string;
  try {
    url = "data:image/svg+xml;base64," + btoaFn(svg);
  } catch (_) {
    url = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  _bgImageCache.set(key, url);
  return url;
}

function conceptTypeLabel(type: string): string {
  switch (type) {
    case "method": return "方法";
    case "dataset": return "数据";
    case "task": return "任务";
    default: return "概念";
  }
}

function edgeDataFromKGEdge(e: KGEdge) {
  // The visible edge label combines type + role for paper→concept edges so
  // "method-link" alone doesn't carry all the meaning; the role distinguishes
  // proposed / used / extended / compared.
  const typeLabel = edgeTypeLabel(e.type, e.role);
  return {
    id: edgeId(e),
    source: e.from,
    target: e.to,
    type: e.type,
    role: e.role || "",
    label: e.rationale || e.label || typeLabel,
    typeLabel,
    strength: e.strength,
    evidence: e.evidence || [],
    rationale: e.rationale || "",
    sourceFields: e.sourceFields || [],
    matchedAliases: e.matchedAliases || [],
  };
}

/**
 * Localized short edge label. For paper→concept edges, role drives the
 * displayed phrase (e.g. method-link + role=proposed → "提出方法").
 */
function edgeTypeLabel(type: KGEdgeType, role?: string): string {
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
  try {
    const v = t(`kg-edge-${type}`);
    if (v && v !== `kg-edge-${type}`) return v;
  } catch (_) {}
  return type;
}

function edgeId(e: KGEdge): string {
  return `${e.from}->${e.to}::${e.type}`;
}

/** Truncate long titles so the cytoscape node label stays compact. */
function shortenTitle(title: string): string {
  if (!title) return "(untitled)";
  return title.length <= 48 ? title : title.slice(0, 45) + "\u2026";
}

// ---------------------------------------------------------------------------
// Hover-tooltip helpers
// ---------------------------------------------------------------------------

/** Minimal HTML escape used inside the inline-styled tooltip strings. */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pastel background pill color matching the node-status palette. */
function statusBgFor(status: string): string {
  switch (status) {
    case "concept": return "#FFEDD5";
    case "ready": return "#DCFCE7";
    case "analyzing": return "#EDE9FE";
    case "pending": return "#F1F5F9";
    case "error": return "#FEE2E2";
    default: return "#F1F5F9";
  }
}

function statusFgFor(status: string): string {
  switch (status) {
    case "concept": return "#C2410C";
    case "ready": return "#15803D";
    case "analyzing": return "#6D28D9";
    case "pending": return "#475569";
    case "error": return "#B91C1C";
    default: return "#475569";
  }
}

/** Shortest distance from a point to the segment (sx,sy)–(tx,ty). */
function pointToSegmentDistance(
  px: number,
  py: number,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): number {
  const dx = tx - sx;
  const dy = ty - sy;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - sx;
    const ey = py - sy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((px - sx) * dx + (py - sy) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = sx + t * dx;
  const cy = sy + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

function buildStylesheet(): any[] {
  // Status palette — used as the node *border* color so the inside stays
  // a clean white card a-la the design comp.
  const STATUS = {
    pending: "#94a3b8",
    analyzing: "#8B5CF6",
    ready: "#22c55e",
    error: "#ef4444",
  } as const;

  // v7 edge palette. Grouped by semantic family so adjacent rows in the
  // chip-row read as a group (citation/relation/contrast/data/concept).
  const EDGE: Record<KGEdgeType, string> = {
    cites: "#ec4899",                // pink — citation
    "similar-method": "#f59e0b",     // amber — method overlap
    contrasts: "#ef4444",            // red — deliberate contrast
    "uses-same-data": "#3b82f6",     // blue — data overlap
    "solves-same-problem": "#22c55e",// green — task overlap
    "method-link": "#94a3b8",         // slate — paper→method bridge (subdued)
    "dataset-link": "#94a3b8",        // slate — paper→dataset bridge
  };

  // Direction semantics: cites and every concept-link are directed.
  const DIRECTED: KGEdgeType[] = ["cites", "method-link", "dataset-link"];
  // Soft / background relations get dashed lines so the eye reads them as
  // weaker even at the same strength.
  const DASHED: KGEdgeType[] = ["contrasts", "method-link", "dataset-link"];

  const styles: any[] = [
    {
      selector: "node",
      css: {
        shape: "ellipse",
        "background-color": "#ffffff",
        "background-opacity": 1,
        label: "data(label)",
        color: "#1f2937",
        "font-size": 10.5 as any,
        "font-weight": 600 as any,
        "line-height": 1.3 as any,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 100 as any,
        "text-margin-y": 0 as any,
        width: 130 as any,
        height: 130 as any,
        "border-width": 2.5 as any,
        "border-color": STATUS.ready,
        "border-opacity": 1 as any,
        "overlay-opacity": 0 as any,
        "transition-property": "border-color, border-width, opacity, width, height",
        "transition-duration": 160 as any,
      },
    },
    // Paper nodes: domain colour drives the border. Status overrides on top.
    { selector: 'node[kind = "paper"]', css: { "border-color": "data(domainColor)" } },
    { selector: 'node[status = "pending"]', css: { "border-color": STATUS.pending } },
    { selector: 'node[status = "analyzing"]', css: { "border-color": STATUS.analyzing } },
    { selector: 'node[status = "error"]', css: { "border-color": STATUS.error } },

    // Concept nodes: type-specific colour, sized by `degree` (data-driven).
    {
      selector: 'node[kind = "concept"]',
      css: {
        shape: "roundrectangle",
        "border-color": "data(conceptColor)",
        "border-style": "dashed",
        "border-width": 2.5 as any,
        width: "data(conceptSize)" as any,
        height: ("mapData(conceptSize, 88, 150, 64, 110)") as any,
        "font-size": 10 as any,
      },
    },

    // Selected node: thick purple ring + soft purple glow.
    {
      selector: "node.ra-selected",
      css: {
        width: 142 as any,
        height: 142 as any,
        "border-width": 4 as any,
        "border-color": "#6366F1",
        "shadow-blur": 38 as any,
        "shadow-color": "#8B5CF6",
        "shadow-opacity": 0.5 as any,
        "shadow-offset-x": 0 as any,
        "shadow-offset-y": 0 as any,
        "z-index": 20 as any,
      },
    },

    // Non-neighbor nodes & edges fade when something is selected.
    {
      selector: "node.ra-faded",
      css: { opacity: 0.28 as any, "text-opacity": 0.4 as any },
    },
    {
      selector: "edge.ra-faded",
      css: { opacity: 0.12 as any, "text-opacity": 0 as any },
    },
    {
      selector: "edge.ra-active",
      css: { width: 3 as any, "z-index": 15 as any, opacity: 1 as any },
    },

    // Edge-type filter: hide entirely so they don't clutter the layout.
    { selector: "edge.ra-type-hidden", css: { display: "none" } },

    // Search filter: highlight matches, fade misses.
    { selector: "node.ra-search-miss", css: { opacity: 0.18 as any, "text-opacity": 0.3 as any } },
    {
      selector: "node.ra-search-match",
      css: { "border-width": 4 as any, "z-index": 18 as any },
    },
    { selector: "edge.ra-search-miss", css: { opacity: 0.08 as any, "text-opacity": 0 as any } },
    { selector: "edge.ra-search-match", css: { opacity: 1 as any, "z-index": 14 as any } },

    // Default edge styling. We use cytoscape's data-driven `mapData` so the
    // line width tracks `strength` linearly: weak relations (0.5) ~1.4px,
    // decisive relations (1.0) ~3.4px. Default arrow is OFF — only the
    // "directed" types below opt back in.
    {
      selector: "edge",
      css: {
        width: "mapData(strength, 0.5, 1, 1.4, 3.4)" as any,
        "line-color": "#94a3b8",
        "curve-style": "bezier",
        "control-point-step-size": 60 as any,
        "target-arrow-shape": "none",
        "target-arrow-color": "#94a3b8",
        "arrow-scale": 1.05 as any,
        opacity: 0.85 as any,
        // Use the localized short type label (e.g. "同领域") on canvas.
        label: "data(typeLabel)",
        "font-size": 10 as any,
        "font-weight": 700 as any,
        color: "#4b5563",
        "text-rotation": "autorotate",
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.95 as any,
        "text-background-padding": 4 as any,
        "text-background-shape": "roundrectangle",
        "text-border-width": 1 as any,
        "text-border-color": "#e0e7ff",
        "text-border-opacity": 1 as any,
        "text-events": "no",
      },
    },
  ];

  // Directed edges: switch the arrow head back on.
  for (const type of DIRECTED) {
    styles.push({
      selector: `edge[type = "${type}"]`,
      css: { "target-arrow-shape": "triangle-backcurve" },
    });
  }

  for (const [type, color] of Object.entries(EDGE) as [KGEdgeType, string][]) {
    styles.push({
      selector: `edge[type = "${type}"]`,
      css: {
        "line-color": color,
        "target-arrow-color": color,
        "text-border-color": color,
        color: color,
      },
    });
    if (DASHED.includes(type)) {
      styles.push({
        selector: `edge[type = "${type}"]`,
        css: { "line-style": "dashed", "line-dash-pattern": [6, 4] as any },
      });
    }
  }

  return styles;
}
