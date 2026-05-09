import { config } from "../../../package.json";

/**
 * Preference keys for the addon
 */
export const PrefKeys = {
  SECRET_KEY: `${config.addonRef}.secretKey`,
  MODEL: `${config.addonRef}.model`,
  API: `${config.addonRef}.api`,
  TEMPERATURE: `${config.addonRef}.temperature`,
  MAX_TOKENS: `${config.addonRef}.maxTokens`,
  WEB_SEARCH: `${config.addonRef}.webSearch`,
  DELTA_TIME: `${config.addonRef}.deltaTime`,
  CHAT_NUMBER: `${config.addonRef}.chatNumber`,
  RELATED_NUMBER: `${config.addonRef}.relatedNumber`,
  EMBEDDING_BATCH_NUM: `${config.addonRef}.embeddingBatchNum`,
} as const;

/**
 * Default preference values
 */
export const DefaultPrefs = {
  [PrefKeys.SECRET_KEY]: "",
  [PrefKeys.MODEL]: "qwen-max",
  [PrefKeys.API]: "https://dashscope.aliyuncs.com/compatible-mode",
  [PrefKeys.TEMPERATURE]: 0.7,
  [PrefKeys.MAX_TOKENS]: 8192,
  [PrefKeys.WEB_SEARCH]: true,
  [PrefKeys.DELTA_TIME]: 50,
  [PrefKeys.CHAT_NUMBER]: 10,
  [PrefKeys.RELATED_NUMBER]: 5,
  [PrefKeys.EMBEDDING_BATCH_NUM]: 50,
};

/**
 * Get preference value
 */
export function getPref(key: string): any {
  const value = Zotero.Prefs.get(key);
  return value === undefined || value === null
    ? DefaultPrefs[key as keyof typeof DefaultPrefs]
    : value;
}

/**
 * Set preference value
 */
export function setPref(key: string, value: any): void {
  Zotero.Prefs.set(key, value);
}

/**
 * Clear preference (reset to default)
 */
export function clearPref(key: string): void {
  Zotero.Prefs.clear(key);
}
