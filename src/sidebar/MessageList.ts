/**
 * Message list rendering
 * ----------------------------------------------------------------------------
 * Owns DOM construction and incremental updates for the chat transcript:
 *
 *   - `appendMessage`      — render a finished user/assistant message
 *   - `createMessagePlaceholder` — empty assistant bubble used as the target
 *                                  of streaming updates
 *   - `updateMessageContent`     — apply streaming chunks to a placeholder
 *   - `formatErrorMessage`       — map raw LLM errors to user-friendly tips
 *
 * The module is callback-driven: the caller (`SidebarView`) supplies retry /
 * regenerate handlers and a scroll callback. State (the conversation array,
 * busy flag, item being viewed) stays in the orchestrator.
 *
 * Markdown rendering is delegated to `../modules/utils/markdown`. The output
 * is post-processed here to turn `[Page N]` text into clickable spans and to
 * attach copy buttons to fenced code blocks.
 */
import { Message, MessageContentPart } from "../modules/llm/types";
import { renderMarkdown } from "../modules/utils/markdown";
import { createHTMLElement, t, HTML_NS } from "./domUtils";

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

/**
 * Split LLM output into a reasoning section (inside `<think>` / `<reasoning>`
 * tags) and the user-visible answer. Falls back to no-reasoning when neither
 * tag is present.
 */
export function splitReasoningContent(content: string): { reasoning: string; answer: string } {
  const patterns = [
    /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/i,
    /<reasoning>([\s\S]*?)(?:<\/reasoning>|$)/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) continue;
    const reasoning = (match[1] || "").trim();
    const answer = content.replace(match[0], "").trim();
    return { reasoning, answer };
  }
  return { reasoning: "", answer: content };
}

/**
 * Map a raw error message from the LLM provider to a localized,
 * user-actionable hint (auth / quota / timeout / image-not-supported).
 * Falls back to `<error-prefix>: <raw>` for anything we don't recognize.
 */
export function formatErrorMessage(errMsg: string): string {
  const lower = errMsg.toLowerCase();
  if (
    lower.includes("does not support image") ||
    lower.includes("image input") ||
    (lower.includes("cannot read") && lower.includes("image")) ||
    (lower.includes("does not support") && lower.includes("image")) ||
    (lower.includes("vision") && lower.includes("not support"))
  ) {
    return t("error-image-not-supported");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("network error")) {
    return t("error-timeout");
  }
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("401")) {
    return t("error-auth");
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate limit")) {
    return t("error-rate-limit");
  }
  return `${t("error-prefix")} ${errMsg}`;
}

// ---------------------------------------------------------------------------
// Page citation linkification
// ---------------------------------------------------------------------------

/**
 * Walk the message body and turn `[Page 12]` / `[Page 12-15]` text into
 * styled clickable spans tagged with `data-page="12"`. Click handling is
 * done via event delegation at the messages-container level by the caller.
 */
export function addPageCitationLinks(container: HTMLElement, addonRef: string): void {
  const regex = /\[Page\s+(\d+)(?:\s*[–-]\s*(\d+))?\]/gi;
  // NodeFilter.SHOW_TEXT = 4; use numeric constant for Zotero compatibility
  const walker = container.ownerDocument.createTreeWalker(container, 4);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  for (const textNode of textNodes) {
    regex.lastIndex = 0;
    const text = textNode.textContent || "";
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) matches.push(m);
    if (matches.length === 0) continue;

    const parent = textNode.parentNode;
    if (!parent) continue;

    const fragments: (Text | HTMLElement)[] = [];
    let lastIndex = 0;
    for (const match of matches) {
      if (match.index > lastIndex) {
        fragments.push(container.ownerDocument.createTextNode(text.slice(lastIndex, match.index)));
      }
      const pageNum = match[1];
      const span = container.ownerDocument.createElement("span");
      span.className = `${addonRef}-page-citation`;
      span.setAttribute("data-page", pageNum);
      span.title = `Go to page ${pageNum}`;
      span.textContent = match[0];
      fragments.push(span);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragments.push(container.ownerDocument.createTextNode(text.slice(lastIndex)));
    }
    for (const fragment of fragments) parent.insertBefore(fragment, textNode);
    parent.removeChild(textNode);
  }
}

// ---------------------------------------------------------------------------
// Code-block copy buttons
// ---------------------------------------------------------------------------

function addCopyButtons(container: HTMLElement, addonRef: string): void {
  const pres = container.querySelectorAll("pre");
  const copyIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const okIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
  for (const pre of pres) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const btn = pre.ownerDocument.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    btn.className = `${addonRef}-copy-btn`;
    btn.innerHTML = `${copyIconSvg}<span>${t("copy")}</span>`;
    btn.addEventListener("click", () => {
      const text = code.textContent || "";
      const flashOk = () => {
        btn.innerHTML = `${okIconSvg}<span>${t("copied")}</span>`;
        setTimeout(() => { btn.innerHTML = `${copyIconSvg}<span>${t("copy")}</span>`; }, 1500);
      };
      btn.ownerDocument.defaultView?.navigator.clipboard.writeText(text).then(flashOk).catch(() => {
        const ta = btn.ownerDocument.createElementNS(HTML_NS, "textarea") as HTMLTextAreaElement;
        ta.value = text;
        btn.ownerDocument.body.appendChild(ta);
        ta.select();
        btn.ownerDocument.execCommand("copy");
        btn.ownerDocument.body.removeChild(ta);
        flashOk();
      });
    });
    pre.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Assistant content rendering (markdown body + citations + copy buttons)
// ---------------------------------------------------------------------------

/**
 * Render markdown into the assistant bubble's content div, then layer on
 * page-citation spans and copy buttons. `isStreaming` defers expensive
 * passes (e.g. KaTeX) until the message is finished.
 */
export function setAssistantContent(opts: {
  contentDiv: HTMLElement;
  content: string;
  addonRef: string;
  isStreaming?: boolean;
}): void {
  const { contentDiv, content, addonRef, isStreaming = false } = opts;
  contentDiv.classList.add("markdown-body");
  const html = renderMarkdown(content, isStreaming);
  try {
    contentDiv.innerHTML = html;
  } catch (e) {
    Zotero.debug("[RA] innerHTML rejected by Zotero, using fragment fallback");
    contentDiv.textContent = "";
    const fragment = contentDiv.ownerDocument.createRange().createContextualFragment(html);
    contentDiv.appendChild(fragment);
  }
  addCopyButtons(contentDiv, addonRef);
  addPageCitationLinks(contentDiv, addonRef);
}

// ---------------------------------------------------------------------------
// Reasoning ("thoughts") foldable container
// ---------------------------------------------------------------------------

/**
 * Find or create the `<details>` block that holds reasoning content above
 * the answer body. Returns the inner body element where text is appended.
 */
export function ensureThoughtsContainer(opts: {
  messageDiv: HTMLElement;
  addonRef: string;
  startOpen?: boolean;
}): HTMLElement {
  const { messageDiv, addonRef, startOpen = true } = opts;
  const existing = messageDiv.querySelector(`.${addonRef}-message-thoughts`);
  if (existing) {
    const body = existing.querySelector(`.${addonRef}-message-thoughts-body`);
    if (body) return body as HTMLElement;
  }

  const doc = messageDiv.ownerDocument;
  const details = createHTMLElement(doc, "details", `${addonRef}-message-thoughts`);
  const summary = createHTMLElement(doc, "summary");
  summary.textContent = t("assistant-thoughts");
  const body = createHTMLElement(doc, "div", `${addonRef}-message-thoughts-body`);
  details.append(summary, body);
  details.open = startOpen;
  const contentDiv = messageDiv.querySelector(`.${addonRef}-message-content`);
  messageDiv.insertBefore(details, contentDiv || null);
  return body;
}

export function removeThoughtsContainer(messageDiv: HTMLElement, addonRef: string): void {
  messageDiv.querySelector(`.${addonRef}-message-thoughts`)?.remove();
}

export function setThoughtsContent(opts: {
  messageDiv: HTMLElement;
  content: string;
  addonRef: string;
}): void {
  const { messageDiv, content, addonRef } = opts;
  if (!content.trim()) {
    removeThoughtsContainer(messageDiv, addonRef);
    return;
  }
  const body = ensureThoughtsContainer({ messageDiv, addonRef, startOpen: false });
  body.textContent = "";
  body.appendChild(body.ownerDocument!.createTextNode(content));
}

/**
 * Append a streaming reasoning token to the thoughts body, opening the
 * container on first non-empty token. Auto-coalesces consecutive text nodes.
 */
export function updateReasoningContent(opts: {
  messageDiv: HTMLElement;
  token: string;
  addonRef: string;
  onScroll?: () => void;
}): void {
  const { messageDiv, token, addonRef, onScroll } = opts;
  if (!token) return;
  const existingText =
    (messageDiv.querySelector(`.${addonRef}-message-thoughts-body`) as HTMLElement | null)
      ?.textContent || "";
  if (!token.trim() && !existingText.trim()) return;

  const body = ensureThoughtsContainer({ messageDiv, addonRef, startOpen: true });
  const textNode = body.lastChild;
  if (textNode && textNode.nodeType === 3) {
    textNode.textContent += token;
  } else {
    body.appendChild(body.ownerDocument!.createTextNode(token));
  }
  onScroll?.();
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

export type AppendMessageOptions = {
  container: HTMLElement;
  addonRef: string;
  role: "user" | "assistant";
  content: string | MessageContentPart[];
  /** Called when an "error" assistant message's Retry button is clicked. */
  onRetry?: () => void;
  /** Called when an assistant message's Regenerate button is clicked. */
  onRegenerate?: () => void;
  /** Called after the message is appended to scroll the container into view. */
  onScroll?: () => void;
};

/**
 * Render and append a finished message bubble to the messages container.
 * Returns the outer message div, or `null` if the container is missing.
 *
 * For assistant messages: parses `<think>` reasoning, renders the answer as
 * markdown, and adds Regenerate (always) + Retry (only on errors) buttons.
 *
 * For user messages: renders text and any pasted images as thumbnails.
 */
export function appendMessage(opts: AppendMessageOptions): HTMLElement | null {
  const { container, addonRef, role, content, onRetry, onRegenerate, onScroll } = opts;
  const doc = container.ownerDocument;
  container.querySelector(`.${addonRef}-empty`)?.remove();

  const messageDiv = createHTMLElement(doc, "div", `${addonRef}-message ${role}`);

  const labelDiv = createHTMLElement(doc, "div", `${addonRef}-message-label`);
  labelDiv.textContent = role === "user" ? t("user-label") : t("assistant-label");
  messageDiv.appendChild(labelDiv);

  const contentDiv = createHTMLElement(doc, "div", `${addonRef}-message-content`);

  if (role === "assistant") {
    const textContent =
      typeof content === "string"
        ? content
        : content
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n");
    const parsed = splitReasoningContent(textContent);
    if (parsed.reasoning) {
      setThoughtsContent({ messageDiv, content: parsed.reasoning, addonRef });
    }
    setAssistantContent({
      contentDiv,
      content: parsed.answer || textContent,
      addonRef,
    });

    const actions = createHTMLElement(doc, "div", `${addonRef}-message-actions`);
    const isError = /^Warning:|^\u63d0\u793a\uff1a/.test(parsed.answer || textContent);
    if (isError && onRetry) {
      actions.classList.add(`${addonRef}-message-actions-visible`);
      const retryBtn = createHTMLElement(doc, "button", `${addonRef}-retry-btn`);
      retryBtn.title = t("retry");
      retryBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg> ${t("retry")}`;
      actions.appendChild(retryBtn);
      retryBtn.addEventListener("click", () => onRetry());
    }
    if (onRegenerate) {
      const regenBtn = createHTMLElement(doc, "button", `${addonRef}-regenerate-btn`);
      regenBtn.title = t("regenerate");
      regenBtn.setAttribute("aria-label", t("regenerate"));
      regenBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>`;
      regenBtn.addEventListener("click", () => onRegenerate());
      actions.appendChild(regenBtn);
    }
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(actions);
  } else {
    if (typeof content === "string") {
      contentDiv.textContent = content;
    } else {
      const textParts = content.filter((p) => p.type === "text");
      const imageParts = content.filter((p) => p.type === "image_url");
      if (imageParts.length > 0) {
        const imgContainer = createHTMLElement(doc, "div", `${addonRef}-message-images`);
        for (const img of imageParts) {
          const imgEl = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
          imgEl.src = (img as { type: "image_url"; image_url: { url: string } }).image_url.url;
          imgContainer.appendChild(imgEl);
        }
        contentDiv.appendChild(imgContainer);
      }
      if (textParts.length > 0) {
        const textSpan = createHTMLElement(doc, "span");
        textSpan.textContent = textParts.map((p) => (p as { type: "text"; text: string }).text).join("\n");
        contentDiv.appendChild(textSpan);
      }
    }
    messageDiv.appendChild(contentDiv);
  }

  container.appendChild(messageDiv);
  onScroll?.();
  return messageDiv;
}

/**
 * Build an empty assistant bubble used as the streaming target. Hidden until
 * the first answer chunk arrives so we don't show an empty bubble.
 */
export function createMessagePlaceholder(opts: {
  container: HTMLElement;
  addonRef: string;
  onScroll?: () => void;
}): HTMLElement {
  const { container, addonRef, onScroll } = opts;
  const doc = container.ownerDocument;
  container.querySelector(`.${addonRef}-empty`)?.remove();

  const messageDiv = createHTMLElement(doc, "div", `${addonRef}-message assistant`);

  const labelDiv = createHTMLElement(doc, "div", `${addonRef}-message-label`);
  labelDiv.textContent = t("assistant-label");

  const contentDiv = createHTMLElement(doc, "div", `${addonRef}-message-content streaming`);
  contentDiv.style.display = "none";

  messageDiv.appendChild(labelDiv);
  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);
  onScroll?.();
  return messageDiv;
}

/**
 * Apply a streaming chunk (or final value) to an existing assistant bubble.
 *
 *   - Splits any new `<think>` reasoning out into the foldable container.
 *   - Auto-collapses the reasoning details once the answer starts appearing
 *     (during streaming only; final completion leaves the user's expand state).
 *   - Toggles the `streaming` class on the content div based on `isComplete`.
 */
export function updateMessageContent(opts: {
  messageDiv: HTMLElement;
  addonRef: string;
  content: string;
  isComplete?: boolean;
  onScroll?: () => void;
}): void {
  const { messageDiv, addonRef, content, isComplete = false, onScroll } = opts;
  const contentDiv = messageDiv.querySelector(
    `.${addonRef}-message-content`,
  ) as HTMLElement | null;
  if (!contentDiv) return;

  const parsed = splitReasoningContent(content || "");
  if (parsed.reasoning) {
    setThoughtsContent({ messageDiv, content: parsed.reasoning, addonRef });
  } else {
    removeThoughtsContainer(messageDiv, addonRef);
  }

  if (parsed.answer && !isComplete) {
    const details = messageDiv.querySelector(
      `.${addonRef}-message-thoughts`,
    ) as HTMLDetailsElement | null;
    if (details && details.open) details.open = false;
  }

  // Only show the content div once there's actual answer text
  if (parsed.answer || isComplete) {
    contentDiv.style.display = "";
    setAssistantContent({
      contentDiv,
      content: parsed.answer || content,
      addonRef,
      isStreaming: !isComplete,
    });
  }

  if (!isComplete) {
    contentDiv.classList.add("streaming");
  } else {
    contentDiv.classList.remove("streaming");
  }

  onScroll?.();
}
