import { aiNotesOverlay } from "./AINotesOverlay";
import { aiNotesStore } from "./AINotesStore";

export { aiNotesStore, aiNotesOverlay };
export type { AINote } from "./types";

export function initAINotes(): void {
  try {
    aiNotesOverlay.start();
    Zotero.debug("[RA] AI Notes started");
  } catch (e: any) {
    Zotero.debug("[RA] AI Notes init failed: " + (e?.message || e));
  }
}

export function shutdownAINotes(): void {
  try {
    aiNotesOverlay.stop();
  } catch (_) {}
}

export function beginAINotePlaceMode(itemID?: number): void {
  aiNotesOverlay.beginPlaceMode(itemID);
}

/** Build LLM context block for the current PDF attachment. */
export function buildAINotesContext(opts: {
  attachmentKey?: string;
  parentItemKey?: string;
  userText?: string;
}): string {
  const attachmentKey = opts.attachmentKey || "";
  if (!attachmentKey) return "";
  const userText = opts.userText || "";
  if (userText && /(?:#|note\s*|便签\s*|笔记\s*)\d+/i.test(userText)) {
    const refs = aiNotesStore.findReferencedNotes(attachmentKey, userText, opts.parentItemKey || "");
    if (!refs.length) return aiNotesStore.formatForLLM(attachmentKey, opts.parentItemKey || "");
    const blocks = refs.map((n) => {
      const body = (n.content || "").trim() || "[empty note]";
      return `[AI Note #${n.number}] (page ${n.pageIndex + 1})\n${body}`;
    });
    return [
      "User-referenced AI sticky notes on the PDF:",
      ...blocks,
    ].join("\n\n");
  }
  return aiNotesStore.formatForLLM(attachmentKey, opts.parentItemKey || "");
}

export function listAINotesForAttachment(attachmentKey: string, parentItemKey = "") {
  return aiNotesStore.getNotes(attachmentKey, parentItemKey);
}
