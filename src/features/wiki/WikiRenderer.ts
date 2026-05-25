import { config } from "../../../package.json";
import { createHTMLElement } from "../../sidebar/domUtils";
import { injectSharedStyles } from "../../shared/design-tokens";
import { renderMarkdown } from "../../modules/utils/markdown";
import { getLLMManager } from "../../modules/llm/LLMManager";
import { getPref, PrefKeys } from "../../modules/utils/prefs";
import {
  KGConceptNode,
  KGConceptType,
  KGEdge,
  KGPaperState,
  KGState,
  ReferencedItem,
  kgStore,
} from "../knowledge-graph/KGStore";
import { hasPdfAttachment, openItemInReader, openItemInZotero } from "./ZoteroOpeners";
import { wikiStore } from "./WikiStore";
import { WikiRoute } from "./WikiWindow";
import { buildOrganizerPage } from "../collection-organizer/OrganizerPage";

type WikiRuntime = {
  route: WikiRoute;
  destroy: () => void;
};

type WikiNavigate = {
  home: () => void;
  paper: (itemKey: string) => void;
  concept: (conceptId: string) => void;
  domain: (domain: string) => void;
  organizer: () => void;
  back: () => void;
};

function setRuntime(win: Window, runtime: WikiRuntime): void {
  const prev = (win as any).__raWikiRuntime as WikiRuntime | undefined;
  try { prev?.destroy(); } catch (_) {}
  (win as any).__raWikiRuntime = runtime;
}

function normalizeLabel(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "").trim();
}

function pageIdForPaper(itemKey: string): string {
  return `paper:${itemKey}`;
}

function pageIdForConcept(conceptId: string): string {
  return `concept-page:${conceptId}`;
}

function pageIdForDomain(domain: string): string {
  return `domain:${domain}`;
}

function domainOf(paper: KGPaperState): string {
  return paper.domain || paper.summary?.domain || "未分类";
}

function conceptTypeLabel(type: KGConceptType | undefined): string {
  switch (type) {
    case "method": return "方法";
    case "dataset": return "数据集";
    case "task": return "任务";
    default: return "概念";
  }
}

function edgeLabel(edge: KGEdge): string {
  if (edge.type === "method-link") return edge.role ? `方法：${roleLabel(edge.role)}` : "方法关联";
  if (edge.type === "dataset-link") return edge.role ? `数据集：${roleLabel(edge.role)}` : "数据集关联";
  const labels: Record<string, string> = {
    cites: "引用",
    "similar-method": "方法相似",
    contrasts: "形成对比",
    "uses-same-data": "使用相同数据",
    "solves-same-problem": "解决同类问题",
  };
  return labels[edge.type] || edge.type;
}

function roleLabel(role: string | undefined): string {
  switch (role) {
    case "proposed": return "提出";
    case "introduced": return "发布";
    case "extended": return "发展";
    case "compared-baseline": return "对比 baseline";
    case "cited-only": return "仅引用";
    case "used": return "使用";
    default: return role || "关联";
  }
}

function conceptLabel(concept: KGConceptNode | undefined, fallback: string): string {
  return concept?.canonicalLabel || concept?.label || fallback;
}

function nodeLabel(state: KGState, id: string): string {
  if (id.startsWith("concept:")) return conceptLabel(state.concepts.find((x) => x.id === id), id);
  return state.papers.find((p) => p.itemKey === id)?.title || id;
}

function findConceptByName(state: KGState, name: string, type?: KGConceptType): KGConceptNode | undefined {
  const norm = normalizeLabel(name);
  if (!norm) return undefined;
  return state.concepts.find((concept) => {
    if (type && concept.type !== type) return false;
    const candidates = [concept.canonicalLabel, concept.label, ...(concept.aliases || [])];
    return candidates.some((candidate) => normalizeLabel(candidate || "") === norm);
  });
}

function paperByKey(state: KGState, itemKey: string): KGPaperState | undefined {
  return state.papers.find((paper) => paper.itemKey === itemKey);
}

function buildSection(doc: Document, title: string): HTMLElement {
  const section = createHTMLElement(doc, "section", `${config.addonRef}-wiki-section`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = title;
  section.appendChild(h);
  return section;
}

function buildChip(doc: Document, label: string): HTMLElement {
  const chip = createHTMLElement(doc, "span", `${config.addonRef}-wiki-chip`);
  chip.textContent = label;
  return chip;
}

function buildLinkButton(doc: Document, label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-link-btn${className ? ` ${className}` : ""}`);
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function appendList(parent: HTMLElement, items: string[] | undefined, emptyText = "暂无"): void {
  if (!items || items.length === 0) {
    const empty = createHTMLElement(parent.ownerDocument, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = emptyText;
    parent.appendChild(empty);
    return;
  }
  const ul = createHTMLElement(parent.ownerDocument, "ul", `${config.addonRef}-wiki-list`);
  for (const item of items) {
    const li = createHTMLElement(parent.ownerDocument, "li");
    li.textContent = item;
    ul.appendChild(li);
  }
  parent.appendChild(ul);
}

function appendConceptList(
  parent: HTMLElement,
  state: KGState,
  labels: string[] | undefined,
  type: KGConceptType,
  nav: WikiNavigate,
  emptyText = "暂无",
): void {
  const doc = parent.ownerDocument;
  if (!labels || labels.length === 0) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = emptyText;
    parent.appendChild(empty);
    return;
  }
  const wrap = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-list`);
  for (const label of labels) {
    const concept = findConceptByName(state, label, type);
    if (concept) {
      wrap.appendChild(buildLinkButton(doc, label, () => nav.concept(concept.id), `${config.addonRef}-wiki-link-chip`));
    } else {
      wrap.appendChild(buildChip(doc, label));
    }
  }
  parent.appendChild(wrap);
}

function conceptSourcePapers(state: KGState, concept: KGConceptNode): KGPaperState[] {
  return (concept.sourcePaperKeys || [])
    .map((key) => paperByKey(state, key))
    .filter(Boolean) as KGPaperState[];
}

function conceptIncidentEdges(state: KGState, concept: KGConceptNode): KGEdge[] {
  return state.edges.filter((edge) => edge.from === concept.id || edge.to === concept.id);
}

function domainConcepts(state: KGState, domain: string): KGConceptNode[] {
  const domainPaperKeys = new Set(state.papers.filter((p) => domainOf(p) === domain).map((p) => p.itemKey));
  return state.concepts
    .filter((concept) => (concept.sourcePaperKeys || []).some((key) => domainPaperKeys.has(key)))
    .sort((a, b) => (b.degree || 0) - (a.degree || 0));
}

function domainCounts(state: KGState): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const paper of state.papers) counts.set(domainOf(paper), (counts.get(domainOf(paper)) || 0) + 1);
  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function buildHeader(doc: Document, nav: WikiNavigate, route: WikiRoute, state: KGState, canGoBack: boolean): HTMLElement {
  const header = createHTMLElement(doc, "header", `${config.addonRef}-wiki-header`);
  const left = createHTMLElement(doc, "div", `${config.addonRef}-wiki-brand`);
  const logo = createHTMLElement(doc, "img", `${config.addonRef}-wiki-logo`);
  logo.setAttribute("src", `chrome://${config.addonRef}/content/icons/sidebar-logo.svg`);
  logo.setAttribute("alt", "");
  logo.onerror = () => { (logo as HTMLElement).style.display = "none"; };
  const titles = createHTMLElement(doc, "div");
  const title = createHTMLElement(doc, "h1");
  title.textContent = "知识 Wiki";
  titles.append(title);
  left.append(logo, titles);

  const navRow = createHTMLElement(doc, "div", `${config.addonRef}-wiki-nav-row`);

  if (canGoBack) {
    const backBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-back-btn`);
    backBtn.type = "button";
    backBtn.textContent = "← 返回";
    backBtn.addEventListener("click", nav.back);
    navRow.appendChild(backBtn);
  }

  const crumbs = createHTMLElement(doc, "nav", `${config.addonRef}-wiki-breadcrumb`);
  const homeCrumb = createHTMLElement(doc, "button", `${config.addonRef}-wiki-crumb`);
  homeCrumb.type = "button";
  homeCrumb.textContent = "首页";
  homeCrumb.addEventListener("click", nav.home);
  crumbs.appendChild(homeCrumb);

  if (route.type === "paper") {
    const sep1 = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-sep`);
    sep1.textContent = "›";
    crumbs.appendChild(sep1);
    const paper = state.papers.find((p) => p.itemKey === route.itemKey);
    const paperCrumb = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-current`);
    paperCrumb.textContent = paper?.title ? (paper.title.length > 40 ? paper.title.slice(0, 37) + "..." : paper.title) : "论文";
    crumbs.appendChild(paperCrumb);
  } else if (route.type === "concept") {
    const sep1 = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-sep`);
    sep1.textContent = "›";
    crumbs.appendChild(sep1);
    const concept = state.concepts.find((c) => c.id === route.conceptId);
    const conceptCrumb = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-current`);
    conceptCrumb.textContent = concept ? conceptLabel(concept, concept.id) : "概念";
    crumbs.appendChild(conceptCrumb);
  } else if (route.type === "domain") {
    const sep1 = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-sep`);
    sep1.textContent = "›";
    crumbs.appendChild(sep1);
    const domainCrumb = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-current`);
    domainCrumb.textContent = route.domain;
    crumbs.appendChild(domainCrumb);
  } else if (route.type === "organizer") {
    const sep1 = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-sep`);
    sep1.textContent = "›";
    crumbs.appendChild(sep1);
    const orgCrumb = createHTMLElement(doc, "span", `${config.addonRef}-wiki-crumb-current`);
    orgCrumb.textContent = "论文整理";
    crumbs.appendChild(orgCrumb);
  }

  navRow.appendChild(crumbs);

  const home = createHTMLElement(doc, "button", `${config.addonRef}-wiki-home-btn`);
  home.type = "button";
  home.textContent = "首页";
  home.addEventListener("click", nav.home);
  header.append(left, navRow, home);
  return header;
}

function buildSidebar(doc: Document, state: KGState, route: WikiRoute, nav: WikiNavigate): HTMLElement {
  const side = createHTMLElement(doc, "aside", `${config.addonRef}-wiki-sidebar`);

  const addGroup = (titleText: string, content: HTMLElement) => {
    const group = createHTMLElement(doc, "div", `${config.addonRef}-wiki-side-group`);
    const title = createHTMLElement(doc, "h2");
    title.textContent = titleText;
    group.append(title, content);
    side.appendChild(group);
  };

  const searchInput = createHTMLElement(doc, "input", `${config.addonRef}-wiki-search`);
  searchInput.type = "search";
  searchInput.placeholder = "搜索论文...";
  side.appendChild(searchInput);

  const paperList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-paper-list`);
  const allPapers = [...state.papers].sort((a, b) => {
    if (a.status === "ready" && b.status !== "ready") return -1;
    if (a.status !== "ready" && b.status === "ready") return 1;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  const renderPaperList = (filter: string) => {
    paperList.textContent = "";
    const lowerFilter = filter.toLowerCase();
    const filtered = lowerFilter ? allPapers.filter((p) => (p.title || "").toLowerCase().includes(lowerFilter)) : allPapers;
    const shown = filtered.slice(0, 120);
    for (const paper of shown) {
      const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-paper-btn`);
      btn.type = "button";
      if (route.type === "paper" && route.itemKey === paper.itemKey) btn.classList.add("active");
      const name = createHTMLElement(doc, "span", `${config.addonRef}-wiki-paper-title`);
      name.textContent = paper.title || "（无标题）";
      const meta = createHTMLElement(doc, "span", `${config.addonRef}-wiki-paper-meta`);
      meta.textContent = domainOf(paper) || paper.metaLine || paper.status;
      btn.append(name, meta);
      btn.addEventListener("click", () => nav.paper(paper.itemKey));
      paperList.appendChild(btn);
    }
    if (filtered.length > shown.length) {
      const hint = createHTMLElement(doc, "p", `${config.addonRef}-wiki-trunc-hint`);
      hint.textContent = `显示 ${shown.length} / ${filtered.length}`;
      paperList.appendChild(hint);
    }
  };
  renderPaperList("");

  searchInput.addEventListener("input", () => renderPaperList(searchInput.value));

  addGroup("论文页面", paperList);

  const conceptList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-mini-list`);
  const allConcepts = state.concepts.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0));
  const shownConcepts = allConcepts.slice(0, 50);
  for (const concept of shownConcepts) {
    const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-mini-btn`);
    btn.type = "button";
    if (route.type === "concept" && route.conceptId === concept.id) btn.classList.add("active");
    btn.textContent = `${conceptLabel(concept, concept.id)} · ${conceptTypeLabel(concept.type)}`;
    btn.addEventListener("click", () => nav.concept(concept.id));
    conceptList.appendChild(btn);
  }
  if (allConcepts.length > shownConcepts.length) {
    const hint = createHTMLElement(doc, "p", `${config.addonRef}-wiki-trunc-hint`);
    hint.textContent = `显示 ${shownConcepts.length} / ${allConcepts.length}`;
    conceptList.appendChild(hint);
  }
  addGroup("方法 / 数据集", conceptList);

  const domains = createHTMLElement(doc, "div", `${config.addonRef}-wiki-mini-list`);
  for (const item of domainCounts(state)) {
    const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-mini-btn`);
    btn.type = "button";
    if (route.type === "domain" && route.domain === item.domain) btn.classList.add("active");
    btn.textContent = `${item.domain} · ${item.count}`;
    btn.addEventListener("click", () => nav.domain(item.domain));
    domains.appendChild(btn);
  }
  addGroup("研究方向", domains);

  const orgBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-organizer-btn`);
  orgBtn.type = "button";
  orgBtn.textContent = "📑 论文分类整理";
  orgBtn.addEventListener("click", nav.organizer);
  side.appendChild(orgBtn);

  return side;
}

function buildHomePage(doc: Document, state: KGState, nav: WikiNavigate): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const hero = createHTMLElement(doc, "section", `${config.addonRef}-wiki-hero`);
  const title = createHTMLElement(doc, "h2");
  title.textContent = "你的个人科研知识库";
  const desc = createHTMLElement(doc, "p");
  desc.textContent = "Wiki 页面由知识图谱状态自动派生；你可以在论文、方法、数据集和领域页面下补充自己的 Markdown 备注。";
  hero.append(title, desc);
  const stats = createHTMLElement(doc, "div", `${config.addonRef}-wiki-stats`);
  const ready = state.papers.filter((p) => p.status === "ready").length;
  for (const [label, value] of [["论文", state.papers.length], ["已分析", ready], ["概念", state.concepts.length], ["关系", state.edges.length]] as const) {
    const card = createHTMLElement(doc, "div", `${config.addonRef}-wiki-stat`);
    const v = createHTMLElement(doc, "strong");
    v.textContent = String(value);
    const l = createHTMLElement(doc, "span");
    l.textContent = label;
    card.append(v, l);
    stats.appendChild(card);
  }
  hero.appendChild(stats);
  main.appendChild(hero);

  const concepts = buildSection(doc, "核心方法与数据集");
  const conceptGrid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
  for (const concept of state.concepts.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 12)) {
    const card = createHTMLElement(doc, "button", `${config.addonRef}-wiki-card`);
    card.type = "button";
    const h = createHTMLElement(doc, "h3");
    h.textContent = conceptLabel(concept, concept.id);
    const p = createHTMLElement(doc, "p");
    p.textContent = `${conceptTypeLabel(concept.type)} · ${concept.degree || concept.sourcePaperKeys?.length || 0} 篇论文提及`;
    card.append(h, p);
    card.addEventListener("click", () => nav.concept(concept.id));
    conceptGrid.appendChild(card);
  }
  concepts.appendChild(conceptGrid);
  main.appendChild(concepts);

  const domains = buildSection(doc, "研究方向");
  const domainGrid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
  for (const item of domainCounts(state).slice(0, 12)) {
    const card = createHTMLElement(doc, "button", `${config.addonRef}-wiki-card`);
    card.type = "button";
    const h = createHTMLElement(doc, "h3");
    h.textContent = item.domain;
    const p = createHTMLElement(doc, "p");
    p.textContent = `${item.count} 篇论文 · ${domainConcepts(state, item.domain).length} 个概念`;
    card.append(h, p);
    card.addEventListener("click", () => nav.domain(item.domain));
    domainGrid.appendChild(card);
  }
  domains.appendChild(domainGrid);
  main.appendChild(domains);

  const recent = buildSection(doc, "最近论文");
  const readyPapers = state.papers.filter((p) => p.status === "ready").slice(0, 12);
  const grid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
  for (const paper of readyPapers) {
    const card = createHTMLElement(doc, "button", `${config.addonRef}-wiki-card`);
    card.type = "button";
    const h = createHTMLElement(doc, "h3");
    h.textContent = paper.title;
    const p = createHTMLElement(doc, "p");
    p.textContent = paper.summary?.problem || paper.metaLine || "打开查看 Wiki 页面";
    card.append(h, p);
    card.addEventListener("click", () => nav.paper(paper.itemKey));
    grid.appendChild(card);
  }
  recent.appendChild(grid);
  main.appendChild(recent);
  return main;
}

function buildReferencedItems(
  doc: Document,
  title: string,
  items: ReferencedItem[] | undefined,
  state: KGState,
  nav: WikiNavigate,
  type: KGConceptType,
): HTMLElement {
  const section = buildSection(doc, title);
  if (!items || items.length === 0) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = "暂无";
    section.appendChild(empty);
    return section;
  }
  const list = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-items`);
  for (const item of items) {
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-item`);
    const top = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-top`);
    top.append(buildChip(doc, roleLabel(item.role)));
    const concept = findConceptByName(state, item.name, type);
    if (concept) top.appendChild(buildLinkButton(doc, item.name, () => nav.concept(concept.id)));
    else {
      const name = createHTMLElement(doc, "strong");
      name.textContent = item.name || "未命名";
      top.appendChild(name);
    }
    row.appendChild(top);
    if (item.evidence) {
      const ev = createHTMLElement(doc, "p");
      ev.textContent = item.evidence;
      row.appendChild(ev);
    }
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
}

function buildRelations(doc: Document, state: KGState, paper: KGPaperState, nav: WikiNavigate): HTMLElement {
  const section = buildSection(doc, "相关连接");
  const edges = state.edges.filter((e) => e.from === paper.itemKey || e.to === paper.itemKey).slice(0, 36);
  if (edges.length === 0) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = "暂无关系；等待关系分析完成后会自动出现。";
    section.appendChild(empty);
    return section;
  }
  const list = createHTMLElement(doc, "div", `${config.addonRef}-wiki-rel-list`);
  for (const edge of edges) {
    const otherId = edge.from === paper.itemKey ? edge.to : edge.from;
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-rel-row`);
    row.appendChild(buildChip(doc, edgeLabel(edge)));
    if (otherId.startsWith("concept:")) row.appendChild(buildLinkButton(doc, nodeLabel(state, otherId), () => nav.concept(otherId)));
    else row.appendChild(buildLinkButton(doc, nodeLabel(state, otherId), () => nav.paper(otherId)));
    if (edge.evidence?.[0]) {
      const ev = createHTMLElement(doc, "p");
      ev.textContent = edge.evidence[0];
      row.appendChild(ev);
    }
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
}

function buildNotes(doc: Document, pageId: string): HTMLElement {
  const section = buildSection(doc, "我的备注");
  const note = wikiStore.getNote(pageId);
  const status = createHTMLElement(doc, "div", `${config.addonRef}-wiki-note-status`);
  status.textContent = note?.updatedAt ? `上次保存：${new Date(note.updatedAt).toLocaleString()}` : "尚未保存备注";

  const tabBar = createHTMLElement(doc, "div", `${config.addonRef}-wiki-note-tabs`);
  const editTab = createHTMLElement(doc, "button", `${config.addonRef}-wiki-note-tab`);
  editTab.type = "button";
  editTab.textContent = "编辑";
  const previewTab = createHTMLElement(doc, "button", `${config.addonRef}-wiki-note-tab`);
  previewTab.type = "button";
  previewTab.textContent = "预览";
  tabBar.append(editTab, previewTab);

  const aiBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-note-ai-btn`);
  aiBtn.type = "button";
  aiBtn.textContent = "AI 整理";
  aiBtn.title = "用 AI 整理和优化备注内容的 Markdown 格式";
  tabBar.appendChild(aiBtn);

  const textarea = createHTMLElement(doc, "textarea", `${config.addonRef}-wiki-note-input`);
  textarea.placeholder = "在这里写你的 Markdown 备注、想法、复现实验记录或后续阅读计划...";
  textarea.value = note?.body || "";

  const preview = createHTMLElement(doc, "div", `${config.addonRef}-wiki-note-preview`);
  preview.style.display = "none";

  let editing = true;

  const renderPreview = () => {
    const body = textarea.value.trim();
    if (!body) {
      preview.innerHTML = `<p class="${config.addonRef}-wiki-empty">还没有备注内容。</p>`;
    } else {
      preview.innerHTML = renderMarkdown(body);
    }
  };

  const switchToEdit = () => {
    editing = true;
    editTab.classList.add("active");
    previewTab.classList.remove("active");
    textarea.style.display = "";
    preview.style.display = "none";
  };

  const switchToPreview = () => {
    editing = false;
    previewTab.classList.add("active");
    editTab.classList.remove("active");
    textarea.style.display = "none";
    preview.style.display = "";
    renderPreview();
  };

  editTab.classList.add("active");
  editTab.addEventListener("click", switchToEdit);
  previewTab.addEventListener("click", switchToPreview);

  let aiRunning = false;
  aiBtn.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body || aiRunning) return;

    if (!doc.defaultView?.confirm("AI 将重写当前备注内容，继续？")) return;

    const llm = getLLMManager();
    if (!llm.isReady()) {
      status.textContent = "请先配置 LLM API";
      return;
    }

    aiRunning = true;
    aiBtn.disabled = true;
    aiBtn.textContent = "整理中...";
    status.textContent = "AI 正在整理内容...";

    textarea.readOnly = true;

    const systemPrompt = `你是一个 Markdown 内容整理助手。用户会给你一段从 AI 对话中复制出来的内容，请你：

1. 去掉多余的对话格式（如"用户："、"助手："、"> "引用块嵌套等冗余前缀）
2. 保留有价值的知识内容、要点、分析
3. 用清晰的 Markdown 格式重新组织（合理使用标题、列表、加粗、代码块等）
4. 数学公式必须用标准定界符包裹：行内公式用 $...$，独立公式用 $$...$$。例如 $E=mc^2$ 或 $$\\int_0^1 f(x)dx$$。不要把公式放在行内代码反引号里。
5. 输出整理后的纯 Markdown，不要加任何额外说明或"以下是整理后的内容"之类的开头`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: body },
    ];

    let result = "";

    llm.chat(messages, {
      onStart: () => {
        textarea.value = "";
      },
      onToken: (token: string) => {
        result += token;
        textarea.value = result;
      },
      onComplete: (fullText: string) => {
        textarea.value = fullText;
        textarea.readOnly = false;
        aiRunning = false;
        aiBtn.disabled = false;
        aiBtn.textContent = "AI 整理";
        status.textContent = "AI 整理完成，正在保存...";
        void wikiStore.setNote(pageId, fullText).then(() => {
          status.textContent = `已保存：${new Date().toLocaleString()}`;
        });
      },
      onError: (error: Error) => {
        textarea.readOnly = false;
        aiRunning = false;
        aiBtn.disabled = false;
        aiBtn.textContent = "AI 整理";
        status.textContent = `整理失败：${error.message}`;
      },
    });
  });

  let timer: number | undefined;
  textarea.addEventListener("input", () => {
    if (aiRunning) return;
    status.textContent = "保存中...";
    const host = doc.defaultView || window;
    if (timer) host.clearTimeout(timer);
    timer = host.setTimeout(() => {
      void wikiStore.setNote(pageId, textarea.value).then(() => {
        status.textContent = `已保存：${new Date().toLocaleString()}`;
      }).catch((e: any) => {
        status.textContent = `保存失败：${e?.message || e}`;
      });
    }, 450);
  });

  section.append(status, tabBar, textarea, preview);
  return section;
}

function buildDataAnalysisSection(doc: Document, paper: KGPaperState): HTMLElement {
  const section = buildSection(doc, "数据分析");
  const details = paper.summary?.datasetDetails;
  const flow = paper.summary?.dataFlow;

  if ((!details || details.length === 0) && (!flow || flow.length === 0)) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = "暂无数据分析信息";
    section.appendChild(empty);
    return section;
  }

  if (details && details.length > 0) {
    const subTitle = createHTMLElement(doc, "h3");
    subTitle.textContent = "数据集详情";
    subTitle.style.cssText = "margin:0 0 var(--ra-space-3);font-size:var(--ra-fs-base);color:var(--ra-purple-800);";
    section.appendChild(subTitle);

    const grid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
    for (const ds of details) {
      const card = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card`);
      const h = createHTMLElement(doc, "h3");
      h.textContent = ds.name;
      card.appendChild(h);
      if (ds.description) {
        const p = createHTMLElement(doc, "p");
        p.textContent = ds.description;
        card.appendChild(p);
      }
      const tags = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-row`);
      tags.style.cssText = "margin-top:6px;";
      for (const [label, value] of [["规模", ds.scale], ["格式", ds.format], ["来源", ds.source]] as const) {
        if (value) {
          const chip = createHTMLElement(doc, "span", `${config.addonRef}-wiki-chip`);
          chip.textContent = `${label}: ${value}`;
          tags.appendChild(chip);
        }
      }
      if (tags.childElementCount > 0) card.appendChild(tags);
      grid.appendChild(card);
    }
    section.appendChild(grid);
  }

  if (flow && flow.length > 0) {
    const subTitle2 = createHTMLElement(doc, "h3");
    subTitle2.textContent = "数据流";
    subTitle2.style.cssText = "margin:var(--ra-space-4) 0 var(--ra-space-3);font-size:var(--ra-fs-base);color:var(--ra-purple-800);";
    section.appendChild(subTitle2);

    const pipeline = createHTMLElement(doc, "div", `${config.addonRef}-wiki-pipeline`);
    for (const step of flow) {
      const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-pipeline-step`);
      const num = createHTMLElement(doc, "span", `${config.addonRef}-wiki-pipeline-num`);
      num.textContent = String(step.step);
      const body = createHTMLElement(doc, "div");
      const name = createHTMLElement(doc, "strong");
      name.textContent = step.name;
      body.appendChild(name);
      if (step.description) {
        const desc = createHTMLElement(doc, "p");
        desc.textContent = step.description;
        body.appendChild(desc);
      }
      row.append(num, body);
      pipeline.appendChild(row);
    }
    section.appendChild(pipeline);
  }

  return section;
}

function buildPipelineSection(doc: Document, paper: KGPaperState): HTMLElement {
  const section = buildSection(doc, "方法 Pipeline");
  const steps = paper.summary?.pipeline;
  if (!steps || steps.length === 0) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = "暂无 pipeline 拆解";
    section.appendChild(empty);
    return section;
  }
  const pipeline = createHTMLElement(doc, "div", `${config.addonRef}-wiki-pipeline`);
  for (const step of steps) {
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-pipeline-step`);
    const num = createHTMLElement(doc, "span", `${config.addonRef}-wiki-pipeline-num`);
    num.textContent = String(step.step);
    const body = createHTMLElement(doc, "div");
    const name = createHTMLElement(doc, "strong");
    name.textContent = step.name;
    body.appendChild(name);
    if (step.description) {
      const desc = createHTMLElement(doc, "p");
      desc.textContent = step.description;
      body.appendChild(desc);
    }
    row.append(num, body);
    pipeline.appendChild(row);
  }
  section.appendChild(pipeline);
  return section;
}

async function generatePipelineDiagram(paper: KGPaperState): Promise<string> {
  const steps = (paper.summary?.pipeline || []).map((s) => `${s.name}`).join(" → ");
  const title = paper.title || "research paper";
  const prompt = steps
    ? `A research paper style pipeline flowchart for "${title}". Arrange the following stages left to right with beautiful icons and English labels: ${steps}. Gradient arrows connecting stages. White background, flat design with subtle 3D feel, Nature Methods journal style, colorful but clean. 16:9 landscape.`
    : `A research paper style pipeline flowchart for "${title}". Arrange multiple stages left to right with beautiful icons and English labels. Gradient arrows connecting stages. White background, flat design with subtle 3D feel, Nature Methods journal style, colorful but clean. 16:9 landscape.`;

  const imageApiKey = String(getPref(PrefKeys.IMAGE_API_KEY) || "").trim();
  const imageApi = String(getPref(PrefKeys.IMAGE_API) || "").trim();
  const imageModel = String(getPref(PrefKeys.IMAGE_MODEL) || "").trim();
  const imageSize = String(getPref(PrefKeys.IMAGE_SIZE) || "1536x1024").trim() || "1536x1024";
  if (!imageApiKey || !imageApi || !imageModel) {
    throw new Error("请先在设置中配置图片生成 API Key、Base URL 和模型");
  }
  const imageApiBase = imageApi.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
  const resp = await fetch(`${imageApiBase}/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${imageApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      n: 1,
      size: imageSize,
      response_format: "url",
    }),
  });

  if (!resp.ok) throw new Error(`Image API error: ${resp.status}`);
  const data = await resp.json() as any;
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error("No image URL in response");
  return url;
}

function buildDiagramSection(doc: Document, paper: KGPaperState): HTMLElement {
  const section = buildSection(doc, "流程图");
  const actions = createHTMLElement(doc, "div", `${config.addonRef}-wiki-actions`);

  const img = doc.createElement("img") as HTMLImageElement;
  img.style.cssText = "max-width:100%;border-radius:var(--ra-radius-card);margin-top:var(--ra-space-3);display:none;";

  if (paper.summary?.pipelineDiagramUrl) {
    img.src = paper.summary.pipelineDiagramUrl;
    img.style.display = "";
  }

  const genBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-action-btn ${config.addonRef}-wiki-action-primary`);
  genBtn.type = "button";
  genBtn.textContent = paper.summary?.pipelineDiagramUrl ? "重新生成流程图" : "生成流程图";
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genBtn.textContent = "生成中...";
    try {
      const url = await generatePipelineDiagram(paper);
      img.src = url;
      img.style.display = "";
      genBtn.textContent = "重新生成流程图";
      if (paper.summary) paper.summary.pipelineDiagramUrl = url;
      await kgStore.updatePaper(paper.itemKey, { summary: { ...paper.summary, pipelineDiagramUrl: url } });
    } catch (e: any) {
      genBtn.textContent = `生成失败：${e?.message || e}`;
      setTimeout(() => {
        genBtn.textContent = paper.summary?.pipelineDiagramUrl ? "重新生成流程图" : "生成流程图";
      }, 3000);
    } finally {
      genBtn.disabled = false;
    }
  });

  actions.appendChild(genBtn);

  const copyBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-action-btn`);
  copyBtn.type = "button";
  copyBtn.textContent = "复制图片";
  copyBtn.style.display = paper.summary?.pipelineDiagramUrl ? "" : "none";
  copyBtn.addEventListener("click", async () => {
    if (!img.src) return;
    copyBtn.disabled = true;
    copyBtn.textContent = "复制中...";
    try {
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      await (doc.defaultView as any)?.navigator.clipboard.write([
        new (doc.defaultView as any).ClipboardItem({ [blob.type]: blob }),
      ]);
      copyBtn.textContent = "已复制";
      setTimeout(() => { copyBtn.textContent = "复制图片"; }, 1500);
    } catch (_) {
      copyBtn.textContent = "复制失败";
      setTimeout(() => { copyBtn.textContent = "复制图片"; }, 1500);
    } finally {
      copyBtn.disabled = false;
    }
  });

  const saveBtn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-action-btn`);
  saveBtn.type = "button";
  saveBtn.textContent = "保存图片";
  saveBtn.style.display = paper.summary?.pipelineDiagramUrl ? "" : "none";
  saveBtn.addEventListener("click", async () => {
    if (!img.src) return;
    try {
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = doc.createElement("a") as HTMLAnchorElement;
      a.href = url;
      a.download = `${(paper.title || "pipeline").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")}_pipeline.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (_) {}
  });

  actions.append(copyBtn, saveBtn);

  const genBtnHandler = genBtn.onclick;
  genBtn.addEventListener("click", () => {
    setTimeout(() => {
      if (img.src && img.style.display !== "none") {
        copyBtn.style.display = "";
        saveBtn.style.display = "";
      }
    }, 500);
  });

  section.append(actions, img);
  return section;
}

function buildPaperPage(doc: Document, state: KGState, paper: KGPaperState, nav: WikiNavigate): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const article = createHTMLElement(doc, "article", `${config.addonRef}-wiki-paper`);
  const heading = createHTMLElement(doc, "section", `${config.addonRef}-wiki-paper-head`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = paper.title || "（无标题）";
  const meta = createHTMLElement(doc, "p");
  meta.textContent = paper.metaLine || paper.status;
  const chips = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-row`);
  chips.append(buildChip(doc, paper.status));
  const domainBtn = buildLinkButton(doc, domainOf(paper), () => nav.domain(domainOf(paper)), `${config.addonRef}-wiki-link-chip`);
  chips.appendChild(domainBtn);
  const actions = createHTMLElement(doc, "div", `${config.addonRef}-wiki-actions`);
  const openBtn = buildLinkButton(doc, "↗ 打开 Zotero", () => openItemInZotero(paper.itemID), `${config.addonRef}-wiki-action-btn`);
  actions.appendChild(openBtn);
  if (hasPdfAttachment(paper.itemID)) {
    const readPdfBtn = buildLinkButton(doc, "📖 阅读 PDF", () => void openItemInReader(paper.itemID), `${config.addonRef}-wiki-action-btn ${config.addonRef}-wiki-action-primary`);
    actions.appendChild(readPdfBtn);
  }
  heading.append(h, meta, chips, actions);
  article.appendChild(heading);

  const overview = buildSection(doc, "概览");
  const problem = createHTMLElement(doc, "p", `${config.addonRef}-wiki-lead`);
  problem.textContent = paper.summary?.problem || "暂无问题描述。";
  overview.appendChild(problem);
  if (paper.summary?.targetTask) overview.appendChild(buildChip(doc, `任务：${paper.summary.targetTask}`));
  article.appendChild(overview);

  const contributions = buildSection(doc, "核心贡献");
  appendList(contributions, paper.summary?.contributions);
  article.appendChild(contributions);

  const outputs = buildSection(doc, "本文提出");
  const outputWrap = createHTMLElement(doc, "div", `${config.addonRef}-wiki-two-col`);
  const methods = createHTMLElement(doc, "div");
  const mh = createHTMLElement(doc, "h3");
  mh.textContent = "方法 / 模型";
  methods.appendChild(mh);
  appendConceptList(methods, state, paper.summary?.ownedMethodNames, "method", nav);
  const datasets = createHTMLElement(doc, "div");
  const dh = createHTMLElement(doc, "h3");
  dh.textContent = "数据集 / Benchmark";
  datasets.appendChild(dh);
  appendConceptList(datasets, state, paper.summary?.proposedDatasets, "dataset", nav);
  outputWrap.append(methods, datasets);
  outputs.appendChild(outputWrap);
  article.appendChild(outputs);

  article.appendChild(buildReferencedItems(doc, "引用的方法", paper.summary?.referencedMethods, state, nav, "method"));
  article.appendChild(buildReferencedItems(doc, "引用的数据集", paper.summary?.referencedDatasets, state, nav, "dataset"));

  const methodology = buildSection(doc, "核心方法论");
  appendList(methodology, paper.summary?.methodology);
  article.appendChild(methodology);

  article.appendChild(buildPipelineSection(doc, paper));
  article.appendChild(buildDiagramSection(doc, paper));
  article.appendChild(buildDataAnalysisSection(doc, paper));

  const limitations = buildSection(doc, "限制与注意事项");
  appendList(limitations, paper.summary?.limitations);
  article.appendChild(limitations);

  article.appendChild(buildRelations(doc, state, paper, nav));
  article.appendChild(buildNotes(doc, pageIdForPaper(paper.itemKey)));
  main.appendChild(article);
  return main;
}

function buildConceptPage(doc: Document, state: KGState, concept: KGConceptNode, nav: WikiNavigate): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const article = createHTMLElement(doc, "article", `${config.addonRef}-wiki-paper`);
  const head = createHTMLElement(doc, "section", `${config.addonRef}-wiki-paper-head`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = conceptLabel(concept, concept.id);
  const meta = createHTMLElement(doc, "p");
  meta.textContent = `${conceptTypeLabel(concept.type)} · ${concept.degree || concept.sourcePaperKeys?.length || 0} 篇论文提及`;
  const chips = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-row`);
  chips.append(buildChip(doc, conceptTypeLabel(concept.type)), buildChip(doc, `关联 ${concept.degree || 0} 篇`));
  head.append(h, meta, chips);
  article.appendChild(head);

  if (concept.description) {
    const desc = buildSection(doc, "概念说明");
    const p = createHTMLElement(doc, "p", `${config.addonRef}-wiki-lead`);
    p.textContent = concept.description;
    desc.appendChild(p);
    article.appendChild(desc);
  }

  const aliases = buildSection(doc, "别名");
  appendList(aliases, concept.aliases, "暂无别名");
  article.appendChild(aliases);

  const rep = buildSection(doc, "代表论文");
  if (concept.representativePaperKey && paperByKey(state, concept.representativePaperKey)) {
    const paper = paperByKey(state, concept.representativePaperKey)!;
    rep.appendChild(buildLinkButton(doc, paper.title || paper.itemKey, () => nav.paper(paper.itemKey)));
  } else {
    appendList(rep, [], "暂无代表论文");
  }
  article.appendChild(rep);

  const sources = buildSection(doc, "来源论文");
  const list = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-items`);
  for (const paper of conceptSourcePapers(state, concept)) {
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-item`);
    row.appendChild(buildLinkButton(doc, paper.title || paper.itemKey, () => nav.paper(paper.itemKey)));
    const metaLine = createHTMLElement(doc, "p");
    metaLine.textContent = domainOf(paper);
    row.appendChild(metaLine);
    list.appendChild(row);
  }
  sources.appendChild(list);
  article.appendChild(sources);

  const edges = buildSection(doc, "关系证据");
  const edgeList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-rel-list`);
  for (const edge of conceptIncidentEdges(state, concept).slice(0, 60)) {
    const otherId = edge.from === concept.id ? edge.to : edge.from;
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-rel-row`);
    row.appendChild(buildChip(doc, edgeLabel(edge)));
    if (otherId.startsWith("concept:")) row.appendChild(buildLinkButton(doc, nodeLabel(state, otherId), () => nav.concept(otherId)));
    else row.appendChild(buildLinkButton(doc, nodeLabel(state, otherId), () => nav.paper(otherId)));
    if (edge.evidence?.[0]) {
      const ev = createHTMLElement(doc, "p");
      ev.textContent = edge.evidence[0];
      row.appendChild(ev);
    }
    edgeList.appendChild(row);
  }
  edges.appendChild(edgeList);
  article.appendChild(edges);

  if (concept.relatedConceptIds?.length) {
    const related = buildSection(doc, "相关概念");
    const wrap = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-list`);
    for (const id of concept.relatedConceptIds) {
      const c = state.concepts.find((x) => x.id === id);
      wrap.appendChild(buildLinkButton(doc, conceptLabel(c, id), () => nav.concept(id), `${config.addonRef}-wiki-link-chip`));
    }
    related.appendChild(wrap);
    article.appendChild(related);
  }

  article.appendChild(buildNotes(doc, pageIdForConcept(concept.id)));
  main.appendChild(article);
  return main;
}

function buildDomainPage(doc: Document, state: KGState, domain: string, nav: WikiNavigate): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const papers = state.papers.filter((paper) => domainOf(paper) === domain);
  const concepts = domainConcepts(state, domain);
  const head = createHTMLElement(doc, "section", `${config.addonRef}-wiki-paper-head`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = domain;
  const meta = createHTMLElement(doc, "p");
  meta.textContent = `${papers.length} 篇论文 · ${concepts.length} 个相关概念`;
  head.append(h, meta);
  main.appendChild(head);

  const conceptSection = buildSection(doc, "核心概念");
  const conceptGrid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
  for (const concept of concepts.slice(0, 24)) {
    const card = createHTMLElement(doc, "button", `${config.addonRef}-wiki-card`);
    card.type = "button";
    const ch = createHTMLElement(doc, "h3");
    ch.textContent = conceptLabel(concept, concept.id);
    const cp = createHTMLElement(doc, "p");
    cp.textContent = `${conceptTypeLabel(concept.type)} · ${concept.degree || 0} 篇论文`;
    card.append(ch, cp);
    card.addEventListener("click", () => nav.concept(concept.id));
    conceptGrid.appendChild(card);
  }
  conceptSection.appendChild(conceptGrid);
  main.appendChild(conceptSection);

  const paperSection = buildSection(doc, "领域论文");
  const paperList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-items`);
  for (const paper of papers) {
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-item`);
    row.appendChild(buildLinkButton(doc, paper.title || paper.itemKey, () => nav.paper(paper.itemKey)));
    const summary = createHTMLElement(doc, "p");
    summary.textContent = paper.summary?.problem || paper.metaLine || paper.status;
    row.appendChild(summary);
    paperList.appendChild(row);
  }
  paperSection.appendChild(paperList);
  main.appendChild(paperSection);
  main.appendChild(buildNotes(doc, pageIdForDomain(domain)));
  return main;
}

function styles(ref: string): string {
  return `
    /* ── Reset ───────────────────────────────────────────────────────────── */
    .${ref}-wiki-shell,
    .${ref}-wiki-shell * {
      box-sizing: border-box;
    }

    /* ── Shell ───────────────────────────────────────────────────────────── */
    .${ref}-wiki-shell {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      background:
        radial-gradient(circle at 5% 0%,   color-mix(in srgb, var(--ra-purple-500) 7%, transparent) 0%, transparent 40%),
        radial-gradient(circle at 95% 100%, color-mix(in srgb, var(--ra-purple-400) 6%, transparent) 0%, transparent 45%),
        linear-gradient(135deg, var(--ra-purple-50) 0%, #fff 45%, var(--ra-purple-50) 100%);
      color: var(--ra-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: var(--ra-fs-base);
      line-height: var(--ra-lh-base);
      -webkit-font-smoothing: antialiased;
    }

    /* ── Header ──────────────────────────────────────────────────────────── */
    .${ref}-wiki-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ra-space-4);
      padding: 18px 22px;
      border-bottom: 1px solid var(--ra-border);
      background: var(--ra-surface-glass);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      flex: 0 0 auto;
    }

    .${ref}-wiki-brand {
      display: flex;
      align-items: center;
      gap: var(--ra-space-3);
      min-width: 0;
    }

    .${ref}-wiki-logo {
      width: 34px;
      height: 34px;
      border-radius: var(--ra-radius-control);
      box-shadow: 0 8px 22px color-mix(in srgb, var(--ra-purple-500) 22%, transparent);
      flex-shrink: 0;
    }

    .${ref}-wiki-brand h1 {
      margin: 0;
      font-size: var(--ra-fs-xl);
      font-weight: var(--ra-fw-display);
      letter-spacing: -0.01em;
      color: var(--ra-purple-900);
      line-height: var(--ra-lh-tight);
    }

    .${ref}-wiki-brand p {
      margin: 2px 0 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-purple-600);
    }

    /* ── Home button ─────────────────────────────────────────────────────── */
    .${ref}-wiki-home-btn {
      border: 1px solid var(--ra-border-strong);
      border-radius: var(--ra-radius-pill);
      padding: 8px 14px;
      color: var(--ra-purple-700);
      background: var(--ra-surface);
      cursor: pointer;
      font-weight: var(--ra-fw-bold);
      font-size: var(--ra-fs-sm);
      font-family: inherit;
      flex-shrink: 0;
      transition:
        transform     var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out),
        background    var(--ra-motion-fast) var(--ra-ease-out),
        border-color  var(--ra-motion-fast) var(--ra-ease-out);
    }
    .${ref}-wiki-home-btn:hover {
      transform: translateY(-1px);
      background: var(--ra-surface-1);
      border-color: var(--ra-border-strong);
      box-shadow: var(--ra-shadow-sm);
    }
    .${ref}-wiki-home-btn:active {
      transform: scale(0.98);
      box-shadow: var(--ra-shadow-xs);
    }
    .${ref}-wiki-home-btn:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      box-shadow: var(--ra-shadow-glow);
    }

    /* ── Nav row / breadcrumb / back ─────────────────────────────────────── */
    .${ref}-wiki-nav-row {
      display: flex;
      align-items: center;
      gap: var(--ra-space-3);
      min-width: 0;
      flex: 1;
    }

    .${ref}-wiki-back-btn {
      border: none;
      padding: 4px 10px;
      border-radius: var(--ra-radius-control);
      background: transparent;
      color: var(--ra-purple-600);
      font-size: var(--ra-fs-sm);
      font-weight: var(--ra-fw-bold);
      font-family: inherit;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .${ref}-wiki-back-btn:hover {
      background: var(--ra-brand-soft);
      color: var(--ra-purple-800);
    }

    .${ref}-wiki-breadcrumb {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: var(--ra-fs-sm);
    }

    .${ref}-wiki-crumb {
      border: none;
      padding: 0;
      background: transparent;
      color: var(--ra-purple-600);
      font-size: var(--ra-fs-sm);
      font-family: inherit;
      cursor: pointer;
      transition: color 0.15s;
    }
    .${ref}-wiki-crumb:hover {
      color: var(--ra-purple-800);
      text-decoration: underline;
    }

    .${ref}-wiki-crumb-sep {
      color: var(--ra-purple-400);
      font-size: var(--ra-fs-sm);
    }

    .${ref}-wiki-crumb-current {
      color: var(--ra-purple-900);
      font-weight: var(--ra-fw-bold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Sidebar search ──────────────────────────────────────────────────── */
    .${ref}-wiki-search {
      box-sizing: border-box;
      width: 100%;
      padding: 7px 10px;
      margin-bottom: var(--ra-space-3);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-control);
      background: var(--ra-surface);
      color: var(--ra-text);
      font-size: var(--ra-fs-sm);
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .${ref}-wiki-search:focus {
      border-color: var(--ra-brand);
      box-shadow: 0 0 0 3px var(--ra-ring);
    }

    .${ref}-wiki-trunc-hint {
      margin: var(--ra-space-2) 0 0;
      font-size: var(--ra-fs-xs);
      color: var(--ra-purple-500);
      text-align: center;
      padding: 4px 0;
    }

    /* ── Action buttons (pill, outlined) ─────────────────────────────────── */
    .${ref}-wiki-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ra-space-2);
      margin-top: var(--ra-space-5);
      align-items: center;
    }

    .${ref}-wiki-action-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--ra-space-1);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-pill);
      padding: 7px 12px;
      background: var(--ra-surface);
      color: var(--ra-purple-700);
      font-weight: var(--ra-fw-display);
      font-size: var(--ra-fs-sm);
      font-family: inherit;
      cursor: pointer;
      text-decoration: none;
      box-shadow: var(--ra-shadow-xs);
      transition:
        transform     var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out),
        background    var(--ra-motion-fast) var(--ra-ease-out),
        border-color  var(--ra-motion-fast) var(--ra-ease-out);
    }
    .${ref}-wiki-action-btn:hover {
      transform: translateY(-1px);
      border-color: var(--ra-border-strong);
      background: var(--ra-surface-1);
      box-shadow: var(--ra-shadow-sm);
    }
    .${ref}-wiki-action-btn:active {
      transform: scale(0.98);
      box-shadow: var(--ra-shadow-xs);
    }
    .${ref}-wiki-action-btn:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      box-shadow: var(--ra-shadow-glow);
    }
    .${ref}-wiki-action-primary:hover {
      background: var(--ra-gradient-soft);
      color: var(--ra-purple-700);
    }
    .${ref}-wiki-action-btn:disabled,
    .${ref}-wiki-action-btn[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    /* ── Body layout ─────────────────────────────────────────────────────── */
    .${ref}-wiki-body {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 0;
    }

    /* ── Sidebar ─────────────────────────────────────────────────────────── */
    .${ref}-wiki-sidebar {
      min-height: 0;
      overflow: auto;
      padding: var(--ra-space-5);
      border-right: 1px solid var(--ra-border);
      background: var(--ra-surface-1);
    }

    .${ref}-wiki-side-group {
      margin-bottom: var(--ra-space-5);
    }

    .${ref}-wiki-sidebar h2 {
      margin: 0 0 var(--ra-space-3);
      font-size: var(--ra-fs-xs);
      font-weight: var(--ra-fw-bold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ra-purple-600);
    }

    .${ref}-wiki-paper-list,
    .${ref}-wiki-mini-list {
      display: flex;
      flex-direction: column;
      gap: var(--ra-space-2);
    }

    .${ref}-wiki-paper-btn,
    .${ref}-wiki-mini-btn {
      text-align: left;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: 10px var(--ra-space-3);
      background: var(--ra-surface);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--ra-purple-900);
      font-family: inherit;
      font-size: var(--ra-fs-base);
      transition:
        border-color  var(--ra-motion-fast) var(--ra-ease-out),
        background    var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out),
        transform     var(--ra-motion-fast) var(--ra-ease-out);
    }

    .${ref}-wiki-mini-btn {
      display: block;
      font-weight: var(--ra-fw-medium);
      line-height: var(--ra-lh-tight);
    }

    .${ref}-wiki-paper-btn:hover,
    .${ref}-wiki-mini-btn:hover {
      border-color: var(--ra-border-strong);
      background: var(--ra-purple-50);
      box-shadow: var(--ra-shadow-sm);
      transform: translateY(-1px);
    }

    .${ref}-wiki-paper-btn.active,
    .${ref}-wiki-mini-btn.active {
      border-color: var(--ra-border-strong);
      background: var(--ra-brand-soft);
      box-shadow: var(--ra-shadow-sm);
    }

    .${ref}-wiki-paper-btn:active,
    .${ref}-wiki-mini-btn:active {
      transform: scale(0.98);
      box-shadow: var(--ra-shadow-xs);
    }

    .${ref}-wiki-paper-btn:focus-visible,
    .${ref}-wiki-mini-btn:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      box-shadow: var(--ra-shadow-glow);
    }

    .${ref}-wiki-paper-title {
      font-weight: var(--ra-fw-bold);
      line-height: var(--ra-lh-tight);
      color: var(--ra-purple-900);
    }

    .${ref}-wiki-paper-meta {
      font-size: var(--ra-fs-xs);
      color: var(--ra-purple-600);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Main page ───────────────────────────────────────────────────────── */
    .${ref}-wiki-page {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: var(--ra-space-6);
    }

    /* ── Surface cards (hero / section / paper-head) ─────────────────────── */
    .${ref}-wiki-hero,
    .${ref}-wiki-section,
    .${ref}-wiki-paper-head {
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-surface);
      background: var(--ra-surface);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.7),
        var(--ra-shadow-md);
      padding: 20px;
      margin-bottom: var(--ra-space-4);
    }

    .${ref}-wiki-hero h2,
    .${ref}-wiki-paper-head h2 {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-2xl);
      font-weight: var(--ra-fw-display);
      letter-spacing: -0.01em;
      color: var(--ra-purple-900);
      line-height: var(--ra-lh-tight);
    }

    .${ref}-wiki-section h2 {
      margin: 0 0 var(--ra-space-3);
      font-size: var(--ra-fs-lg);
      font-weight: var(--ra-fw-bold);
      letter-spacing: -0.01em;
      color: var(--ra-purple-900);
    }

    .${ref}-wiki-section h3 {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-base);
      font-weight: var(--ra-fw-bold);
      color: var(--ra-purple-700);
    }

    .${ref}-wiki-lead {
      font-size: var(--ra-fs-md);
      line-height: var(--ra-lh-loose);
      color: var(--ra-text);
    }

    /* ── Grid layouts ────────────────────────────────────────────────────── */
    .${ref}-wiki-stats,
    .${ref}-wiki-card-grid,
    .${ref}-wiki-two-col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--ra-space-3);
      margin-top: var(--ra-space-3);
    }

    /* ── Stat card ───────────────────────────────────────────────────────── */
    .${ref}-wiki-stat {
      border-radius: var(--ra-radius-card);
      padding: 14px;
      background: var(--ra-surface-1);
      border: 1px solid var(--ra-border);
    }

    .${ref}-wiki-stat strong {
      display: block;
      font-size: 22px;
      font-weight: var(--ra-fw-display);
      color: var(--ra-purple-700);
      line-height: 1.2;
    }

    .${ref}-wiki-stat span {
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
    }

    /* ── Card button ─────────────────────────────────────────────────────── */
    .${ref}-wiki-card {
      text-align: left;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: 14px;
      background: var(--ra-surface);
      cursor: pointer;
      font-family: inherit;
      transition:
        border-color  var(--ra-motion-fast) var(--ra-ease-out),
        background    var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out),
        transform     var(--ra-motion-fast) var(--ra-ease-out);
    }

    .${ref}-wiki-card:hover {
      border-color: var(--ra-border-strong);
      background: var(--ra-surface-1);
      box-shadow: var(--ra-shadow-sm);
      transform: translateY(-1px);
    }

    .${ref}-wiki-card:active {
      transform: scale(0.99);
      box-shadow: var(--ra-shadow-xs);
    }

    .${ref}-wiki-card:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      box-shadow: var(--ra-shadow-glow);
    }

    .${ref}-wiki-card h3 {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-base);
      font-weight: var(--ra-fw-bold);
      color: var(--ra-purple-900);
      line-height: var(--ra-lh-tight);
    }

    .${ref}-wiki-card p {
      margin: 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
      line-height: var(--ra-lh-base);
    }

    /* ── Chips ───────────────────────────────────────────────────────────── */
    .${ref}-wiki-chip-row,
    .${ref}-wiki-chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ra-space-2);
      margin-top: var(--ra-space-2);
    }

    .${ref}-wiki-chip {
      display: inline-flex;
      align-items: center;
      border-radius: var(--ra-radius-pill);
      padding: 4px 9px;
      background: var(--ra-brand-soft);
      color: var(--ra-purple-700);
      font-size: var(--ra-fs-xs);
      font-weight: var(--ra-fw-display);
      line-height: 1.3;
    }

    /* ── Link button (inline text) ───────────────────────────────────────── */
    .${ref}-wiki-link-btn {
      border: 0;
      background: transparent;
      color: var(--ra-purple-800);
      font-weight: var(--ra-fw-bold);
      font-family: inherit;
      font-size: inherit;
      padding: 0;
      cursor: pointer;
      text-align: left;
      line-height: var(--ra-lh-base);
      transition: color var(--ra-motion-fast) var(--ra-ease-out);
    }

    /* Underline only when the button is NOT also an action-btn or link-chip
       (those share the link-btn base class but have different hover intent). */
    .${ref}-wiki-link-btn:hover:not(.${ref}-wiki-action-btn):not(.${ref}-wiki-link-chip) {
      text-decoration: underline;
      color: var(--ra-purple-600);
    }

    .${ref}-wiki-link-btn:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      border-radius: 3px;
    }

    /* ── Link chip (pill, outlined) ──────────────────────────────────────── */
    .${ref}-wiki-link-chip {
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-pill);
      padding: 4px 9px;
      background: var(--ra-purple-50);
      font-size: var(--ra-fs-xs);
      text-decoration: none;
      transition:
        border-color  var(--ra-motion-fast) var(--ra-ease-out),
        background    var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out);
    }
    .${ref}-wiki-link-chip:hover {
      border-color: var(--ra-border-strong);
      background: var(--ra-brand-soft);
      box-shadow: var(--ra-shadow-sm);
    }
    .${ref}-wiki-link-chip:focus-visible {
      outline: 2px solid var(--ra-brand);
      outline-offset: 2px;
      box-shadow: var(--ra-shadow-glow);
    }

    /* ── Lists ───────────────────────────────────────────────────────────── */
    .${ref}-wiki-list {
      margin: 0;
      padding-left: 20px;
      line-height: var(--ra-lh-loose);
      color: var(--ra-text);
    }

    .${ref}-wiki-empty {
      margin: 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
    }

    /* ── Reference / relation rows ───────────────────────────────────────── */
    .${ref}-wiki-ref-items,
    .${ref}-wiki-rel-list {
      display: flex;
      flex-direction: column;
      gap: var(--ra-space-3);
    }

    .${ref}-wiki-ref-item,
    .${ref}-wiki-rel-row {
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: 10px var(--ra-space-3);
      background: var(--ra-surface);
    }

    .${ref}-wiki-ref-top {
      display: flex;
      align-items: center;
      gap: var(--ra-space-2);
      flex-wrap: wrap;
    }

    .${ref}-wiki-ref-item p,
    .${ref}-wiki-rel-row p {
      margin: var(--ra-space-1) 0 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
      line-height: var(--ra-lh-base);
    }

    /* ── Notes ───────────────────────────────────────────────────────────── */
    .${ref}-wiki-note-status {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-sm);
      color: var(--ra-purple-600);
    }

    .${ref}-wiki-note-tabs {
      display: flex;
      gap: 0;
      margin-bottom: var(--ra-space-2);
      border-bottom: 1px solid var(--ra-border);
    }

    .${ref}-wiki-note-tab {
      border: none;
      border-bottom: 2px solid transparent;
      padding: 6px 14px;
      background: transparent;
      color: var(--ra-text-muted);
      font-size: var(--ra-fs-sm);
      font-weight: var(--ra-fw-medium);
      font-family: inherit;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }

    .${ref}-wiki-note-tab:hover {
      color: var(--ra-purple-700);
    }

    .${ref}-wiki-note-tab.active {
      color: var(--ra-purple-800);
      border-bottom-color: var(--ra-purple-500);
    }

    .${ref}-wiki-note-ai-btn {
      margin-left: auto;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-pill);
      padding: 4px 12px;
      background: var(--ra-brand-soft);
      color: var(--ra-purple-700);
      font-size: var(--ra-fs-xs);
      font-weight: var(--ra-fw-bold);
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .${ref}-wiki-note-ai-btn:hover:not(:disabled) {
      background: var(--ra-gradient-soft);
      box-shadow: var(--ra-shadow-sm);
      transform: translateY(-1px);
    }

    .${ref}-wiki-note-ai-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .${ref}-wiki-note-input {
      box-sizing: border-box;
      width: 100%;
      min-height: 180px;
      resize: vertical;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: var(--ra-space-3);
      background: var(--ra-surface);
      color: var(--ra-text);
      font: var(--ra-fs-base) / var(--ra-lh-base) ui-monospace, SFMono-Regular, Menlo, monospace;
      outline: none;
      transition:
        border-color  var(--ra-motion-fast) var(--ra-ease-out),
        box-shadow    var(--ra-motion-fast) var(--ra-ease-out);
    }

    .${ref}-wiki-note-input:focus,
    .${ref}-wiki-note-input:focus-visible {
      border-color: var(--ra-brand);
      box-shadow: var(--ra-shadow-glow);
      outline: none;
    }

    .${ref}-wiki-note-preview {
      box-sizing: border-box;
      width: 100%;
      min-height: 180px;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: var(--ra-space-3);
      background: var(--ra-surface);
      color: var(--ra-text);
      font: var(--ra-fs-base) / var(--ra-lh-base) -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: auto;
    }

    .${ref}-wiki-note-preview h1,
    .${ref}-wiki-note-preview h2,
    .${ref}-wiki-note-preview h3,
    .${ref}-wiki-note-preview h4 {
      margin: 0.6em 0 0.3em;
      color: var(--ra-purple-900);
      line-height: var(--ra-lh-tight);
    }
    .${ref}-wiki-note-preview h1 { font-size: var(--ra-fs-2xl); }
    .${ref}-wiki-note-preview h2 { font-size: var(--ra-fs-xl); }
    .${ref}-wiki-note-preview h3 { font-size: var(--ra-fs-lg); }
    .${ref}-wiki-note-preview h4 { font-size: var(--ra-fs-base); }

    .${ref}-wiki-note-preview p {
      margin: 0.4em 0;
    }

    .${ref}-wiki-note-preview ul,
    .${ref}-wiki-note-preview ol {
      margin: 0.4em 0;
      padding-left: 1.5em;
    }

    .${ref}-wiki-note-preview code {
      background: var(--ra-surface-1);
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 0.9em;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .${ref}-wiki-note-preview pre {
      border-radius: var(--ra-radius-card);
      padding: var(--ra-space-3);
      overflow-x: auto;
    }

    .${ref}-wiki-note-preview pre code {
      background: transparent;
      padding: 0;
    }

    .${ref}-wiki-note-preview blockquote {
      margin: 0.4em 0;
      padding: 2px 12px;
      border-left: 3px solid var(--ra-purple-300);
      color: var(--ra-text-muted);
    }

    .${ref}-wiki-note-preview table {
      border-collapse: collapse;
      margin: 0.4em 0;
    }

    .${ref}-wiki-note-preview th,
    .${ref}-wiki-note-preview td {
      border: 1px solid var(--ra-border);
      padding: 4px 8px;
    }

    /* ── Pipeline ──────────────────────────────────────────────────────── */
    .${ref}-wiki-pipeline {
      display: flex;
      flex-direction: column;
      gap: 0;
      position: relative;
      padding-left: 28px;
    }

    .${ref}-wiki-pipeline::before {
      content: "";
      position: absolute;
      left: 13px;
      top: 14px;
      bottom: 14px;
      width: 2px;
      background: linear-gradient(to bottom, var(--ra-purple-300), var(--ra-purple-200));
      border-radius: 1px;
    }

    .${ref}-wiki-pipeline-step {
      display: flex;
      align-items: flex-start;
      gap: var(--ra-space-3);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      padding: 12px var(--ra-space-3);
      background: var(--ra-surface);
      position: relative;
    }

    .${ref}-wiki-pipeline-num {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--ra-brand-soft);
      color: var(--ra-purple-700);
      font-weight: var(--ra-fw-bold);
      font-size: var(--ra-fs-sm);
      flex-shrink: 0;
      position: absolute;
      left: -28px;
      z-index: 1;
      border: 2px solid var(--ra-surface);
    }

    .${ref}-wiki-pipeline-step strong {
      display: block;
      color: var(--ra-purple-900);
      font-size: var(--ra-fs-base);
    }

    .${ref}-wiki-pipeline-step p {
      margin: 2px 0 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
      line-height: var(--ra-lh-base);
    }

    .${ref}-wiki-pipeline-arrow {
      display: flex;
      justify-content: center;
      color: var(--ra-purple-400);
      padding: 2px 0;
    }

    /* ── Organizer sidebar button ─────────────────────────────────────── */
    .${ref}-wiki-organizer-btn {
      display: block;
      width: 100%;
      margin-top: var(--ra-space-4);
      padding: 10px 14px;
      border: 1px dashed var(--ra-border-strong);
      border-radius: var(--ra-radius-control);
      background: var(--ra-surface);
      color: var(--ra-purple-700);
      font-weight: var(--ra-fw-bold);
      font-size: var(--ra-fs-sm);
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .${ref}-wiki-organizer-btn:hover {
      background: var(--ra-brand-soft);
      border-color: var(--ra-brand);
    }

    /* ── Organizer page ───────────────────────────────────────────────── */
    .${ref}-org-toolbar {
      display: flex;
      gap: var(--ra-space-2);
      margin-top: var(--ra-space-4);
    }

    .${ref}-org-content {
      margin-top: var(--ra-space-4);
    }

    .${ref}-org-status {
      padding: var(--ra-space-4);
      color: var(--ra-text-muted);
      font-size: var(--ra-fs-sm);
      text-align: center;
    }

    .${ref}-org-proposal-summary {
      padding: var(--ra-space-4);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      background: var(--ra-surface);
      margin-bottom: var(--ra-space-4);
    }

    .${ref}-org-proposal-summary h3 {
      margin: 0 0 var(--ra-space-2);
      color: var(--ra-purple-900);
    }

    .${ref}-org-section {
      margin-bottom: var(--ra-space-4);
    }

    .${ref}-org-section h3 {
      margin: 0 0 var(--ra-space-3);
      font-size: var(--ra-fs-base);
      color: var(--ra-purple-800);
    }

    .${ref}-org-card {
      padding: 12px var(--ra-space-3);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      background: var(--ra-surface);
      margin-bottom: var(--ra-space-2);
    }

    .${ref}-org-card strong {
      display: block;
      color: var(--ra-purple-900);
    }

    .${ref}-org-card p {
      margin: 4px 0 0;
      font-size: var(--ra-fs-sm);
      color: var(--ra-text-muted);
    }

    .${ref}-org-parent-tag {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: var(--ra-radius-pill);
      background: var(--ra-brand-soft);
      font-size: var(--ra-fs-xs);
      font-weight: var(--ra-fw-normal);
      color: var(--ra-purple-600);
    }

    .${ref}-org-count {
      display: inline-block;
      margin-top: 4px;
      font-size: var(--ra-fs-xs);
      color: var(--ra-purple-500);
    }

    .${ref}-org-move-arrow {
      font-size: var(--ra-fs-sm);
      color: var(--ra-purple-600);
      font-weight: var(--ra-fw-bold);
    }

    .${ref}-org-actions {
      display: flex;
      gap: var(--ra-space-2);
      margin-top: var(--ra-space-4);
      padding-top: var(--ra-space-4);
      border-top: 1px solid var(--ra-border);
    }

    /* ── Manual drag-and-drop ─────────────────────────────────────────── */
    .${ref}-org-manual {
      margin-top: var(--ra-space-3);
    }

    .${ref}-org-columns {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: var(--ra-space-4);
    }

    .${ref}-org-column {
      min-height: 200px;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-card);
      background: var(--ra-surface-1);
      padding: var(--ra-space-3);
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .${ref}-org-column.drag-over {
      border-color: var(--ra-brand);
      box-shadow: var(--ra-shadow-glow);
    }

    .${ref}-org-column-title {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-sm);
      font-weight: var(--ra-fw-bold);
      color: var(--ra-purple-800);
    }

    .${ref}-org-child-section {
      margin-top: var(--ra-space-3);
      padding-top: var(--ra-space-2);
      border-top: 1px dashed var(--ra-border);
    }

    .${ref}-org-child-title {
      margin: 0 0 var(--ra-space-2);
      font-size: var(--ra-fs-xs);
      color: var(--ra-purple-600);
    }

    .${ref}-org-paper-card {
      padding: 8px 10px;
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius-control);
      background: var(--ra-surface);
      margin-bottom: 6px;
      cursor: grab;
      transition: transform 0.1s, box-shadow 0.1s, opacity 0.15s;
    }

    .${ref}-org-paper-card:hover {
      transform: translateY(-1px);
      box-shadow: var(--ra-shadow-sm);
    }

    .${ref}-org-paper-card.dragging {
      opacity: 0.4;
    }

    .${ref}-org-paper-card .${ref}-org-paper-title {
      display: block;
      font-size: var(--ra-fs-sm);
      font-weight: var(--ra-fw-bold);
      color: var(--ra-purple-900);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .${ref}-org-paper-card .${ref}-org-paper-meta {
      display: block;
      font-size: var(--ra-fs-xs);
      color: var(--ra-purple-600);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
}

export function renderKnowledgeWiki(win: Window, initialRoute: WikiRoute = { type: "home" }): void {
  const doc = win.document;
  const root = doc.getElementById("wiki-root");
  if (!root) return;

  const ref = config.addonRef;
  let route: WikiRoute = initialRoute;
  const history: WikiRoute[] = [];
  let unsubscribeKG: (() => void) | null = null;
  let unsubscribeWiki: (() => void) | null = null;

  root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8B5CF6;font:14px system-ui,sans-serif;">加载中...</div>`;

  const pushRoute = (next: WikiRoute) => {
    history.push(route);
    if (history.length > 30) history.shift();
    route = next;
    rerender();
  };

  const rerender = () => {
    const state = kgStore.getState();
    const nav: WikiNavigate = {
      home: () => pushRoute({ type: "home" }),
      paper: (itemKey: string) => pushRoute({ type: "paper", itemKey }),
      concept: (conceptId: string) => pushRoute({ type: "concept", conceptId }),
      domain: (domain: string) => pushRoute({ type: "domain", domain }),
      organizer: () => pushRoute({ type: "organizer" }),
      back: () => {
        const prev = history.pop();
        if (prev) { route = prev; rerender(); }
      },
    };

    const style = createHTMLElement(doc, "style");
    style.textContent = styles(ref);
    const shell = createHTMLElement(doc, "div", `${ref}-wiki-shell`);
    const body = createHTMLElement(doc, "div", `${ref}-wiki-body`);
    body.appendChild(buildSidebar(doc, state, route, nav));

    const currentRoute = route;
    if (currentRoute.type === "paper") {
      const itemKey = currentRoute.itemKey;
      const paper = state.papers.find((p) => p.itemKey === itemKey);
      body.appendChild(paper ? buildPaperPage(doc, state, paper, nav) : buildHomePage(doc, state, nav));
    } else if (currentRoute.type === "concept") {
      const conceptId = currentRoute.conceptId;
      const concept = state.concepts.find((c) => c.id === conceptId);
      body.appendChild(concept ? buildConceptPage(doc, state, concept, nav) : buildHomePage(doc, state, nav));
    } else if (currentRoute.type === "domain") {
      body.appendChild(buildDomainPage(doc, state, currentRoute.domain, nav));
    } else if (currentRoute.type === "organizer") {
      body.appendChild(buildOrganizerPage(doc, state, nav));
    } else {
      body.appendChild(buildHomePage(doc, state, nav));
    }

    shell.append(buildHeader(doc, nav, currentRoute, state, history.length > 0), body);
    root.replaceChildren(style, shell);
  };

  void Promise.all([kgStore.init(), wikiStore.init()]).then(() => {
    injectSharedStyles(doc, ref);
    unsubscribeKG = kgStore.subscribe(rerender);
    unsubscribeWiki = wikiStore.subscribe(() => {});
    rerender();
  });

  setRuntime(win, {
    route,
    destroy: () => {
      try { unsubscribeKG?.(); } catch (_) {}
      try { unsubscribeWiki?.(); } catch (_) {}
    },
  });
}
