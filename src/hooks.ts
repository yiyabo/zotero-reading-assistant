import { config } from "../package.json";
import {
  attachToMainWindow as attachKGToWindow,
  detachFromMainWindow as detachKGFromWindow,
  initKnowledgeGraph,
  shutdownKnowledgeGraph,
} from "./features/knowledge-graph";
import {
  attachToMainWindow as attachWikiToWindow,
  detachFromMainWindow as detachWikiFromWindow,
  initKnowledgeWiki,
  shutdownKnowledgeWiki,
} from "./features/wiki";
import { initFollowup } from "./features/followup";
import { resetLLMManager } from "./modules/llm/LLMManager";
import { initLocale } from "./modules/utils/locale";
import { PrefKeys } from "./modules/utils/prefs";
import SidebarView from "./sidebar/SidebarView";

const prefObserverIDs: any[] = [];

function getFullPrefKey(key: string): string {
  return `extensions.zotero.${key}`;
}

async function registerPreferencePane() {
  if (!(Zotero as any).PreferencePanes?.register) {
    Zotero.debug("[RA] PreferencePanes.register is not available");
    return;
  }

  if (addon.data.preferencePaneID) {
    return;
  }

  addon.data.preferencePaneID = await (Zotero as any).PreferencePanes.register({
    pluginID: config.addonID,
    id: `${config.addonRef}-preferences`,
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    src: `chrome://${config.addonRef}/content/preferences.xhtml`,
    stylesheets: [`chrome://${config.addonRef}/content/preferences.css`],
  });
}

function registerPreferenceObservers() {
  if (!(Zotero as any).Prefs?.registerObserver || prefObserverIDs.length) {
    return;
  }

  for (const key of [
    PrefKeys.SECRET_KEY,
    PrefKeys.API,
    PrefKeys.MODEL,
    PrefKeys.PROVIDER,
    PrefKeys.TEMPERATURE,
    PrefKeys.MAX_TOKENS,
    PrefKeys.WEB_SEARCH,
  ]) {
    prefObserverIDs.push(
      (Zotero as any).Prefs.registerObserver(getFullPrefKey(key), () => resetLLMManager(), true)
    );
  }
}

function unregisterPreferenceObservers() {
  if (!(Zotero as any).Prefs?.unregisterObserver) {
    prefObserverIDs.length = 0;
    return;
  }

  while (prefObserverIDs.length) {
    const id = prefObserverIDs.pop();
    try {
      (Zotero as any).Prefs.unregisterObserver(id);
    } catch (e) {}
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await registerPreferencePane();
  registerPreferenceObservers();
  initKnowledgeGraph();
  initKnowledgeWiki();
  initFollowup();
}

async function onMainWindowLoad(win: Window) {
  try {
    Zotero[config.addonInstance].sidebarView = new SidebarView();
  } catch (e: any) {
    Zotero.logError(new Error("[RA] SidebarView error: " + e.message));
  }
  try {
    attachKGToWindow(win);
  } catch (e: any) {
    Zotero.logError(new Error("[RA] KG attach error: " + e.message));
  }
  try {
    attachWikiToWindow(win);
  } catch (e: any) {
    Zotero.logError(new Error("[RA] Wiki attach error: " + e.message));
  }
}

async function onMainWindowUnload(win: Window) {
  if (Zotero[config.addonInstance]?.sidebarView) {
    Zotero[config.addonInstance].sidebarView.destroy();
  }
  try {
    detachKGFromWindow(win);
  } catch (_) {}
  try {
    detachWikiFromWindow(win);
  } catch (_) {}
}

function onShutdown(): void {
  unregisterPreferenceObservers();
  try { shutdownKnowledgeGraph(); } catch (_) {}
  try { shutdownKnowledgeWiki(); } catch (_) {}

  if (addon.data.preferencePaneID && (Zotero as any).PreferencePanes?.unregister) {
    try {
      (Zotero as any).PreferencePanes.unregister(addon.data.preferencePaneID);
    } catch (e) {}
  }

  if (Zotero[config.addonInstance]?.sidebarView) {
    Zotero[config.addonInstance].sidebarView.destroy();
  }

  addon.data.alive = false;
  delete Zotero[config.addonInstance];
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
