import { config } from "../../../package.json";
import { createHTMLElement } from "../../sidebar/domUtils";
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

type WikiRuntime = {
  route: WikiRoute;
  destroy: () => void;
};

type WikiNavigate = {
  home: () => void;
  paper: (itemKey: string) => void;
  concept: (conceptId: string) => void;
  domain: (domain: string) => void;
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

function buildHeader(doc: Document, nav: WikiNavigate): HTMLElement {
  const header = createHTMLElement(doc, "header", `${config.addonRef}-wiki-header`);
  const left = createHTMLElement(doc, "div", `${config.addonRef}-wiki-brand`);
  const logo = createHTMLElement(doc, "img", `${config.addonRef}-wiki-logo`);
  logo.setAttribute("src", `chrome://${config.addonRef}/content/icons/sidebar-logo.svg`);
  logo.setAttribute("alt", "");
  const titles = createHTMLElement(doc, "div");
  const title = createHTMLElement(doc, "h1");
  title.textContent = "知识 Wiki";
  const subtitle = createHTMLElement(doc, "p");
  subtitle.textContent = "论文、方法、数据集与领域的个人科研知识库";
  titles.append(title, subtitle);
  left.append(logo, titles);
  const home = createHTMLElement(doc, "button", `${config.addonRef}-wiki-home-btn`);
  home.type = "button";
  home.textContent = "首页";
  home.addEventListener("click", nav.home);
  header.append(left, home);
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

  const paperList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-paper-list`);
  const papers = [...state.papers].sort((a, b) => {
    if (a.status === "ready" && b.status !== "ready") return -1;
    if (a.status !== "ready" && b.status === "ready") return 1;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
  for (const paper of papers.slice(0, 120)) {
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
  addGroup("论文页面", paperList);

  const conceptList = createHTMLElement(doc, "div", `${config.addonRef}-wiki-mini-list`);
  for (const concept of state.concepts.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 50)) {
    const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-mini-btn`);
    btn.type = "button";
    if (route.type === "concept" && route.conceptId === concept.id) btn.classList.add("active");
    btn.textContent = `${conceptLabel(concept, concept.id)} · ${conceptTypeLabel(concept.type)}`;
    btn.addEventListener("click", () => nav.concept(concept.id));
    conceptList.appendChild(btn);
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
  const textarea = createHTMLElement(doc, "textarea", `${config.addonRef}-wiki-note-input`);
  textarea.placeholder = "在这里写你的 Markdown 备注、想法、复现实验记录或后续阅读计划...";
  textarea.value = note?.body || "";
  let timer: number | undefined;
  textarea.addEventListener("input", () => {
    status.textContent = "保存中...";
    const host = doc.defaultView || window;
    if (timer) host.clearTimeout(timer);
    timer = host.setTimeout(() => {
      void wikiStore.setNote(pageId, textarea.value).then(() => {
        status.textContent = `已保存：${new Date().toLocaleString()}`;
      });
    }, 450);
  });
  section.append(status, textarea);
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
  const openBtn = buildLinkButton(doc, "在 Zotero 中打开", () => openItemInZotero(paper.itemID), `${config.addonRef}-wiki-action-btn`);
  actions.appendChild(openBtn);
  if (hasPdfAttachment(paper.itemID)) {
    const readPdfBtn = buildLinkButton(doc, "在 PDF 中阅读", () => void openItemInReader(paper.itemID), `${config.addonRef}-wiki-action-btn ${config.addonRef}-wiki-action-primary`);
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

  const limitations = buildSection(doc, "限制与注意事项");
  appendList(limitations, paper.summary?.limitations);
  article.appendChild(limitations);

  const refs = buildSection(doc, "关键参考文献");
  const refItems = (paper.summary?.references || []).slice(0, 18).map((r) => r.title || r.raw).filter(Boolean);
  appendList(refs, refItems, "暂无可解析 references");
  article.appendChild(refs);

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
  chips.append(buildChip(doc, conceptTypeLabel(concept.type)), buildChip(doc, `degree ${concept.degree || 0}`));
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
    .${ref}-wiki-shell { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; background:linear-gradient(135deg,#faf7ff 0%,#fff 45%,#f5f3ff 100%); color:#1f2937; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
    .${ref}-wiki-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 22px; border-bottom:1px solid rgba(139,92,246,.16); background:rgba(255,255,255,.82); backdrop-filter:blur(14px); }
    .${ref}-wiki-brand { display:flex; align-items:center; gap:12px; min-width:0; }
    .${ref}-wiki-logo { width:34px; height:34px; border-radius:10px; box-shadow:0 8px 22px rgba(139,92,246,.22); }
    .${ref}-wiki-brand h1 { margin:0; font-size:20px; font-weight:800; color:#4c1d95; }
    .${ref}-wiki-brand p { margin:2px 0 0; color:#7c3aed; }
    .${ref}-wiki-home-btn { border:1px solid rgba(139,92,246,.28); border-radius:999px; padding:8px 14px; color:#6d28d9; background:#fff; cursor:pointer; font-weight:700; }
    .${ref}-wiki-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
    .${ref}-wiki-action-btn { border:1px solid rgba(139,92,246,.24); border-radius:999px; padding:8px 12px; background:#fff; color:#6d28d9; font-weight:800; text-decoration:none !important; }
    .${ref}-wiki-action-primary { background:linear-gradient(135deg,#7c3aed,#8b5cf6,#a855f7); color:#fff; border-color:transparent; box-shadow:0 10px 24px rgba(139,92,246,.24); }
    .${ref}-wiki-body { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:320px minmax(0,1fr); gap:0; }
    .${ref}-wiki-sidebar { min-height:0; overflow:auto; padding:18px; border-right:1px solid rgba(139,92,246,.14); background:rgba(255,255,255,.58); }
    .${ref}-wiki-side-group { margin-bottom:18px; }
    .${ref}-wiki-sidebar h2 { margin:0 0 12px; font-size:13px; color:#6d28d9; }
    .${ref}-wiki-paper-list, .${ref}-wiki-mini-list { display:flex; flex-direction:column; gap:8px; }
    .${ref}-wiki-paper-btn, .${ref}-wiki-mini-btn { text-align:left; border:1px solid rgba(139,92,246,.12); border-radius:14px; padding:10px; background:rgba(255,255,255,.78); cursor:pointer; display:flex; flex-direction:column; gap:4px; color:#312e81; }
    .${ref}-wiki-mini-btn { display:block; font-weight:700; line-height:1.35; }
    .${ref}-wiki-paper-btn:hover, .${ref}-wiki-paper-btn.active, .${ref}-wiki-mini-btn:hover, .${ref}-wiki-mini-btn.active { border-color:rgba(139,92,246,.48); background:#f5f3ff; box-shadow:0 8px 18px rgba(139,92,246,.12); }
    .${ref}-wiki-paper-title { font-weight:700; line-height:1.35; color:#312e81; }
    .${ref}-wiki-paper-meta { font-size:11px; color:#7c3aed; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .${ref}-wiki-page { min-width:0; min-height:0; overflow:auto; padding:24px; }
    .${ref}-wiki-hero, .${ref}-wiki-section, .${ref}-wiki-paper-head { border:1px solid rgba(139,92,246,.14); border-radius:22px; background:rgba(255,255,255,.84); box-shadow:0 16px 38px rgba(76,29,149,.07); padding:18px; margin-bottom:16px; }
    .${ref}-wiki-hero h2, .${ref}-wiki-paper-head h2 { margin:0 0 8px; font-size:24px; color:#312e81; line-height:1.25; }
    .${ref}-wiki-section h2 { margin:0 0 12px; font-size:17px; color:#4c1d95; }
    .${ref}-wiki-section h3 { margin:0 0 8px; font-size:13px; color:#6d28d9; }
    .${ref}-wiki-lead { font-size:15px; line-height:1.7; color:#1f2937; }
    .${ref}-wiki-stats, .${ref}-wiki-card-grid, .${ref}-wiki-two-col { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
    .${ref}-wiki-stat { border-radius:16px; padding:14px; background:linear-gradient(180deg,#f5f3ff,#fff); border:1px solid rgba(139,92,246,.16); }
    .${ref}-wiki-stat strong { display:block; font-size:22px; color:#6d28d9; }
    .${ref}-wiki-stat span { color:#6b7280; }
    .${ref}-wiki-card { text-align:left; border:1px solid rgba(139,92,246,.16); border-radius:18px; padding:14px; background:#fff; cursor:pointer; }
    .${ref}-wiki-card h3 { margin:0 0 8px; color:#312e81; }
    .${ref}-wiki-card p { margin:0; color:#6b7280; line-height:1.5; }
    .${ref}-wiki-chip-row, .${ref}-wiki-chip-list { display:flex; flex-wrap:wrap; gap:8px; }
    .${ref}-wiki-chip { display:inline-flex; align-items:center; border-radius:999px; padding:4px 9px; background:#ede9fe; color:#6d28d9; font-size:11px; font-weight:800; margin:2px 6px 2px 0; }
    .${ref}-wiki-link-btn { border:0; background:transparent; color:#5b21b6; font-weight:800; padding:0; cursor:pointer; text-align:left; line-height:1.4; }
    .${ref}-wiki-link-btn:hover { text-decoration:underline; color:#7c3aed; }
    .${ref}-wiki-link-chip { border:1px solid rgba(139,92,246,.22); border-radius:999px; padding:4px 9px; background:#f5f3ff; text-decoration:none !important; }
    .${ref}-wiki-list { margin:0; padding-left:20px; line-height:1.75; }
    .${ref}-wiki-empty { margin:0; color:#9ca3af; }
    .${ref}-wiki-ref-items, .${ref}-wiki-rel-list { display:flex; flex-direction:column; gap:10px; }
    .${ref}-wiki-ref-item, .${ref}-wiki-rel-row { border:1px solid rgba(139,92,246,.12); border-radius:14px; padding:10px 12px; background:#fff; }
    .${ref}-wiki-ref-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .${ref}-wiki-ref-item p, .${ref}-wiki-rel-row p { margin:6px 0 0; color:#6b7280; line-height:1.5; }
    .${ref}-wiki-note-status { margin:0 0 8px; color:#7c3aed; font-size:12px; }
    .${ref}-wiki-note-input { box-sizing:border-box; width:100%; min-height:180px; resize:vertical; border:1px solid rgba(139,92,246,.24); border-radius:16px; padding:12px; background:#fff; color:#1f2937; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; line-height:1.55; outline:none; }
    .${ref}-wiki-note-input:focus { border-color:#8b5cf6; box-shadow:0 0 0 3px rgba(139,92,246,.14); }
  `;
}

export function renderKnowledgeWiki(win: Window, initialRoute: WikiRoute = { type: "home" }): void {
  const doc = win.document;
  const root = doc.getElementById("wiki-root");
  if (!root) return;

  const ref = config.addonRef;
  let route: WikiRoute = initialRoute;
  let unsubscribeKG: (() => void) | null = null;
  let unsubscribeWiki: (() => void) | null = null;

  const rerender = () => {
    const state = kgStore.getState();
    const nav: WikiNavigate = {
      home: () => { route = { type: "home" }; rerender(); },
      paper: (itemKey: string) => { route = { type: "paper", itemKey }; rerender(); },
      concept: (conceptId: string) => { route = { type: "concept", conceptId }; rerender(); },
      domain: (domain: string) => { route = { type: "domain", domain }; rerender(); },
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
    } else {
      body.appendChild(buildHomePage(doc, state, nav));
    }

    shell.append(buildHeader(doc, nav), body);
    root.replaceChildren(style, shell);
  };

  void Promise.all([kgStore.init(), wikiStore.init()]).then(() => {
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
