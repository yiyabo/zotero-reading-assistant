/**
 * Stage 3 — Global concept canonicalization.
 * ----------------------------------------------------------------------------
 * Stage 1 produces per-paper raw alias lists (`ownedMethodNames`,
 * `proposedDatasets`, `referencedMethods[*].name`, `referencedDatasets[*].name`).
 * Those raw aliases overlap heavily across papers ("AlphaFold" / "AlphaFold v2"
 * / "AF" / "alphafold2") but the v1 store happily created a fresh slug node
 * for every spelling, which is why 96% of concepts ended up as orphans.
 *
 * This module runs once after stage 1+2 finish and before stage 4 rebuilds
 * paper→concept edges. It:
 *
 *   3a — Collect candidates from every ready paper.
 *   3b — Deterministically pre-cluster candidates that are obviously the same
 *        thing (normalized string equality, substring containment, token
 *        overlap, type match).
 *   3c — Send the pre-clusters to the LLM in one (or chunked) prompt and ask
 *        it to assign canonical labels, merge equivalent clusters, and flag
 *        related-but-distinct clusters (e.g. AlphaFold ↔ AlphaFold2).
 *   3d — Build canonical KGConceptNode + paper→concept KGEdge lists.
 *
 * The output never silently loses a candidate: anything the LLM doesn't place
 * falls back to a deterministic singleton concept.
 */
import type { Message } from "../../modules/llm/types";
import { getLLMManager } from "../../modules/llm/LLMManager";
import { fileLog } from "../../utils/fileLog";
import {
  type KGConceptNode,
  type KGConceptType,
  type KGEdge,
  type KGEdgeRole,
  type KGPaperState,
} from "./KGStore";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Stage 3 LLM prompt cap on number of clusters per call. */
const CANON_CHUNK_SIZE = 80;

/** Soft per-cluster character cap when building the prompt. */
const CANON_CLUSTER_PROMPT_CHARS = 320;

/** Cooldown between chunked canonicalize calls. */
const CANON_CHUNK_COOLDOWN_MS = 2000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type RawCandidate = {
  rawAlias: string;
  type: KGConceptType;
  paperKey: string;
  role: KGEdgeRole;
  evidence?: string;
};

type RawCluster = {
  /** Temp id used inside this stage; not persisted. */
  tempId: string;
  type: KGConceptType;
  members: RawCandidate[];
  /** Distinct alias surface forms (deduped, casing preserved). */
  surfaceForms: string[];
};

type CanonicalCluster = {
  canonicalLabel: string;
  type: KGConceptType;
  description?: string;
  /** Which RawCluster temp ids merged into this canonical cluster. */
  mergedTempIds: string[];
  relatedCanonicalLabels?: string[];
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function canonicalizeConcepts(papers: KGPaperState[]): Promise<{
  concepts: KGConceptNode[];
  edges: KGEdge[];
  metrics: { rawCandidates: number; preClusters: number; canonicalClusters: number; llmCalls: number; prunedLeaves: number };
}> {
  const candidates = collectCandidates(papers);
  if (candidates.length === 0) {
    return {
      concepts: [],
      edges: [],
      metrics: { rawCandidates: 0, preClusters: 0, canonicalClusters: 0, llmCalls: 0, prunedLeaves: 0 },
    };
  }

  const preClusters = preClusterCandidates(candidates);
  fileLog(
    `ConceptCanonicalizer: ${candidates.length} candidates → ${preClusters.length} pre-clusters`,
  );

  let canonicalClusters: CanonicalCluster[];
  let llmCalls = 0;
  try {
    const r = await runLLMCanonicalize(preClusters);
    canonicalClusters = r.clusters;
    llmCalls = r.llmCalls;
  } catch (e: any) {
    fileLog("ConceptCanonicalizer: LLM canonicalize failed, falling back to pre-clusters: " + (e?.message || e));
    canonicalClusters = preClusters.map(fallbackCluster);
  }

  // Anything the LLM dropped: fall back to its pre-cluster.
  const emittedTempIds = new Set(canonicalClusters.flatMap((c) => c.mergedTempIds));
  for (const pc of preClusters) {
    if (!emittedTempIds.has(pc.tempId)) {
      canonicalClusters.push(fallbackCluster(pc));
    }
  }

  const { concepts, edges } = assembleConceptsAndEdges(
    canonicalClusters,
    preClusters,
    candidates,
  );

  // Pick a representative paper for each concept. Priority is the strongest
  // role pointing at the concept (proposed > introduced > extended >
  // compared-baseline > used > cited-only). Falls back to the first source
  // paper. This drives the "首次出现于" line in the concept detail panel.
  attachRepresentativePapers(concepts, edges);

  // Prune concepts that are anchored to a single paper. The visual layer
  // already hides them in every view mode (CONCEPT_DEGREE_THRESHOLD=2), so
  // keeping them in the persisted graph just bloats kg-state.json without
  // any user-visible benefit. We drop both the concept node AND its
  // outbound paper→concept edges so the on-disk state stays consistent.
  const { prunedConcepts, prunedEdges, prunedLeaves } = pruneIsolatedLeaves(
    concepts,
    edges,
  );

  fileLog(
    `ConceptCanonicalizer: emitted ${prunedConcepts.length} canonical concepts (pruned ${prunedLeaves} leaves), ${prunedEdges.length} paper→concept edges`,
  );
  return {
    concepts: prunedConcepts,
    edges: prunedEdges,
    metrics: {
      rawCandidates: candidates.length,
      preClusters: preClusters.length,
      canonicalClusters: canonicalClusters.length,
      llmCalls,
      prunedLeaves,
    },
  };
}

/**
 * Walk the produced edges and assign each concept's `representativePaperKey`
 * to whichever source paper has the strongest role pointing at it. The
 * priority mirrors strengthForRole — proposed > extended > compared-baseline
 * > used. Mutates concepts in place.
 */
function attachRepresentativePapers(concepts: KGConceptNode[], edges: KGEdge[]): void {
  const ROLE_RANK: Record<string, number> = {
    proposed: 5,
    introduced: 5,
    extended: 4,
    "compared-baseline": 3,
    used: 2,
    "cited-only": 1,
  };
  // index: conceptId → best (rank, paperKey)
  const best = new Map<string, { rank: number; paperKey: string }>();
  for (const e of edges) {
    if (!e.role) continue;
    const rank = ROLE_RANK[e.role] ?? 0;
    const cur = best.get(e.to);
    if (!cur || rank > cur.rank) {
      best.set(e.to, { rank, paperKey: e.from });
    }
  }
  for (const c of concepts) {
    const pick = best.get(c.id);
    if (pick) {
      c.representativePaperKey = pick.paperKey;
    } else if (c.sourcePaperKeys && c.sourcePaperKeys.length > 0) {
      c.representativePaperKey = c.sourcePaperKeys[0];
    }
  }
}

/**
 * Drop concepts whose degree (= unique source-paper count) is below 2 along
 * with every paper→concept edge that targets one of them. Concepts merged
 * from the LLM phase keep their `degree` field already, so this is a single
 * O(N) scan.
 */
function pruneIsolatedLeaves(
  concepts: KGConceptNode[],
  edges: KGEdge[],
): { prunedConcepts: KGConceptNode[]; prunedEdges: KGEdge[]; prunedLeaves: number } {
  const keep = new Set<string>();
  for (const c of concepts) {
    if ((c.degree || 0) >= 2) keep.add(c.id);
  }
  const prunedLeaves = concepts.length - keep.size;
  if (prunedLeaves === 0) {
    return { prunedConcepts: concepts, prunedEdges: edges, prunedLeaves: 0 };
  }
  const prunedConcepts = concepts.filter((c) => keep.has(c.id));
  const prunedEdges = edges.filter((e) => keep.has(e.to));
  return { prunedConcepts, prunedEdges, prunedLeaves };
}

// ---------------------------------------------------------------------------
// 3a — Collect candidates
// ---------------------------------------------------------------------------

function collectCandidates(papers: KGPaperState[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const paper of papers) {
    if (paper.status !== "ready" || !paper.summary) continue;
    const s = paper.summary;
    pushCandidates(out, s.ownedMethodNames, "method", paper.itemKey, "proposed");
    pushCandidates(out, s.proposedDatasets, "dataset", paper.itemKey, "introduced");
    if (Array.isArray(s.referencedMethods)) {
      for (const item of s.referencedMethods) {
        if (!item || typeof item.name !== "string") continue;
        const role: KGEdgeRole =
          item.role === "extended"
            ? "extended"
            : item.role === "compared-baseline"
              ? "compared-baseline"
              : "used";
        addCandidate(out, item.name, "method", paper.itemKey, role, item.evidence);
      }
    }
    if (Array.isArray(s.referencedDatasets)) {
      for (const item of s.referencedDatasets) {
        if (!item || typeof item.name !== "string") continue;
        const role: KGEdgeRole =
          item.role === "extended"
            ? "extended"
            : item.role === "compared-baseline"
              ? "compared-baseline"
              : "used";
        addCandidate(out, item.name, "dataset", paper.itemKey, role, item.evidence);
      }
    }
  }
  return out;
}

function pushCandidates(
  out: RawCandidate[],
  values: string[] | undefined,
  type: KGConceptType,
  paperKey: string,
  role: KGEdgeRole,
): void {
  if (!Array.isArray(values)) return;
  for (const v of values) addCandidate(out, v, type, paperKey, role);
}

function addCandidate(
  out: RawCandidate[],
  rawAlias: string,
  type: KGConceptType,
  paperKey: string,
  role: KGEdgeRole,
  evidence?: string,
): void {
  const cleaned = String(rawAlias || "").trim();
  if (!cleaned) return;
  if (!isLikelyConcept(cleaned)) return;
  out.push({ rawAlias: cleaned, type, paperKey, role, evidence: evidence?.slice(0, 240) });
}

/**
 * Reject candidates that look like LLM-generated descriptions (parentheticals
 * with numerics, oversized phrases, generic stop words) instead of concept
 * names. Designed to be conservative: better to drop a borderline phrase
 * than to spawn yet another orphan concept node.
 */
export function isLikelyConcept(value: string): boolean {
  const v = value.trim();
  if (v.length < 2 || v.length > 80) return false;
  // Sentence punctuation suggests a description, not a name.
  if (/[。！？；]/.test(v)) return false;
  if (/[（(]\s*[\d>~约≈]/.test(v)) return false;
  if (/^\d+(\.\d+)?\s*(万|亿|million|billion|k)/i.test(v)) return false;
  // 8+ tokens (CJK or whitespace-split) reads as a phrase.
  const cjkChars = (v.match(/[\u4e00-\u9fff]/g) || []).length;
  const tokens = v.split(/\s+/).filter(Boolean);
  if (tokens.length > 8) return false;
  if (cjkChars > 18) return false;
  // Generic descriptive prefixes that the LLM emits as fake concepts.
  const descriptive = [
    /^自整理/,
    /^自建/,
    /^专属/,
    /^大规模/,
    /^大量/,
    /^海量/,
    /^新型/,
    /^某种/,
    /^某个/,
    /^一种/,
    /^一些/,
    /^约\s*\d/,
    /^超过\s*\d/,
    /^several\s+/i,
    /^various\s+/i,
    /^multiple\s+/i,
    /^certain\s+/i,
  ];
  for (const re of descriptive) if (re.test(v)) return false;
  // Pure stop words.
  const norm = normalizeForMatch(v);
  const generic = new Set([
    "protein",
    "proteins",
    "structure",
    "structures",
    "prediction",
    "model",
    "models",
    "modeling",
    "learning",
    "deep learning",
    "method",
    "methods",
    "transformer",
    "neural network",
    "graph neural network",
    "embedding",
    "embeddings",
    "pipeline",
    "framework",
    "system",
    "approach",
    "技术",
    "方法",
    "模型",
    "框架",
    "网络",
    "系统",
    "数据集",
    "数据",
    "技术路线",
  ]);
  if (generic.has(norm)) return false;
  // Must contain at least one informative letter or digit.
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 3b — Pre-cluster (deterministic)
// ---------------------------------------------------------------------------

function preClusterCandidates(candidates: RawCandidate[]): RawCluster[] {
  // Union-find keyed by candidate index. Two candidates merge if same type
  // and either:
  //   (a) normalizeForMatch produces equal strings (case/punct insensitive),
  //   (b) one's normalized form contains the other (and the shorter has
  //       length ≥ 4 to avoid "AI" matching everything),
  //   (c) token-set overlap ≥ 0.7 across normalized whitespace tokens.
  const n = candidates.length;
  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const norms = candidates.map((c) => normalizeForMatch(c.rawAlias));
  // Bucket by type+exact-norm for O(n) primary merging.
  const exactBuckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${candidates[i].type}\u0000${norms[i]}`;
    let arr = exactBuckets.get(key);
    if (!arr) {
      arr = [];
      exactBuckets.set(key, arr);
    }
    arr.push(i);
  }
  for (const arr of exactBuckets.values()) {
    for (let k = 1; k < arr.length; k++) union(arr[0], arr[k]);
  }

  // Substring containment + token-overlap pass (O(n^2) but n is small).
  const tokenSets = norms.map((n) => new Set(n.split(" ").filter((t) => t.length >= 3)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (candidates[i].type !== candidates[j].type) continue;
      if (find(i) === find(j)) continue;
      const a = norms[i];
      const b = norms[j];
      if (!a || !b) continue;
      // Substring containment with min length to avoid spurious "AI" matches.
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (shorter.length >= 4 && longer.includes(shorter)) {
        union(i, j);
        continue;
      }
      // Token-set Jaccard.
      const ts1 = tokenSets[i];
      const ts2 = tokenSets[j];
      if (ts1.size === 0 || ts2.size === 0) continue;
      let inter = 0;
      for (const t of ts1) if (ts2.has(t)) inter++;
      const union_ = ts1.size + ts2.size - inter;
      if (union_ > 0 && inter / union_ >= 0.7) union(i, j);
    }
  }

  // Materialize clusters.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let arr = groups.get(r);
    if (!arr) {
      arr = [];
      groups.set(r, arr);
    }
    arr.push(i);
  }
  const out: RawCluster[] = [];
  let idx = 0;
  for (const arr of groups.values()) {
    const members = arr.map((i) => candidates[i]);
    const seen = new Set<string>();
    const surfaceForms: string[] = [];
    for (const m of members) {
      const k = m.rawAlias.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      surfaceForms.push(m.rawAlias);
    }
    out.push({
      tempId: `T${++idx}`,
      type: members[0].type,
      members,
      surfaceForms,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3c — LLM canonicalize
// ---------------------------------------------------------------------------

const CANON_SYSTEM_PROMPT = [
  "You normalize a noisy list of method/dataset alias clusters extracted from",
  "research papers into clean canonical concepts. Output a single JSON array",
  "and nothing else (no markdown, no comments).",
  "",
  "For each canonical concept you decide on, you may merge multiple input",
  "clusters whose members refer to the same underlying entity (e.g. AlphaFold +",
  "alphafold + AF), but never merge clusters of different `type` values.",
  "Different versions of the same family (AlphaFold vs AlphaFold2 vs",
  "AlphaFold3) are SEPARATE canonical concepts, but list each other under",
  "`relatedConcepts`.",
  "",
  "Pick a Chinese-friendly canonical label that researchers actually use (model",
  "names like `AlphaFold`, `ESMFold`, `Diffusion Transformer`; dataset names",
  "like `PDBBind`, `ImageNet`). For Chinese-only concepts use Chinese.",
  "Provide a one-sentence Chinese description (≤40 chars).",
  "",
  "Reject clusters that are clearly descriptive phrases rather than named",
  "entities by omitting them from the output.",
].join("\n");

async function runLLMCanonicalize(preClusters: RawCluster[]): Promise<{
  clusters: CanonicalCluster[];
  llmCalls: number;
}> {
  const llm = getLLMManager();
  if (!llm.isReady()) throw new Error("LLM not configured");

  // Chunk if needed; usually preClusters ~150 fits one call comfortably.
  const chunks = chunkArray(preClusters, CANON_CHUNK_SIZE);
  const all: CanonicalCluster[] = [];
  let llmCalls = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const messages = buildCanonicalizeMessages(chunk);
    const raw = await runLLMOneShot(messages);
    llmCalls++;
    const parsed = parseCanonicalizeResponse(raw, chunk);
    all.push(...parsed);
    if (i < chunks.length - 1) await delay(CANON_CHUNK_COOLDOWN_MS);
  }
  return { clusters: all, llmCalls };
}

function buildCanonicalizeMessages(clusters: RawCluster[]): Message[] {
  const lines: string[] = [
    "TASK: Canonicalize the following concept clusters. Each cluster has a",
    "temp id, a type (method or dataset), the surface forms found across",
    "papers, and a sample of source paper titles to help disambiguate.",
    "",
    "Output a JSON array. Each element looks like:",
    "{",
    '  "canonicalLabel": "<Canonical name, e.g. AlphaFold>",',
    '  "type": "method" | "dataset" | "task" | "concept",',
    '  "description": "<≤40-char 中文 description>",',
    '  "mergedTempIds": ["T7","T18"],',
    '  "relatedCanonicalLabels": ["AlphaFold2"]',
    "}",
    "",
    "Rules:",
    "  - mergedTempIds must reference temp ids from the INPUT below; do not",
    "    invent new ids.",
    "  - Never merge clusters across types (method ≠ dataset).",
    "  - Different versions of the same model family are SEPARATE canonical",
    "    concepts; list each other under relatedCanonicalLabels.",
    "  - If a cluster is a descriptive phrase (not a named entity), omit it",
    "    from output entirely. Examples to drop:",
    "      \"自整理蛋白质-配体轨迹数据库\", \"大规模蒸馏数据集\", \"自建数据集\".",
    "  - Output strict JSON only — no markdown.",
    "",
    "==== INPUT CLUSTERS ====",
  ];
  for (const cluster of clusters) {
    const sample = sampleSurfaceForms(cluster.surfaceForms);
    const titleSet = new Set<string>();
    const titles: string[] = [];
    for (const m of cluster.members) {
      // Deduplicated paper-key list (titles unavailable here; KGPipeline can
      // pass them in via context, but key-only suffices for the LLM since
      // the cluster's surface forms are usually informative enough).
      if (titleSet.has(m.paperKey)) continue;
      titleSet.add(m.paperKey);
      titles.push(m.paperKey);
      if (titles.length >= 4) break;
    }
    const block = [
      `[${cluster.tempId}] type=${cluster.type}`,
      `  surfaceForms: ${sample.join(" | ")}`,
      `  papers: ${titles.join(", ")}`,
    ].join("\n");
    lines.push(truncate(block, CANON_CLUSTER_PROMPT_CHARS));
  }
  return [
    { role: "system", content: CANON_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

function sampleSurfaceForms(forms: string[]): string[] {
  if (forms.length <= 6) return forms;
  return [...forms.slice(0, 4), `…(+${forms.length - 4} more)`, forms[forms.length - 1]];
}

function parseCanonicalizeResponse(raw: string, chunk: RawCluster[]): CanonicalCluster[] {
  let text = String(raw || "").trim();
  if (!text) return [];
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    fileLog("ConceptCanonicalizer: LLM JSON parse failed: " + (e?.message || e));
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const validTempIds = new Set(chunk.map((c) => c.tempId));
  const validTypes = new Set<KGConceptType>(["method", "dataset", "task", "concept"]);
  const out: CanonicalCluster[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const canonicalLabel =
      typeof obj.canonicalLabel === "string" ? obj.canonicalLabel.trim() : "";
    if (!canonicalLabel) continue;
    const typeRaw = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "";
    if (!validTypes.has(typeRaw as KGConceptType)) continue;
    const merged = Array.isArray(obj.mergedTempIds)
      ? (obj.mergedTempIds as unknown[])
          .filter((x) => typeof x === "string")
          .map((x) => String(x))
          .filter((id) => validTempIds.has(id))
      : [];
    if (merged.length === 0) continue;
    out.push({
      canonicalLabel,
      type: typeRaw as KGConceptType,
      description: typeof obj.description === "string" ? obj.description.trim() : undefined,
      mergedTempIds: merged,
      relatedCanonicalLabels: Array.isArray(obj.relatedCanonicalLabels)
        ? (obj.relatedCanonicalLabels as unknown[]).filter((x) => typeof x === "string").map(String)
        : undefined,
    });
  }
  return out;
}

function fallbackCluster(pc: RawCluster): CanonicalCluster {
  // Pick the most-frequent surface form as label.
  const counts = new Map<string, number>();
  for (const m of pc.members) {
    counts.set(m.rawAlias, (counts.get(m.rawAlias) || 0) + 1);
  }
  let label = pc.surfaceForms[0] || pc.tempId;
  let best = -1;
  for (const [v, c] of counts.entries()) {
    if (c > best) {
      best = c;
      label = v;
    }
  }
  return {
    canonicalLabel: label,
    type: pc.type,
    mergedTempIds: [pc.tempId],
  };
}

// ---------------------------------------------------------------------------
// 3d — Assemble concepts + edges
// ---------------------------------------------------------------------------

function assembleConceptsAndEdges(
  canonicalClusters: CanonicalCluster[],
  preClusters: RawCluster[],
  candidates: RawCandidate[],
): { concepts: KGConceptNode[]; edges: KGEdge[] } {
  const preById = new Map<string, RawCluster>();
  for (const pc of preClusters) preById.set(pc.tempId, pc);

  // De-duplicate canonical labels: if the LLM emitted two clusters with the
  // exact same canonical label & type, merge them (rare but possible at chunk
  // boundaries).
  const byCanonId = new Map<string, CanonicalCluster>();
  for (const cc of canonicalClusters) {
    const key = `${cc.type}\u0000${normalizeForMatch(cc.canonicalLabel)}`;
    const existing = byCanonId.get(key);
    if (!existing) {
      byCanonId.set(key, cc);
    } else {
      existing.mergedTempIds.push(...cc.mergedTempIds);
      existing.relatedCanonicalLabels = uniq([
        ...(existing.relatedCanonicalLabels || []),
        ...(cc.relatedCanonicalLabels || []),
      ]);
    }
  }

  // Build canonical id → node + map every member candidate to its canonical id.
  const concepts: KGConceptNode[] = [];
  const tempIdToCanonical = new Map<string, string>();
  const labelToId = new Map<string, string>();

  for (const cc of byCanonId.values()) {
    const id = canonicalConceptId(cc.type, cc.canonicalLabel);
    const aliases = new Set<string>();
    const sourcePaperKeys = new Set<string>();
    for (const tid of cc.mergedTempIds) {
      tempIdToCanonical.set(tid, id);
      const pre = preById.get(tid);
      if (!pre) continue;
      for (const sf of pre.surfaceForms) aliases.add(sf);
      for (const m of pre.members) sourcePaperKeys.add(m.paperKey);
    }
    if (!aliases.has(cc.canonicalLabel)) aliases.add(cc.canonicalLabel);
    concepts.push({
      id,
      type: cc.type,
      canonicalLabel: cc.canonicalLabel,
      aliases: Array.from(aliases),
      description: cc.description,
      sourcePaperKeys: Array.from(sourcePaperKeys),
      degree: sourcePaperKeys.size,
    });
    labelToId.set(`${cc.type}\u0000${normalizeForMatch(cc.canonicalLabel)}`, id);
  }

  // Resolve relatedCanonicalLabels → ids (best-effort, only if the related
  // label exists in this batch as a canonical concept).
  for (const cc of byCanonId.values()) {
    if (!cc.relatedCanonicalLabels?.length) continue;
    const id = canonicalConceptId(cc.type, cc.canonicalLabel);
    const node = concepts.find((c) => c.id === id);
    if (!node) continue;
    const rel = cc.relatedCanonicalLabels
      .map((lbl) => labelToId.get(`${cc.type}\u0000${normalizeForMatch(lbl)}`))
      .filter((x): x is string => Boolean(x));
    if (rel.length) node.relatedConceptIds = uniq(rel);
  }

  // Build paper→concept edges from each candidate.
  // We emit at most one edge per (paper, concept, role) combination, picking
  // the strongest role (proposed > extended > compared-baseline > used) when
  // the same paper supplies multiple aliases of the same concept.
  type EdgeKey = string;
  const bestEdge = new Map<EdgeKey, KGEdge>();
  for (const cand of candidates) {
    // Find the temp cluster this candidate landed in by scanning preClusters
    // (small enough this is fine; candidates ~ a few hundred).
    let tempId: string | undefined;
    for (const pc of preClusters) {
      if (pc.members.includes(cand)) {
        tempId = pc.tempId;
        break;
      }
    }
    if (!tempId) continue;
    const conceptId = tempIdToCanonical.get(tempId);
    if (!conceptId) continue;
    const conceptNode = concepts.find((c) => c.id === conceptId);
    if (!conceptNode) continue;

    const edgeType = conceptNode.type === "dataset" ? "dataset-link" : "method-link";
    const key = `${cand.paperKey}\u0000${conceptId}\u0000${cand.role}`;
    const strength = strengthForRole(cand.role);
    const newEdge: KGEdge = {
      from: cand.paperKey,
      to: conceptId,
      type: edgeType,
      role: cand.role,
      strength,
      evidence: cand.evidence ? [cand.evidence] : undefined,
      rationale: rationaleForRole(cand.role, conceptNode.type),
      sourceFields: [`${cand.role}-${conceptNode.type}`],
      matchedAliases: [cand.rawAlias],
    };
    const existing = bestEdge.get(key);
    if (!existing || existing.strength < newEdge.strength) {
      bestEdge.set(key, newEdge);
    }
  }

  // Collapse multiple roles for the same paper-concept pair into a single
  // edge with the strongest role (proposed beats used, etc.).
  const ROLE_PRIORITY: Record<KGEdgeRole, number> = {
    proposed: 4,
    introduced: 4,
    extended: 3,
    "compared-baseline": 2,
    used: 1,
  };
  const collapsed = new Map<string, KGEdge>();
  for (const e of bestEdge.values()) {
    const k = `${e.from}\u0000${e.to}`;
    const cur = collapsed.get(k);
    if (!cur) {
      collapsed.set(k, e);
      continue;
    }
    const curR = (cur.role || "used") as KGEdgeRole;
    const newR = (e.role || "used") as KGEdgeRole;
    if (ROLE_PRIORITY[newR] > ROLE_PRIORITY[curR]) {
      collapsed.set(k, {
        ...e,
        evidence: uniq([...(cur.evidence || []), ...(e.evidence || [])]),
        matchedAliases: uniq([...(cur.matchedAliases || []), ...(e.matchedAliases || [])]),
      });
    } else {
      collapsed.set(k, {
        ...cur,
        evidence: uniq([...(cur.evidence || []), ...(e.evidence || [])]),
        matchedAliases: uniq([...(cur.matchedAliases || []), ...(e.matchedAliases || [])]),
      });
    }
  }

  return { concepts, edges: Array.from(collapsed.values()) };
}

function canonicalConceptId(type: KGConceptType, label: string): string {
  const slug = normalizeForMatch(label).replace(/\s+/g, "-").slice(0, 80);
  return `concept:${type}:${slug || label.slice(0, 40)}`;
}

function strengthForRole(role: KGEdgeRole): number {
  switch (role) {
    case "proposed":
    case "introduced":
      return 0.96;
    case "extended":
      return 0.85;
    case "compared-baseline":
      return 0.74;
    case "used":
      return 0.66;
  }
}

function rationaleForRole(role: KGEdgeRole, type: KGConceptType): string {
  const noun = type === "dataset" ? "数据" : "方法";
  switch (role) {
    case "proposed":
      return `本文自身提出该${noun}。`;
    case "introduced":
      return `本文自身发布该${noun}。`;
    case "extended":
      return `本文在该${noun}基础上发展/改进。`;
    case "compared-baseline":
      return `本文将该${noun}作为对照基线。`;
    case "used":
      return `本文使用了该${noun}。`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeForMatch(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "\u2026";
}

function runLLMOneShot(messages: Message[]): Promise<string> {
  const llm = getLLMManager();
  return new Promise<string>((resolve, reject) => {
    let acc = "";
    let settled = false;
    llm
      .chat(messages, {
        onToken: (t: string) => {
          acc += t;
        },
        onComplete: (full: string) => {
          if (settled) return;
          settled = true;
          resolve(full || acc);
        },
        onError: (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      })
      .catch((err: any) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
