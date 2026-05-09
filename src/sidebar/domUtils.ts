/**
 * Sidebar DOM utilities
 * ----------------------------------------------------------------------------
 * Tiny helpers shared between the sidebar orchestrator (`SidebarView.ts`) and
 * the per-section UI modules (`EmptyState.ts`, `InputDock.ts`, ...). Kept
 * deliberately small — anything that grows beyond trivial DOM creation should
 * live in its own dedicated module.
 */
import { getString } from "../modules/utils/locale";

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Create an XHTML element inside a Zotero chrome document.
 *
 * Zotero's main window is XUL, so plain `doc.createElement(...)` would yield
 * XUL elements (which behave very differently from HTML for layout/styling).
 * `createElementNS(HTML_NS, ...)` forces an HTML element so our flex/grid CSS
 * works as expected.
 */
export function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const elem = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) {
    elem.className = className;
  }
  return elem;
}

/**
 * Locale string lookup. Thin alias for `getString()` so the sidebar modules
 * can use a short `t("key")` call without each importing the locale helper
 * directly.
 */
export function t(key: string): string {
  return getString(key);
}
