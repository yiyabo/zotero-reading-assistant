export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | MessageContentPart[];
}

export interface LLMConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  webSearch?: boolean;
}

export interface StreamCallback {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onReasoningToken?: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

export interface LLMProvider {
  chat(messages: Message[], callback: StreamCallback): Promise<string>;
  abort(): void;
  getName(): string;
  validateConfig(): boolean;
}