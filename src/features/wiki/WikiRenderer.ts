import { config } from "../../../package.json";
import { createHTMLElement } from "../../sidebar/domUtils";
import { KGConceptNode, KGEdge, KGPaperState, KGState, kgStore } from "../knowledge-graph/KGStore";
import { wikiStore } from "./WikiStore";
import { WikiRoute } from "./WikiWindow";

const HTML_NS = "http://www.w3.org/1999/xhtml";

type WikiRuntime = {
  route: WikiRoute;
  destroy: () => void;
};

function setRuntime(win: Window, runtime: WikiRuntime): void {
  const prev = (win as any).__raWikiRuntime as WikiRuntime | undefined;
  try { prev?.destroy(); } catch (_) {}
  (win as any).__raWikiRuntime = runtime;
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function pageIdForPaper(itemKey: string): string {
  return `paper:${itemKey}`;
}

function edgeLabel(edge: KGEdge): string {
  if (edge.type === "method-link") return edge.role ? `方法：${edge.role}` : "方法关联";
  if (edge.type === "dataset-link") return edge.role ? `数据集：${edge.role}` : "数据集关联";
  const labels: Record<string, string> = {
    cites: "引用",
    "similar-method": "方法相似",
    contrasts: "形成对比",
    "uses-same-data": "使用相同数据",
    "solves-same-problem": "解决同类问题",
  };
  return labels[edge.type] || edge.type;
}

function conceptLabel(state: KGState, id: string): string {
  const c = state.concepts.find((x) => x.id === id);
  return c?.canonicalLabel || c?.label || id;
}

function nodeLabel(state: KGState, id: string): string {
  if (id.startsWith("concept:")) return conceptLabel(state, id);
  return state.papers.find((p) => p.itemKey === id)?.title || id;
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

function buildHeader(doc: Document, onHome: () => void): HTMLElement {
  const header = createHTMLElement(doc, "header", `${config.addonRef}-wiki-header`);
  const left = createHTMLElement(doc, "div", `${config.addonRef}-wiki-brand`);
  const logo = createHTMLElement(doc, "img", `${config.addonRef}-wiki-logo`);
  logo.setAttribute("src", `chrome://${config.addonRef}/content/icons/sidebar-logo.svg`);
  logo.setAttribute("alt", "");
  const titles = createHTMLElement(doc, "div");
  const title = createHTMLElement(doc, "h1");
  title.textContent = "知识 Wiki";
  const subtitle = createHTMLElement(doc, "p");
  subtitle.textContent = "从知识图谱生成的论文、方法和数据集知识库";
  titles.append(title, subtitle);
  left.append(logo, titles);
  const home = createHTMLElement(doc, "button", `${config.addonRef}-wiki-home-btn`);
  home.type = "button";
  home.textContent = "首页";
  home.addEventListener("click", onHome);
  header.append(left, home);
  return header;
}

function buildSidebar(doc: Document, papers: KGPaperState[], currentKey: string | undefined, goPaper: (itemKey: string) => void): HTMLElement {
  const side = createHTMLElement(doc, "aside", `${config.addonRef}-wiki-sidebar`);
  const title = createHTMLElement(doc, "h2");
  title.textContent = "论文页面";
  side.appendChild(title);
  const list = createHTMLElement(doc, "div", `${config.addonRef}-wiki-paper-list`);
  for (const p of papers) {
    const btn = createHTMLElement(doc, "button", `${config.addonRef}-wiki-paper-btn`);
    btn.type = "button";
    if (p.itemKey === currentKey) btn.classList.add("active");
    const name = createHTMLElement(doc, "span", `${config.addonRef}-wiki-paper-title`);
    name.textContent = p.title || "（无标题）";
    const meta = createHTMLElement(doc, "span", `${config.addonRef}-wiki-paper-meta`);
    meta.textContent = p.domain || p.metaLine || p.status;
    btn.append(name, meta);
    btn.addEventListener("click", () => goPaper(p.itemKey));
    list.appendChild(btn);
  }
  side.appendChild(list);
  return side;
}

function buildHomePage(doc: Document, state: KGState, goPaper: (itemKey: string) => void): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const hero = createHTMLElement(doc, "section", `${config.addonRef}-wiki-hero`);
  const title = createHTMLElement(doc, "h2");
  title.textContent = "你的个人科研知识库";
  const desc = createHTMLElement(doc, "p");
  desc.textContent = "Wiki 页面由知识图谱状态自动派生；你可以在每篇论文页面下补充自己的 Markdown 备注。";
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

  const recent = buildSection(doc, "最近论文");
  const readyPapers = state.papers.filter((p) => p.status === "ready").slice(0, 12);
  const grid = createHTMLElement(doc, "div", `${config.addonRef}-wiki-card-grid`);
  for (const p of readyPapers) {
    const card = createHTMLElement(doc, "button", `${config.addonRef}-wiki-card`);
    card.type = "button";
    const h = createHTMLElement(doc, "h3");
    h.textContent = p.title;
    const m = createHTMLElement(doc, "p");
    m.textContent = p.summary?.problem || p.metaLine || "打开查看 Wiki 页面";
    card.append(h, m);
    card.addEventListener("click", () => goPaper(p.itemKey));
    grid.appendChild(card);
  }
  recent.appendChild(grid);
  main.appendChild(recent);
  return main;
}

function buildReferencedItems(doc: Document, title: string, items: KGPaperState["summary"] extends infer S ? any[] | undefined : never): HTMLElement {
  const section = buildSection(doc, title);
  if (!items || items.length === 0) {
    const empty = createHTMLElement(doc, "p", `${config.addonRef}-wiki-empty`);
    empty.textContent = "暂无";
    section.appendChild(empty);
    return section;
  }
  const list = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-items`);
  for (const it of items) {
    const row = createHTMLElement(doc, "div", `${config.addonRef}-wiki-ref-item`);
    const top = createHTMLElement(doc, "div");
    top.append(buildChip(doc, it.role || "unknown"));
    const name = createHTMLElement(doc, "strong");
    name.textContent = it.name || "未命名";
    top.appendChild(name);
    row.appendChild(top);
    if (it.evidence) {
      const ev = createHTMLElement(doc, "p");
      ev.textContent = it.evidence;
      row.appendChild(ev);
    }
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
}

function buildRelations(doc: Document, state: KGState, paper: KGPaperState): HTMLElement {
  const section = buildSection(doc, "相关连接");
  const edges = state.edges.filter((e) => e.from === paper.itemKey || e.to === paper.itemKey).slice(0, 24);
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
    const label = createHTMLElement(doc, "strong");
    label.textContent = nodeLabel(state, otherId);
    row.appendChild(label);
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

function buildPaperPage(doc: Document, state: KGState, paper: KGPaperState): HTMLElement {
  const main = createHTMLElement(doc, "main", `${config.addonRef}-wiki-page`);
  const article = createHTMLElement(doc, "article", `${config.addonRef}-wiki-paper`);
  const heading = createHTMLElement(doc, "section", `${config.addonRef}-wiki-paper-head`);
  const h = createHTMLElement(doc, "h2");
  h.textContent = paper.title || "（无标题）";
  const meta = createHTMLElement(doc, "p");
  meta.textContent = paper.metaLine || paper.status;
  const chips = createHTMLElement(doc, "div", `${config.addonRef}-wiki-chip-row`);
  chips.append(buildChip(doc, paper.status), buildChip(doc, paper.domain || paper.summary?.domain || "未分类"));
  heading.append(h, meta, chips);
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
  appendList(methods, paper.summary?.ownedMethodNames);
  const datasets = createHTMLElement(doc, "div");
  const dh = createHTMLElement(doc, "h3");
  dh.textContent = "数据集 / Benchmark";
  datasets.appendChild(dh);
  appendList(datasets, paper.summary?.proposedDatasets);
  outputWrap.append(methods, datasets);
  outputs.appendChild(outputWrap);
  article.appendChild(outputs);

  article.appendChild(buildReferencedItems(doc, "引用的方法", paper.summary?.referencedMethods));
  article.appendChild(buildReferencedItems(doc, "引用的数据集", paper.summary?.referencedDatasets));

  const limitations = buildSection(doc, "限制与注意事项");
  appendList(limitations, paper.summary?.limitations);
  article.appendChild(limitations);

  const refs = buildSection(doc, "关键参考文献");
  const refItems = (paper.summary?.references || []).slice(0, 18).map((r) => r.title || r.raw).filter(Boolean);
  appendList(refs, refItems, "暂无可解析 references");
  article.appendChild(refs);

  article.appendChild(buildRelations(doc, state, paper));
  article.appendChild(buildNotes(doc, pageIdForPaper(paper.itemKey)));
  main.appendChild(article);
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
    .${ref}-wiki-body { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:300px minmax(0,1fr); gap:0; }
    .${ref}-wiki-sidebar { min-height:0; overflow:auto; padding:18px; border-right:1px solid rgba(139,92,246,.14); background:rgba(255,255,255,.58); }
    .${ref}-wiki-sidebar h2 { margin:0 0 12px; font-size:13px; color:#6d28d9; }
    .${ref}-wiki-paper-list { display:flex; flex-direction:column; gap:8px; }
    .${ref}-wiki-paper-btn { text-align:left; border:1px solid rgba(139,92,246,.12); border-radius:14px; padding:10px; background:rgba(255,255,255,.78); cursor:pointer; display:flex; flex-direction:column; gap:4px; }
    .${ref}-wiki-paper-btn:hover, .${ref}-wiki-paper-btn.active { border-color:rgba(139,92,246,.48); background:#f5f3ff; box-shadow:0 8px 18px rgba(139,92,246,.12); }
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
    .${ref}-wiki-chip-row { display:flex; flex-wrap:wrap; gap:8px; }
    .${ref}-wiki-chip { display:inline-flex; align-items:center; border-radius:999px; padding:4px 9px; background:#ede9fe; color:#6d28d9; font-size:11px; font-weight:800; margin:2px 6px 2px 0; }
    .${ref}-wiki-list { margin:0; padding-left:20px; line-height:1.75; }
    .${ref}-wiki-empty { margin:0; color:#9ca3af; }
    .${ref}-wiki-ref-items, .${ref}-wiki-rel-list { display:flex; flex-direction:column; gap:10px; }
    .${ref}-wiki-ref-item, .${ref}-wiki-rel-row { border:1px solid rgba(139,92,246,.12); border-radius:14px; padding:10px 12px; background:#fff; }
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
    const paperKey = route.type === "paper" ? route.itemKey : undefined;
    const papers = [...state.papers].sort((a, b) => {
      if (a.status === "ready" && b.status !== "ready") return -1;
      if (a.status !== "ready" && b.status === "ready") return 1;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    const goHome = () => { route = { type: "home" }; rerender(); };
    const goPaper = (itemKey: string) => { route = { type: "paper", itemKey }; rerender(); };

    const style = createHTMLElement(doc, "style");
    style.textContent = styles(ref);
    const shell = createHTMLElement(doc, "div", `${ref}-wiki-shell`);
    const body = createHTMLElement(doc, "div", `${ref}-wiki-body`);
    body.appendChild(buildSidebar(doc, papers, paperKey, goPaper));

    if (route.type === "paper") {
      const paper = state.papers.find((p) => p.itemKey === paperKey);
      body.appendChild(paper ? buildPaperPage(doc, state, paper) : buildHomePage(doc, state, goPaper));
    } else {
      body.appendChild(buildHomePage(doc, state, goPaper));
    }

    shell.append(buildHeader(doc, goHome), body);
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
