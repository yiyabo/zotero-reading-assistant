/**
 * Input dock DOM builder
 * ----------------------------------------------------------------------------
 * Builds the bottom-of-panel composer: the dock container, image-preview
 * strip, textarea, and the dual-mode send/stop button.
 *
 * Architecture: this module owns nothing — no state, no class instance,
 * no global handlers. It returns the DOM tree plus references to interesting
 * elements; the caller (`SidebarView`) wires up business logic through the
 * supplied callbacks. This keeps the module testable and easy to swap out
 * later (e.g. when we add a knowledge-graph composer that reuses parts of
 * this dock).
 */
import { createHTMLElement, t } from "./domUtils";

export type BuildInputDockOptions = {
  /** Owning document — the chrome document the dock will live in. */
  doc: Document;
  /** Addon ref / CSS class prefix (e.g. "readingassistant"). */
  addonRef: string;
  /** Submit current input (Enter without shift, or send button when idle). */
  onSubmit: () => void;
  /** Cancel an in-flight generation (Esc while busy, or send button when busy). */
  onStop: () => void;
  /** Discard any pasted-but-unsent image attachments (Esc when images pending). */
  onClearImages: () => void;
  /** Paste handler — receives the raw ClipboardEvent so the caller can introspect. */
  onPaste: (e: ClipboardEvent) => void;
  /** Called on textarea input — typically used to auto-grow height + recompute layout. */
  onInput: () => void;
  /** Returns true if a generation is currently in-flight; used by Esc routing. */
  isBusy: () => boolean;
  /** Returns true if there are pasted images waiting to be sent; used by Esc routing. */
  hasPendingImages: () => boolean;
};

export type InputDockHandles = {
  /** The outer `<div>` to be appended to the panel. */
  root: HTMLDivElement;
  /** The textarea — caller may read/write `.value`, focus it, set selection, etc. */
  textarea: HTMLTextAreaElement;
  /** The send/stop button — caller's setBusy flips its icon + label. */
  sendButton: HTMLButtonElement;
  /** The image-preview container; caller appends thumbnails into it. */
  imagePreview: HTMLDivElement;
};

/**
 * Build the input dock DOM and return handles to the interactive elements.
 *
 * The returned tree is *not* yet attached to a parent; the caller decides
 * where to mount it.
 */
export function buildInputDock(opts: BuildInputDockOptions): InputDockHandles {
  const {
    doc,
    addonRef,
    onSubmit,
    onStop,
    onClearImages,
    onPaste,
    onInput,
    isBusy,
    hasPendingImages,
  } = opts;

  const root = createHTMLElement(doc, "div", `${addonRef}-input-dock`);
  root.id = `${addonRef}-input-dock`;

  const inputWrapper = createHTMLElement(doc, "div", `${addonRef}-input-wrapper`);

  const imagePreview = createHTMLElement(doc, "div", `${addonRef}-image-preview`);
  imagePreview.id = `${addonRef}-image-preview`;

  const textarea = createHTMLElement(doc, "textarea", `${addonRef}-input`);
  textarea.id = `${addonRef}-input`;
  textarea.rows = 3;
  textarea.placeholder = t("input-placeholder");
  textarea.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "Escape") {
      // Priority 1: cancel an in-flight generation
      if (isBusy()) {
        e.preventDefault();
        onStop();
        return;
      }
      // Priority 2: clear any pending pasted images
      if (hasPendingImages()) {
        e.preventDefault();
        onClearImages();
      }
    }
  });
  textarea.addEventListener("input", () => onInput());
  textarea.addEventListener("paste", (e: Event) => onPaste(e as ClipboardEvent));

  const sendBtn = createHTMLElement(doc, "button", `${addonRef}-send-btn`);
  sendBtn.id = `${addonRef}-send`;
  sendBtn.type = "button";
  sendBtn.title = t("send");
  sendBtn.setAttribute("aria-label", t("send"));
  const SVG_NS = "http://www.w3.org/2000/svg";
  const sendIcon = doc.createElementNS(SVG_NS, "svg");
  sendIcon.setAttribute("class", `${addonRef}-send-icon`);
  sendIcon.setAttribute("viewBox", "0 0 24 24");
  sendIcon.setAttribute("fill", "none");
  sendIcon.setAttribute("stroke", "currentColor");
  sendIcon.setAttribute("stroke-width", "2");
  sendIcon.setAttribute("stroke-linecap", "round");
  sendIcon.setAttribute("stroke-linejoin", "round");
  sendIcon.setAttribute("width", "17");
  sendIcon.setAttribute("height", "17");
  sendIcon.setAttribute("aria-hidden", "true");
  const sendPath = doc.createElementNS(SVG_NS, "path");
  sendPath.setAttribute("d", "M22 2 11 13");
  const sendPolygon = doc.createElementNS(SVG_NS, "path");
  sendPolygon.setAttribute("d", "m22 2-7 20-4-9-9-4 20-7Z");
  sendIcon.append(sendPath, sendPolygon);
  const stopIcon = doc.createElementNS(SVG_NS, "svg");
  stopIcon.setAttribute("class", `${addonRef}-stop-icon`);
  stopIcon.setAttribute("viewBox", "0 0 24 24");
  stopIcon.setAttribute("fill", "currentColor");
  stopIcon.setAttribute("width", "14");
  stopIcon.setAttribute("height", "14");
  stopIcon.setAttribute("style", "display:none");
  stopIcon.setAttribute("aria-hidden", "true");
  const stopRect = doc.createElementNS(SVG_NS, "rect");
  stopRect.setAttribute("x", "5");
  stopRect.setAttribute("y", "5");
  stopRect.setAttribute("width", "14");
  stopRect.setAttribute("height", "14");
  stopRect.setAttribute("rx", "3");
  stopIcon.appendChild(stopRect);
  sendBtn.append(sendIcon, stopIcon);
  sendBtn.addEventListener("click", () => {
    if (isBusy()) {
      onStop();
    } else {
      onSubmit();
    }
  });

  inputWrapper.append(textarea, sendBtn);
  root.append(imagePreview, inputWrapper);

  return { root, textarea, sendButton: sendBtn, imagePreview };
}

export type AddImagePreviewOptions = {
  /** The image-preview container returned from `buildInputDock`. */
  container: HTMLElement;
  /** Addon ref / CSS class prefix. */
  addonRef: string;
  /** Image data URL (base64). */
  base64: string;
  /** Called when the user clicks ✕ to remove this image. */
  onRemove: () => void;
};

/**
 * Append a thumbnail to the image-preview strip.
 *
 * The caller is responsible for tracking the underlying `pendingImages`
 * array and for calling `onRemove` to splice the matching entry. This
 * helper just renders the DOM, marks the strip visible, and wires up the
 * remove button.
 */
export function addImagePreview(opts: AddImagePreviewOptions): void {
  const { container, addonRef, base64, onRemove } = opts;
  const doc = container.ownerDocument;

  container.classList.add("has-images");

  const item = createHTMLElement(doc, "div", `${addonRef}-image-preview-item`);
  const img = doc.createElementNS("http://www.w3.org/1999/xhtml", "img") as HTMLImageElement;
  img.src = base64;
  const removeBtn = createHTMLElement(doc, "button", `${addonRef}-image-remove`);
  removeBtn.type = "button";
  removeBtn.textContent = "\u00d7";
  removeBtn.title = t("image-remove");
  removeBtn.setAttribute("aria-label", t("image-remove"));
  removeBtn.addEventListener("click", () => {
    item.remove();
    if (container.children.length === 0) {
      container.classList.remove("has-images");
    }
    onRemove();
  });
  item.append(img, removeBtn);
  container.appendChild(item);
}

/**
 * Empty the image-preview strip and hide its show-when-non-empty class.
 */
export function clearImagePreview(container: HTMLElement): void {
  container.replaceChildren();
  container.classList.remove("has-images");
}
