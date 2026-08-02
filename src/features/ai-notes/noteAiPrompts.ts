import type { Message } from "../../modules/llm/types";

export type NoteAiAction = "generate" | "format" | "rewrite";

export type NoteAiContext = {
  /** Sticky-note number shown as #N. */
  noteNumber: number;
  /** 1-based page number the note sits on. */
  pageNumber: number;
  paperTitle: string;
  /** Text of the PDF page the note sits on ("" when the page has no text layer). */
  pageText: string;
  /** Text the user currently has selected in the PDF, if any. */
  pdfSelection: string;
  /** Full current textarea content. */
  draft: string;
  /** Textarea selection — only meaningful for the "rewrite" action. */
  selectedSpan: string;
};

const LIMIT_PAGE_TEXT = 6000;
const LIMIT_PDF_SELECTION = 2000;
const LIMIT_DRAFT = 4000;
const LIMIT_SPAN = 2000;

function clip(text: string, max: number): string {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "\n[内容过长，已截断]";
}

const SYSTEM_PROMPT = [
  "你是一位学术阅读助手，负责为 PDF 论文页面上的便签撰写笔记。",
  "输出规则（必须严格遵守）：",
  "1. 只输出便签正文本身，使用 Markdown 语法。",
  "2. 不要输出开场白、解释、总结或“好的”之类的客套话。",
  "3. 不要用 ``` 代码围栏把整段回复包起来（正文内部确实要展示代码时除外）。",
  "4. 内容凝练，优先使用短标题、要点列表和加粗关键词。",
  "5. 使用与论文/用户草稿一致的语言；无法判断时使用中文。",
  "6. 只依据给定的页面内容作答，不要编造论文里没有的数据或结论。",
].join("\n");

function buildContextBlock(ctx: NoteAiContext): string {
  const parts: string[] = [];
  if (ctx.paperTitle) parts.push(`【论文】${ctx.paperTitle}`);
  parts.push(`【便签位置】第 ${ctx.pageNumber} 页 · 便签 #${ctx.noteNumber}`);

  const pageText = clip(ctx.pageText, LIMIT_PAGE_TEXT);
  parts.push(
    pageText
      ? `【本页正文】\n${pageText}`
      : "【本页正文】（无法提取该页文字，可能是扫描件或纯图表页）",
  );

  const selection = clip(ctx.pdfSelection, LIMIT_PDF_SELECTION);
  if (selection) parts.push(`【用户在 PDF 中选中的片段】\n${selection}`);

  return parts.join("\n\n");
}

export function buildNoteAiMessages(action: NoteAiAction, ctx: NoteAiContext): Message[] {
  const lines: string[] = [buildContextBlock(ctx), "---"];
  const draft = clip(ctx.draft, LIMIT_DRAFT);

  if (action === "generate") {
    if (draft) {
      lines.push(`【用户已写的草稿 / 关注点】\n${draft}`);
      lines.push("任务：参考草稿体现出的关注点，基于本页内容重新写出一段完整的便签笔记。");
    } else {
      lines.push("任务：基于本页内容写一段便签笔记；若上面给出了选中片段，就以该片段为核心展开。");
    }
    lines.push(
      "要求：控制在 250 字以内；先用一句话点明核心，再用 2-4 条要点展开；只输出便签正文。",
    );
  } else if (action === "format") {
    lines.push(`【待整理的草稿】\n${draft}`);
    lines.push("任务：把上面的草稿整理成结构清晰的 Markdown 便签。");
    lines.push(
      "要求：完整保留原意和全部信息点，不新增事实、不删减要点；" +
        "可以补标点、分段、拆成要点列表、加粗关键词、修正明显错别字；只输出整理后的 Markdown。",
    );
  } else {
    lines.push(`【便签全文（仅供理解上下文，不要输出）】\n${draft}`);
    lines.push(`【需要改写的片段】\n${clip(ctx.selectedSpan, LIMIT_SPAN)}`);
    lines.push("任务：只改写【需要改写的片段】，让它更清晰、通顺、准确。");
    lines.push(
      "要求：只输出改写后的片段本身；不要重复便签的其他部分，" +
        "不要加引号、编号或任何前后缀；长度与原片段相当。",
    );
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n\n") },
  ];
}

/** Drop a code fence that wraps the whole reply (models add it despite the prompt). */
export function stripCodeFence(text: string): string {
  const trimmed = (text || "").trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (!match) return text;
  // Multiple fences means the fence is real content, not a wrapper.
  if (match[1].includes("```")) return text;
  return match[1];
}
