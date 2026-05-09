import { LLMProvider, Message, StreamCallback, LLMConfig } from "./types";

/**
 * Qwen (通义千问) LLM Provider
 * Compatible with OpenAI API format
 */
export class QwenProvider implements LLMProvider {
  private config: LLMConfig;
  private currentXHR: XMLHttpRequest | null = null;
  private aborted = false;

  constructor(config: LLMConfig) {
    this.config = {
      ...config,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 8192,
    };
  }

  getName(): string {
    return "Qwen";
  }

  validateConfig(): boolean {
    if (!this.config.apiKey || this.config.apiKey.trim() === "") {
      Zotero.debug("Qwen API key is not configured");
      return false;
    }
    if (!this.config.apiUrl || this.config.apiUrl.trim() === "") {
      Zotero.debug("Qwen API URL is not configured");
      return false;
    }
    if (!this.config.model || this.config.model.trim() === "") {
      Zotero.debug("Qwen model is not configured");
      return false;
    }
    return true;
  }

  abort(): void {
    this.aborted = true;
    if (this.currentXHR) {
      try { this.currentXHR.abort(); } catch (_) {}
      this.currentXHR = null;
    }
  }

  async chat(messages: Message[], callback: StreamCallback): Promise<string> {
    if (!this.validateConfig()) {
      const error = new Error("Qwen configuration is invalid. Please check your API key, URL, and model.");
      callback.onError?.(error);
      throw error;
    }

    // Clean up API URL
    let apiUrl = this.config.apiUrl.trim();
    // Remove trailing slashes and /v1 if present
    apiUrl = apiUrl.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
    const url = `${apiUrl}/v1/chat/completions`;

    Zotero.debug(`Qwen API URL: ${url}`);
    Zotero.debug(`Qwen Model: ${this.config.model}`);
    Zotero.debug(`Messages count: ${messages.length}`);

    callback.onStart?.();

    this.aborted = false;
    let fullText = "";
    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    let processedLength = 0;
    let sseBuffer = "";

    try {
      const requestBody: any = {
        model: this.config.model,
        messages: messages,
        stream: true,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      };

      if (this.config.webSearch) {
        requestBody.enable_search = true;
      }

      // Enable high-resolution image processing for better OCR on document pages
      requestBody.vl_high_resolution_images = true;

      await Zotero.HTTP.request("POST", url, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        responseType: "text",
        timeout: 300000,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          this.currentXHR = xmlhttp;
          xmlhttp.timeout = 0;
          // Force UTF-8 decoding for the SSE stream.
          // DashScope returns `Content-Type: text/event-stream` without a charset,
          // which causes Mozilla XHR to fall back to ISO-8859-1 and mangle CJK
          // characters into mojibake (e.g. "你" -> "ä½ ").
          try { (xmlhttp as any).overrideMimeType?.("text/event-stream; charset=utf-8"); } catch (_) {}
          xmlhttp.onprogress = (e: any) => {
            if (this.aborted) return;
            try {
              const response = String(e.target.response || "");
              const newResponse = response.slice(processedLength);
              processedLength = response.length;
              sseBuffer += newResponse;
               
              // Parse SSE (Server-Sent Events) format
              // Format: data: {"choices":[{"delta":{"content":"token"}}]}
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() || "";
              
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const data = line.substring(6).trim();
                  
                  // Skip [DONE] marker
                  if (data === "[DONE]") {
                    continue;
                  }
                  
                  try {
                    const json = JSON.parse(data);
                    const delta = json.choices?.[0]?.delta || {};
                    const content = delta.content;
                    const reasoningContent =
                      delta.reasoning_content ||
                      delta.reasoning ||
                      delta.reasoningContent ||
                      delta.thoughts;
                    
                    if (reasoningContent) {
                      reasoningChunks.push(reasoningContent);
                      callback.onReasoningToken?.(reasoningContent);
                    }
                    
                    if (content) {
                      textChunks.push(content);
                      callback.onToken?.(content);
                    }
                  } catch (parseError) {
                    // Skip invalid JSON lines
                    Zotero.debug("Failed to parse SSE line: " + data);
                  }
                }
              }

              } catch (error: any) {
              Zotero.debug("Error processing stream: " + error);
            }
          };
        },
      });

      this.currentXHR = null;

      if (this.aborted) {
        fullText = textChunks.join("");
        const reasoningText = reasoningChunks.join("");
        if (!fullText && reasoningText) fullText = reasoningText;
        Zotero.debug(`Qwen response aborted. Length: ${fullText.length}`);
        callback.onComplete?.(fullText);
        return fullText;
      }

      fullText = textChunks.join("");
      const reasoningText = reasoningChunks.join("");
      if (!fullText && reasoningText) {
        fullText = reasoningText;
      }
      Zotero.debug(`Qwen response complete. Length: ${fullText.length}`);
      
      callback.onComplete?.(fullText);
      return fullText;

    } catch (error: any) {
      Zotero.debug("Qwen API error: " + error);

      let errorMessage = "Failed to get response from Qwen API";
      
      try {
        // Try to parse error response
        if (error.xmlhttp?.response) {
          const errorData = JSON.parse(error.xmlhttp.response);
          if (errorData.error) {
            errorMessage = `${errorData.error.type || "Error"}: ${errorData.error.message}`;
          }
        } else if (error.message) {
          errorMessage = error.message;
        }
      } catch (parseError) {
        // Use default error message
      }

      const finalError = new Error(errorMessage);
      callback.onError?.(finalError);
      throw finalError;
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration (without API key)
   */
  getConfig(): Omit<LLMConfig, "apiKey"> {
    return {
      apiUrl: this.config.apiUrl,
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    };
  }
}
