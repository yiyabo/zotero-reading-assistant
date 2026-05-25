/**
 * CollectionAnalyzer — uses LLM to analyze the user's existing Zotero
 * collection structure and propose improvements with reasoning.
 * No changes are applied without explicit user confirmation.
 */
import { getLLMManager } from "../../modules/llm/LLMManager";
import type { Message } from "../../modules/llm/types";
import type { CollectionInfo, PaperBrief } from "./CollectionManager";

export type MoveProposal = {
  itemKey: string;
  title: string;
  fromCollections: string[];
  toCollection: string;
  reason: string;
};

export type NewCollectionProposal = {
  name: string;
  parentName: string | null;
  reason: string;
  paperKeys: string[];
};

export type OrganizationProposal = {
  summary: string;
  newCollections: NewCollectionProposal[];
  moves: MoveProposal[];
};

export function buildAnalysisPrompt(
  collections: CollectionInfo[],
  papers: PaperBrief[],
): Message[] {
  const collectionTree = collections
    .filter((c) => !c.parentID)
    .map((c) => {
      const children = collections.filter((ch) => ch.parentID === c.id);
      const childStr = children.length
        ? children.map((ch) => `    - ${ch.name} (${ch.itemKeys.length} 篇)`).join("\n")
        : "";
      return `- ${c.name} (${c.itemKeys.length} 篇)${childStr ? "\n" + childStr : ""}`;
    })
    .join("\n");

  const paperList = papers
    .map((p) => {
      const inCols = p.collectionIDs
        .map((id) => collections.find((c) => c.id === id)?.name)
        .filter(Boolean)
        .join(", ");
      return `[${p.itemKey}] ${p.title} (${p.authors}, ${p.year}) — 领域: ${p.domain || "未知"} | 问题: ${p.problem || "未知"} | 当前分类: ${inCols || "未分类"}`;
    })
    .join("\n");

  const systemPrompt =
    "你是一个学术论文分类助手。用户有一个 Zotero 论文库，里面有已有的集合（文件夹）分类。" +
    "你需要分析用户的分类结构和论文内容，给出优化建议。" +
    "请严格返回一个 JSON 对象，不要其他文字。";

  const userPrompt = [
    "以下是用户的 Zotero 集合结构：",
    collectionTree || "（暂无集合）",
    "",
    "以下是论文列表（含当前分类）：",
    paperList,
    "",
    "请分析后返回以下 JSON：",
    "{",
    '  "summary": "对当前分类结构的整体评价和改进方向（中文，2-3句话）",',
    '  "newCollections": [',
    '    { "name": "建议新建的子集合名称", "parentName": "父集合名称（null表示顶层）", "reason": "为什么要建这个集合", "paperKeys": ["应该放入的论文key"] }',
    "  ],",
    '  "moves": [',
    '    { "itemKey": "论文key", "title": "论文标题", "fromCollections": ["原集合名"], "toCollection": "建议移到的目标集合", "reason": "移动理由" }',
    "  ]",
    "}",
    "",
    "--- 规则 ---",
    "1. 不要建议删除现有集合，只建议新建子集合或移动论文。",
    "2. 移动建议要谨慎，只移动分类明显不合理的论文。",
    "3. 新建集合要有明确的分类逻辑，不要建太多（一般 2-5 个）。",
    "4. 理由要简短具体，说明为什么这样分更好。",
    "5. 如果当前分类已经很好，可以说不需要改动。",
    "6. 所有文字用简体中文。",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

export async function analyzeCollections(
  collections: CollectionInfo[],
  papers: PaperBrief[],
): Promise<OrganizationProposal> {
  const llm = getLLMManager();
  if (!llm.isReady()) {
    throw new Error("请先配置 LLM API");
  }

  const messages = buildAnalysisPrompt(collections, papers);

  return new Promise<OrganizationProposal>((resolve, reject) => {
    let acc = "";
    let settled = false;

    llm.chat(messages, {
      onToken: (t: string) => { acc += t; },
      onComplete: (full: string) => {
        if (settled) return;
        settled = true;
        try {
          resolve(parseProposal(full || acc));
        } catch (e: any) {
          reject(new Error("解析 LLM 响应失败: " + e.message));
        }
      },
      onError: (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    }).catch((err: any) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

function parseProposal(raw: string): OrganizationProposal {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }

  const parsed = JSON.parse(text);

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    newCollections: Array.isArray(parsed.newCollections)
      ? parsed.newCollections
          .filter((n: any) => n && typeof n.name === "string")
          .map((n: any) => ({
            name: String(n.name).trim(),
            parentName: typeof n.parentName === "string" ? n.parentName.trim() : null,
            reason: typeof n.reason === "string" ? n.reason : "",
            paperKeys: Array.isArray(n.paperKeys) ? n.paperKeys.filter((k: any) => typeof k === "string") : [],
          }))
      : [],
    moves: Array.isArray(parsed.moves)
      ? parsed.moves
          .filter((m: any) => m && typeof m.itemKey === "string")
          .map((m: any) => ({
            itemKey: String(m.itemKey).trim(),
            title: typeof m.title === "string" ? m.title : "",
            fromCollections: Array.isArray(m.fromCollections) ? m.fromCollections : [],
            toCollection: typeof m.toCollection === "string" ? m.toCollection : "",
            reason: typeof m.reason === "string" ? m.reason : "",
          }))
      : [],
  };
}
