/**
 * OrganizerPage — guided collection organizer UI for the Wiki window.
 * Two modes:
 *   1. "AI 分析" — LLM reviews current collections, proposes improvements
 *   2. "手动整理" — drag-and-drop papers between collections
 */
import { config } from "../../../package.json";
import { createHTMLElement } from "../../sidebar/domUtils";
import { getLLMManager } from "../../modules/llm/LLMManager";
import {
  readAllCollections,
  readPaperBriefs,
  createCollection,
  moveItemToCollection,
  removeItemFromCollection,
  type CollectionInfo,
  type PaperBrief,
} from "./CollectionManager";
import {
  analyzeCollections,
  type OrganizationProposal,
  type MoveProposal,
  type NewCollectionProposal,
} from "./CollectionAnalyzer";

type OrganizerMode = "idle" | "loading" | "proposal" | "manual";

export function buildOrganizerPage(
  doc: Document,
  state: any,
  nav: any,
): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const ref = config.addonRef;

  const hero = createHTMLElement(doc, "section", `${config.addonRef}-wiki-section`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = "论文分类整理";
  const desc = createHTMLElement(doc, "p");
  desc.textContent = "让 AI 分析你的 Zotero 集合结构，提出优化建议；或手动拖拽论文到目标集合。所有变更需要你确认后才会执行。";
  hero.append(h, desc);

  const toolbar = createHTMLElement(doc, "div", `${ref}-org-toolbar`);
  const analyzeBtn = createHTMLElement(doc, "button", `${ref}-wiki-action-btn ${ref}-wiki-action-primary`);
  analyzeBtn.type = "button";
  analyzeBtn.textContent = "AI 分析分类";
  const manualBtn = createHTMLElement(doc, "button", `${ref}-wiki-action-btn`);
  manualBtn.type = "button";
  manualBtn.textContent = "手动整理";
  toolbar.append(analyzeBtn, manualBtn);
  hero.appendChild(toolbar);
  main.appendChild(hero);

  const contentArea = createHTMLElement(doc, "div", `${ref}-org-content`);
  main.appendChild(contentArea);

  let collections: CollectionInfo[] = [];
  let papers: PaperBrief[] = [];

  const setStatus = (msg: string) => {
    contentArea.textContent = "";
    const p = createHTMLElement(doc, "p", `${ref}-org-status`);
    p.textContent = msg;
    contentArea.appendChild(p);
  };

  const showProposal = (proposal: OrganizationProposal) => {
    contentArea.textContent = "";

    const summarySection = createHTMLElement(doc, "div", `${ref}-org-proposal-summary`);
    const summaryTitle = createHTMLElement(doc, "h3");
    summaryTitle.textContent = "AI 分析结果";
    const summaryText = createHTMLElement(doc, "p");
    summaryText.textContent = proposal.summary;
    summarySection.append(summaryTitle, summaryText);
    contentArea.appendChild(summarySection);

    if (proposal.newCollections.length === 0 && proposal.moves.length === 0) {
      const noChange = createHTMLElement(doc, "p", `${ref}-org-status`);
      noChange.textContent = "当前分类已经很好，无需调整。";
      contentArea.appendChild(noChange);
      return;
    }

    if (proposal.newCollections.length > 0) {
      const newSection = createHTMLElement(doc, "div", `${ref}-org-section`);
      const newTitle = createHTMLElement(doc, "h3");
      newTitle.textContent = `建议新建 ${proposal.newCollections.length} 个集合`;
      newSection.appendChild(newTitle);

      for (const nc of proposal.newCollections) {
        const card = createHTMLElement(doc, "div", `${ref}-org-card`);
        const name = createHTMLElement(doc, "strong");
        name.textContent = nc.name;
        if (nc.parentName) {
          const parent = createHTMLElement(doc, "span", `${ref}-org-parent-tag`);
          parent.textContent = `在 "${nc.parentName}" 下`;
          name.appendChild(parent);
        }
        const reason = createHTMLElement(doc, "p");
        reason.textContent = nc.reason;
        const count = createHTMLElement(doc, "span", `${ref}-org-count`);
        count.textContent = `${nc.paperKeys.length} 篇论文`;
        card.append(name, reason, count);
        newSection.appendChild(card);
      }
      contentArea.appendChild(newSection);
    }

    if (proposal.moves.length > 0) {
      const moveSection = createHTMLElement(doc, "div", `${ref}-org-section`);
      const moveTitle = createHTMLElement(doc, "h3");
      moveTitle.textContent = `建议移动 ${proposal.moves.length} 篇论文`;
      moveSection.appendChild(moveTitle);

      for (const mv of proposal.moves) {
        const card = createHTMLElement(doc, "div", `${ref}-org-card`);
        const title = createHTMLElement(doc, "strong");
        title.textContent = mv.title || mv.itemKey;
        const arrow = createHTMLElement(doc, "p", `${ref}-org-move-arrow`);
        arrow.textContent = `${mv.fromCollections.join(", ") || "未分类"} → ${mv.toCollection}`;
        const reason = createHTMLElement(doc, "p");
        reason.textContent = mv.reason;
        card.append(title, arrow, reason);
        moveSection.appendChild(card);
      }
      contentArea.appendChild(moveSection);
    }

    const actionBar = createHTMLElement(doc, "div", `${ref}-org-actions`);
    const acceptBtn = createHTMLElement(doc, "button", `${ref}-wiki-action-btn ${ref}-wiki-action-primary`);
    acceptBtn.type = "button";
    acceptBtn.textContent = "执行建议";
    const rejectBtn = createHTMLElement(doc, "button", `${ref}-wiki-action-btn`);
    rejectBtn.type = "button";
    rejectBtn.textContent = "不采纳";

    acceptBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = "执行中...";
      try {
        await applyProposal(proposal);
        setStatus("分类整理完成！Zotero 集合已更新。");
      } catch (e: any) {
        setStatus(`执行失败：${e?.message || e}`);
      }
    });

    rejectBtn.addEventListener("click", () => {
      contentArea.textContent = "";
      const p = createHTMLElement(doc, "p", `${ref}-org-status`);
      p.textContent = "已取消。你可以重新分析或切换到手动整理模式。";
      contentArea.appendChild(p);
    });

    actionBar.append(acceptBtn, rejectBtn);
    contentArea.appendChild(actionBar);
  };

  const showManualMode = () => {
    contentArea.textContent = "";

    const manualContainer = createHTMLElement(doc, "div", `${ref}-org-manual`);

    const collectionColumns = createHTMLElement(doc, "div", `${ref}-org-columns`);

    const unassignedCol = createHTMLElement(doc, "div", `${ref}-org-column`);
    unassignedCol.dataset.collectionId = "unassigned";
    const unassignedTitle = createHTMLElement(doc, "h3", `${ref}-org-column-title`);
    unassignedTitle.textContent = "未分类";
    unassignedCol.appendChild(unassignedTitle);

    const assignedKeys = new Set(
      collections.flatMap((c) => c.itemKeys)
    );

    const unassignedPapers = papers.filter((p) => !assignedKeys.has(p.itemKey));
    for (const paper of unassignedPapers) {
      unassignedCol.appendChild(buildPaperCard(doc, ref, paper));
    }
    collectionColumns.appendChild(unassignedCol);

    const topCollections = collections.filter((c) => !c.parentID);
    for (const col of topCollections) {
      const colEl = createHTMLElement(doc, "div", `${ref}-org-column`);
      colEl.dataset.collectionId = String(col.id);
      const colTitle = createHTMLElement(doc, "h3", `${ref}-org-column-title`);
      colTitle.textContent = `${col.name} (${col.itemKeys.length})`;
      colEl.appendChild(colTitle);

      for (const key of col.itemKeys) {
        const paper = papers.find((p) => p.itemKey === key);
        if (paper) colEl.appendChild(buildPaperCard(doc, ref, paper));
      }

      const childCollections = collections.filter((c) => c.parentID === col.id);
      for (const child of childCollections) {
        const childSection = createHTMLElement(doc, "div", `${ref}-org-child-section`);
        const childTitle = createHTMLElement(doc, "h4", `${ref}-org-child-title`);
        childTitle.textContent = `${child.name} (${child.itemKeys.length})`;
        childSection.appendChild(childTitle);
        for (const key of child.itemKeys) {
          const paper = papers.find((p) => p.itemKey === key);
          if (paper) childSection.appendChild(buildPaperCard(doc, ref, paper));
        }
        colEl.appendChild(childSection);
      }

      collectionColumns.appendChild(colEl);
    }

    manualContainer.appendChild(collectionColumns);

    setupDragAndDrop(manualContainer, collections, papers, (msg) => setStatus(msg));

    contentArea.appendChild(manualContainer);
  };

  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "分析中...";
    setStatus("正在读取 Zotero 集合和论文信息...");

    try {
      collections = await readAllCollections();
      const allKeys = collections.flatMap((c) => c.itemKeys);
      const uniqueKeys = [...new Set(allKeys)];

      if (uniqueKeys.length === 0) {
        const kgPapers = state.papers.filter((p: any) => p.status === "ready");
        for (const p of kgPapers) {
          if (!uniqueKeys.includes(p.itemKey)) uniqueKeys.push(p.itemKey);
        }
      }

      papers = await readPaperBriefs(uniqueKeys);

      for (const paper of papers) {
        const kgPaper = state.papers.find((p: any) => p.itemKey === paper.itemKey);
        if (kgPaper?.summary) {
          paper.domain = kgPaper.summary.domain || "";
          paper.problem = kgPaper.summary.problem || "";
        }
      }

      setStatus("正在调用 AI 分析分类结构...");
      const proposal = await analyzeCollections(collections, papers);
      showProposal(proposal);
    } catch (e: any) {
      setStatus(`分析失败：${e?.message || e}`);
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "AI 分析分类";
    }
  });

  manualBtn.addEventListener("click", async () => {
    manualBtn.disabled = true;
    manualBtn.textContent = "加载中...";
    try {
      collections = await readAllCollections();
      const allKeys = collections.flatMap((c) => c.itemKeys);
      const uniqueKeys = [...new Set(allKeys)];
      if (uniqueKeys.length === 0) {
        const kgPapers = state.papers.filter((p: any) => p.status === "ready");
        for (const p of kgPapers) {
          if (!uniqueKeys.includes(p.itemKey)) uniqueKeys.push(p.itemKey);
        }
      }
      papers = await readPaperBriefs(uniqueKeys);
      for (const paper of papers) {
        const kgPaper = state.papers.find((p: any) => p.itemKey === paper.itemKey);
        if (kgPaper?.summary) {
          paper.domain = kgPaper.summary.domain || "";
          paper.problem = kgPaper.summary.problem || "";
        }
      }
      showManualMode();
    } catch (e: any) {
      setStatus(`加载失败：${e?.message || e}`);
    } finally {
      manualBtn.disabled = false;
      manualBtn.textContent = "手动整理";
    }
  });

  return main;
}

function buildPaperCard(doc: Document, ref: string, paper: PaperBrief): HTMLElement {
  const card = createHTMLElement(doc, "div", `${ref}-org-paper-card`);
  card.draggable = true;
  card.dataset.itemKey = paper.itemKey;

  const title = createHTMLElement(doc, "span", `${ref}-org-paper-title`);
  title.textContent = paper.title || "（无标题）";
  title.title = paper.title;
  card.appendChild(title);

  if (paper.domain || paper.problem) {
    const meta = createHTMLElement(doc, "span", `${ref}-org-paper-meta`);
    const parts = [paper.authors, paper.year, paper.domain].filter(Boolean);
    meta.textContent = parts.join(" · ");
    card.appendChild(meta);
  }

  return card;
}

function setupDragAndDrop(
  container: HTMLElement,
  _collections: CollectionInfo[],
  _papers: PaperBrief[],
  setStatus: (msg: string) => void,
): void {
  let draggedKey: string | null = null;

  container.addEventListener("dragstart", (e: Event) => {
    const target = e.target as HTMLElement;
    const card = target.closest(`[data-item-key]`) as HTMLElement | null;
    if (!card) return;
    draggedKey = card.dataset.itemKey || null;
    card.classList.add("dragging");
    (e as DragEvent).dataTransfer?.setData("text/plain", draggedKey || "");
  });

  container.addEventListener("dragend", (e: Event) => {
    const target = e.target as HTMLElement;
    target.classList.remove("dragging");
    draggedKey = null;
    container.querySelectorAll(`.drag-over`).forEach((el) => el.classList.remove("drag-over"));
  });

  container.addEventListener("dragover", (e: Event) => {
    e.preventDefault();
    const col = (e.target as HTMLElement).closest(`[data-collection-id]`) as HTMLElement | null;
    if (col) col.classList.add("drag-over");
  });

  container.addEventListener("dragleave", (e: Event) => {
    const col = (e.target as HTMLElement).closest(`[data-collection-id]`) as HTMLElement | null;
    if (col) col.classList.remove("drag-over");
  });

  container.addEventListener("drop", async (e: Event) => {
    e.preventDefault();
    const de = e as DragEvent;
    const key = de.dataTransfer?.getData("text/plain") || draggedKey;
    if (!key) return;

    const col = (de.target as HTMLElement).closest(`[data-collection-id]`) as HTMLElement | null;
    if (!col) return;

    const colIdStr = col.dataset.collectionId;
    col.classList.remove("drag-over");

    const card = container.querySelector(`[data-item-key="${key}"]`) as HTMLElement | null;
    if (!card) return;

    if (colIdStr === "unassigned") {
      setStatus(`已将论文移出所有集合（需手动在 Zotero 中操作，拖拽仅做预览）`);
      return;
    }

    const colId = Number(colIdStr);
    if (isNaN(colId)) return;

    const colInfo = _collections.find((c) => c.id === colId);
    if (!colInfo) return;

    try {
      const ok = await moveItemToCollection(key, colId);
      if (ok) {
        setStatus(`已将论文移入 "${colInfo.name}"`);
        const columnTitle = col.querySelector(`[class*="column-title"]`) as HTMLElement | null;
        if (columnTitle) {
          const currentCount = col.querySelectorAll(`[data-item-key]`).length;
          columnTitle.textContent = `${colInfo.name} (${currentCount + 1})`;
        }
      } else {
        setStatus(`移动失败，请在 Zotero 中手动操作`);
      }
    } catch (err: any) {
      setStatus(`移动出错：${err?.message || err}`);
    }
  });
}

async function applyProposal(proposal: OrganizationProposal): Promise<void> {
  for (const nc of proposal.newCollections) {
    let parentID: number | undefined;
    if (nc.parentName) {
      const allCols = await readAllCollections();
      const parent = allCols.find((c) => c.name === nc.parentName);
      if (parent) parentID = parent.id;
    }
    const newID = await createCollection(nc.name, parentID);
    if (!newID) continue;

    for (const key of nc.paperKeys) {
      await moveItemToCollection(key, newID);
    }
  }

  for (const mv of proposal.moves) {
    const allCols = await readAllCollections();
    const target = allCols.find((c) => c.name === mv.toCollection);
    if (!target) continue;
    await moveItemToCollection(mv.itemKey, target.id);
  }
}
