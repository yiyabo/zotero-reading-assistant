import { config } from "../../package.json";
import { createHTMLElement, t } from "./domUtils";

export type ReferencePaper = {
  itemID: number;
  itemKey: string;
  title: string;
  metaLine: string;
};

export type ReferencePaperPickerHandle = {
  root: HTMLDivElement;
  focus: () => void;
  destroy: () => void;
};

export type ReferencePaperPickerOptions = {
  doc: Document;
  currentItemKey: string;
  maxSelected: number;
  getSelected: () => ReferencePaper[];
  onAdd: (paper: ReferencePaper) => void;
  onRemove: (itemKey: string) => void;
  onClose: () => void;
};

function resolveContextItem(item: any): any | null {
  if (!item || item.deleted) return null;
  try {
    if (item.isRegularItem?.()) return item;
    if (item.parentItem?.isRegularItem?.()) return item.parentItem;
    if (item.parentID) {
      const parent = Zotero.Items.get(item.parentID);
      if (parent?.isRegularItem?.()) return parent;
    }
    if (typeof item.isPDFAttachment === "function" && item.isPDFAttachment()) return item;
  } catch (_) {}
  const ct = String(item.attachmentContentType || "");
  if (ct.toLowerCase() === "application/pdf") return item;
  const path = String(item.attachmentPath || item.path || "");
  return path.toLowerCase().endsWith(".pdf") ? item : null;
}

export function referencePaperFromItem(item: any): ReferencePaper | null {
  const target = resolveContextItem(item);
  if (!target || target.id == null) return null;
  const itemKey = String(target.key || target.id || "");
  if (!itemKey) return null;
  return {
    itemID: Number(target.id),
    itemKey,
    title: String(target.getDisplayTitle?.() || target.getField?.("title") || t("reference-untitled")),
    metaLine: formatItemMeta(target),
  };
}

export async function getReferencePaperItem(paper: ReferencePaper): Promise<any | null> {
  try {
    const cached = (Zotero.Items as any).get?.(paper.itemID);
    if (cached && !cached.deleted) return resolveContextItem(cached);
  } catch (_) {}
  try {
    const libID = (Zotero as any).Libraries?.userLibraryID;
    const item = await (Zotero.Items as any).getByLibraryAndKeyAsync?.(libID, paper.itemKey);
    return resolveContextItem(item);
  } catch (_) {
    return null;
  }
}

export function buildReferencePaperPicker(opts: ReferencePaperPickerOptions): ReferencePaperPickerHandle {
  const { doc, maxSelected } = opts;
  const ref = config.addonRef;
  let searchTimer: any = null;
  let disposed = false;

  const root = createHTMLElement(doc, "div", `${ref}-reference-picker`);
  root.addEventListener("click", (e) => e.stopPropagation());

  const header = createHTMLElement(doc, "div", `${ref}-reference-picker-header`);
  const title = createHTMLElement(doc, "div", `${ref}-reference-picker-title`);
  title.textContent = t("reference-picker-title");
  const closeBtn = createHTMLElement(doc, "button", `${ref}-reference-picker-close`);
  closeBtn.type = "button";
  closeBtn.title = t("reference-picker-close");
  closeBtn.setAttribute("aria-label", t("reference-picker-close"));
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", opts.onClose);
  header.append(title, closeBtn);

  const selected = createHTMLElement(doc, "div", `${ref}-reference-selected`);
  const search = createHTMLElement(doc, "input", `${ref}-reference-search`);
  search.type = "text";
  search.placeholder = t("reference-search-placeholder");
  const resultLabel = createHTMLElement(doc, "div", `${ref}-reference-result-label`);
  const results = createHTMLElement(doc, "div", `${ref}-reference-results`);

  root.append(header, selected, search, resultLabel, results);

  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = search.value.trim();
      if (q) {
        void renderSearch(q);
      } else {
        void renderRecent();
      }
    }, 220);
  });

  renderSelected();
  void renderRecent();

  function renderSelected(): void {
    selected.replaceChildren();
    const papers = opts.getSelected();
    if (papers.length === 0) {
      const empty = createHTMLElement(doc, "div", `${ref}-reference-selected-empty`);
      empty.textContent = t("reference-selected-empty");
      selected.appendChild(empty);
      return;
    }
    for (const paper of papers) {
      const chip = createHTMLElement(doc, "button", `${ref}-reference-chip`);
      chip.type = "button";
      chip.title = t("reference-remove-paper");
      chip.innerHTML = `<span class="${ref}-reference-chip-title"></span><span class="${ref}-reference-chip-remove" aria-hidden="true">\u00d7</span>`;
      const chipTitle = chip.querySelector(`.${ref}-reference-chip-title`) as HTMLElement | null;
      if (chipTitle) chipTitle.textContent = paper.title;
      chip.addEventListener("click", () => {
        opts.onRemove(paper.itemKey);
        renderSelected();
        rerenderCurrentResults();
      });
      selected.appendChild(chip);
    }
  }

  function renderResultRows(papers: ReferencePaper[], label: string): void {
    if (disposed) return;
    resultLabel.textContent = label;
    results.replaceChildren();
    if (papers.length === 0) {
      const empty = createHTMLElement(doc, "div", `${ref}-reference-empty`);
      empty.textContent = t("reference-search-empty");
      results.appendChild(empty);
      return;
    }
    const seen = new Set<string>();
    for (const paper of papers) {
      if (seen.has(paper.itemKey)) continue;
      seen.add(paper.itemKey);
      results.appendChild(buildResultRow(paper));
    }
  }

  function buildResultRow(paper: ReferencePaper): HTMLButtonElement {
    const row = createHTMLElement(doc, "button", `${ref}-reference-result`);
    row.type = "button";
    const mark = createHTMLElement(doc, "span", `${ref}-reference-result-mark`);
    const body = createHTMLElement(doc, "span", `${ref}-reference-result-body`);
    const rowTitle = createHTMLElement(doc, "span", `${ref}-reference-result-title`);
    rowTitle.textContent = paper.title;
    const meta = createHTMLElement(doc, "span", `${ref}-reference-result-meta`);
    meta.textContent = paper.metaLine || paper.itemKey;
    body.append(rowTitle, meta);
    row.append(mark, body);

    const selectedPapers = opts.getSelected();
    const alreadySelected = selectedPapers.some((p) => p.itemKey === paper.itemKey);
    const isCurrent = paper.itemKey === opts.currentItemKey;
    const maxReached = selectedPapers.length >= maxSelected;

    if (isCurrent) {
      row.disabled = true;
      row.classList.add(`${ref}-reference-result-disabled`);
      mark.textContent = "\u2022";
      row.title = t("reference-current-paper");
    } else if (alreadySelected) {
      row.classList.add(`${ref}-reference-result-selected`);
      mark.textContent = "\u2713";
      row.title = t("reference-remove-paper");
      row.addEventListener("click", () => {
        opts.onRemove(paper.itemKey);
        renderSelected();
        rerenderCurrentResults();
      });
    } else if (maxReached) {
      row.disabled = true;
      row.classList.add(`${ref}-reference-result-disabled`);
      mark.textContent = "\u002b";
      row.title = t("reference-max-reached").replace("%N", String(maxSelected));
    } else {
      mark.textContent = "\u002b";
      row.title = t("reference-add-paper");
      row.addEventListener("click", () => {
        opts.onAdd(paper);
        renderSelected();
        rerenderCurrentResults();
      });
    }
    return row;
  }

  async function renderRecent(): Promise<void> {
    resultLabel.textContent = t("reference-loading");
    results.replaceChildren();
    const papers = await loadRecentPapers();
    renderResultRows(papers, t("reference-recent-label"));
  }

  async function renderSearch(query: string): Promise<void> {
    resultLabel.textContent = t("reference-loading");
    results.replaceChildren();
    const papers = await searchPapers(query);
    renderResultRows(papers, t("reference-results-label"));
  }

  function rerenderCurrentResults(): void {
    const q = search.value.trim();
    if (q) {
      void renderSearch(q);
    } else {
      void renderRecent();
    }
  }

  return {
    root,
    focus: () => {
      try { search.focus(); } catch (_) {}
    },
    destroy: () => {
      disposed = true;
      if (searchTimer) clearTimeout(searchTimer);
    },
  };
}

async function loadRecentPapers(): Promise<ReferencePaper[]> {
  try {
    const search = new (Zotero as any).Search();
    search.libraryID = (Zotero as any).Libraries?.userLibraryID;
    const ids: number[] = await search.search();
    const fetched = ids?.length ? await (Zotero.Items as any).getAsync(ids) : [];
    return dedupePapers(
      fetched
        .sort((a: any, b: any) => String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")))
        .map((item: any) => referencePaperFromItem(item))
        .filter((paper: ReferencePaper | null): paper is ReferencePaper => !!paper),
    ).slice(0, 24);
  } catch (e: any) {
    Zotero.debug("[RA] reference loadRecentPapers error: " + (e?.message || e));
    return [];
  }
}

async function searchPapers(query: string): Promise<ReferencePaper[]> {
  try {
    const search = new (Zotero as any).Search();
    search.libraryID = (Zotero as any).Libraries?.userLibraryID;
    search.addCondition("quicksearch-titleCreatorYear", "contains", query);
    const ids: number[] = await search.search();
    const fetched = ids?.length ? await (Zotero.Items as any).getAsync(ids) : [];
    return dedupePapers(
      fetched
        .map((item: any) => referencePaperFromItem(item))
        .filter((paper: ReferencePaper | null): paper is ReferencePaper => !!paper),
    ).slice(0, 40);
  } catch (e: any) {
    Zotero.debug("[RA] reference searchPapers error: " + (e?.message || e));
    return [];
  }
}

function dedupePapers(papers: ReferencePaper[]): ReferencePaper[] {
  const out: ReferencePaper[] = [];
  const seen = new Set<string>();
  for (const paper of papers) {
    if (seen.has(paper.itemKey)) continue;
    seen.add(paper.itemKey);
    out.push(paper);
  }
  return out;
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
