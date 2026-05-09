# Knowledge Graph v2 — Architecture & Migration Notes

This document captures the v2 redesign of the knowledge-graph feature, the
migration model that turns v1 state into v2 state without losing user data,
and the small set of versioned vocabularies that gate stage-by-stage
re-runs. Keep it close to the code; bump the version constants below when
the corresponding contract changes.

## Three-stage pipeline

The system is split into three independent stages running serially behind
one queue (see `KGPipeline.ts → scan / tick`).

1. **Stage 1 — single-paper extraction.** For each `pending` paper, call
   the LLM to fill `PaperSummary` (profile schema **v10**: 12 focused
   fields with role-tagged `referencedMethods` / `referencedDatasets`;
   extraction now falls back to direct PDFWorker full-text when Zotero's
   full-text index is missing).
   Output is canonical: `domain` is funnelled into one of the eight
   `DOMAIN_BUCKETS` defined in `KGPipeline.ts`.
2. **Stage 2 — pairwise relations.** For each `ready` paper that lacks
   `relationsAt`, the LLM proposes paper→paper edges from the v7 vocab
   (`cites`, `shares-domain`, `similar-method`, `contrasts`, `uses-same-data`,
   `solves-same-problem`, `method-link`, `dataset-link`). Method/dataset
   edges (`method-link`, `dataset-link`) are *placeholders* — the
   concrete targets are filled in by Stage 3.
3. **Stage 3 — concept canonicalization.** Once every ready paper has
   `relationsAt`, the pipeline runs `ConceptCanonicalizer.canonicalizeConcepts`:
   collect candidates → deterministic pre-cluster → LLM merge of pre-clusters
   → emit canonical concept nodes + paper→concept role-tagged edges. Bridges
   (degree ≥ 2) are kept; isolated leaves are pruned to keep
   `kg-state.json` lean.

## Versioned vocabularies (gate stage re-runs)

`KGStore.ts` exports four constants. The on-disk state remembers each
version it was produced under; on startup, any constant that's strictly
greater than the on-disk value triggers the matching migration.

| Constant                            | Current | What a bump triggers                                                |
| ----------------------------------- | ------- | ------------------------------------------------------------------- |
| `CURRENT_PROFILE_SCHEMA_VERSION`    | 10      | Reset every paper's `summary`; queue stage-1 re-analysis            |
| `CURRENT_RELATIONS_VOCAB_VERSION`   | 7       | Clear `relationsAt` everywhere; queue stage-2 full re-run           |
| `CURRENT_CONCEPT_CANONICAL_VERSION` | 2       | Set `canonicalizedAt = 0`; stage-3 re-runs after stage-2 is settled |
| `CURRENT_DOMAIN_BUCKETS_VERSION`    | 1       | One-shot regex backfill of `summary.domain` (no LLM call)           |

The first three are persistent migrations triggered at `runPipeline` startup.
The fourth is the lightweight one — bucket vocabulary is keyword-driven, so
we can rewrite every paper's `domain` in milliseconds.

## State shape (v2)

`KGState` (`KGStore.ts`):

- `papers: KGPaperState[]` — per-paper rows including `summary` + `relationsAt`.
- `concepts: KGConceptNode[]` — Stage-3 output. Each carries
  `canonicalLabel`, deduped `aliases`, `sourcePaperKeys`, cached `degree`,
  and `representativePaperKey` (the strongest-role source paper, used by
  the "首次出现于" link in the UI).
- `edges: KGEdge[]` — both paper→paper (Stage 2) and paper→concept
  (Stage 3) live here. The visual layer disambiguates by node type.
- `domainPalette: Record<string,string>` — stable
  domain → colour map. Filled lazily by `GraphCanvas` on first sighting
  of a domain so colours stay consistent across restarts.
- `pipelinePhase: "idle" | "stage3"` — **ephemeral**. Reset to `"idle"`
  on every load. Used by `CurrentGraphView` to render the Stage-3
  progress banner.

## Domain buckets

Eight canonical buckets ordered narrow → broad:

```text
药物发现与对接    drug-discovery
蛋白质结构与设计  protein-structure
分子建模与生成    molecular-modeling
大语言模型与智能体 llm-agents
计算化学          comp-chem
计算生物学        comp-bio
机器学习方法      ml-methods
其他              (fallback)
```

`normalizeDomain(raw)` in `KGPipeline.ts` is the single entry point. It
runs at three places:

1. Stage-1 parser (`parseAnalysisResponse`) — every fresh LLM response.
2. Migration `backfillDomainBuckets` — every existing ready paper at startup.
3. `DOMAIN_BUCKET_LIST_TEXT` injected into the Stage-1 prompt — steers the
   LLM toward the same vocabulary.

To add a bucket: append to `DOMAIN_BUCKETS`, bump
`CURRENT_DOMAIN_BUCKETS_VERSION`. The next launch backfills automatically.

## Concept canonicalization invariants

`ConceptCanonicalizer.canonicalizeConcepts` returns
`{ concepts, edges, metrics }` and guarantees:

- `concepts` contains **only** canonical nodes with `degree ≥ 2`. Single-
  source concepts are dropped along with their paper→concept edges.
- Every `concept.id` referenced by an edge in `edges` is present in
  `concepts` (no dangling targets).
- Each concept has `representativePaperKey` set to the source paper with
  the strongest role pointing at it (rank: `proposed` / `introduced` >
  `extended` > `compared-baseline` > `used` > `cited-only`).
- `metrics.prunedLeaves` reports how many concepts were dropped, which
  the pipeline logs to `/tmp/ra-bootstrap.log`.

## Race-free Stage-3 commit ordering

`processCanonicalize` writes results in this exact order to avoid the
double-canonicalize race we hit during the v2 bring-up:

1. `setConceptCanonicalVersion(CURRENT)` — no notify.
2. `setCanonicalizedAt(now)` — no notify.
3. `replaceConcepts(result.concepts)` — notifies; scan sees fresh flags.
4. `setAllEdges([...paperPaperEdges, ...result.edges])` — notifies.

Because (3) and (4) are the only methods that fire `notify()`, scan
listeners always observe a settled `canonicalStale = false` and never
re-queue stage-3.

## UI surface

Three view modes (`GraphCanvas.ts → ViewMode`):

- `papers-only` — only paper nodes; useful for citation-style overview.
- `papers+datasets` — papers plus dataset bridge concepts.
- `full` — papers + every bridge concept (default).

Edge chips are grouped into five clusters in `CurrentGraphView.ts →
CHIP_GROUPS`; concept hot-list (top bridges by degree) renders above
the empty detail panel. Stage-3 banner appears between stat row and chip
row whenever `pipelinePhase === "stage3"`.

## File layout

```text
src/features/knowledge-graph/
  KGStore.ts              # state shape, versions, persist
  KGPipeline.ts           # stage 1/2/3 orchestration, prompts, migrations
  ConceptCanonicalizer.ts # stage 3: collect → pre-cluster → LLM → emit
  GraphCanvas.ts          # cytoscape rendering, view modes, layout
  CurrentGraphView.ts     # detail panel, chips, hot-list, banner
  KGRenderer.ts           # all CSS (scoped to ${ref}-kg-* prefix)
  KGWindow.ts             # dialog shell
  ToolsMenu.ts            # Tools menu entry point
  index.ts                # public re-exports
  LibraryBrowser.ts       # "+ 加入更多论文" picker
```
