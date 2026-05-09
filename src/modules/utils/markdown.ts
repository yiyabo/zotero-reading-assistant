import MarkdownIt from "markdown-it";
import katex from "katex";
import hljs from "highlight.js/lib/common";

type MathToken = {
  placeholder: string;
  source: string;
  displayMode: boolean;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightCode(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    // Auto-detect when no language is given
    return hljs.highlightAuto(code).value;
  } catch (e) {
    return escapeHtml(code);
  }
}

function extractMath(markdown: string): { text: string; tokens: MathToken[] } {
  const tokens: MathToken[] = [];
  let output = "";
  let i = 0;
  let inFence = false;

  const pushMath = (source: string, displayMode: boolean) => {
    const placeholder = `READINGASSISTANTMATH${tokens.length}TOKEN`;
    tokens.push({ placeholder, source, displayMode });
    output += placeholder;
  };

  while (i < markdown.length) {
    if (markdown.startsWith("```", i)) {
      inFence = !inFence;
      output += "```";
      i += 3;
      continue;
    }

    if (inFence) {
      output += markdown[i++];
      continue;
    }

    if (markdown.startsWith("$$", i)) {
      let end = markdown.indexOf("$$", i + 2);
      while (end !== -1 && markdown[end + 2] === "$") {
        end = markdown.indexOf("$$", end + 3);
      }
      if (end !== -1) {
        pushMath(markdown.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }

    if (markdown.startsWith("\\[", i)) {
      let end = markdown.indexOf("\\]", i + 2);
      if (end !== -1) {
        pushMath(markdown.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }

    if (markdown.startsWith("\\(", i)) {
      let end = markdown.indexOf("\\)", i + 2);
      if (end !== -1) {
        pushMath(markdown.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
    }

    if (markdown[i] === "$" && markdown[i + 1] !== "$" && (i === 0 || markdown[i - 1] !== "\\")) {
      let end = i + 1;
      let depth = 1;
      while (end < markdown.length && depth > 0) {
        if (markdown[end] === "\\" && end + 1 < markdown.length) {
          end += 2;
          continue;
        }
        if (markdown[end] === "$" && end !== i) {
          depth--;
          if (depth === 0) break;
        }
        if (markdown[end] === "\n") break;
        end++;
      }
      if (end < markdown.length && markdown[end] === "$" && end > i + 1) {
        const source = markdown.slice(i + 1, end).trim();
        if (source && !/^\d+(\.\d+)?$/.test(source)) {
          pushMath(source, false);
          i = end + 1;
          continue;
        }
      }
    }

    output += markdown[i++];
  }

  return { text: output, tokens };
}

function balanceMarkdown(markdown: string): string {
  let result = markdown;
  const fenceCount = (result.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    result += "\n```";
  }
  let cleaned = result.replace(/\$\$/g, "\x00");
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "\x00") { depth++; }
  }
  if (depth % 2 !== 0) {
    result += "$$";
  }
  let openBrackets = 0;
  let closeBrackets = 0;
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i] === "\\" && result[i + 1] === "[") { openBrackets++; i++; }
    if (result[i] === "\\" && result[i + 1] === "]") { closeBrackets++; i++; }
  }
  if (openBrackets > closeBrackets) {
    result += "\\]";
  }
  openBrackets = 0;
  closeBrackets = 0;
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i] === "\\" && result[i + 1] === "(") { openBrackets++; i++; }
    if (result[i] === "\\" && result[i + 1] === ")") { closeBrackets++; i++; }
  }
  if (openBrackets > closeBrackets) {
    result += "\\)";
  }

  return result;
}

function renderMathToken(token: MathToken): string {
  try {
    return katex.renderToString(token.source, {
      displayMode: token.displayMode,
      throwOnError: false,
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch (error) {
    return `<code class="math-error">${escapeHtml(token.source)}</code>`;
  }
}

/**
 * Markdown renderer
 * Supports Markdown plus LaTeX math delimiters rendered with KaTeX.
 * Model output is still Markdown text; math is LaTeX inside $...$, $$...$$,
 * \(...\), or \[...\].
 */
class MarkdownRenderer {
  private md: MarkdownIt;

  constructor() {
    this.md = new MarkdownIt({
      html: true, // Enable HTML tags in source
      xhtmlOut: true, // Output self-closing tags for XHTML compatibility (<br />, <hr />)
      breaks: true, // Convert '\n' in paragraphs into <br />
      linkify: true, // Autoconvert URL-like text to links
      typographer: true, // Enable smartypants and other sweet transforms
      highlight: (str, lang) => {
        const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
        const langLabel = lang ? `<span class="readingassistant-code-lang">${escapeHtml(lang)}</span>` : "";
        const highlighted = highlightCode(str, lang);
        return `<pre class="hljs"${langLabel ? ` data-lang="${escapeHtml(lang)}"` : ""}><code class="hljs${langClass}">${highlighted}</code></pre>`;
      },
    });

    this.md.renderer.rules.table_open = () => '<div class="readingassistant-table-scroll"><table>\n';
    this.md.renderer.rules.table_close = () => '</table></div>\n';
  }

  /**
   * Render markdown to HTML
   */
  render(markdown: string, isStreaming: boolean = false): string {
    try {
      const balanced = isStreaming ? balanceMarkdown(markdown) : markdown;
      const { text, tokens } = extractMath(balanced);
      let html = this.md.render(text);
      for (const token of tokens) {
        html = html.split(token.placeholder).join(renderMathToken(token));
      }
      return html;
    } catch (error) {
      Zotero.debug("Markdown render error: " + error);
      return markdown.replace(/\n/g, "<br />");
    }
  }

  renderInline(markdown: string): string {
    try {
      const { text, tokens } = extractMath(markdown);
      let html = this.md.renderInline(text);
      for (const token of tokens) {
        html = html.split(token.placeholder).join(renderMathToken(token));
      }
      return html;
    } catch (error) {
      Zotero.debug("Markdown inline render error: " + error);
      return markdown;
    }
  }
}

// Singleton instance
let rendererInstance: MarkdownRenderer | null = null;

/**
 * Get the Markdown renderer singleton
 */
export function getMarkdownRenderer(): MarkdownRenderer {
  if (!rendererInstance) {
    rendererInstance = new MarkdownRenderer();
  }
  return rendererInstance;
}

/**
 * Quick render function
 */
export function renderMarkdown(markdown: string, isStreaming: boolean = false): string {
  return getMarkdownRenderer().render(markdown, isStreaming);
}

/**
 * Quick inline render function
 */
export function renderMarkdownInline(markdown: string): string {
  return getMarkdownRenderer().renderInline(markdown);
}
