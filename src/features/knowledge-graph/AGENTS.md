# Knowledge Graph Feature

## OVERVIEW

Multi-phase pipeline that builds a browsable knowledge network from Zotero library papers. Extracts paper profiles, infers inter-paper relations, and canonicalizes method/dataset concepts.

## STRUCTURE

```
knowledge-graph/
├── index.ts               # Lifecycle: init, attach/detach, shutdown
├── KGPipeline.ts          # Core pipeline: processOne → processRelations → processCanonicalize
├── KGStore.ts             # JSON-file-backed state with schema versioning + migrations
├── KGRenderer.ts          # Renders graph into the KG window
├── KGWindow.ts            # XHTML dialog management (open/close/resize)
├── GraphCanvas.ts         # Cytoscape.js canvas wrapper
├── CurrentGraphView.ts    # Current-paper-focused subgraph view
├── ConceptCanonicalizer.ts # LLM-based concept merging
├── LibraryBrowser.ts      # Paper selection UI for adding to KG
├── ToolsMenu.ts           # Zotero Tools menu registration
└── ToolsMenu.ts           # Menu item for opening KG window
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Paper profiling prompt | `KGPipeline.ts:buildAnalysisMessages` | System prompt + user prompt construction |
| Relation extraction | `KGPipeline.ts:processRelations` | Batched pairwise comparison with LLM |
| Concept canonicalization | `KGPipeline.ts:processCanonicalize` | Merges method/dataset aliases across papers |
| State schema + migrations | `KGStore.ts:normalizeLoadedState` | Handles v1→current schema upgrades |
| Edge types | `KGStore.ts:KGEdgeType` | `extends`, `applies`, `same-problem`, `same-dataset`, etc. |
| PDF text extraction for KG | `KGPipeline.ts:readBestFullText` | Zotero full-text index → PDFWorker fallback |
| Reference parsing | `KGPipeline.ts:parseReferenceEntries` | Extracts bibliography from PDF text |
| Domain classification | `KGPipeline.ts:DOMAIN_BUCKETS` | Keyword-based bucket system for research domains |

## CONVENTIONS

- **Pipeline phases**: `pending` → `summarized` → `relations` → `canonicalized`. Each paper tracks its own phase independently.
- **Schema versioning**: `profileSchemaVersion`, `relationsVocabVersion`, `conceptCanonicalVersion`, `domainBucketsVersion` — bumping any triggers re-processing of affected papers.
- **Edge evidence**: Every `KGEdge` carries `evidence` (text quote), `rationale` (why), and `sourceFields` (which prompt fields produced it).
- **Paper identity aliases**: `buildPaperIdentityAliases()` generates title variants for cross-paper matching.
- **Deterministic edges**: `buildDeterministicPaperEdges()` creates edges from reference overlap without LLM — supplements LLM-inferred relations.
- **KGStore is a singleton**: `kgStore` exported from `KGStore.ts`. All mutations go through its methods, which call `notify()` → triggers pipeline re-scan.

## ANTI-PATTERNS

- **Never skip PDF extraction**: The pipeline is PDF-first. Only papers without any PDF attachment fall back to abstract-only analysis.
- **Don't mutate state directly**: Always use `KGStore` methods (`updatePaper`, `setEdgesFrom`, `replaceConcepts`) — they handle persistence and notification.
- **Rate limiting**: `COOLDOWN_MS` and `RELATION_CHUNK_COOLDOWN_MS` exist — don't remove the delays between LLM calls.
