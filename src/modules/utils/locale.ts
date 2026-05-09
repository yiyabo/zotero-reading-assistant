import { config } from "../../../package.json";

export function initLocale() {
  try {
    const L10nClass = (typeof Localization !== "undefined")
      ? Localization
      : (window as any).Localization;
    const l10n = new L10nClass([`${config.addonRef}-addon.ftl`], true);
    addon.data.locale = {
      current: l10n,
    };
  } catch (e: any) {
    Zotero.debug("Failed to init Fluent locale: " + e.message);
    // Fallback to stringBundle
    try {
      addon.data.locale = {
        stringBundle: Components.classes["@mozilla.org/intl/stringbundle;1"]
          .getService(Components.interfaces.nsIStringBundleService)
          .createBundle(`chrome://${config.addonRef}/locale/overlay.properties`),
      };
    } catch (e2: any) {
      Zotero.debug("Failed to init stringBundle locale: " + e2.message);
    }
  }
}

export function getString(key: string, ...args: string[]): string {
  try {
    if (addon.data.locale?.current) {
      // Fluent mode
      const pattern = addon.data.locale.current.formatMessagesSync([
        { id: `${config.addonRef}-${key}`, args: {} },
      ])[0];
      if (pattern?.value) return pattern.value;
    }
    if (addon.data.locale?.stringBundle) {
      // stringBundle fallback
      if (args.length === 0) {
        return addon.data.locale.stringBundle.GetStringFromName(key) || key;
      } else {
        return (
          addon.data.locale.stringBundle.formatStringFromName(key, args) || key
        );
      }
    }
  } catch (e) {
    // ignore
  }
  return key;
}

export function getLocaleID(id: string): string {
  return `${config.addonRef}-${id}`;
}
