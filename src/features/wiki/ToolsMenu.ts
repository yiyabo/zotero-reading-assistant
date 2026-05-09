import { config } from "../../../package.json";
import { t } from "../../sidebar/domUtils";
import { fileLog } from "../../utils/fileLog";

const MENU_ITEM_ID = `${config.addonRef}-tools-menu-knowledge-wiki`;

export function registerWikiToolsMenuItem(win: Window, onActivate: (win: Window) => void): void {
  try {
    const doc = win.document;
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (!toolsPopup || doc.getElementById(MENU_ITEM_ID)) return;
    const createXUL = (doc as any).createXULElement
      ? (doc as any).createXULElement.bind(doc)
      : (tag: string) => doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", tag);
    const menuItem = createXUL("menuitem");
    menuItem.id = MENU_ITEM_ID;
    menuItem.setAttribute("label", t("wiki-menu-label"));
    menuItem.addEventListener("command", () => {
      try { onActivate(win); } catch (e: any) { Zotero.debug("[RA] Wiki menu activate error: " + (e?.message || e)); }
    });
    toolsPopup.appendChild(menuItem);
    fileLog("Wiki tools menu item appended");
  } catch (e: any) {
    Zotero.debug("[RA] registerWikiToolsMenuItem error: " + (e?.message || e));
  }
}

export function unregisterWikiToolsMenuItem(win: Window): void {
  try { win.document.getElementById(MENU_ITEM_ID)?.remove(); } catch (_) {}
}
