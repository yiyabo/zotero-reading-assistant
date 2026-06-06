# Wiki Feature

## OVERVIEW

Browsable knowledge wiki that surfaces KG data as interconnected pages. Opens in a separate XHTML window with route-based navigation (home, paper, method, dataset, direction).

## STRUCTURE

```
wiki/
├── index.ts           # Lifecycle: init, attach/detach, shutdown
├── WikiRenderer.ts    # Route-based page rendering
├── WikiWindow.ts      # XHTML dialog management, route types
├── WikiStore.ts       # Wiki-specific persistent state (notes, bookmarks)
├── ToolsMenu.ts       # Zotero Tools menu registration for wiki
└── ZoteroOpeners.ts   # Helpers to open Zotero items from wiki pages
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Route definitions | `WikiWindow.ts:WikiRoute` | Union type: `{ type: "home" }`, `{ type: "paper", key }`, etc. |
| Page rendering | `WikiRenderer.ts:renderKnowledgeWiki` | Switches on route type to render appropriate page |
| Wiki state | `WikiStore.ts` | Stores user notes per wiki page, persists to JSON |
| Navigation | `WikiRenderer.ts` | Internal links use `openKnowledgeWikiWindow(win, route)` |

## CONVENTIONS

- **Route-based navigation**: Every page is a `WikiRoute` object. Opening a wiki page means calling `openKnowledgeWikiWindow(host, route)`.
- **Depends on KGStore**: Wiki reads from `kgStore` for paper/concept data. `WikiStore` only holds wiki-specific state (notes, bookmarks).
- **Separate window**: Like KG, the wiki opens as a standalone XHTML dialog — not embedded in the sidebar.
