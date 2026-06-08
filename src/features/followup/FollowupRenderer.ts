import { config } from "../../../package.json";
import { getLLMManager } from "../../modules/llm/LLMManager";
import { Message, MessageContentPart } from "../../modules/llm/types";
import { injectSharedStyles } from "../../shared/design-tokens";
import { icon } from "../../shared/icons";
import {
  addImagePreview,
  clearImagePreview,
} from "../../sidebar/InputDock";
import {
  appendMessage,
  createMessagePlaceholder,
  updateMessageContent,
  updateReasoningContent,
} from "../../sidebar/MessageList";
import { createHTMLElement, t } from "../../sidebar/domUtils";
import { buildSidebarStyles } from "../../sidebar/styles";
import { FollowupWindowContext } from "./FollowupWindow";

type FollowupMessage = {
  role: "user" | "assistant";
  content: string | MessageContentPart[];
};

export function renderFollowupWindow(win: Window, ctx: FollowupWindowContext): void {
  const doc = win.document;
  const root = doc.getElementById("followup-root");
  if (!root) return;

  root.replaceChildren();

  injectSharedStyles(doc, config.addonRef);
  const style = doc.createElement("style");
  style.textContent = buildSidebarStyles(config.addonRef);
  doc.head.appendChild(style);

  const container = createHTMLElement(doc, "div", `${config.addonRef}-followup-container`);
  root.appendChild(container);

  const header = createHTMLElement(doc, "div", `${config.addonRef}-followup-header`);
  const headerIcon = createHTMLElement(doc, "span", `${config.addonRef}-followup-header-icon`);
  headerIcon.innerHTML = icon("book");
  const title = createHTMLElement(doc, "div", `${config.addonRef}-followup-title`);
  title.textContent = t("followup-title");
  header.append(headerIcon, title);
  container.appendChild(header);

  const panes = createHTMLElement(doc, "div", `${config.addonRef}-followup-panes`);
  container.appendChild(panes);

  const leftPane = createHTMLElement(doc, "div", `${config.addonRef}-followup-left`);
  const leftLabel = createHTMLElement(doc, "div", `${config.addonRef}-followup-pane-label`);
  leftLabel.textContent = t("followup-history-label");
  const leftMessages = createHTMLElement(doc, "div", `${config.addonRef}-followup-messages`);
  leftPane.append(leftLabel, leftMessages);
  panes.appendChild(leftPane);

  for (const msg of ctx.historyMessages) {
    appendMessage({
      container: leftMessages,
      addonRef: config.addonRef,
      role: msg.role as "user" | "assistant",
      content: msg.content,
    });
  }

  const divider = createHTMLElement(doc, "div", `${config.addonRef}-followup-divider`);
  panes.appendChild(divider);

  const rightPane = createHTMLElement(doc, "div", `${config.addonRef}-followup-right`);
  const rightLabel = createHTMLElement(doc, "div", `${config.addonRef}-followup-pane-label`);
  rightLabel.textContent = t("followup-chat-label");
  const rightMessages = createHTMLElement(doc, "div", `${config.addonRef}-followup-messages`);

  const emptyState = createHTMLElement(doc, "div", `${config.addonRef}-followup-empty`);
  const emptyIcon = createHTMLElement(doc, "span", `${config.addonRef}-followup-empty-icon`);
  emptyIcon.innerHTML = icon("info", 32);
  const emptyText = createHTMLElement(doc, "div");
  emptyText.textContent = t("followup-empty-hint") || "Ask a follow-up question about this message";
  emptyState.append(emptyIcon, emptyText);
  rightMessages.appendChild(emptyState);

  rightPane.append(rightLabel, rightMessages);
  panes.appendChild(rightPane);

  let dragging = false;
  divider.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    doc.body.style.cursor = "col-resize";
    doc.body.style.userSelect = "none";
  });
  doc.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    const panesRect = panes.getBoundingClientRect();
    const newWidth = e.clientX - panesRect.left;
    const minW = 120;
    const maxW = panesRect.width - 200;
    leftPane.style.width = `${Math.min(Math.max(newWidth, minW), maxW)}px`;
    leftPane.style.flex = "none";
  });
  doc.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      doc.body.style.cursor = "";
      doc.body.style.userSelect = "";
    }
  });

  const pendingImages: string[] = [];

  const inputDock = createHTMLElement(doc, "div", `${config.addonRef}-followup-input-dock`);

  const imagePreview = createHTMLElement(doc, "div", `${config.addonRef}-image-preview`);
  imagePreview.id = `${config.addonRef}-followup-image-preview`;

  const input = createHTMLElement(doc, "textarea", `${config.addonRef}-followup-input`) as HTMLTextAreaElement;
  input.placeholder = t("followup-input-placeholder");
  input.rows = 2;
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text || pendingImages.length > 0) {
        input.value = "";
        handleSend(text);
      }
    }
    if (e.key === "Escape" && pendingImages.length > 0) {
      e.preventDefault();
      pendingImages.length = 0;
      clearImagePreview(imagePreview);
    }
  });
  input.addEventListener("paste", (e: Event) => {
    const pasteEvent = e as ClipboardEvent;
    const items = pasteEvent.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile?.();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          pendingImages.push(base64);
          addImagePreview({
            container: imagePreview,
            addonRef: config.addonRef,
            base64,
            onRemove: () => {
              const idx = pendingImages.indexOf(base64);
              if (idx !== -1) pendingImages.splice(idx, 1);
            },
          });
        };
        reader.readAsDataURL(file);
      }
    }
  });

  const sendBtn = createHTMLElement(doc, "button", `${config.addonRef}-followup-send-btn`);
  sendBtn.type = "button";
  sendBtn.title = t("send");
  sendBtn.setAttribute("aria-label", t("send"));
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7Z"/></svg>`;
  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (text || pendingImages.length > 0) {
      input.value = "";
      handleSend(text);
    }
  });
  inputDock.append(imagePreview, input, sendBtn);
  rightPane.appendChild(inputDock);

  const messages: FollowupMessage[] = [];
  let busy = false;

  function renderMessages() {
    const existing = rightMessages.querySelectorAll(`.${config.addonRef}-message`);
    existing.forEach((el) => el.remove());
    if (emptyState.parentNode) emptyState.remove();
    for (const msg of messages) {
      appendMessage({
        container: rightMessages,
        addonRef: config.addonRef,
        role: msg.role,
        content: msg.content,
        onScroll: () => {
          rightMessages.scrollTop = rightMessages.scrollHeight;
        },
      });
    }
    rightMessages.scrollTop = rightMessages.scrollHeight;
  }

  async function handleSend(userText: string) {
    if (busy) return;
    const images = [...pendingImages];
    if (!userText.trim() && images.length === 0) return;

    pendingImages.length = 0;
    clearImagePreview(imagePreview);

    let content: string | MessageContentPart[];
    if (images.length > 0) {
      const parts: MessageContentPart[] = [];
      if (userText.trim()) {
        parts.push({ type: "text", text: userText });
      }
      for (const img of images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      content = parts;
    } else {
      content = userText;
    }

    messages.push({ role: "user", content });
    renderMessages();

    const llm = getLLMManager();
    if (!llm.isReady()) {
      messages.push({ role: "assistant", content: t("message-llm-not-configured") });
      renderMessages();
      return;
    }

    const placeholder = createMessagePlaceholder({
      container: rightMessages,
      addonRef: config.addonRef,
      onScroll: () => {
        rightMessages.scrollTop = rightMessages.scrollHeight;
      },
    });
    busy = true;

    let fullResponse = "";
    const requestMessages: Message[] = [
      { role: "system", content: "You are a helpful research assistant. Answer follow-up questions based on the conversation context." },
      ...ctx.historyMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      await llm.chat(requestMessages, {
        onToken: (token) => {
          fullResponse += token;
          updateMessageContent({
            messageDiv: placeholder,
            addonRef: config.addonRef,
            content: fullResponse,
            onScroll: () => {
              rightMessages.scrollTop = rightMessages.scrollHeight;
            },
          });
        },
        onReasoningToken: (token) => {
          updateReasoningContent({
            messageDiv: placeholder,
            token,
            addonRef: config.addonRef,
            onScroll: () => {
              rightMessages.scrollTop = rightMessages.scrollHeight;
            },
          });
        },
        onComplete: (text) => {
          fullResponse = text;
          updateMessageContent({
            messageDiv: placeholder,
            addonRef: config.addonRef,
            content: fullResponse,
            isComplete: true,
            onScroll: () => {
              rightMessages.scrollTop = rightMessages.scrollHeight;
            },
          });
          messages.push({ role: "assistant", content: fullResponse });
          busy = false;
        },
        onError: (err) => {
          updateMessageContent({
            messageDiv: placeholder,
            addonRef: config.addonRef,
            content: `Error: ${err.message}`,
            isComplete: true,
            onScroll: () => {
              rightMessages.scrollTop = rightMessages.scrollHeight;
            },
          });
          busy = false;
        },
      });
    } catch (err: any) {
      updateMessageContent({
        messageDiv: placeholder,
        addonRef: config.addonRef,
        content: `Error: ${err.message}`,
        isComplete: true,
        onScroll: () => {
          rightMessages.scrollTop = rightMessages.scrollHeight;
        },
      });
      busy = false;
    }
  }

  setTimeout(() => {
    leftMessages.scrollTop = leftMessages.scrollHeight;
    input.focus();
  }, 100);
}
