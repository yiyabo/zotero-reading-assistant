/**
 * Knowledge-Graph persistent store.
 * ----------------------------------------------------------------------------
 * The KG is treated as a long-lived, append-friendly artifact that the user
 * grows paper by paper. State is serialized as a single JSON file on disk so
 * that closing the window, restarting Zotero, or reinstalling the plugin (as
 * long as the data directory survives) preserves the user's progress.
 *
 * Storage layout
 * --------------
 *   <Zotero data dir>/zotero-reading-assistant/kg-state.json
 *
 * Why a JSON file (not Zotero.Prefs)?
 *   - Prefs cap at ~few KB before they become slow on startup.
 *   - JSON is trivially inspectable, exportable, and migratable.
 *   - We get atomic-ish writes via Zotero.File.putContentsAsync.
 *
 * Concurrency
 * -----------
 * All writes go through a chained `writeQueue` promise so concurrent edits
 * (e.g. the user spamming "+" on multiple papers) serialize cleanly without
 * each one needing its own lock.
 *
 * Stable identity
 * ---------------
 * We key papers by Zotero's `itemKey` (8-char string, stable across syncs)
 * rather than `itemID` (numeric, only stable within one Zotero install).
 * The numeric id is cached for the current session for fast lookup.
 */
import { config } from "../../../package.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KGPaperStatus = "pending" | "analyzing" | "ready" | "error";

/**
 * Per-paper analytical summary produced by stage-1 LLM analysis.
 *
 * Profile schema v10 is PDF-first and fills 12 focused fields with
 * role-tagged reference lists. Older profiles are detected at startup and
 * queued for re-analysis.
 */
export type PaperSummary = {
  // ---- Description ----
  domain?: string;
  problem?: string;
  targetTask?: string;
  abstract?: string;

  // ---- This paper's own output ----
  contributions?: string[];     // 3-5 substantive sentences (replaces contributions+keyClaims)
  ownedMethodNames?: string[];  // methods/models/systems the paper itself proposes
  proposedDatasets?: string[];  // datasets/benchmarks the paper itself releases

  // ---- References to prior work, with role tags ----
  referencedMethods?: ReferencedItem[];
  referencedDatasets?: ReferencedItem[];

  // ---- Pipeline & methodology ----
  pipeline?: PipelineStep[];    // ordered steps of the paper's method pipeline
  methodology?: string[];       // core methodology insights / design principles

  // ---- Data analysis ----
  datasetDetails?: DatasetDetail[];  // detailed description of each dataset used
  dataFlow?: DataFlowStep[];         // how data flows through the pipeline

  // ---- Citations & supporting context ----
  limitations?: string[];
  keywords?: string[];

  // ---- Pipeline diagram (generated on demand) ----
  pipelineDiagramUrl?: string;  // URL of the generated pipeline flowchart image

  // ---- Legacy fields from pre-role-tagged schemas ----
  /** @deprecated */
  references?: PaperReference[];
  /** @deprecated */
  methods?: string[];
  /** @deprecated */
  citedMethods?: string[];
  /** @deprecated */
  extendsFrom?: string[];
  /** @deprecated */
  baselines?: string[];
  /** @deprecated */
  datasets?: string[];
  /** @deprecated */
  benchmarks?: string[];
  /** @deprecated */
  comparedAgainst?: string[];
  /** @deprecated */
  contrastingApproaches?: string[];
  /** @deprecated */
  citedPapers?: string[];
  /** @deprecated */
  inputs?: string[];
  /** @deprecated */
  outputs?: string[];
  /** @deprecated */
  metrics?: string[];
  /** @deprecated */
  modelArchitecture?: string;
  /** @deprecated */
  conclusions?: string[];
  /** @deprecated */
  keyClaims?: string[];
};

/**
 * Single named method or dataset that a paper references. The role tag
 * tells downstream code (concept-canonicalizer, edge builder, UI) what
 * kind of relationship the paper has with the named entity.
 */
export type ReferencedItem = {
  name: string;
  role: "used" | "extended" | "compared-baseline" | "cited-only";
  evidence?: string;
};

export type PipelineStep = {
  step: number;
  name: string;
  description: string;
};

export type DatasetDetail = {
  name: string;
  description: string;
  scale?: string;
  format?: string;
  source?: string;
};

export type DataFlowStep = {
  step: number;
  name: string;
  description: string;
};

export type PaperReference = {
  raw: string;
  title?: string;
  authors?: string;
  year?: string;
  venue?: string;
  doi?: string;
  matchedItemKey?: string;
  matchConfidence?: number;
};

export type KGConceptType = "method" | "dataset" | "task" | "concept";

/**
 * Canonicalized concept node — a method/dataset/task that bridges multiple
 * papers. Built by Stage 3 of the pipeline (ConceptCanonicalizer).
 *
 * `id` is a stable canonical id derived from the canonical label after LLM
 * disambiguation, so two papers using "AlphaFold" and "AlphaFold2" can be
 * linked to a shared concept rather than two separate slug nodes.
 *
 * Visual layer renders concept nodes only when `degree >= 2` so the graph
 * stays clean — orphan concepts (one source paper) are persisted in state
 * but hidden by GraphCanvas.
 */
export type KGConceptNode = {
  id: string;
  type: KGConceptType;
  /** Canonical display name chosen by Stage 3 (e.g. "AlphaFold"). */
  canonicalLabel: string;
  /** All raw alias strings that were merged into this concept. */
  aliases: string[];
  /** One-sentence Chinese description set by the canonicalizer. */
  description?: string;
  /** Distinct paper itemKeys that mention any of the aliases. */
  sourcePaperKeys: string[];
  /** Cached `sourcePaperKeys.length`; the visual layer filters on this. */
  degree: number;
  /**
   * Optional related-concept ids the canonicalizer flagged as "related but
   * not the same" (e.g. AlphaFold ↔ AlphaFold2). Future feature; not
   * currently rendered as edges.
   */
  relatedConceptIds?: string[];
  /**
   * Source paper picked as the canonical "first appearance" — chosen by
   * Stage 3 as the strongest-role-edge paper (proposed > extended >
   * compared-baseline > used). The detail panel renders this as
   * "首次出现于：<title>" with a click-through to the paper node.
   */
  representativePaperKey?: string;
  /** @deprecated Use `canonicalLabel`. Retained for one-version transition. */
  label?: string;
};

export type KGPaperState = {
  itemKey: string;
  itemID: number; // session-cached; may be stale after a Zotero re-key event
  title: string;
  metaLine: string; // formatted "Smith et al. · 2024 · Nature"
  addedAt: number;
  status: KGPaperStatus;
  summary?: PaperSummary;
  /** Schema version used to produce `summary`. Bump triggers re-analysis. */
  profileVersion?: number;
  errorMsg?: string;
  /**
   * Unix-ms timestamp when this paper's outgoing relationships were last
   * computed. Absent means the relations pass hasn't run yet.
   */
  relationsAt?: number;
  /**
   * Cached domain string (mirrors `summary.domain`) hoisted to top level so
   * the visual layer can drive layout/colour without traversing summary.
   * Refreshed on every `updatePaper` call that includes `summary`.
   */
  domain?: string;
};

/**
 * Categorical label for a relationship in the graph.
 *
 * Vocabulary v7 splits into two layers:
 *   - paper → paper (5 types)
 *       directed: cites
 *       symmetric: similar-method, contrasts, uses-same-data,
 *                   solves-same-problem
 *   - paper → concept (2 types, role discriminates fine-grained semantics)
 *       method-link, dataset-link
 *
 * `shares-domain` was removed in v7; domain is now a node attribute
 * (KGPaperState.domain + per-domain colour from KGState.domainPalette)
 * rather than an edge type. The five method/dataset edge types from v6
 * (proposes-method, uses-method, extends-method, uses-dataset,
 * introduces-dataset) collapse into method-link / dataset-link with role.
 */
export type KGEdgeType =
  // paper → paper
  | "cites"
  | "similar-method"
  | "contrasts"
  | "uses-same-data"
  | "solves-same-problem"
  // paper → concept
  | "method-link"
  | "dataset-link";

export type KGEdgeRole =
  | "proposed"
  | "used"
  | "extended"
  | "compared-baseline"
  | "introduced";

export type KGEdge = {
  /** Source paper itemKey, OR concept id when a concept is the source. */
  from: string;
  /** Target paper itemKey OR concept id (for method-link / dataset-link). */
  to: string;
  type: KGEdgeType;
  /**
   * Optional role discriminator for paper→concept edges. Lets a single
   * `method-link` edge type encode "the paper proposed / used / extended /
   * compared against" the method.
   */
  role?: KGEdgeRole;
  /** 0..1 confidence/strength score. */
  strength: number;
  evidence?: string[];
  rationale?: string;
  sourceFields?: string[];
  matchedAliases?: string[];
  /** @deprecated v6 free-form Chinese label. UI now derives from type+role. */
  label?: string;
};

/** Persisted node positions, so a re-render doesn't reshuffle the layout. */
export type KGLayout = {
  [itemKey: string]: { x: number; y: number };
};

export type KGState = {
  /** Top-level shape version. v2 = three-layer redesign (profile schema 9). */
  version: 2;
  papers: KGPaperState[];
  concepts: KGConceptNode[];
  edges: KGEdge[];
  layout: KGLayout;
  /**
   * Stable mapping from `domain` string → palette colour. Computed lazily
   * by the visual layer (first time a domain is seen) and persisted so the
   * same domain always paints the same colour even after restart.
   */
  domainPalette: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /**
   * Bumped whenever the LLM relations vocabulary changes. v7 dropped
   * shares-domain + 5 method/dataset edge types in favour of role-tagged
   * method-link / dataset-link.
   */
  relationsVocabVersion?: number;
  /**
   * Persisted profile-schema version so we don't unconditionally re-run
   * stage 1 on every startup. Compared against CURRENT_PROFILE_SCHEMA_VERSION.
   */
  profileSchemaVersion?: number;
  /**
   * Persisted concept canonicalization version (Stage 3). When the canon
   * algorithm or LLM prompt changes, bump CURRENT_CONCEPT_CANONICAL_VERSION
   * and the pipeline re-runs canonicalize on next startup.
   */
  conceptCanonicalVersion?: number;
  /** Unix-ms timestamp of the most recent successful canonicalize pass. */
  canonicalizedAt?: number;
  /**
   * Persisted domain-bucket migration version. When the canonical bucket
   * list (`DOMAIN_BUCKETS` in KGPipeline) changes shape, bump
   * CURRENT_DOMAIN_BUCKETS_VERSION and the pipeline backfills `summary.domain`
   * for every ready paper without re-running stage 1.
   */
  domainBucketsVersion?: number;
  /**
   * Ephemeral pipeline phase. "stage3" is set while concept canonicalization
   * is running (LLM merge can take 1–2 minutes); UI uses this to surface a
   * non-blocking progress banner. Always reset to "idle" on load.
   */
  pipelinePhase?: "idle" | "stage3";
};

export type KGStoreListener = (state: KGState) => void;

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/** Resolve the on-disk path for the KG state JSON. Uses Zotero data dir. */
function resolveStateFilePath(): string {
  // `Zotero.DataDirectory.dir` is the canonical path; fall back to
  // `Zotero.Prefs.get('dataDir')` on older builds.
  const dataDir =
    (Zotero as any).DataDirectory?.dir ||
    (Zotero.Prefs as any).get?.("dataDir") ||
    "";
  if (!dataDir) {
    throw new Error("[RA] KGStore: no data directory available");
  }
  // PathUtils is a global in Zotero 7 (chrome contexts).
  const PU = (globalThis as any).PathUtils;
  if (PU?.join) {
    return PU.join(dataDir, "zotero-reading-assistant", "kg-state.json");
  }
  // Last-resort manual join (POSIX style); Zotero on macOS/Linux uses /, and
  // ChromeWorker File APIs accept forward slashes on Windows too.
  return dataDir.replace(/[\\/]+$/, "") + "/zotero-reading-assistant/kg-state.json";
}

async function ensureDirectoryFor(filePath: string): Promise<void> {
  const PU = (globalThis as any).PathUtils;
  const IOU = (globalThis as any).IOUtils;
  if (!PU?.parent || !IOU?.makeDirectory) return; // fallback: assume it exists
  const dir = PU.parent(filePath);
  await IOU.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
}

async function readJSONFile<T>(filePath: string): Promise<T | null> {
  try {
    const txt = await (Zotero.File as any).getContentsAsync(filePath);
    if (!txt) return null;
    return JSON.parse(txt) as T;
  } catch (e: any) {
    // ENOENT-ish errors come through with various messages depending on the
    // underlying API; treat any read failure as "no file yet".
    Zotero.debug("[RA] KGStore read miss: " + (e?.message || e));
    return null;
  }
}

async function writeJSONFile(filePath: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  await (Zotero.File as any).putContentsAsync(filePath, text);
}

// ---------------------------------------------------------------------------
// Initial-state factory
// ---------------------------------------------------------------------------

/** Bump this whenever the relations vocabulary or prompt rules change. */
export const CURRENT_RELATIONS_VOCAB_VERSION = 7;
export const CURRENT_PROFILE_SCHEMA_VERSION = 12;
// v2: emits `representativePaperKey` on every concept and prunes degree=1
// leaves at canonicalize time (see ConceptCanonicalizer). Bump again for
// any future shape change in concept output.
export const CURRENT_CONCEPT_CANONICAL_VERSION = 3;
/**
 * Bump this when the canonical domain bucket list changes (adding / merging
 * / renaming buckets). Triggers a one-shot backfill of `summary.domain` on
 * every ready paper at startup; no LLM call is needed.
 */
export const CURRENT_DOMAIN_BUCKETS_VERSION = 1;

function makeEmptyState(): KGState {
  const now = Date.now();
  return {
    version: 2,
    relationsVocabVersion: CURRENT_RELATIONS_VOCAB_VERSION,
    profileSchemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    conceptCanonicalVersion: CURRENT_CONCEPT_CANONICAL_VERSION,
    domainBucketsVersion: CURRENT_DOMAIN_BUCKETS_VERSION,
    papers: [],
    concepts: [],
    edges: [],
    layout: {},
    domainPalette: {},
    pipelinePhase: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Defensive normalizer + v1 → v2 migration.
 *
 * v2 (this version): three-layer redesign with role-tagged paper→concept
 * edges, canonicalized concept nodes, and domain promoted to a node
 * attribute. When loading a v1 file we keep paper rows + saved layout but
 * wipe edges/concepts because both old vocabularies are now invalid; the
 * pipeline will rebuild them under the new schema.
 */
function normalizeLoadedState(raw: any): KGState {
  const base = makeEmptyState();
  if (!raw || typeof raw !== "object") return base;

  const onDiskVersion =
    typeof raw.version === "number" ? raw.version : 1;
  const isV1 = onDiskVersion < 2;

  // Papers always survive (re-analyzed in stage 1 if profileVersion is old).
  // We strip per-paper concepts/relationsAt so the pipeline retriggers them
  // under the new schema; layout positions for paper nodes are preserved.
  const papers: KGPaperState[] = Array.isArray(raw.papers)
    ? raw.papers.filter(isValidPaper).map((p: any) => normalizePaper(p, isV1))
    : [];

  // v1 → v2: wipe concepts and edges; they'll be rebuilt by stages 2+3.
  const concepts: KGConceptNode[] = isV1
    ? []
    : Array.isArray(raw.concepts)
      ? raw.concepts.filter(isValidConcept).map(normalizeConcept)
      : [];
  const edges: KGEdge[] = isV1
    ? []
    : Array.isArray(raw.edges)
      ? raw.edges.filter(isValidEdge)
      : [];
  fillRepresentativePaperKeys(concepts, edges);

  return {
    version: 2,
    relationsVocabVersion:
      typeof raw.relationsVocabVersion === "number" && !isV1
        ? raw.relationsVocabVersion
        : 0,
    profileSchemaVersion:
      typeof raw.profileSchemaVersion === "number" && !isV1
        ? raw.profileSchemaVersion
        : 0,
    conceptCanonicalVersion:
      typeof raw.conceptCanonicalVersion === "number" && !isV1
        ? raw.conceptCanonicalVersion
        : 0,
    canonicalizedAt:
      typeof raw.canonicalizedAt === "number" && !isV1
        ? raw.canonicalizedAt
        : undefined,
    domainBucketsVersion:
      typeof raw.domainBucketsVersion === "number" && !isV1
        ? raw.domainBucketsVersion
        : 0,
    // Always reset on load: a half-finished stage-3 from a previous session
    // is not still running here.
    pipelinePhase: "idle",
    papers,
    concepts,
    edges,
    layout: raw.layout && typeof raw.layout === "object" ? raw.layout : {},
    domainPalette:
      raw.domainPalette && typeof raw.domainPalette === "object"
        ? raw.domainPalette
        : {},
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : base.updatedAt,
  };
}

function fillRepresentativePaperKeys(concepts: KGConceptNode[], edges: KGEdge[]): void {
  if (concepts.length === 0) return;
  const conceptIds = new Set(concepts.map((c) => c.id));
  const roleRank: Record<string, number> = {
    proposed: 5,
    introduced: 5,
    extended: 4,
    "compared-baseline": 3,
    used: 2,
    "cited-only": 1,
  };
  const best = new Map<string, { rank: number; paperKey: string }>();
  for (const e of edges) {
    if (!conceptIds.has(e.to)) continue;
    const rank = e.role ? roleRank[e.role] ?? 0 : 0;
    const cur = best.get(e.to);
    if (!cur || rank > cur.rank) best.set(e.to, { rank, paperKey: e.from });
  }
  for (const c of concepts) {
    if (c.representativePaperKey) continue;
    const pick = best.get(c.id);
    c.representativePaperKey = pick?.paperKey || c.sourcePaperKeys[0];
  }
}

function normalizePaper(p: any, isV1Migration: boolean): KGPaperState {
  const out: KGPaperState = {
    itemKey: String(p.itemKey),
    itemID: typeof p.itemID === "number" ? p.itemID : 0,
    title: String(p.title || ""),
    metaLine: String(p.metaLine || ""),
    addedAt: typeof p.addedAt === "number" ? p.addedAt : Date.now(),
    status: p.status === "ready" || p.status === "analyzing" || p.status === "error"
      ? p.status
      : "pending",
    summary: p.summary && typeof p.summary === "object" ? p.summary : undefined,
    profileVersion: typeof p.profileVersion === "number" ? p.profileVersion : 0,
    errorMsg: typeof p.errorMsg === "string" ? p.errorMsg : undefined,
    relationsAt: isV1Migration
      ? undefined
      : typeof p.relationsAt === "number"
        ? p.relationsAt
        : undefined,
    domain:
      typeof p.domain === "string"
        ? p.domain
        : typeof p.summary?.domain === "string"
          ? p.summary.domain
          : undefined,
  };
  return out;
}

function normalizeConcept(c: any): KGConceptNode {
  const aliases: string[] = Array.isArray(c.aliases) ? c.aliases.filter(Boolean) : [];
  const sourcePaperKeys: string[] = Array.isArray(c.sourcePaperKeys)
    ? c.sourcePaperKeys.filter(Boolean)
    : [];
  const canonicalLabel: string =
    typeof c.canonicalLabel === "string" && c.canonicalLabel.trim()
      ? c.canonicalLabel.trim()
      : typeof c.label === "string"
        ? c.label.trim()
        : c.id;
  return {
    id: String(c.id),
    type: (c.type === "method" || c.type === "dataset" || c.type === "task" || c.type === "concept")
      ? c.type
      : "concept",
    canonicalLabel,
    aliases,
    description: typeof c.description === "string" ? c.description : undefined,
    sourcePaperKeys,
    degree: typeof c.degree === "number" ? c.degree : sourcePaperKeys.length,
    relatedConceptIds: Array.isArray(c.relatedConceptIds)
      ? c.relatedConceptIds.filter(Boolean)
      : undefined,
    representativePaperKey:
      typeof c.representativePaperKey === "string" && c.representativePaperKey
        ? c.representativePaperKey
        : undefined,
  };
}

function isValidPaper(p: any): p is KGPaperState {
  return (
    p &&
    typeof p.itemKey === "string" &&
    typeof p.title === "string" &&
    typeof p.addedAt === "number"
  );
}
function isValidEdge(e: any): e is KGEdge {
  return e && typeof e.from === "string" && typeof e.to === "string" && typeof e.type === "string";
}

function isValidConcept(c: any): boolean {
  return c && typeof c.id === "string" && (typeof c.canonicalLabel === "string" || typeof c.label === "string");
}

// ---------------------------------------------------------------------------
// Store class (singleton via the module-level export)
// ---------------------------------------------------------------------------

class KGStore {
  private state: KGState = makeEmptyState();
  private listeners = new Set<KGStoreListener>();
  private filePath: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  /**
   * Resolve the storage path, ensure the directory exists, and load the
   * on-disk state. Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.filePath = resolveStateFilePath();
      await ensureDirectoryFor(this.filePath);
      const loaded = await readJSONFile<KGState>(this.filePath);
      const hadEphemeralPipelinePhase =
        Boolean(loaded && Object.prototype.hasOwnProperty.call(loaded, "pipelinePhase"));
      const hadMissingRepresentativePaperKey =
        Boolean(
          loaded &&
            Array.isArray((loaded as any).concepts) &&
            (loaded as any).concepts.some((c: any) => c && !c.representativePaperKey),
        );
      this.state = loaded ? normalizeLoadedState(loaded) : makeEmptyState();
      if (hadEphemeralPipelinePhase || hadMissingRepresentativePaperKey) {
        await this.persist();
      }
    } catch (e: any) {
      Zotero.debug("[RA] KGStore init error: " + (e?.message || e));
      this.state = makeEmptyState();
    } finally {
      this.initialized = true;
    }
    Zotero.debug(
      `[RA] KGStore init: ${this.state.papers.length} papers, ` +
        `${this.state.edges.length} edges (${this.filePath})`,
    );
  }

  /** Returns the live state. Treat as read-only — mutations bypass the queue. */
  getState(): KGState {
    return this.state;
  }

  hasPaper(itemKey: string): boolean {
    return this.state.papers.some((p) => p.itemKey === itemKey);
  }

  /**
   * Append the given Zotero items to the KG with `status="pending"`. Items
   * that are already present (matched by itemKey) are skipped silently.
   * Returns the freshly-added paper states (for the caller to dispatch
   * stage-1 analysis on, in M3+).
   */
  async addPapers(items: Zotero.Item[]): Promise<KGPaperState[]> {
    const added: KGPaperState[] = [];
    for (const item of items) {
      const key = (item as any).key;
      if (!key || this.hasPaper(key)) continue;
      const paper: KGPaperState = {
        itemKey: key,
        itemID: (item as any).id,
        title: String((item as any).getDisplayTitle?.() || "(untitled)"),
        metaLine: formatItemMeta(item),
        addedAt: Date.now(),
        status: "pending",
      };
      this.state.papers.push(paper);
      added.push(paper);
    }
    if (added.length > 0) {
      this.state.updatedAt = Date.now();
      await this.persist();
      this.notify();
    }
    return added;
  }

  async removePaper(itemKey: string): Promise<void> {
    const before = this.state.papers.length;
    this.state.papers = this.state.papers.filter((p) => p.itemKey !== itemKey);
    if (this.state.papers.length === before) return;
    this.state.edges = this.state.edges.filter(
      (e) => e.from !== itemKey && e.to !== itemKey,
    );
    const usedConcepts = new Set<string>();
    for (const e of this.state.edges) {
      if (e.from.startsWith("concept:")) usedConcepts.add(e.from);
      if (e.to.startsWith("concept:")) usedConcepts.add(e.to);
    }
    this.state.concepts = this.state.concepts.filter((c) => usedConcepts.has(c.id));
    delete this.state.layout[itemKey];
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /**
   * Patch a paper's mutable fields. When `summary.domain` changes we
   * automatically mirror it onto the top-level `domain` field so the visual
   * layer (which drives node colour and fcose clustering) doesn't need to
   * dig into the summary.
   */
  async updatePaper(itemKey: string, patch: Partial<KGPaperState>): Promise<void> {
    const idx = this.state.papers.findIndex((p) => p.itemKey === itemKey);
    if (idx < 0) return;
    const prev = this.state.papers[idx];
    const next: KGPaperState = { ...prev, ...patch };
    if (patch.summary && next.summary) {
      const summaryDomain = next.summary.domain;
      if (typeof summaryDomain === "string" && summaryDomain.trim()) {
        next.domain = summaryDomain.trim();
      }
    }
    this.state.papers[idx] = next;
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /**
   * Replace all edges originating from `itemKey` with the given list. Use
   * this when the M4 pairwise-relationship pass produces a fresh batch of
   * connections for a newly-added paper.
   */
  async setEdgesFrom(itemKey: string, edges: KGEdge[]): Promise<void> {
    this.state.edges = this.state.edges.filter((e) => e.from !== itemKey);
    this.state.edges.push(...edges);
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /**
   * Merge a batch of concept nodes into existing state. For each new node:
   *   - If id exists, union aliases + sourcePaperKeys, refresh degree.
   *   - If id is new, append.
   *
   * Stage 3 (canonicalize) usually calls `replaceConcepts` instead so the
   * concept list reflects fresh canonical ids without leftover orphans.
   */
  async mergeConcepts(concepts: KGConceptNode[]): Promise<void> {
    if (concepts.length === 0) return;
    const byId = new Map<string, KGConceptNode>();
    for (const c of this.state.concepts) byId.set(c.id, c);
    for (const c of concepts) {
      const prev = byId.get(c.id);
      const aliases = mergeStringArrays(prev?.aliases, c.aliases) || [];
      const sourcePaperKeys = mergeStringArrays(prev?.sourcePaperKeys, c.sourcePaperKeys) || [];
      const merged: KGConceptNode = {
        id: c.id,
        type: c.type || prev?.type || "concept",
        canonicalLabel: c.canonicalLabel || prev?.canonicalLabel || c.id,
        aliases,
        description: c.description ?? prev?.description,
        sourcePaperKeys,
        degree: sourcePaperKeys.length,
        relatedConceptIds: mergeStringArrays(
          prev?.relatedConceptIds,
          c.relatedConceptIds,
        ),
      };
      byId.set(c.id, merged);
    }
    this.state.concepts = Array.from(byId.values()).sort(
      (a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel),
    );
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /**
   * Replace the entire concept list. Used by Stage 3 after canonicalization
   * produces a fresh set of canonical concepts (orphan / pre-canonical
   * concepts are dropped).
   */
  async replaceConcepts(concepts: KGConceptNode[]): Promise<void> {
    const sorted = [...concepts]
      .map((c) => ({ ...c, degree: (c.sourcePaperKeys || []).length }))
      .sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel));
    this.state.concepts = sorted;
    // Drop any layout positions for old concept ids that no longer exist.
    const validIds = new Set(sorted.map((c) => c.id));
    for (const id of Object.keys(this.state.layout)) {
      if (id.startsWith("concept:") && !validIds.has(id)) {
        delete this.state.layout[id];
      }
    }
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /**
   * Replace ALL edges in the graph atomically. Stage 3 uses this after
   * rebuilding paper→concept edges with new canonical concept ids; the
   * paper→paper edges are rebuilt outside Stage 3 and merged together.
   */
  async setAllEdges(edges: KGEdge[]): Promise<void> {
    this.state.edges = [...edges];
    this.state.updatedAt = Date.now();
    await this.persist();
    this.notify();
  }

  /** Persist a node's layout position (used by the cytoscape view in M5+). */
  async setLayoutPosition(itemKey: string, x: number, y: number): Promise<void> {
    this.state.layout[itemKey] = { x, y };
    this.state.updatedAt = Date.now();
    // Layout updates are noisy — persist but don't notify subscribers since
    // they don't visually depend on saved positions.
    await this.persist();
  }

  /**
   * Persist a new value for `relationsVocabVersion`. Called by the pipeline
   * after it finishes a vocab-bump migration so we don't repeat it on the
   * next startup.
   */
  async setRelationsVocabVersion(v: number): Promise<void> {
    this.state.relationsVocabVersion = v;
    this.state.updatedAt = Date.now();
    await this.persist();
    // No notify(): purely metadata, no UI dependents.
  }

  async setProfileSchemaVersion(v: number): Promise<void> {
    this.state.profileSchemaVersion = v;
    this.state.updatedAt = Date.now();
    await this.persist();
  }

  async setConceptCanonicalVersion(v: number): Promise<void> {
    this.state.conceptCanonicalVersion = v;
    this.state.updatedAt = Date.now();
    await this.persist();
  }

  async setCanonicalizedAt(t: number): Promise<void> {
    this.state.canonicalizedAt = t;
    this.state.updatedAt = Date.now();
    await this.persist();
  }

  async setDomainBucketsVersion(v: number): Promise<void> {
    this.state.domainBucketsVersion = v;
    this.state.updatedAt = Date.now();
    await this.persist();
    // No notify(): purely metadata, no UI dependents.
  }

  /**
   * Set ephemeral pipeline phase ("idle" / "stage3"). Notifies listeners so
   * the UI can render a progress banner, but does NOT persist (the field is
   * always reset to "idle" on load).
   */
  setPipelinePhase(phase: NonNullable<KGState["pipelinePhase"]>): void {
    if (this.state.pipelinePhase === phase) return;
    this.state.pipelinePhase = phase;
    this.notify();
  }

  /**
   * Persist a stable colour for `domain`. The visual layer assigns colours
   * lazily (first time a domain appears) and persists so the same domain
   * paints the same colour across restarts.
   */
  async setDomainColor(domain: string, color: string): Promise<void> {
    if (!domain) return;
    if (this.state.domainPalette[domain] === color) return;
    this.state.domainPalette[domain] = color;
    this.state.updatedAt = Date.now();
    await this.persist();
    // No notify(): the visual layer reads palette synchronously.
  }

  /** Wipe everything. Caller is responsible for confirming destructive UX. */
  async clear(): Promise<void> {
    this.state = makeEmptyState();
    await this.persist();
    this.notify();
  }

  subscribe(listener: KGStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const path = this.filePath;
    const snapshot = JSON.parse(JSON.stringify(this.state)) as KGState;
    delete snapshot.pipelinePhase;
    // Chain onto the existing queue so writes are serialized.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeJSONFile(path, snapshot);
      } catch (e: any) {
        Zotero.debug("[RA] KGStore persist error: " + (e?.message || e));
      }
    });
    return this.writeQueue;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l(this.state);
      } catch (e: any) {
        Zotero.debug("[RA] KGStore listener threw: " + (e?.message || e));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Display helper (re-implemented here to avoid a cross-feature import)
// ---------------------------------------------------------------------------

function formatItemMeta(item: any): string {
  const parts: string[] = [];
  const creators = item.getCreators?.() || [];
  if (creators.length > 0) {
    const first = creators[0];
    const name = first.lastName || first.name || "";
    if (name) parts.push(creators.length > 1 ? `${name} et al.` : name);
  }
  const year = String(item.getField?.("date") || "").match(/\d{4}/)?.[0];
  if (year) parts.push(year);
  const venue =
    item.getField?.("publicationTitle") ||
    item.getField?.("conferenceName") ||
    item.getField?.("publisher") ||
    "";
  if (venue) parts.push(String(venue));
  return parts.join(" \u00b7 ");
}

function mergeStringArrays(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const out = new Set<string>();
  for (const v of a || []) if (v) out.add(v);
  for (const v of b || []) if (v) out.add(v);
  return out.size ? Array.from(out) : undefined;
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Module-level singleton. Importers must call `await kgStore.init()` once at
 * plugin startup before using any read/write methods.
 */
export const kgStore = new KGStore();

// Expose a stable name for debugging in Zotero's console.
try {
  (Zotero as any)[`${config.addonInstance}_kgStore`] = kgStore;
} catch (_) {}
