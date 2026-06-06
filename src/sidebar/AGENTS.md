# Sidebar Feature

## OVERVIEW

Chat sidebar that lives in Zotero's item pane. Handles all user-facing LLM interaction: main conversation, followup threads, image paste, deep PDF reading, and conversation management.

## STRUCTURE

```
sidebar/
├── SidebarView.ts      # Main class (~2400 lines) — panel lifecycle, LLM streaming, DOM
├── MessageList.ts      # Message rendering helpers
├── ConversationStore.ts # Per-paper conversation persistence (JSON)
├── InputDock.ts        # Input area with auto-grow, paste handling
├── EmptyState.ts       # Onboarding state when no API key configured
├── domUtils.ts         # Shared DOM helpers (createElement, showToast)
└── styles.ts           # Sidebar-specific CSS strings
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Panel registration | `SidebarView.ts:registerSection` | Uses Zotero's `registerSection` API for item pane sidenav |
| Main chat flow | `SidebarView.ts:handleUserInput` | Builds messages → streams LLM → renders response |
| Followup dialog | `SidebarView.ts:ensureFollowupDialog` | Modal overlay anchored to a specific message — resizable |
| Deep PDF read | `SidebarView.ts:startDeepRead` | Multi-step PDF analysis with progress reporting |
| Image generation | `SidebarView.ts:handleImageGeneration` | Detects image-gen intent, calls image API, renders results |
| Conversation switching | `SidebarView.ts:switchConversation` | Per-paper conversation index with dropdown UI |
| Context bar | `SidebarView.ts:buildContextBar` | Shows current paper, KG add/open buttons, wiki link |
| Max height management | `SidebarView.ts:setupPanelMaxHeight` | ResizeObserver + polling for Zotero pane sizing quirks |

## CONVENTIONS

- **All DOM is programmatic**: No HTML templates. Everything is `doc.createElement` + inline styles.
- **Streaming rendering**: `onToken` callbacks append to `currentMessageDiv` incrementally. `onComplete` finalizes and parses markdown.
- **Followup threads**: Each followup is a separate thread linked to a parent message. Stored in `ConversationStore` under the parent message ID.
- **Image support**: Users can paste images (Ctrl+V). Images are base64-encoded and sent as `image_url` content parts.
- **Conversation persistence**: JSON file per paper key in Zotero data directory. Indexed by `paperKey` (parent item key for attachments).

## ANTI-PATTERNS

- **Don't block the main thread**: All LLM calls are async streaming. Never use synchronous XHR or blocking operations.
- **Panel max height is fragile**: Zotero's item pane sizing is unpredictable — the `setupPanelMaxHeight` method uses both ResizeObserver and polling. Don't simplify this without testing on multiple Zotero versions.
