import { config } from "../../../package.json";

/**
 * Preference keys for the addon
 */
export const PrefKeys = {
  SECRET_KEY: `${config.addonRef}.secretKey`,
  MODEL: `${config.addonRef}.model`,
  API: `${config.addonRef}.api`,
  PROVIDER: `${config.addonRef}.provider`,
  TEMPERATURE: `${config.addonRef}.temperature`,
  MAX_TOKENS: `${config.addonRef}.maxTokens`,
  WEB_SEARCH: `${config.addonRef}.webSearch`,
  IMAGE_API_KEY: `${config.addonRef}.imageApiKey`,
  IMAGE_API: `${config.addonRef}.imageApi`,
  IMAGE_MODEL: `${config.addonRef}.imageModel`,
  IMAGE_SIZE: `${config.addonRef}.imageSize`,
  DELTA_TIME: `${config.addonRef}.deltaTime`,
  CHAT_NUMBER: `${config.addonRef}.chatNumber`,
  RELATED_NUMBER: `${config.addonRef}.relatedNumber`,
  EMBEDDING_BATCH_NUM: `${config.addonRef}.embeddingBatchNum`,
} as const;

export type ProviderPreset = {
  label: string;
  apiUrl: string;
  model: string;
};

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  dashscope: {
    label: "DashScope (通义千问)",
    apiUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    model: "qwen-max",
  },
  deepseek: {
    label: "DeepSeek",
    apiUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    apiUrl: "https://api.openai.com",
    model: "gpt-4o",
  },
  siliconflow: {
    label: "SiliconFlow (硅基流动)",
    apiUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
  },
  custom: {
    label: "自定义",
    apiUrl: "",
    model: "",
  },
};

/**
 * Default preference values
 */
export const DefaultPrefs = {
  [PrefKeys.SECRET_KEY]: "",
  [PrefKeys.MODEL]: "qwen-max",
  [PrefKeys.API]: "https://dashscope.aliyuncs.com/compatible-mode",
  [PrefKeys.PROVIDER]: "dashscope",
  [PrefKeys.TEMPERATURE]: 0.7,
  [PrefKeys.MAX_TOKENS]: 8192,
  [PrefKeys.WEB_SEARCH]: true,
  [PrefKeys.IMAGE_API_KEY]: "",
  [PrefKeys.IMAGE_API]: "https://new.yxgz.cc",
  [PrefKeys.IMAGE_MODEL]: "gpt-image-2",
  [PrefKeys.IMAGE_SIZE]: "1024x1024",
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
