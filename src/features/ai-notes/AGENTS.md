# AI Notes Feature

## OVERVIEW

Numbered Markdown sticky notes overlaid on the Zotero PDF reader. Notes persist
per PDF attachment and are injected into sidebar LLM context (cite as `#1`).

## STRUCTURE

```
ai-notes/
├── index.ts            # Lifecycle + context helpers
├── types.ts            # AINote schema
├── AINotesStore.ts     # JSON persistence under Zotero DataDirectory
├── AINotesOverlay.ts   # Reader iframe overlay, place/edit/drag/resize
└── overlayCss.ts       # CSS injected into reader document
```

## DATA

- Path: `<DataDirectory>/reading-assistant/ai-notes/<attachmentKey>.json`
- Each note: `{ id, number, pageIndex, rect[PDF coords], content(md), color }`

## INTEGRATION

- `hooks.ts` → `initAINotes()` / `shutdownAINotes()`
- Sidebar context bar button → `beginAINotePlaceMode()`
- `SidebarView.buildMessagesForRequest` injects `buildAINotesContext()`

## RISKS

Overlay uses internal Reader/PDF.js APIs (`_iframeWindow`, `pdfViewer._pages`).
May need adjustment after Zotero reader upgrades.
