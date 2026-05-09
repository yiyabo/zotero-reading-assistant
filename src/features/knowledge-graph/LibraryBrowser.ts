/**
 * Library Browser — two-pane navigator for selecting papers to add to the KG.
 * ----------------------------------------------------------------------------
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [Search input — filters across the whole library]        │
 *   ├──────────────┬──────────────────────────────────────────┤
 *   │ Library      │ Items in selected collection            │
 *   │ ▼ My Library │ ☐ Paper 1                                │
 *   │   📂 LLM     │ ☑ Paper 2  (selected)                    │
 *   │   📂 AI蛋白  │ ☐ Paper 3                                │
 *   │   ...        │                                          │
 *   ├──────────────┴──────────────────────────────────────────┤
 *   │ N selected to add │ [Cancel] [Add N to Graph]           │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Notes:
 *   - The collection tree mirrors Zotero's nesting (recursive).
 *   - "All Papers" is a synthetic root entry that lists every regular item.
 *   - Items already in the persistent KG are shown but visually marked and
 *     can't be re-added.
 *   - The browser does NOT cap items: collections are typically <1k papers,
 *     so we render all of them. We virtualize lazily only if performance
 *     becomes an issue (TODO post-M5).
 *   - Filtering: when the search input is non-empty we run Zotero's
 *     quicksearch against the user's library and ignore the collection
 *     selection (otherwise filter behavior is confusing).
 */
import { config } from "../../../package.json";
import { createHTMLElement, t } from "../../sidebar/domUtils";
import { kgStore } from "./KGStore";

export type LibraryBrowserOptions = {
  doc: Document;
  /** Called when the user confirms with `commit=true`, with the items they picked. */
  onClose: (commit: boolean, addedItems: Zotero.Item[]) => void;
};

export type LibraryBrowserHandle = {
  root: HTMLElement;
  destroy: () => void;
};

/**
 * Internal "node" model for the collection tree. Top-level "All Papers" and
 * the special "Unfiled" entry are represented as nodes with sentinel ids.
 */
type TreeNode = {
  /**
   * - "all"       → all regular items in the user's library
   * - "unfiled"   → items not in any collection
   * - <number>    → real Zotero collection id, stored as string for DOM keys
   */
  id: string;
  kind: "all" | "unfiled" | "collection";
  name: string;
  collectionID?: number;
  children: TreeNode[];
  depth: number;
};

const SPECIAL_ALL_ID = "all";
const SPECIAL_UNFILED_ID = "unfiled";

export function buildLibraryBrowser(opts: LibraryBrowserOptions): LibraryBrowserHandle {
  const { doc, onClose } = opts;
  const ref = config.addonRef;

  // Internal selection state — independent of the persistent KGStore. Only on
  // commit do we hand items back; on cancel they're discarded.
  const pendingSelection = new Map<number, Zotero.Item>();

  let activeNodeId: string = SPECIAL_ALL_ID;
  let searchTimer: any = null;
  let lastSearchQuery = "";

  // ----- DOM scaffold -----
  const root = createHTMLElement(doc, "div", `${ref}-kg-browser`);

  const header = createHTMLElement(doc, "div", `${ref}-kg-browser-header`);
  const headerTitle = createHTMLElement(doc, "h2", `${ref}-kg-browser-title`);
  headerTitle.textContent = t("kg-browser-title");
  const searchInput = createHTMLElement(doc, "input", `${ref}-kg-search-input`);
  searchInput.type = "text";
  searchInput.placeholder = t("kg-search-placeholder");
  header.append(headerTitle, searchInput);

  const main = createHTMLElement(doc, "div", `${ref}-kg-browser-main`);
  const treePane = createHTMLElement(doc, "div", `${ref}-kg-browser-tree`);
  const itemsPane = createHTMLElement(doc, "div", `${ref}-kg-browser-items`);
  const itemsHeader = createHTMLElement(doc, "div", `${ref}-kg-browser-items-header`);
  const itemsList = createHTMLElement(doc, "div", `${ref}-kg-browser-items-list`);
  itemsPane.append(itemsHeader, itemsList);
  main.append(treePane, itemsPane);

  const footer = createHTMLElement(doc, "div", `${ref}-kg-browser-footer`);
  const footerHint = createHTMLElement(doc, "div", `${ref}-kg-browser-footer-hint`);
  const cancelBtn = createHTMLElement(doc, "button", `${ref}-kg-back-btn`);
  cancelBtn.type = "button";
  cancelBtn.textContent = t("kg-browser-cancel");
  cancelBtn.addEventListener("click", () => {
    onClose(false, []);
  });
  const addBtn = createHTMLElement(doc, "button", `${ref}-kg-generate-btn`);
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    onClose(true, [...pendingSelection.values()]);
  });
  footer.append(footerHint, cancelBtn, addBtn);

  root.append(header, main, footer);

  // ----- Behavior -----
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = searchInput.value.trim();
      lastSearchQuery = q;
      if (q) {
        renderSearchItems(q);
      } else {
        renderItemsForNode(findNode(treeRoot, activeNodeId));
      }
    }, 220);
  });

  // Build tree, render initial state.
  let treeRoot: TreeNode = buildTreeStub();
  renderFooter();
  buildTree()
    .then((tree) => {
      treeRoot = tree;
      renderTree();
      renderItemsForNode(findNode(treeRoot, activeNodeId));
    })
    .catch((e) => {
      Zotero.debug("[RA] LibraryBrowser buildTree error: " + (e?.message || e));
    });

  // -------------------------------------------------------------------------
  // Tree pane
  // -------------------------------------------------------------------------

  function renderTree(): void {
    treePane.replaceChildren();
    renderTreeNodes([treeRoot], treePane);
  }

  function renderTreeNodes(nodes: TreeNode[], host: HTMLElement): void {
    for (const node of nodes) {
      const row = createHTMLElement(doc, "button", `${ref}-kg-tree-row`);
      row.type = "button";
      row.style.paddingLeft = `${10 + node.depth * 14}px`;
      const icon = createHTMLElement(doc, "span", `${ref}-kg-tree-icon`);
      icon.textContent =
        node.kind === "all" ? "\u{1F4DA}" : node.kind === "unfiled" ? "\u{1F4DD}" : "\u{1F4C1}";
      const label = createHTMLElement(doc, "span", `${ref}-kg-tree-label`);
      label.textContent = node.name;
      row.append(icon, label);
      if (node.id === activeNodeId) {
        row.classList.add(`${ref}-kg-tree-row-active`);
      }
      row.addEventListener("click", () => {
        activeNodeId = node.id;
        // Active node click clears any active search so the user gets a clean
        // collection view (consistent with Zotero's main pane behavior).
        searchInput.value = "";
        lastSearchQuery = "";
        renderTree();
        renderItemsForNode(node);
      });
      host.appendChild(row);
      if (node.children.length > 0) {
        renderTreeNodes(node.children, host);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Items pane
  // -------------------------------------------------------------------------

  async function renderItemsForNode(node: TreeNode | null): Promise<void> {
    if (!node) {
      itemsList.replaceChildren();
      itemsHeader.textContent = "";
      return;
    }
    itemsHeader.textContent = `${node.name} \u00b7 ${t("kg-browser-loading")}`;
    itemsList.replaceChildren();
    let items: any[] = [];
    try {
      items = await loadItemsForNode(node);
    } catch (e: any) {
      Zotero.debug("[RA] LibraryBrowser loadItemsForNode error: " + (e?.message || e));
    }
    items = items.filter((it: any) => it.isRegularItem?.() && !it.deleted);
    items.sort((a, b) => String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")));
    itemsHeader.textContent = `${node.name} \u00b7 ${items.length} ${t("kg-browser-items-suffix")}`;
    if (items.length === 0) {
      const empty = createHTMLElement(doc, "div", `${ref}-kg-search-empty`);
      empty.textContent = t("kg-browser-collection-empty");
      itemsList.appendChild(empty);
      return;
    }
    for (const item of items) {
      itemsList.appendChild(buildItemRow(item));
    }
  }

  async function renderSearchItems(query: string): Promise<void> {
    itemsHeader.textContent = `${t("kg-search-results-label")} \u00b7 ${t("kg-browser-loading")}`;
    itemsList.replaceChildren();
    try {
      const search = new (Zotero as any).Search();
      search.libraryID = (Zotero as any).Libraries?.userLibraryID;
      search.addCondition("quicksearch-titleCreatorYear", "contains", query);
      const ids: number[] = await search.search();
      const fetched = ids?.length ? await (Zotero.Items as any).getAsync(ids) : [];
      const items = fetched
        .filter((it: any) => it.isRegularItem?.() && !it.deleted)
        .sort((a: any, b: any) =>
          String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")),
        );
      itemsHeader.textContent = `${t("kg-search-results-label")} \u00b7 ${items.length}`;
      if (items.length === 0) {
        const empty = createHTMLElement(doc, "div", `${ref}-kg-search-empty`);
        empty.textContent = t("kg-search-noresults");
        itemsList.appendChild(empty);
        return;
      }
      for (const item of items) {
        itemsList.appendChild(buildItemRow(item));
      }
    } catch (e: any) {
      Zotero.debug("[RA] LibraryBrowser search error: " + (e?.message || e));
      const err = createHTMLElement(doc, "div", `${ref}-kg-search-empty`);
      err.textContent = t("kg-search-error");
      itemsList.appendChild(err);
    }
  }

  function buildItemRow(item: any): HTMLElement {
    const row = createHTMLElement(doc, "button", `${ref}-kg-search-result`);
    row.type = "button";

    const checkEl = createHTMLElement(doc, "span", `${ref}-kg-search-result-check`);
    checkEl.setAttribute("aria-hidden", "true");

    const bodyEl = createHTMLElement(doc, "span", `${ref}-kg-search-result-body`);
    const titleEl = createHTMLElement(doc, "span", `${ref}-kg-search-result-title`);
    titleEl.textContent = String(item.getDisplayTitle?.() || t("kg-untitled"));
    const metaEl = createHTMLElement(doc, "span", `${ref}-kg-search-result-meta`);
    metaEl.textContent = formatItemMeta(item);
    bodyEl.append(titleEl, metaEl);

    row.append(checkEl, bodyEl);

    const itemKey = item.key;
    const inGraph = kgStore.hasPaper(itemKey);
    const inPending = pendingSelection.has(item.id);

    if (inGraph) {
      row.classList.add(`${ref}-kg-search-result-disabled`);
      row.disabled = true;
      checkEl.textContent = "\u2713";
      checkEl.classList.add(`${ref}-kg-search-result-check-existing`);
      row.title = t("kg-browser-already-in-graph");
    } else if (inPending) {
      row.classList.add(`${ref}-kg-search-result-selected`);
      checkEl.textContent = "\u2713";
      row.title = t("kg-row-selected-hint");
      row.addEventListener("click", () => {
        pendingSelection.delete(item.id);
        row.replaceWith(buildItemRow(item));
        renderFooter();
      });
    } else {
      checkEl.textContent = "\u002b";
      row.title = t("kg-row-add-hint");
      row.addEventListener("click", () => {
        pendingSelection.set(item.id, item);
        row.replaceWith(buildItemRow(item));
        renderFooter();
      });
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  function renderFooter(): void {
    const n = pendingSelection.size;
    if (n === 0) {
      footerHint.textContent = t("kg-browser-footer-hint-zero");
      addBtn.disabled = true;
    } else {
      footerHint.textContent = `${n} ${t("kg-browser-footer-hint-pending")}`;
      addBtn.disabled = false;
    }
    addBtn.textContent = n > 0 ? `${t("kg-browser-add-btn")} (${n})` : t("kg-browser-add-btn");
  }

  // -------------------------------------------------------------------------
  // Tree construction
  // -------------------------------------------------------------------------

  function buildTreeStub(): TreeNode {
    return {
      id: SPECIAL_ALL_ID,
      kind: "all",
      name: t("kg-browser-all-papers"),
      children: [],
      depth: 0,
    };
  }

  async function buildTree(): Promise<TreeNode> {
    const libID = (Zotero as any).Libraries?.userLibraryID;
    const root: TreeNode = {
      id: SPECIAL_ALL_ID,
      kind: "all",
      name: t("kg-browser-all-papers"),
      children: [],
      depth: 0,
    };

    let collections: any[] = [];
    try {
      collections = (Zotero as any).Collections?.getByLibrary?.(libID, true) || [];
    } catch (e: any) {
      Zotero.debug("[RA] LibraryBrowser getByLibrary error: " + (e?.message || e));
    }

    // Build id → node map, then attach children using parentID.
    const byId = new Map<number, TreeNode>();
    for (const col of collections) {
      byId.set(col.id, {
        id: String(col.id),
        kind: "collection",
        name: col.name || "(unnamed)",
        collectionID: col.id,
        children: [],
        depth: 0,
      });
    }
    for (const col of collections) {
      const node = byId.get(col.id);
      if (!node) continue;
      const parentID = col.parentID;
      if (parentID && byId.has(parentID)) {
        const parentNode = byId.get(parentID)!;
        node.depth = parentNode.depth + 1;
        parentNode.children.push(node);
      } else {
        node.depth = 1;
        root.children.push(node);
      }
    }

    // Sort children alphabetically (Zotero's locale-aware sort would be
    // nicer but `localeCompare` is good enough for the picker).
    sortRecursive(root);

    // Append "Unfiled" virtual node at the bottom for items in no collection.
    root.children.push({
      id: SPECIAL_UNFILED_ID,
      kind: "unfiled",
      name: t("kg-browser-unfiled"),
      children: [],
      depth: 1,
    });

    return root;
  }

  function sortRecursive(node: TreeNode): void {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) sortRecursive(child);
  }

  function findNode(root: TreeNode, id: string): TreeNode | null {
    if (root.id === id) return root;
    for (const c of root.children) {
      const n = findNode(c, id);
      if (n) return n;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Item loading per node kind
  // -------------------------------------------------------------------------

  async function loadItemsForNode(node: TreeNode): Promise<any[]> {
    if (node.kind === "all") {
      const search = new (Zotero as any).Search();
      search.libraryID = (Zotero as any).Libraries?.userLibraryID;
      const ids: number[] = await search.search();
      if (!ids?.length) return [];
      return await (Zotero.Items as any).getAsync(ids);
    }
    if (node.kind === "collection" && node.collectionID != null) {
      const col = (Zotero as any).Collections?.get?.(node.collectionID);
      if (!col) return [];
      // Recursive: include items from all descendant collections too.
      const allColIds = collectDescendantIds(node);
      const items: any[] = [];
      const seen = new Set<number>();
      for (const cid of allColIds) {
        const c = (Zotero as any).Collections?.get?.(cid);
        if (!c) continue;
        // First arg is `asIDs`: pass `false` to receive Item objects, not
        // numeric IDs. Second arg is `includeDeleted`.
        const childItems: any[] = c.getChildItems?.(false, false) || [];
        for (const it of childItems) {
          if (it && it.id != null && !seen.has(it.id)) {
            seen.add(it.id);
            items.push(it);
          }
        }
      }
      return items;
    }
    if (node.kind === "unfiled") {
      // Items with no collection memberships. Use Zotero's Search "unfiled".
      try {
        const search = new (Zotero as any).Search();
        search.libraryID = (Zotero as any).Libraries?.userLibraryID;
        search.addCondition("unfiled", "true");
        const ids: number[] = await search.search();
        if (!ids?.length) return [];
        return await (Zotero.Items as any).getAsync(ids);
      } catch (e: any) {
        Zotero.debug("[RA] LibraryBrowser unfiled search error: " + (e?.message || e));
        return [];
      }
    }
    return [];
  }

  function collectDescendantIds(node: TreeNode): number[] {
    const ids: number[] = [];
    if (node.collectionID != null) ids.push(node.collectionID);
    for (const c of node.children) ids.push(...collectDescendantIds(c));
    return ids;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  return {
    root,
    destroy: () => {
      if (searchTimer) clearTimeout(searchTimer);
    },
  };
}

function formatItemMeta(item: any): string {
  const parts: string[] = [];
  const creators = item.getCreators?.() || [];
  if (creators.length > 0) {
    const first = creators[0];
    const name = first.lastName || first.name || "";
    if (name) parts.push(creators.length > 1 ? `${name} et al.` : name);
  }
  const year = String(item.getField?.("date") || "").match(/\d{4}/)?.[0];
  if (year) parts.push(year);
  const venue =
    item.getField?.("publicationTitle") ||
    item.getField?.("conferenceName") ||
    item.getField?.("publisher") ||
    "";
  if (venue) parts.push(String(venue));
  return parts.join(" \u00b7 ");
}
