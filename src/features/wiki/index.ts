import { kgStore } from "../knowledge-graph/KGStore";
import { renderKnowledgeWiki } from "./WikiRenderer";
import { closeKnowledgeWikiWindow, openKnowledgeWikiWindow, setKnowledgeWikiRenderer } from "./WikiWindow";
import { wikiStore } from "./WikiStore";
import { registerWikiToolsMenuItem, unregisterWikiToolsMenuItem } from "./ToolsMenu";

export function initKnowledgeWiki(): void {
  setKnowledgeWikiRenderer((win, route) => renderKnowledgeWiki(win, route));
  Promise.all([kgStore.init(), wikiStore.init()]).catch((e: any) => {
    Zotero.debug("[RA] wiki eager init failed: " + (e?.message || e));
  });
}

export function attachToMainWindow(win: Window): void {
  registerWikiToolsMenuItem(win, (host) => openKnowledgeWikiWindow(host, { type: "home" }));
}

export function detachFromMainWindow(win: Window): void {
  unregisterWikiToolsMenuItem(win);
}

export function shutdownKnowledgeWiki(): void {
  closeKnowledgeWikiWindow();
}

export { openKnowledgeWikiWindow, closeKnowledgeWikiWindow };
export type { WikiRoute } from "./WikiWindow";
