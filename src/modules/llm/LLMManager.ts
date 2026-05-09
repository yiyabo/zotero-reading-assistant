import { config } from "../../../package.json";
import { getPref, PrefKeys } from "../utils/prefs";
import { QwenProvider } from "./QwenProvider";
import { LLMProvider, Message, StreamCallback } from "./types";

/**
 * LLM Manager - manages LLM providers and handles chat requests
 */
export class LLMManager {
  private provider: LLMProvider | null = null;

  constructor() {
    this.initializeProvider();
  }

  /**
   * Initialize LLM provider based on preferences
   */
  private initializeProvider(): void {
    const apiKey = getPref(PrefKeys.SECRET_KEY) as string;
    const apiUrl = getPref(PrefKeys.API) as string;
    const model = getPref(PrefKeys.MODEL) as string;
    const temperature = getPref(PrefKeys.TEMPERATURE) as number;
    const maxTokens = getPref(PrefKeys.MAX_TOKENS) as number;
    const webSearch = getPref(PrefKeys.WEB_SEARCH) as boolean;

    if (!apiKey || !apiUrl || !model) {
      Zotero.debug("LLM configuration incomplete");
      return;
    }

    this.provider = new QwenProvider({
      apiKey,
      apiUrl,
      model,
      temperature,
      maxTokens,
      webSearch,
    });

    Zotero.debug(`LLM Provider initialized: ${this.provider.getName()}`);
  }

  /**
   * Check if provider is configured and ready
   */
  isReady(): boolean {
    return this.provider !== null && this.provider.validateConfig();
  }

  /**
   * Get the current provider
   */
  getProvider(): LLMProvider | null {
    return this.provider;
  }

  /**
   * Send a chat request
   */
  async chat(messages: Message[], callback: StreamCallback): Promise<string> {
    if (!this.provider) {
      const error = new Error(
        "LLM provider not initialized. Please configure your API key and settings."
      );
      callback.onError?.(error);
      throw error;
    }

    if (!this.provider.validateConfig()) {
      const error = new Error(
        "LLM configuration is invalid. Please check your settings."
      );
      callback.onError?.(error);
      throw error;
    }

    return await this.provider.chat(messages, callback);
  }

  abort(): void {
    if (this.provider) {
      this.provider.abort();
    }
  }

  /**
   * Reload provider with updated configuration
   */
  reload(): void {
    this.provider = null;
    this.initializeProvider();
  }

  /**
   * Show configuration error to user
   */
  showConfigError(): void {
    try {
      const pw = new Zotero.ProgressWindow({});
      pw.changeHeadline("Configuration Error");
      (pw as any).addLines(["Please configure your API key in the settings"]);
      pw.show();
      pw.startCloseTimer(3000);
    } catch (e) {}
  }
}

// Singleton instance
let llmManagerInstance: LLMManager | null = null;

/**
 * Get the LLM Manager singleton instance
 */
export function getLLMManager(): LLMManager {
  if (!llmManagerInstance) {
    llmManagerInstance = new LLMManager();
  }
  return llmManagerInstance;
}

/**
 * Reset the LLM Manager (useful for testing or reloading config)
 */
export function resetLLMManager(): void {
  llmManagerInstance = null;
}
