# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-06
**Commit:** e668be4
**Branch:** main

## OVERVIEW

Zotero Reading Assistant — AI-powered sidebar plugin for Zotero 7. TypeScript + esbuild, bundles into a single XPI. Integrates LLM chat, PDF context reading, knowledge graph analysis, and a wiki system into Zotero's item pane.

## STRUCTURE

```
zotero-reading-assistant/
├── src/
│   ├── index.ts              # Entry point — creates Addon, registers on Zotero global
│   ├── addon.ts              # Addon class (data + hooks + api)
│   ├── hooks.ts              # Lifecycle: onStartup, onMainWindowLoad/Unload, onShutdown
│   ├── sidebar/              # Chat sidebar UI (SidebarView is the main class)
│   ├── features/
│   │   ├── knowledge-graph/  # KG pipeline, store, renderer, window, canvas
│   │   ├── wiki/             # Knowledge wiki — separate window, routes, store
│   │   └── collection-organizer/  # AI-assisted collection management
│   ├── modules/
│   │   ├── llm/              # LLMProvider interface, QwenProvider, LLMManager singleton
│   │   ├── zotero/           # PDFReader — PDF text extraction
│   │   └── utils/            # prefs, locale, markdown rendering
│   ├── shared/               # Design tokens, icons, interactive helpers
│   ├── types/                # Ambient type declarations
│   └── utils/                # fileLog
├── addon/                    # Static assets: XHTML, CSS, icons, locale, bootstrap.js, manifest.json
├── scripts/                  # build.js (esbuild + UglifyJS + XPI packaging), start/stop
├── builds/                   # Build output (generated, gitignored)
├── typing/                   # Global type augmentations for Zotero
└── package.json              # config.addonID, addonRef, addonInstance used by build
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Plugin bootstrap / startup | `addon/bootstrap.js` → `src/index.ts` → `src/hooks.ts` | bootstrap.js loads bundled JS via `Services.scriptloader` |
| Sidebar chat UI | `src/sidebar/SidebarView.ts` | ~2400 lines, the largest file — handles all sidebar DOM, LLM streaming, followup dialogs |
| LLM integration | `src/modules/llm/` | `LLMManager` singleton, `QwenProvider` implements OpenAI-compatible streaming |
| Knowledge graph pipeline | `src/features/knowledge-graph/KGPipeline.ts` | ~1900 lines — paper profiling, relation extraction, concept canonicalization |
| KG state management | `src/features/knowledge-graph/KGStore.ts` | JSON-file-backed store with schema versioning |
| Wiki system | `src/features/wiki/` | Separate window with route-based rendering |
| PDF text extraction | `src/modules/zotero/PDFReader.ts` | Uses Zotero full-text index + PDFWorker fallback |
| Preferences | `addon/content/preferences.xhtml` + `src/modules/utils/prefs.ts` | PrefKeys enum maps to `extensions.zotero.*` |
| Build pipeline | `scripts/build.js` | esbuild → UglifyJS → template replacement → XPI zip |
| Design system | `src/shared/design-tokens.ts` | Purple-scale CSS custom properties, shared keyframes |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Addon` | Class | `src/addon.ts:3` | Plugin root object — holds data, hooks, api |
| `SidebarView` | Class | `src/sidebar/SidebarView.ts:96` | Main sidebar UI controller (~2400 lines) |
| `LLMManager` | Class | `src/modules/llm/LLMManager.ts:9` | Singleton LLM orchestrator |
| `QwenProvider` | Class | `src/modules/llm/QwenProvider.ts` | OpenAI-compatible streaming provider |
| `KGStore` | Class | `src/features/knowledge-graph/KGStore.ts:601` | Persistent KG state with schema migrations |
| `KGPipeline` | Functions | `src/features/knowledge-graph/KGPipeline.ts` | `startKGPipeline`, `processOne`, `processRelations`, `processCanonicalize` |
| `KGConceptNode` | Type | `src/features/knowledge-graph/KGStore.ts:167` | Concept node with type, aliases, sourcePaperKeys |
| `KGEdge` | Type | `src/features/knowledge-graph/KGStore.ts:256` | Edge with type, evidence, rationale, sourceFields |
| `PURPLE` | Const | `src/shared/design-tokens.ts:11` | 9-stop purple scale (Tailwind violet) |
| `buildSharedTokens` | Function | `src/shared/design-tokens.ts:51` | Generates CSS custom properties block |

## CONVENTIONS

- **Zotero global**: Plugin instance lives at `Zotero.ReadingAssistant` (from `config.addonInstance`)
- **Addon ref**: `readingassistant` — used in CSS class prefixes (`ra-*`), chrome URIs, and bundle filename
- **Build template vars**: `__addonRef__`, `__addonID__`, `__addonName__` etc. replaced at build time by `scripts/build.js`
- **esbuild target**: `firefox60` — must avoid modern JS features unavailable in Firefox 60
- **Console stub**: `bootstrap.js` injects a `console` shim because Mozilla's scriptloader sandbox lacks it
- **Pref namespace**: All prefs under `extensions.zotero.readingassistant.*` via `PrefKeys` enum
- **Streaming LLM**: All LLM calls use `StreamCallback` pattern (`onStart`, `onToken`, `onReasoningToken`, `onComplete`, `onError`)
- **Feature lifecycle**: Each feature exports `init*()`, `attachToMainWindow()`, `detachFromMainWindow()`, `shutdown*()` — called from `hooks.ts`
- **KG state persistence**: JSON file in `Zotero.DataDirectory.dir` with schema version fields for migration
- **Design tokens**: All UI modules import `injectSharedStyles` from `src/shared/design-tokens.ts` — purple-white visual identity

## ANTI-PATTERNS (THIS PROJECT)

- **No `console` in bundled code**: Mozilla sandbox doesn't provide it. Use `Zotero.debug()` instead. The bootstrap.js console stub is a safety net, not a pattern.
- **No auto-mutations**: Collection organizer proposals require user confirmation — never auto-apply changes to Zotero collections
- **API keys**: Never hardcode or log API keys. Only stored via Zotero prefs (`PrefKeys.SECRET_KEY`)
- **No `as any` for Zotero API**: Zotero types are incomplete — use `(Zotero as any).SomeAPI` with explicit casts, but prefer `zotero-types` declarations
- **KG pipeline is PDF-first**: Always prefer PDF full-text over abstract-only analysis. Only fall back to abstract when no PDF exists
- **Do not break the fallback**: `src/index.ts` wraps Addon creation in try/catch with a no-op fallback — bootstrap.js must never crash

## UNIQUE STYLES

- CSS custom properties prefixed `--ra-*` (e.g. `--ra-brand`, `--ra-space-4`)
- Purple scale: 50–900 stops from Tailwind violet
- All DOM built programmatically (no HTML templates) — `doc.createElement` + style objects
- Sidebar uses `registerSection` API to inject into Zotero's item pane sidenav
- Feature windows (KG, Wiki) open as separate XHTML dialogs loaded via `chrome://` URIs

## COMMANDS

```bash
npm run build-dev     # Development build → builds/addon/ + builds/*.xpi
npm run build-prod    # Production build (same pipeline, NODE_ENV=production)
npm run build         # build-prod + tsc --noEmit (type check)
npm run tsc           # Type check only (tsc --noEmit)
npm run start         # Launch Zotero with dev profile (scripts/start.js)
npm run stop          # Kill Zotero (scripts/stop.js)
npm run restart       # build-dev → stop → start
```

## NOTES

- `builds/` is committed (contains pre-built XPI) — be careful not to accidentally commit dev builds
- `.kilo/` contains worktree snapshots — ignore these
- No test framework configured — manual testing via Zotero dev profile
- `addon/bootstrap.js` is the true entry point that Zotero loads; it then loads the bundled JS
- The bundled output is a single file: `builds/addon/content/scripts/readingassistant.js`
- `zotero-types` provides partial type coverage — expect `(Zotero as any)` casts throughout
- KaTeX fonts are copied from `node_modules` during build — required for LaTeX rendering in sidebar
