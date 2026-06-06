# Modules

## OVERVIEW

Shared infrastructure modules: LLM provider abstraction, Zotero/PDF integration, and utility functions.

## STRUCTURE

```
modules/
├── llm/
│   ├── types.ts          # LLMProvider interface, Message, StreamCallback, LLMConfig
│   ├── LLMManager.ts     # Singleton that creates/manages provider lifecycle
│   └── QwenProvider.ts   # OpenAI-compatible streaming provider (SSE)
├── zotero/
│   └── PDFReader.ts      # PDF text extraction via Zotero full-text index + PDFWorker
└── utils/
    ├── prefs.ts          # PrefKeys enum + getPref/setPref wrappers
    ├── locale.ts         # Fluent localization initialization
    └── markdown.ts       # markdown-it + KaTeX + highlight.js renderer
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| LLM streaming | `llm/QwenProvider.ts` | SSE-based streaming with `StreamCallback` |
| Provider config | `llm/LLMManager.ts:initializeProvider` | Reads prefs → creates QwenProvider |
| PDF text extraction | `zotero/PDFReader.ts` | `getFullText()`, `getSelectedText()`, `getAnnotations()` |
| Preference keys | `utils/prefs.ts:PrefKeys` | All pref keys as enum values |
| Markdown rendering | `utils/markdown.ts` | Configured markdown-it with KaTeX math, hljs code blocks |

## CONVENTIONS

- **LLMProvider is an interface**: `chat(messages, callback)` returns Promise<string>. `abort()` cancels in-flight requests. New providers implement this interface.
- **StreamCallback pattern**: `onStart` → `onToken*` → `onReasoningToken*` → `onComplete` | `onError`. Reasoning tokens are for chain-of-thought models.
- **LLMManager is a singleton**: `getLLMManager()` returns the instance. `resetLLMManager()` nulls it — called when prefs change, next call creates fresh.
- **PrefKeys map to `extensions.zotero.readingassistant.*`**: The enum values are the suffix after the namespace prefix.
- **PDFReader is stateless**: All methods are standalone functions that take Zotero item references.

## ANTI-PATTERNS

- **Don't add new providers without updating LLMManager**: Currently only `QwenProvider` exists. Adding a new provider requires updating `initializeProvider` to select based on `PrefKeys.PROVIDER`.
- **PDFWorker is a fallback**: Always try Zotero's full-text index first (`Zotero.Fulltext.getItemContent`). Only use PDFWorker when the index is empty.
