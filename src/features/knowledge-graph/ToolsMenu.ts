/**
 * Tools-menu integration for Knowledge Graph
 * ----------------------------------------------------------------------------
 * Zotero 7's main window has a Tools menu identified by `menu_ToolsPopup`.
 * We inject a `<menuitem>` into it on each window's `load` and remove it on
 * `unload`, mirroring the pattern used by most third-party Zotero plugins
 * (Better BibTeX, Zotero PDF Translate, etc.).
 *
 * `Zotero.MenuManager` is not available on all Zotero 7 builds, so we go
 * directly via XUL DOM manipulation — robust and well-tested.
 */
import { config } from "../../../package.json";
import { t } from "../../sidebar/domUtils";
import { fileLog } from "../../utils/fileLog";

const MENU_ITEM_ID = `${config.addonRef}-tools-menu-knowledge-graph`;

/**
 * Append our "Knowledge Graph" item to the Tools menu of `win`.
 * Idempotent — calling twice on the same window is safe.
 */
export function registerToolsMenuItem(
  win: Window,
  onActivate: (win: Window) => void,
): void {
  fileLog("registerToolsMenuItem: start");
  try {
    const doc = win.document;
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    fileLog("  toolsPopup found: " + (!!toolsPopup));
    if (!toolsPopup) {
      Zotero.debug("[RA] Tools menu (menu_ToolsPopup) not found");
      fileLog("  ABORT: menu_ToolsPopup not in DOM");
      return;
    }
    if (doc.getElementById(MENU_ITEM_ID)) {
      fileLog("  ABORT: menu item already exists");
      return;
    }

    const createXUL = (doc as any).createXULElement
      ? (doc as any).createXULElement.bind(doc)
      : (tag: string) =>
          doc.createElementNS(
            "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
            tag,
          );

    const label = t("kg-menu-label");
    fileLog("  label resolved: '" + label + "' (" + label.length + " chars)");

    const separator = createXUL("menuseparator");
    separator.id = `${MENU_ITEM_ID}-separator`;
    toolsPopup.appendChild(separator);

    const menuItem = createXUL("menuitem");
    menuItem.id = MENU_ITEM_ID;
    menuItem.setAttribute("label", label);
    menuItem.addEventListener("command", () => {
      fileLog("menu item clicked");
      try {
        onActivate(win);
      } catch (e: any) {
        fileLog("onActivate threw: " + (e?.message || e));
        Zotero.debug("[RA] KG menu activate error: " + (e?.message || e));
      }
    });
    toolsPopup.appendChild(menuItem);
    fileLog("  menu item appended OK; id=" + MENU_ITEM_ID);
  } catch (e: any) {
    fileLog("  EXCEPTION: " + (e?.message || e) + " stack=" + (e?.stack || "").split("\n")[0]);
    Zotero.debug("[RA] registerToolsMenuItem error: " + (e?.message || e));
  }
}

/**
 * Remove our menu item (and the separator we added with it) from the Tools
 * menu of `win`. Safe to call when the item is already gone.
 */
export function unregisterToolsMenuItem(win: Window): void {
  try {
    const doc = win.document;
    doc.getElementById(MENU_ITEM_ID)?.remove();
    doc.getElementById(`${MENU_ITEM_ID}-separator`)?.remove();
  } catch (e: any) {
    Zotero.debug("[RA] unregisterToolsMenuItem error: " + (e?.message || e));
  }
}
