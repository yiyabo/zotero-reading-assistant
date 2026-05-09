/**
 * Knowledge-Graph analysis pipeline (M3 — single-paper stage).
 * ----------------------------------------------------------------------------
 * The pipeline observes `kgStore` and, for every paper in `pending` state,
 * runs a one-shot LLM call that extracts a structured summary
 * (`PaperSummary`). It then writes the summary back to the store and flips
 * the paper's status to `ready` (or `error`).
 *
 * Design
 * ------
 *   - Single global queue, processed strictly serially. Concurrent LLM
 *     calls produce confusing UX and burn quota; one-at-a-time is plenty
 *     for an interactive tool. M4 may parallelize the pairwise pass.
 *   - The pipeline is reactive: KGStore.subscribe re-scans for new pending
 *     papers each notify, so the user can add more mid-flight and they
 *     queue automatically.
 *   - Crash recovery: on `start()`, any paper stuck in `analyzing`
 *     (because Zotero quit mid-call last session) is reset to `pending`.
 *   - LLM unavailable: each `pending` paper transitions to `error` with a
 *     descriptive message instead of blocking forever.
 *   - The pipeline never *removes* edges or papers — only reads & patches.
 *     KGStore is the only place mutating the persistent state.
 */
import { config } from "../../../package.json";
import { getLLMManager } from "../../modules/llm/LLMManager";
import type { Message } from "../../modules/llm/types";
import { fileLog } from "../../utils/fileLog";
import { canonicalizeConcepts, isLikelyConcept } from "./ConceptCanonicalizer";
import {
  CURRENT_CONCEPT_CANONICAL_VERSION,
  CURRENT_DOMAIN_BUCKETS_VERSION,
  CURRENT_PROFILE_SCHEMA_VERSION,
  CURRENT_RELATIONS_VOCAB_VERSION,
  kgStore,
  type KGEdge,
  type KGEdgeRole,
  type KGEdgeType,
  type KGPaperState,
  type PaperReference,
  type PaperSummary,
  type ReferencedItem,
} from "./KGStore";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_INDEXED_FULLTEXT_CHARS = 240000;
const MAX_BODY_CHARS = 42000;
const MAX_REFERENCE_CHARS = 28000;

/** Cap abstract length to keep prompts focused. */
const MAX_ABSTRACT_CHARS = 6000;

/** Throttle between papers to avoid hammering APIs / hitting rate limits. */
const COOLDOWN_MS = 3000;

const RELATION_CHUNK_COOLDOWN_MS = 3000;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Phase tag for queued work. The same worker handles both:
 *   - `"summary"` runs the M3 single-paper extraction.
 *   - `"relations"` runs the M4 pairwise comparison vs existing ready papers.
 * Tasks are processed strictly serially across both phases — relationship
 * passes can be heavy (multiple papers in one prompt), so we don't want to
 * stack them with summary calls.
 */
type PipelineTask = {
  /** Empty string when phase=canonicalize (it operates on the whole graph). */
  itemKey: string;
  phase: "summary" | "relations" | "canonicalize";
};

let running = false;
let processing = false;
let currentTask: PipelineTask | null = null;
const queue: PipelineTask[] = []; // FIFO of (itemKey, phase) pairs
let unsubscribe: (() => void) | null = null;

function inQueue(itemKey: string, phase: PipelineTask["phase"]): boolean {
  return queue.some((t) => t.itemKey === itemKey && t.phase === phase);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the pipeline. Idempotent; safe to call repeatedly. Resets any
 * crashed-mid-flight `analyzing` papers back to `pending` so they get a
 * second shot.
 */
export function startKGPipeline(): void {
  if (running) return;
  running = true;
  Zotero.debug("[RA] KGPipeline starting");

  const state = kgStore.getState();

  // Crash recovery: anything stuck in `analyzing` from a previous session.
  for (const p of state.papers) {
    if (p.status === "analyzing") {
      kgStore.updatePaper(p.itemKey, { status: "pending" }).catch(() => {});
    }
  }

  // KG vocab/schema migration. v1→v2 is handled inside `normalizeLoadedState`
  // (which already wiped edges/concepts). What's left here is to detect papers
  // whose `summary` was produced under an older PROFILE schema and queue them
  // for re-analysis under the new 12-field schema.
  const onDiskProfile = state.profileSchemaVersion ?? 0;
  if (onDiskProfile < CURRENT_PROFILE_SCHEMA_VERSION) {
    let queued = 0;
    for (const p of state.papers) {
      if (
        (p.profileVersion || 0) < CURRENT_PROFILE_SCHEMA_VERSION ||
        (p.status === "ready" && (!p.summary || summaryNeedsProfileUpgrade(p)))
      ) {
        queued++;
        kgStore
          .updatePaper(p.itemKey, {
            status: "pending",
            errorMsg: undefined,
            relationsAt: undefined,
          })
          .catch(() => {});
      }
    }
    fileLog(
      `KGPipeline: profile schema v${onDiskProfile} → v${CURRENT_PROFILE_SCHEMA_VERSION}: queued ${queued} papers for stage-1 re-analysis`,
    );
    if (queued > 0) {
      kgStore.setAllEdges([]).catch(() => {});
      kgStore.replaceConcepts([]).catch(() => {});
      kgStore.setCanonicalizedAt(0).catch(() => {});
    }
    kgStore.setProfileSchemaVersion(CURRENT_PROFILE_SCHEMA_VERSION).catch(() => {});
  }

  // Vocabulary-version migration. When `relationsVocabVersion` on disk is
  // older than the current code version, every paper's relations are stale.
  const onDiskVocab = state.relationsVocabVersion ?? 0;
  if (onDiskVocab < CURRENT_RELATIONS_VOCAB_VERSION) {
    let queued = 0;
    for (const p of state.papers) {
      if (p.relationsAt != null) {
        kgStore.updatePaper(p.itemKey, { relationsAt: undefined }).catch(() => {});
        queued++;
      }
    }
    kgStore.setRelationsVocabVersion(CURRENT_RELATIONS_VOCAB_VERSION).catch(() => {});
    fileLog(
      `KGPipeline: vocab v${onDiskVocab} → v${CURRENT_RELATIONS_VOCAB_VERSION}: queued ${queued} papers for full relations re-run`,
    );
  } else {
    fileLog(`KGPipeline: vocab v${onDiskVocab} up to date, skipping vocab migration`);
  }

  // Concept-canonicalization migration. When the canonical version is older
  // than current, mark canonicalizedAt as stale so the scan loop schedules a
  // canonicalize phase after relations finish.
  const onDiskCanonical = state.conceptCanonicalVersion ?? 0;
  if (onDiskCanonical < CURRENT_CONCEPT_CANONICAL_VERSION) {
    fileLog(
      `KGPipeline: concept canonical v${onDiskCanonical} → v${CURRENT_CONCEPT_CANONICAL_VERSION}: will rebuild concepts after stage-2`,
    );
    kgStore.setCanonicalizedAt(0).catch(() => {});
  }

  // Domain-buckets migration. The domain bucket vocabulary is small and
  // keyword-driven, so we can backfill `summary.domain` for every existing
  // ready paper without re-running stage 1. Triggered when the on-disk
  // version is older than CURRENT_DOMAIN_BUCKETS_VERSION.
  const onDiskDomain = state.domainBucketsVersion ?? 0;
  if (onDiskDomain < CURRENT_DOMAIN_BUCKETS_VERSION) {
    void backfillDomainBuckets(state);
  }

  unsubscribe = kgStore.subscribe((s) => scan(s));
  scan(kgStore.getState());

  // Expose for in-console debugging.
  try {
    (Zotero as any)[`${config.addonInstance}_kgPipeline`] = {
      processOne,
      processRelations,
      processCanonicalize,
      queue,
    };
  } catch (_) {}
}

/**
 * Stop the pipeline. Currently-running analysis is allowed to finish (the
 * worker can't be cancelled mid-LLM-call without complicating
 * cancellation), but no new work is dequeued after this returns.
 */
export function stopKGPipeline(): void {
  running = false;
  unsubscribe?.();
  unsubscribe = null;
  queue.length = 0;
}

/**
 * One-shot migration: rewrite every ready paper's `summary.domain` to a
 * canonical bucket label. The bucket vocabulary is regex-driven so we don't
 * need an LLM round-trip — this is what made the upgrade feasible without
 * forcing every user to wait through stage-1 again.
 *
 * Persists the bumped `domainBucketsVersion` only after every paper has been
 * patched, so a crash mid-loop simply restarts the migration on next launch.
 */
async function backfillDomainBuckets(state: ReturnType<typeof kgStore.getState>): Promise<void> {
  const before = state.domainBucketsVersion ?? 0;
  let changed = 0;
  for (const p of state.papers) {
    if (p.status !== "ready" || !p.summary) continue;
    const oldDomain = p.summary.domain;
    const newDomain = normalizeDomain(oldDomain);
    if (oldDomain === newDomain) continue;
    try {
      await kgStore.updatePaper(p.itemKey, {
        summary: { ...p.summary, domain: newDomain },
      });
      changed++;
    } catch (e: any) {
      Zotero.debug(`[RA] backfillDomainBuckets ${p.itemKey} error: ${e?.message || e}`);
    }
  }
  try {
    await kgStore.setDomainBucketsVersion(CURRENT_DOMAIN_BUCKETS_VERSION);
  } catch (_) {}
  fileLog(
    `KGPipeline: domain buckets v${before} → v${CURRENT_DOMAIN_BUCKETS_VERSION}: rewrote ${changed}/${state.papers.length} paper domains`,
  );
}

/**
 * Bump a retry to the head of the queue.
 *
 * Triggered from the UI's "重试分析" button. Without priority insertion,
 * a retry would land at the end of the queue behind any pending phase-2
 * relations passes for other papers — which can mean a several-minute
 * wait when you've just added a batch. The user expectation is "click
 * retry → see it immediately re-process", so we cut the line.
 *
 * Idempotent: removes any prior queued tasks for this itemKey before
 * inserting at the front, so spamming the button doesn't pile up.
 */
export function enqueueRetry(itemKey: string): void {
  if (!running) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].itemKey === itemKey) queue.splice(i, 1);
  }
  queue.unshift({ itemKey, phase: "summary" });
  void tick();
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function scan(state: ReturnType<typeof kgStore.getState>): void {
  if (!running) return;
  const hasSummaryWork = state.papers.some((p) => p.status === "pending" || p.status === "analyzing");
  for (const p of state.papers) {
    // Phase 1: paper still needs summary.
    if (p.status === "pending" && !inQueue(p.itemKey, "summary")) {
      queue.push({ itemKey: p.itemKey, phase: "summary" });
    }
  }
  if (hasSummaryWork) {
    void tick();
    return;
  }
  for (const p of state.papers) {
    // Phase 2: paper has a summary but hasn't had its relations pass yet.
    if (
      p.status === "ready" &&
      p.summary &&
      p.relationsAt == null &&
      !inQueue(p.itemKey, "relations")
    ) {
      queue.push({ itemKey: p.itemKey, phase: "relations" });
    }
  }
  // Phase 3: when all summary+relations are done and concept canonicalization
  // is stale (or never run), schedule one canonicalize task. We gate on every
  // ready paper having relationsAt set so we only canonicalize once per
  // settled graph, not after every individual paper.
  const allRelationsDone =
    state.papers.length > 0 &&
    state.papers.every(
      (p) => p.status !== "ready" || p.summary == null || p.relationsAt != null,
    );
  const hasReadyPaper = state.papers.some((p) => p.status === "ready" && p.summary);
  const canonicalStale =
    (state.conceptCanonicalVersion ?? 0) < CURRENT_CONCEPT_CANONICAL_VERSION ||
    (state.canonicalizedAt ?? 0) === 0;
  if (
    allRelationsDone &&
    hasReadyPaper &&
    canonicalStale &&
    currentTask?.phase !== "canonicalize" &&
    !inQueue("", "canonicalize") &&
    queue.length === 0
  ) {
    queue.push({ itemKey: "", phase: "canonicalize" });
  }
  void tick();
}

async function tick(): Promise<void> {
  if (!running || processing) return;
  const next = queue.shift();
  if (!next) return;
  processing = true;
  currentTask = next;
  try {
    if (next.phase === "summary") {
      await processOne(next.itemKey);
    } else if (next.phase === "relations") {
      await processRelations(next.itemKey);
    } else if (next.phase === "canonicalize") {
      await processCanonicalize();
    }
  } catch (e: any) {
    Zotero.debug("[RA] KGPipeline tick error: " + (e?.message || e));
  } finally {
    processing = false;
    currentTask = null;
    if (running && queue.length > 0) {
      setTimeout(() => void tick(), COOLDOWN_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-paper analysis
// ---------------------------------------------------------------------------

/**
 * Run one full analysis cycle for the given paper. Tolerates the paper
 * having been removed or status-changed between dequeue and start.
 */
async function processOne(itemKey: string): Promise<void> {
  // Re-read state in case the paper was removed/edited while queued.
  const paper = kgStore.getState().papers.find((p) => p.itemKey === itemKey);
  if (!paper || paper.status !== "pending") return;

  Zotero.debug(`[RA] KGPipeline processing ${itemKey}: ${paper.title}`);
  await kgStore.updatePaper(itemKey, { status: "analyzing", errorMsg: undefined });

  try {
    const llm = getLLMManager();
    if (!llm.isReady()) {
      throw new Error("LLM not configured. Set API key/model in Preferences.");
    }

    const item = await resolveItem(paper);
    if (!item) {
      throw new Error("Item no longer exists in your Zotero library.");
    }

    const content = await extractPaperContent(item);
    if (content.pdfAttachmentCount > 0 && !content.fullText) {
      throw new Error(
        "PDF attachment exists, but neither Zotero full-text index nor direct PDF text extraction produced readable text. Open/reindex the PDF or replace the attachment.",
      );
    }
    if (content.pdfAttachmentCount === 0 && !content.abstract) {
      throw new Error("No PDF attachment or abstract available for this paper.");
    }

    const messages = buildAnalysisMessages(content);
    const response = await runLLMOneShot(messages);
    const summary = parseAnalysisResponse(response);
    summary.references = mergeReferences(summary.references, content.parsedReferences);
    if (!isUsableSummary(summary)) {
      throw new Error("LLM response was not usable JSON. Try re-adding.");
    }

    await kgStore.updatePaper(itemKey, {
      status: "ready",
      summary,
      profileVersion: CURRENT_PROFILE_SCHEMA_VERSION,
      errorMsg: undefined,
    });
    Zotero.debug(`[RA] KGPipeline ready: ${itemKey}`);
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 240);
    Zotero.debug(`[RA] KGPipeline error on ${itemKey}: ${msg}`);
    await kgStore.updatePaper(itemKey, {
      status: "error",
      errorMsg: msg,
    });
  }
}

/**
 * Look up the live Zotero.Item for a stored paper. Prefers the cached
 * numeric `itemID`, but falls back to the (stable) `itemKey` lookup if the
 * cache miss-matches (e.g. paper restored from trash, sync re-key event).
 */
async function resolveItem(paper: KGPaperState): Promise<any | null> {
  try {
    if (paper.itemID != null) {
      const cached = (Zotero.Items as any).get?.(paper.itemID);
      if (cached && cached.key === paper.itemKey && !cached.deleted) return cached;
    }
    const libID = (Zotero as any).Libraries?.userLibraryID;
    const item = await (Zotero.Items as any).getByLibraryAndKeyAsync?.(libID, paper.itemKey);
    return item || null;
  } catch (e: any) {
    Zotero.debug("[RA] resolveItem error: " + (e?.message || e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

type ExtractedPaperContent = {
  title: string;
  authors: string;
  year: string;
  venue: string;
  abstract: string;
  fullText: string;
  referenceText: string;
  parsedReferences: PaperReference[];
  pdfAttachmentCount: number;
  usedDirectPdfExtraction: boolean;
};

type FullTextReadResult = {
  text: string;
  pdfAttachmentCount: number;
  usedDirectPdfExtraction: boolean;
};

/**
 * Pull metadata + best-available text from a Zotero item. PDF content is
 * preferred and required whenever a PDF attachment exists: first use Zotero's
 * full-text index, then fall back to direct PDFWorker extraction. Abstract-only
 * analysis is kept only for rare library items with no PDF attachment.
 */
async function extractPaperContent(item: any): Promise<ExtractedPaperContent> {
  const title = String(item.getDisplayTitle?.() || item.getField?.("title") || "");
  const creators = item.getCreators?.() || [];
  const authors = creators
    .map((c: any) => `${c.firstName || ""} ${c.lastName || c.name || ""}`.trim())
    .filter(Boolean)
    .join(", ");
  const year = String(item.getField?.("date") || "").match(/\d{4}/)?.[0] || "";
  const venue = String(
    item.getField?.("publicationTitle") ||
      item.getField?.("conferenceName") ||
      item.getField?.("publisher") ||
      "",
  );
  const abstract = String(item.getField?.("abstractNote") || "").slice(0, MAX_ABSTRACT_CHARS);

  const fullTextResult = await readBestFullText(item);
  const referenceText = extractReferenceSection(fullTextResult.text);
  const parsedReferences = parseReferenceEntries(referenceText);
  const fullText = buildFullTextExcerpt(fullTextResult.text, referenceText);

  return {
    title,
    authors,
    year,
    venue,
    abstract,
    fullText,
    referenceText,
    parsedReferences,
    pdfAttachmentCount: fullTextResult.pdfAttachmentCount,
    usedDirectPdfExtraction: fullTextResult.usedDirectPdfExtraction,
  };
}

/**
 * Read full text from attachments. Zotero's full-text index is fastest; for
 * unindexed PDFs, call Zotero.PDFWorker directly so references/body text are
 * still available for KG extraction.
 */
async function readBestFullText(item: any): Promise<FullTextReadResult> {
  const result: FullTextReadResult = {
    text: "",
    pdfAttachmentCount: 0,
    usedDirectPdfExtraction: false,
  };
  try {
    const attachmentIDs = item.getAttachments?.() || [];
    if (!attachmentIDs.length) return result;
    let combined = "";
    for (const attID of attachmentIDs) {
      const att = (Zotero.Items as any).get?.(attID);
      if (!att) continue;
      const isPdf = isPdfAttachment(att);
      if (isPdf) result.pdfAttachmentCount++;
      try {
        const ft = await (Zotero.Fulltext as any).getItemFullText?.(att.id);
        const txt = typeof ft === "string" ? ft : ft?.text || "";
        if (txt) {
          combined += (combined ? "\n\n" : "") + String(txt);
          continue;
        }
      } catch (_) {
      }
      if (!isPdf) continue;
      const directText = await readPdfWorkerFullText(att);
      if (directText) {
        result.usedDirectPdfExtraction = true;
        combined += (combined ? "\n\n" : "") + directText;
        scheduleFullTextIndex(att);
      }
    }
    result.text = trimIndexedFullText(combined);
    return result;
  } catch (e: any) {
    Zotero.debug("[RA] readBestFullText error: " + (e?.message || e));
    return result;
  }
}

function isPdfAttachment(att: any): boolean {
  try {
    if (typeof att.isPDFAttachment === "function") return !!att.isPDFAttachment();
  } catch (_) {}
  const contentType = String(att.attachmentContentType || "");
  if (contentType.toLowerCase() === "application/pdf") return true;
  const path = String(att.attachmentPath || att.path || "");
  return path.toLowerCase().endsWith(".pdf");
}

async function readPdfWorkerFullText(att: any): Promise<string> {
  try {
    const worker = (Zotero as any).PDFWorker;
    if (!worker || typeof worker.getFullText !== "function") return "";
    const extracted = await worker.getFullText(att.id, null, true);
    const text = String(extracted?.text || "");
    if (!text.trim()) return "";
    fileLog(
      `KGPipeline: direct PDF text extracted attachment=${att.key || att.id} chars=${text.length} pages=${extracted?.extractedPages || 0}/${extracted?.totalPages || 0}`,
    );
    return text;
  } catch (e: any) {
    fileLog(`KGPipeline: direct PDF text extraction failed attachment=${att?.key || att?.id}: ${e?.message || e}`);
    return "";
  }
}

function scheduleFullTextIndex(att: any): void {
  try {
    const fulltext = (Zotero.Fulltext as any);
    if (typeof fulltext?.indexItems !== "function") return;
    void fulltext.indexItems([att.id], { complete: true, ignoreErrors: true }).catch((e: any) => {
      fileLog(`KGPipeline: background fulltext indexing failed attachment=${att?.key || att?.id}: ${e?.message || e}`);
    });
  } catch (_) {}
}

function trimIndexedFullText(text: string): string {
  const raw = String(text || "");
  if (raw.length <= MAX_INDEXED_FULLTEXT_CHARS) return raw;
  const headChars = Math.floor(MAX_INDEXED_FULLTEXT_CHARS * 0.58);
  const tailChars = MAX_INDEXED_FULLTEXT_CHARS - headChars;
  return [
    raw.slice(0, headChars),
    "\n\n[... indexed full text middle omitted; tail retained for References parsing ...]\n\n",
    raw.slice(Math.max(0, raw.length - tailChars)),
  ].join("");
}

function buildFullTextExcerpt(text: string, referenceText: string): string {
  const raw = String(text || "");
  if (!raw) return "";
  const refStart = referenceText ? raw.lastIndexOf(referenceText.slice(0, Math.min(200, referenceText.length))) : -1;
  const body = refStart > 0 ? raw.slice(0, refStart) : raw;
  if (body.length <= MAX_BODY_CHARS) return body;
  const head = body.slice(0, Math.floor(MAX_BODY_CHARS * 0.52));
  const midStart = Math.max(0, Math.floor(body.length * 0.42));
  const mid = body.slice(midStart, midStart + Math.floor(MAX_BODY_CHARS * 0.2));
  const tail = body.slice(Math.max(0, body.length - Math.floor(MAX_BODY_CHARS * 0.28)));
  return [head, "\n\n[... middle excerpt ...]\n\n", mid, "\n\n[... late body excerpt ...]\n\n", tail].join("");
}

function extractReferenceSection(text: string): string {
  const raw = String(text || "");
  if (!raw) return "";
  const matches = Array.from(raw.matchAll(/(?:^|\n)\s*(references|bibliography|literature cited|works cited)\s*(?:\n|$)/gi));
  if (matches.length > 0) {
    const start = matches[matches.length - 1].index || 0;
    return raw.slice(start, start + MAX_REFERENCE_CHARS);
  }
  const inlineMatches = Array.from(raw.matchAll(/\b(references|bibliography|literature cited|works cited)\b/gi));
  if (inlineMatches.length > 0) {
    const start = inlineMatches[inlineMatches.length - 1].index || 0;
    return raw.slice(start, start + MAX_REFERENCE_CHARS);
  }
  return raw.slice(Math.max(0, raw.length - MAX_REFERENCE_CHARS));
}

function parseReferenceEntries(referenceText: string): PaperReference[] {
  const raw = String(referenceText || "")
    .replace(/\r/g, "\n")
    .replace(/^\s*(references|bibliography|literature cited|works cited)\b[:\s]*/i, "");
  if (!raw.trim()) return [];
  const lines = raw
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const entries: string[] = [];
  let current = "";
  for (const line of lines) {
    const startsNew =
      /^\[\d+\]\s+/.test(line) ||
      /^\d+\.\s+/.test(line) ||
      /^[A-Z][A-Za-z'’`-]+,\s+[A-Z]/.test(line) ||
      /^doi\s*:/i.test(line);
    if (startsNew && current.length > 80) {
      entries.push(current.trim());
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current.trim()) entries.push(current.trim());
  const compact = raw.replace(/\s+/g, " ").trim();
  const numbered = compact
    .split(/(?=(?:\[\d{1,3}\]|\b\d{1,3}\.\s+[A-Z][A-Za-z]))/g)
    .map((x) => x.trim())
    .filter((x) => /^(?:\[\d{1,3}\]|\d{1,3}\.)/.test(x) && x.length > 25);
  const authorYear = compact
    .split(/(?=\b[A-Z][A-Za-z'’`-]{2,}(?:,\s+[A-Z][A-Za-z'’`-]+|,\s+[A-Z]\.| et al\.| and [A-Z][A-Za-z'’`-]+).{0,140}\b(?:19|20)\d{2}\b)/g)
    .map((x) => x.trim())
    .filter((x) => /\b(?:19|20)\d{2}\b/.test(x) && x.length > 45);
  const candidateEntries = numbered.length >= 3 ? numbered : authorYear.length >= 3 ? authorYear : entries;
  return candidateEntries
    .map(parseReferenceEntry)
    .filter((r) => r.raw.length > 20 && (r.title || r.year || r.doi))
    .slice(0, 100);
}

function parseReferenceEntry(rawEntry: string): PaperReference {
  const raw = rawEntry.replace(/\s+/g, " ").replace(/^(?:\[\d{1,3}\]|\d{1,3}\.)\s*/, "").trim();
  const doi = raw.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0];
  const year = raw.match(/\b(19|20)\d{2}\b/)?.[0];
  const sentenceParts = raw
    .split(/\.\s+/)
    .map((x) => x.trim())
    .map(cleanReferenceTitleCandidate)
    .filter((x) => looksLikeReferenceTitle(x));
  const title = chooseReferenceTitle(sentenceParts);
  const authors = year ? raw.slice(0, raw.indexOf(year)).replace(/[().,\s]+$/, "").trim() : undefined;
  return {
    raw,
    title: title || undefined,
    authors: authors || undefined,
    year,
    doi,
  };
}

function cleanReferenceTitleCandidate(value: string): string {
  return String(value || "")
    .replace(/^(?:\[\d{1,3}\]|\d{1,3}\.)\s*/, "")
    .replace(/^[\s()[\].,;:]+/, "")
    .replace(/\s+[\[(]?(?:19|20)\d{2}[)\]]?$/, "")
    .replace(/\.$/, "")
    .trim();
}

function looksLikeReferenceTitle(value: string): boolean {
  const v = String(value || "").trim();
  if (v.length < 18 || v.length > 240) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (/\bdoi\b|https?:\/\/|www\./i.test(v)) return false;
  if (/^(in|proceedings|journal|conference|arxiv|biorxiv|medrxiv|nature|science|cell|bioinformatics|nucleic acids research|lecture notes)\b/i.test(v)) return false;
  if (/^[A-Z][A-Za-z'’`-]+,\s+[A-Z](?:\.|\s)/.test(v) && (v.match(/,/g) || []).length >= 2) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  return true;
}

function chooseReferenceTitle(candidates: string[]): string {
  let best = "";
  let bestScore = -Infinity;
  for (const c of candidates) {
    const words = c.split(/\s+/).filter(Boolean);
    let score = Math.min(c.length, 160) + words.length * 4;
    if (/[a-z]/.test(c)) score += 20;
    if (/\b(protein|structure|prediction|learning|model|design|binding|docking|generation|molecular|language|deep|neural|graph)\b/i.test(c)) score += 25;
    if ((c.match(/,/g) || []).length > 3) score -= 35;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Domain canonicalization (Stage 1 post-processing)
// ---------------------------------------------------------------------------

/**
 * Canonical domain buckets. The Stage-1 LLM is asked to pick from this list;
 * a regex pass below maps any free-text domain it returns into the same
 * vocabulary. Keeping the bucket count small keeps the GraphCanvas colour
 * scheme legible — earlier free-text domains produced 12 ad-hoc labels for
 * 47 papers with strong semantic overlap (生物信息学 vs 计算生物学 vs 结构
 * 生物信息学), which broke the "papers in the same area share a colour" story.
 *
 * Order matters: the first matching bucket wins. Place narrow buckets
 * (drug-discovery, llm-agents) before broader ones (ml-methods).
 */
const DOMAIN_BUCKETS: { id: string; label: string; keywords: RegExp[] }[] = [
  {
    id: "drug-discovery",
    label: "药物发现与对接",
    keywords: [
      /药物(发现|设计|筛选|研发)/,
      /对接|docking/i,
      /induced[\s-]*fit/i,
      /配体|ligand/i,
      /结合(位点|亲和|姿态)|binding[\s-]*(site|pose|affinity)/i,
      /virtual[\s-]*screen/i,
    ],
  },
  {
    id: "protein-structure",
    label: "蛋白质结构与设计",
    keywords: [
      /蛋白(质)?(结构|设计|折叠|动态|工程)/,
      /蛋白(质)?语言模型/,
      /protein.{0,5}(structure|design|fold|engineering|language)/i,
      /结构生物(信息|学)/,
    ],
  },
  {
    id: "molecular-modeling",
    label: "分子建模与生成",
    keywords: [
      /分子(建模|生成|动力学|动态|表示|机器学习)/,
      /molecul/i,
      /conform/i,
      /流匹配|flow[\s-]*match/i,
      /扩散模型|diffusion[\s-]*(model|generative)/i,
      /生成(模型|式)/,
    ],
  },
  {
    id: "llm-agents",
    label: "大语言模型与智能体",
    keywords: [
      /大语言模型|大模型|\bLLM\b/i,
      /智能体|\bagent\b/i,
      /retrieval[\s-]*aug|RAG\b/i,
      /对话|chat[\s-]*bot|prompt(ing)?/i,
    ],
  },
  {
    id: "comp-chem",
    label: "计算化学",
    keywords: [
      /计算化学|量子化学/,
      /quantum[\s-]*chem/i,
      /\bDFT\b/i,
      /分子动力学|\bMD\b/,
    ],
  },
  {
    id: "comp-bio",
    label: "计算生物学",
    keywords: [
      /计算生物(学)?/,
      /生物信息(学)?/,
      /comput.{0,5}biolog/i,
      /bioinformatics/i,
      /omics|基因组|序列分析/i,
    ],
  },
  {
    id: "ml-methods",
    label: "机器学习方法",
    keywords: [
      /机器学习|深度学习|神经网络/,
      /machine[\s-]*learning|deep[\s-]*learning/i,
      /\bGNN\b|图神经/i,
      /transformer/i,
      /自监督|对比学习|self[\s-]*supervis|contrastive/i,
    ],
  },
];

/**
 * Map any LLM-emitted domain string into one of the canonical bucket labels.
 * Falls back to "其他" if no pattern matches. Used both at Stage-1 parse time
 * (forward) and at startup migration time (backfill of existing summaries).
 */
export function normalizeDomain(raw: string | undefined | null): string {
  if (!raw) return "其他";
  const s = String(raw).trim();
  if (!s) return "其他";
  // Already canonical? Cheap fast-path.
  for (const b of DOMAIN_BUCKETS) {
    if (s === b.label) return b.label;
  }
  for (const b of DOMAIN_BUCKETS) {
    if (b.keywords.some((re) => re.test(s))) return b.label;
  }
  return "其他";
}

/** Comma-joined bucket label list to embed in the Stage-1 prompt. */
const DOMAIN_BUCKET_LIST_TEXT = DOMAIN_BUCKETS.map((b) => b.label).join(" / ") + " / 其他";

// ---------------------------------------------------------------------------
// Prompting & response parsing
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a precise research assistant that extracts structured information from academic papers " +
  "for a knowledge graph (profile schema v10). You always respond with a single valid JSON object " +
  "and no other text — no Markdown, no commentary, no code fences. If a field cannot be reliably " +
  "determined, include it with an empty string \"\" or empty array []. Be concise but specific. " +
  "IMPORTANT: All natural-language values (domain, problem, targetTask, contributions, limitations, " +
  "keywords, evidence) MUST be written in Simplified Chinese (简体中文), even if the input paper is " +
  "in English. Keep proper nouns, model/dataset names, and well-known acronyms (e.g. BERT, GNN, " +
  "AlphaFold, PDBBind) in their original form.";

function buildAnalysisMessages(content: ExtractedPaperContent): Message[] {
  const userPrompt = [
    "请分析下面这篇论文，并返回一个严格符合此 schema 的 JSON 对象（仅返回 JSON，不要 markdown，不要解释）：",
    "",
    "{",
    `  "domain": "从以下固定枚举中选择最合适的一个（中文）：${DOMAIN_BUCKET_LIST_TEXT}。如果都不合适请填 '其他'。",`,
    '  "problem": "1 句话描述这篇论文要解决的核心问题（中文）",',
    '  "targetTask": "具体任务名称，如 protein function prediction、protein-ligand docking；不确定则空字符串",',
    '  "contributions": ["3-5 条中文句子。要具体准确，可含核心架构、输入/输出、指标、主要 finding。避免「提高了准确率」这类空话"],',
    '  "ownedMethodNames": ["本文自己提出或命名的方法/模型/系统/框架名称。只填本文原创的东西；不要把引用的 AlphaFold/ESMFold/Fpocket 填进来\。没有则 []"],',
    '  "proposedDatasets": ["本文自己发布的数据集/benchmark 名称。没有则 []"],',
    '  "referencedMethods": [{',
    '    "name": "本文引用、使用、发展或对比的具体方法/模型/框架名（如 AlphaFold2、Diffusion Transformer）",',
    '    "role": "used | extended | compared-baseline | cited-only",',
    '    "evidence": "≤1句中文证据。used=在本文 pipeline 中使用；extended=在其基础上改进/泛化/适配；compared-baseline=作为实验 baseline 比较；cited-only=仅发生于 related work"',
    "  }],",
    '  "referencedDatasets": [{',
    '    "name": "本文使用或发展的数据集/benchmark 名称（如 PDBBind、ImageNet）",',
    '    "role": "used | extended | compared-baseline | cited-only",',
    '    "evidence": "≤1句中文证据"',
    "  }],",
    '  "references": [{"raw":"参考文献原文","title":"论文标题，不确定则空字符串","authors":"作者","year":"年份","venue":"期刊/会议","doi":"DOI"}],',
    '  "limitations": ["1-3 条论文承认的限制；没有则 []"],',
    '  "keywords": ["4-8 个中文关键词，专有名词可保留原文"]',
    "}",
    "",
    "--- 关键规则 ---",
    "1. domain / problem / targetTask / contributions / limitations / keywords 全部输出简体中文。\
专有名词、模型名、数据集名、缩写（BERT/AlphaFold/PDBBind）保留原文即可。",
    "2. ownedMethodNames 严格只填本文创造/命名的名称。如果本文只是使用 prior work，请填进 referencedMethods.role=used，不要填进 ownedMethodNames。",
    "3. referencedMethods/referencedDatasets 是这个论文领域连接的核心输出。请尽可能多抽。\
name 必须是名称（AlphaFold2、RoseTTAFold）而不是描述短语。避免填入「自整数据库」、「大规模蒙马」这类描述。",
    "4. role 必须是枚举之一：used / extended / compared-baseline / cited-only。\
判决标准：\n\
   - extended：本文明确「基于/改进/泛化/适配/替代」该方法。\n\
   - compared-baseline：作为实验 table 里的 baseline 比较。\n\
   - used：作为 pipeline 部分使用、训练数据、评估 setting。\n\
   - cited-only：仅在 related work / introduction 提及，没有实验交集。",
    "5. references 字段如果 bibliography 片段可见，请尽量抽出能识别标题/作者/年份的关键论文，优先被正文重点引用的。",
    "6. 不要输出答案之外的任何文字。",
    "",
    "Paper:",
    content.title ? `Title: ${content.title}` : "",
    content.authors ? `Authors: ${content.authors}` : "",
    content.year ? `Year: ${content.year}` : "",
    content.venue ? `Venue: ${content.venue}` : "",
    "",
    content.abstract ? `Abstract:\n${content.abstract}` : "(No abstract available.)",
    "",
    content.fullText ? `Body excerpts:\n${content.fullText}` : "",
    "",
    content.referenceText ? `References/Bibliography excerpts:\n${content.referenceText}` : "",
    "",
    content.parsedReferences.length
      ? `Deterministically parsed reference candidates:\n${content.parsedReferences
          .slice(0, 70)
          .map((r, i) => `${i + 1}. ${r.raw}`)
          .join("\n")}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

/**
 * Promise-wrapper around LLMManager.chat (which is stream-callback shaped).
 * Resolves with the full assistant text. Rejects on transport/auth errors.
 */
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

/**
 * Parse the LLM response into a `PaperSummary`. Tolerates code-fence
 * wrappers (```json ... ```), and arbitrary leading/trailing prose by
 * extracting the largest JSON object candidate.
 */
function parseAnalysisResponse(raw: string): PaperSummary {
  let text = String(raw || "").trim();
  if (!text) return {};

  // Strip code fences.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  // If the model still wrapped commentary around it, grab the first {...}.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      text = text.slice(start, end + 1);
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    Zotero.debug("[RA] parseAnalysisResponse failed: " + e?.message);
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  // v9: 12 focused fields with role-tagged reference lists.
  return {
    // Funnel any LLM-emitted free text into the canonical bucket vocabulary
    // so GraphCanvas colouring stays consistent across runs.
    domain: normalizeDomain(typeof parsed.domain === "string" ? parsed.domain : undefined),
    problem: typeof parsed.problem === "string" ? parsed.problem.trim() : undefined,
    targetTask: typeof parsed.targetTask === "string" ? parsed.targetTask.trim() : undefined,
    contributions: toStringArray(parsed.contributions),
    ownedMethodNames: toStringArray(parsed.ownedMethodNames),
    proposedDatasets: toStringArray(parsed.proposedDatasets),
    referencedMethods: toReferencedItemArray(parsed.referencedMethods),
    referencedDatasets: toReferencedItemArray(parsed.referencedDatasets),
    references: toReferenceArray(parsed.references),
    limitations: toStringArray(parsed.limitations),
    keywords: toStringArray(parsed.keywords),
  };
}

function toReferencedItemArray(value: unknown): ReferencedItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReferencedItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    if (!isLikelyConcept(name)) continue;
    const roleRaw = typeof obj.role === "string" ? obj.role.trim().toLowerCase() : "";
    let role: ReferencedItem["role"] = "used";
    if (roleRaw === "extended") role = "extended";
    else if (roleRaw === "compared-baseline" || roleRaw === "compared baseline" || roleRaw === "baseline") role = "compared-baseline";
    else if (roleRaw === "cited-only" || roleRaw === "cited only" || roleRaw === "cited") role = "cited-only";
    else if (roleRaw === "used" || roleRaw === "") role = "used";
    const dedupeKey = `${name.toLowerCase()}\u0000${role}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const evidenceRaw =
      typeof obj.evidence === "string" ? obj.evidence.trim().slice(0, 240) : undefined;
    out.push({ name, role, evidence: evidenceRaw || undefined });
    if (out.length >= 60) break;
  }
  return out.length > 0 ? out : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value
    .filter((v) => typeof v === "string")
    .map((v) => (v as string).trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

function toReferenceArray(value: unknown): PaperReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PaperReference[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const raw = entry.trim();
      if (raw) out.push(parseReferenceEntry(raw));
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const raw = typeof obj.raw === "string" ? obj.raw.trim() : "";
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const authors = typeof obj.authors === "string" ? obj.authors.trim() : "";
    const year = typeof obj.year === "string" ? obj.year.trim() : "";
    const venue = typeof obj.venue === "string" ? obj.venue.trim() : "";
    const doi = typeof obj.doi === "string" ? obj.doi.trim() : "";
    if (raw || title) {
      out.push({
        raw: raw || title,
        title: title || undefined,
        authors: authors || undefined,
        year: year || undefined,
        venue: venue || undefined,
        doi: doi || undefined,
      });
    }
  }
  return out.length ? dedupeReferences(out).slice(0, 120) : undefined;
}

function mergeReferences(a: PaperReference[] | undefined, b: PaperReference[] | undefined): PaperReference[] | undefined {
  const merged = dedupeReferences([...(a || []), ...(b || [])]);
  return merged.length ? merged : undefined;
}

function dedupeReferences(refs: PaperReference[]): PaperReference[] {
  const seen = new Set<string>();
  const out: PaperReference[] = [];
  for (const r of refs) {
    const key = normalizeForMatch(r.doi || r.title || r.raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function mergeStringLists(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const out = new Set<string>();
  for (const v of a || []) if (v) out.add(v);
  for (const v of b || []) if (v) out.add(v);
  return out.size ? Array.from(out) : undefined;
}

/** A summary is "usable" if at least one substantive field was populated. */
function isUsableSummary(s: PaperSummary): boolean {
  return Boolean(
    s.domain ||
      s.problem ||
      s.targetTask ||
      (s.contributions && s.contributions.length) ||
      (s.keywords && s.keywords.length) ||
      (s.ownedMethodNames && s.ownedMethodNames.length) ||
      (s.proposedDatasets && s.proposedDatasets.length) ||
      (s.referencedMethods && s.referencedMethods.length) ||
      (s.referencedDatasets && s.referencedDatasets.length) ||
      (s.references && s.references.length),
  );
}

// ===========================================================================
// M4: Pairwise relationship pass
// ===========================================================================

/**
 * Hard cap on how many papers we feed into one comparison prompt. Larger
 * graphs are chunked so every eligible pair is eventually compared.
 */
const RELATIONS_BATCH_SIZE = 12;

/** Soft per-field truncation when summarizing each paper for the prompt. */
const REL_PROMPT_FIELD_CHARS = 260;
const REL_CANDIDATE_HINTS_LIMIT = 40;

// v7: paper→paper edge types only. method-link / dataset-link are produced
// deterministically by Stage 3 (canonicalize), not by the LLM.
const VALID_EDGE_TYPES: ReadonlySet<KGEdgeType> = new Set<KGEdgeType>([
  "cites",
  "similar-method",
  "contrasts",
  "uses-same-data",
  "solves-same-problem",
]);

/** Aliases the LLM might still emit; we silently retype them rather than
 *  drop the edge altogether — most are forgivable. */
const TYPE_ALIASES: Record<string, KGEdgeType> = {
  // v7 dropped these as edge types; map to the closest survivor so old or
  // confused LLM responses aren't silently lost.
  "shares-domain": "similar-method",
  "shares-result": "solves-same-problem",
  "shares-results": "solves-same-problem",
  extends: "similar-method",
  // Common LLM phrasings that aren't in the strict enum.
  improves: "similar-method",
  builds_on: "similar-method",
  "builds-on": "similar-method",
  "builds on": "similar-method",
  "same-data": "uses-same-data",
  "same-dataset": "uses-same-data",
  benchmark: "uses-same-data",
  "same-problem": "solves-same-problem",
  "same-task": "solves-same-problem",
};

/**
 * Compute and persist the outgoing edges from `itemKey` to every other ready
 * paper currently in the graph. Idempotent on success: subsequent calls skip
 * if `relationsAt` is already set.
 */
async function processRelations(itemKey: string): Promise<void> {
  const state = kgStore.getState();
  const paper = state.papers.find((p) => p.itemKey === itemKey);
  if (!paper) return;
  if (paper.status !== "ready" || !paper.summary) return;
  if (paper.relationsAt != null) return;

  const ordered = state.papers
    .filter(
      (p) =>
        p.status === "ready" &&
        p.summary &&
        isUsableSummary(p.summary),
    )
    .sort(comparePapersForRelations);
  const idx = ordered.findIndex((p) => p.itemKey === itemKey);
  const others = idx > 0 ? ordered.slice(0, idx) : [];

  // Trivial case: nothing to compare against. Mark relations done with no
  // edges so the scan loop doesn't keep re-queueing this paper.
  if (others.length === 0) {
    Zotero.debug(`[RA] KGPipeline relations: ${itemKey} has no peers, skipping LLM`);
    await kgStore.setEdgesFrom(itemKey, []);
    await kgStore.updatePaper(itemKey, { relationsAt: Date.now() });
    return;
  }

  Zotero.debug(`[RA] KGPipeline relations: ${itemKey} vs ${others.length} peers`);

  try {
    const llm = getLLMManager();
    if (!llm.isReady()) {
      throw new Error("LLM not configured. Set API key/model in Preferences.");
    }
    const chunks = chunkArray(others, RELATIONS_BATCH_SIZE);
    const allEdges: KGEdge[] = [...buildDeterministicPaperEdges(paper, others)];
    const chunkErrors: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        fileLog(`KGPipeline relations: ${itemKey} chunk ${i + 1}/${chunks.length} vs ${chunk.length}`);
        const messages = buildRelationsMessages(paper, chunk);
        const response = await runLLMOneShot(messages);
        allEdges.push(...parseRelationsResponse(response, paper.itemKey, chunk));
        if (i < chunks.length - 1) await delay(RELATION_CHUNK_COOLDOWN_MS);
      } catch (e: any) {
        chunkErrors.push((e?.message || String(e)).slice(0, 160));
      }
    }
    if (chunkErrors.length === chunks.length && chunks.length > 0) {
      throw new Error(chunkErrors[0] || "all relation chunks failed");
    }
    const edges = dedupeEdges(allEdges);

    // Even an empty edge list is valid (no relationships found). Persist
    // it so the paper is marked as relations-computed.
    await kgStore.setEdgesFrom(itemKey, edges);
    await kgStore.updatePaper(itemKey, {
      relationsAt: Date.now(),
      // Clear any stale relations-error from a prior attempt.
      errorMsg: chunkErrors.length
        ? `Relations partial: ${chunkErrors.length}/${chunks.length} chunks failed`
        : undefined,
    });
    Zotero.debug(`[RA] KGPipeline relations done: ${itemKey} → ${edges.length} edges`);
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 240);
    Zotero.debug(`[RA] KGPipeline relations error on ${itemKey}: ${msg}`);
    // We do NOT flip status back to "error" here — the paper itself is
    // still usable (its summary is fine). Instead, we leave relationsAt
    // unset so the next scan retries; surface the cause via errorMsg for
    // debugging. The UI distinguishes "ready" from "error" by status pill.
    await kgStore.updatePaper(itemKey, {
      errorMsg: `Relations: ${msg}`,
    });
    // Backoff: mark as relationsAt anyway with a "negative" sentinel so we
    // don't busy-loop on a deterministically-failing prompt. User can hit
    // retry via M3's button which will reset both flags.
    await kgStore.updatePaper(itemKey, { relationsAt: Date.now() });
  }
}

const RELATIONS_SYSTEM_PROMPT = [
  "You analyze relationships between research papers for a knowledge graph.",
  "You always respond with a single valid JSON array — no markdown, no code",
  "fences, no prose commentary.",
  "",
  "Quality bar (read carefully):",
  "  - Build a useful exploratory map, not an empty proof-only citation graph.",
  "  - Prefer specific edges (citation/contrast/same task/data/method)",
  "    when evidence is present.",
  "  - Same broad domain alone is not a relationship in v7 — don't try to express it",
  "    as an edge. Domain similarity is rendered visually via node colour.",
  "  - Too-generic links are forbidden: 'both use AI' or 'both use neural",
  "    networks' is too broad; 'both model protein-ligand binding sites' counts.",
  "    For 'same broad subfield, different methods', prefer similar-method or",
  "    solves-same-problem when concrete; otherwise leave the edge out.",
  "  - A paper pair may have multiple relationship types when distinct evidence",
  "    supports them. Never emit duplicate edges of the same type for one pair.",
  "  - Candidate hints are deterministic alias/profile matches, not facts.",
  "    Use them to inspect the profiles, then decide with evidence.",
  "  - References are stronger than baseline/method-name overlap. If a",
  "    reference candidate clearly matches an existing paper title/year,",
  "    emit cites with high confidence and cite the matched reference.",
  "  - Empty arrays are allowed only when there is truly no concrete overlap.",
  "",
  "Strength scale (`strength` field, in [0, 1]):",
  "  - 0.9-1.0  decisive: clear citation or near-identical method/data/task",
  "  - 0.7-0.9  strong: same problem framing, same dataset, or strong contrast",
  "  - 0.5-0.7  moderate: meaningful overlap or useful comparison",
  "  - 0.35-0.5 weak-but-useful: same concrete domain/subtask; otherwise leave empty",
  "  - <0.35    DROP THE EDGE. Don't emit anything weaker than 0.35.",
  "",
  "Language: the `label` field MUST be Simplified Chinese (简体中文).",
  "Proper nouns, model names, dataset names, acronyms (BERT, GNN, AlphaFold,",
  "PDB, Swiss-Prot, ImageNet) keep their original form.",
].join("\n");

function buildRelationsMessages(
  newPaper: KGPaperState,
  existing: KGPaperState[],
): Message[] {
  const newSection = formatPaperForPrompt("NEW", newPaper);
  const existingSections = existing
    .map((p) => formatPaperForPrompt(p.itemKey, p))
    .join("\n\n");
  const candidateHints = buildCandidateHints(newPaper, existing);

  const instructions = [
    "TASK: For the NEW paper, decide whether each EXISTING paper has a",
    "meaningful relationship with it. Output a single JSON array. The NEW paper",
    "is later in chronological comparison order where possible, so the directed",
    "edge (cites) normally points NEW → existing when there is actual",
    "evidence in the profile.",
    "",
    "Allowed types (USE ONLY THESE — do not invent new ones; in v7 we removed",
    "shares-domain, proposes-method, uses-method, extends-method, uses-dataset,",
    "introduces-dataset — those are now node attributes / concept-edge layer):",
    "",
    "  cites               (DIRECTED, NEW → existing)",
    "     The NEW paper explicitly references / cites the existing one.",
    "     Use when the existing paper's title, acronym/model name, author-year,",
    "     or distinctive method appears in citedPapers, citedMethods, baselines,",
    "     comparedAgainst, related work, or reference-like evidence.",
    "     ✓ 'references AlphaFold2 / cites the AlphaFold paper as prior work'",
    "     ✗ '同领域所以可能引用过' (太弱 → 留空)",
    "",
    "  similar-method      (UNDIRECTED, symmetric)",
    "     Both papers use the same / very similar core technique to attack their",
    "     respective problems, even if the problems differ.",
    "     ✓ '都使用扩散模型 (diffusion model) 做生成'",
    "     ✗ '都使用神经网络'  (太宽泛 → 留空)",
    "",
    "     NOTE: shares-domain (同领域) is NO LONGER a valid edge. Domain is now",
    "     encoded as a paper attribute (each paper has a `domain` field shown",
    "     visually as node colour); do not emit shares-domain.",
    "",
    "  contrasts           (UNDIRECTED, symmetric)",
    "     The papers are useful to compare because they tackle the same concrete",
    "     task/domain with materially different method families, assumptions,",
    "     input modalities, supervision regimes, scales, or trade-offs. Explicit",
    "     disagreement is strong evidence, but not required.",
    "     ✓ '同做结合位点预测，但一篇用3D CNN，另一篇用蛋白语言模型'",
    "     ✗ '一个做蛋白设计，一个做LLM记忆' (任务太不同)",
    "",
    "  uses-same-data      (UNDIRECTED, symmetric)",
    "     Both papers train or evaluate on the SAME named dataset / benchmark /",
    "     corpus. Concrete dataset names matter (PDB, ImageNet, GLUE, MS-MARCO).",
    "     ✓ '都在 PDBBind 上做评测'",
    "     ✗ '都用蛋白质数据'  (太宽泛 → 留空)",
    "",
    "  solves-same-problem (UNDIRECTED, symmetric)",
    "     Both papers tackle the SAME concrete task / problem statement, even if",
    "     they take different approaches. Stronger than shares-domain.",
    "     ✓ '都做蛋白-配体对接 (docking)，但方法不同'",
    "     ✗ '都研究蛋白质'  (那是 shares-domain)",
    "",
    "Each output element must look like:",
    "{",
    '  "to": "<the existing paper id, EXACTLY as given>",',
    '  "type": "<one of the 5 allowed types above>",',
    '  "label": "5-15 字的简体中文短语，具体描述两篇之间的联系",',
    '  "strength": <number in [0.35, 1.0], see system message>,',
    '  "evidence": ["1-3 条来自 profile 或候选提示的简短证据"],',
    '  "rationale": "1 句中文解释为什么这个关系类型成立",',
    '  "sourceFields": ["citedPapers/comparedAgainst/referencedMethods/etc."],',
    '  "matchedAliases": ["触发判断的论文名、模型名、数据集名或方法名"]',
    "}",
    "",
    "Final reminders:",
    "  - JSON array only, no markdown, no comments.",
    "  - Empty array `[]` is a valid (and often correct) answer.",
    "  - Each (NEW, existing, type) appears at most once.",
    "  - For cites, include concrete evidence or matchedAliases.",
    "  - Do not invent lineage/development edges; use similar-method, cites, or leave empty.",
    "  - The `label` is in Simplified Chinese.",
    "",
    "Examples of good output:",
    '  [{"to":"ABCD1234","type":"similar-method","label":"共享构象采样方法","strength":0.82}]',
    '  [{"to":"WXYZ9876","type":"uses-same-data","label":"同样以 PDBBind 作为评测集","strength":0.7}]',
    "  []",
    "",
    "==== CANDIDATE MATCH HINTS ====",
    candidateHints.length ? candidateHints.join("\n") : "(none)",
    "",
    "==== NEW PAPER ====",
    newSection,
    "",
    "==== EXISTING PAPERS ====",
    existingSections,
  ].join("\n");

  return [
    { role: "system", content: RELATIONS_SYSTEM_PROMPT },
    { role: "user", content: instructions },
  ];
}

/** Compact representation of a paper for the comparison prompt. */
function formatPaperForPrompt(id: string, paper: KGPaperState): string {
  const s = paper.summary || {};
  const lines: string[] = [`[id: ${id}]`, `Title: ${truncate(paper.title, 200)}`];
  if (s.domain) lines.push(`Domain: ${truncate(s.domain, 80)}`);
  if (s.targetTask) lines.push(`Target task: ${truncate(s.targetTask, REL_PROMPT_FIELD_CHARS)}`);
  if (s.problem) lines.push(`Problem: ${truncate(s.problem, REL_PROMPT_FIELD_CHARS)}`);

  pushArrayLine(lines, "Aliases", buildPaperAliases(paper), 12, 80);
  pushArrayLine(lines, "Owned methods/models", s.ownedMethodNames, 12, 90);
  pushArrayLine(lines, "Proposed datasets/benchmarks", s.proposedDatasets, 8, 90);

  // ReferencedItem fields are rendered as "name [role]" so the LLM can see
  // both the entity and the relationship type the stage-1 prompt assigned.
  pushReferencedLine(lines, "Referenced methods", s.referencedMethods, 14, 90);
  pushReferencedLine(lines, "Referenced datasets", s.referencedDatasets, 10, 90);
  pushReferenceLine(lines, "Parsed references", s.references, 12, 160);

  if (s.contributions && s.contributions.length) {
    lines.push("Contributions:");
    for (const c of s.contributions.slice(0, 4)) {
      lines.push(`  - ${truncate(c, REL_PROMPT_FIELD_CHARS)}`);
    }
  }
  pushArrayLine(lines, "Limitations", s.limitations, 3, REL_PROMPT_FIELD_CHARS);
  pushArrayLine(lines, "Keywords", s.keywords, 8, 60);
  return lines.join("\n");
}

function pushReferencedLine(
  lines: string[],
  label: string,
  values: ReferencedItem[] | undefined,
  maxItems: number,
  maxChars: number,
): void {
  if (!values || values.length === 0) return;
  const formatted = values
    .slice(0, maxItems)
    .filter((r): r is ReferencedItem => Boolean(r && typeof r.name === "string" && r.name.trim()))
    .map((r) => `${truncate(r.name.trim(), maxChars)} [${r.role || "used"}]`)
    .join("; ");
  if (formatted) lines.push(`${label}: ${formatted}`);
}

function pushArrayLine(
  lines: string[],
  label: string,
  values: string[] | undefined,
  maxItems: number,
  maxChars: number,
): void {
  if (!values || values.length === 0) return;
  lines.push(`${label}: ${values.slice(0, maxItems).map((v) => truncate(v, maxChars)).join("; ")}`);
}

function pushReferenceLine(
  lines: string[],
  label: string,
  values: PaperReference[] | undefined,
  maxItems: number,
  maxChars: number,
): void {
  if (!values || values.length === 0) return;
  lines.push(`${label}: ${values.slice(0, maxItems).map((r) => truncate(referenceLabel(r), maxChars)).join("; ")}`);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeEdges(edges: KGEdge[]): KGEdge[] {
  const best = new Map<string, KGEdge>();
  for (const e of edges) {
    const k = `${e.from}\u0000${e.to}\u0000${e.type}`;
    const prev = best.get(k);
    if (!prev || e.strength > prev.strength) best.set(k, e);
  }
  return Array.from(best.values()).sort((a, b) => b.strength - a.strength);
}

function buildCandidateHints(newPaper: KGPaperState, existing: KGPaperState[]): string[] {
  const out: string[] = [];
  const sources = candidateSourceFields(newPaper);
  for (const peer of existing) {
    const aliases = buildPaperAliases(peer);
    const identityAliases = buildPaperIdentityAliases(peer);
    const hits = new Map<KGEdgeType, Set<string>>();
    const hitFields = new Set<string>();
    for (const source of sources) {
      for (const value of source.values) {
        const pool = source.field === "references" ? identityAliases : aliases;
        const matched = pool.filter((alias) => aliasMatches(value, alias)).slice(0, 4);
        if (matched.length === 0) continue;
        hitFields.add(source.field);
        for (const type of source.types) {
          const set = hits.get(type) || new Set<string>();
          for (const m of matched) set.add(m);
          hits.set(type, set);
        }
      }
    }
    if (hits.size === 0) continue;
    const suggested = Array.from(hits.keys());
    const matchedAliases = Array.from(new Set(Array.from(hits.values()).flatMap((s) => Array.from(s)))).slice(0, 8);
    out.push(
      `- to ${peer.itemKey}: suggested=${suggested.join(", ")}; fields=${Array.from(hitFields).join(", ")}; matchedAliases=${matchedAliases.join(", ")}; title=${truncate(peer.title, 120)}`,
    );
    if (out.length >= REL_CANDIDATE_HINTS_LIMIT) break;
  }
  return out;
}

function candidateSourceFields(paper: KGPaperState): { field: string; values: string[]; types: KGEdgeType[] }[] {
  const s = paper.summary || {};
  const refMethodValues = (s.referencedMethods || []).map((r) => r?.name).filter(Boolean) as string[];
  const refMethodExtended = (s.referencedMethods || [])
    .filter((r) => r?.role === "extended")
    .map((r) => r.name)
    .filter(Boolean) as string[];
  const refMethodBaseline = (s.referencedMethods || [])
    .filter((r) => r?.role === "compared-baseline")
    .map((r) => r.name)
    .filter(Boolean) as string[];
  const refDatasetValues = (s.referencedDatasets || []).map((r) => r?.name).filter(Boolean) as string[];
  const sources: { field: string; values: string[]; types: KGEdgeType[] }[] = [
    { field: "references", values: referenceCandidateStrings(s.references), types: ["cites"] },
    { field: "referencedMethods", values: refMethodValues, types: ["cites"] },
    { field: "referencedMethods.extended", values: refMethodExtended, types: ["similar-method"] },
    { field: "referencedMethods.baseline", values: refMethodBaseline, types: ["contrasts"] },
    { field: "referencedDatasets", values: refDatasetValues, types: ["uses-same-data"] },
  ];
  return sources.filter((x) => x.values.length > 0);
}

function referenceCandidateStrings(refs: PaperReference[] | undefined): string[] {
  if (!refs || refs.length === 0) return [];
  return refs.flatMap((r) => [r.title, r.raw, r.doi].filter(Boolean) as string[]).slice(0, 140);
}

function buildPaperAliases(paper: KGPaperState): string[] {
  const s = paper.summary || {};
  const values: string[] = [paper.title];
  const acronym = paper.title.match(/^\s*([A-Za-z][A-Za-z0-9-]{2,30})\s*:/)?.[1];
  if (acronym) values.push(acronym);
  values.push(...(s.ownedMethodNames || []));
  values.push(...(s.proposedDatasets || []));
  values.push(...((s.referencedMethods || []).map((r) => r?.name).filter(Boolean) as string[]));
  values.push(...((s.referencedDatasets || []).map((r) => r?.name).filter(Boolean) as string[]));
  values.push(...(s.keywords || []));
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const v of values) {
    for (const candidate of splitAliasCandidates(v)) {
      const key = normalizeForMatch(candidate);
      if (!key || seen.has(key) || !isSpecificAlias(key)) continue;
      seen.add(key);
      aliases.push(candidate.trim());
    }
  }
  return aliases.slice(0, 24);
}

function buildPaperIdentityAliases(paper: KGPaperState): string[] {
  const s = paper.summary || {};
  const values: string[] = [paper.title];
  const acronym = paper.title.match(/^\s*([A-Za-z][A-Za-z0-9-]{2,30})\s*:/)?.[1];
  if (acronym) values.push(acronym);
  values.push(...(s.ownedMethodNames || []));
  values.push(...(s.proposedDatasets || []));
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const v of values) {
    for (const candidate of splitAliasCandidates(v)) {
      const key = normalizeForMatch(candidate);
      if (!key || seen.has(key) || !isSpecificAlias(key)) continue;
      seen.add(key);
      aliases.push(candidate.trim());
    }
  }
  return aliases.slice(0, 24);
}

function buildDeterministicPaperEdges(newPaper: KGPaperState, existing: KGPaperState[]): KGEdge[] {
  const edges: KGEdge[] = [];
  const refs = newPaper.summary?.references || [];
  const refMethods = newPaper.summary?.referencedMethods || [];
  for (const peer of existing) {
    const identityAliases = buildPaperIdentityAliases(peer);
    const refHit = refs.find((r) => identityAliases.some((alias) => aliasMatches(r.title || r.raw, alias)));
    const refMethodHit = refMethods.find(
      (rm) => rm && identityAliases.some((alias) => aliasMatches(rm.name, alias)),
    );
    if (refHit || refMethodHit) {
      const hitText = refHit ? referenceLabel(refHit) : refMethodHit?.name || "";
      edges.push({
        from: newPaper.itemKey,
        to: peer.itemKey,
        type: "cites",
        strength: refHit ? 0.96 : 0.84,
        evidence: [truncate(hitText, 220)],
        rationale: "参考文献或 referencedMethods 字段与图中论文身份别名直接匹配。",
        sourceFields: [refHit ? "references" : "referencedMethods"],
        matchedAliases: identityAliases.filter((alias) => aliasMatches(hitText, alias)).slice(0, 4),
      });
    }
    const owned = [...(peer.summary?.ownedMethodNames || []), ...(peer.summary?.proposedDatasets || [])];
    const extHit = refMethods.find(
      (rm) => rm && rm.role === "extended" && owned.some((alias) => aliasMatches(rm.name, alias)),
    );
    if (extHit) {
      edges.push({
        from: newPaper.itemKey,
        to: peer.itemKey,
        type: "similar-method",
        strength: 0.9,
        evidence: [`referencedMethods role=extended 命中对方 owned: ${truncate(extHit.name, 160)}`],
        rationale: "NEW 的 referencedMethods role=extended 明确命中已有论文自身提出的方法/数据集，按主动关系层保留为相似方法。",
        sourceFields: ["referencedMethods.extended", "ownedMethodNames"],
        matchedAliases: owned.filter((alias) => aliasMatches(extHit.name, alias)).slice(0, 4),
      });
    }
  }
  return edges;
}

function splitAliasCandidates(value: string): string[] {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/[;；,，、|/()（）\[\]]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [raw, ...parts];
}

function aliasMatches(value: string, alias: string): boolean {
  const a = normalizeForMatch(value);
  const b = normalizeForMatch(alias);
  if (!isSpecificAlias(a) || !isSpecificAlias(b)) return false;
  return a.includes(b) || b.includes(a);
}

function normalizeForMatch(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceLabel(r: PaperReference): string {
  return [r.title || r.raw, r.authors, r.year, r.doi].filter(Boolean).join(" | ");
}

function isSpecificAlias(value: string): boolean {
  if (!value || value.length < 4) return false;
  const generic = new Set([
    "protein",
    "proteins",
    "structure",
    "prediction",
    "model",
    "models",
    "learning",
    "deep",
    "method",
    "methods",
    "transformer",
    "neural network",
    "graph neural network",
  ]);
  if (generic.has(value)) return false;
  const tokens = value.split(" ").filter(Boolean);
  if (tokens.length === 1) return value.length >= 4;
  return tokens.some((t) => t.length >= 4 && !generic.has(t));
}

function comparePapersForRelations(a: KGPaperState, b: KGPaperState): number {
  const ay = paperYear(a);
  const by = paperYear(b);
  if (ay !== by) return ay - by;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.itemKey.localeCompare(b.itemKey);
}

function paperYear(p: KGPaperState): number {
  const y = String(p.metaLine || p.title || "").match(/\b(19|20)\d{2}\b/)?.[0];
  return y ? Number(y) : 9999;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "\u2026";
}

/**
 * Parse the LLM's JSON-array response into validated KGEdges. Drops entries
 * that don't reference one of the known existing-paper ids, have an
 * unrecognized type, or are missing required fields.
 */
function parseRelationsResponse(
  raw: string,
  fromKey: string,
  existing: KGPaperState[],
): KGEdge[] {
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
    Zotero.debug("[RA] parseRelationsResponse failed: " + e?.message);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const validKeys = new Set(existing.map((p) => p.itemKey));
  const edges: KGEdge[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const to = typeof obj.to === "string" ? obj.to : "";
    if (!to || !validKeys.has(to)) continue;
    if (to === fromKey) continue; // self-loops never useful
    const typeRaw = (typeof obj.type === "string" ? obj.type.trim() : "").toLowerCase();
    let type: KGEdgeType | null = null;
    if (VALID_EDGE_TYPES.has(typeRaw as KGEdgeType)) {
      type = typeRaw as KGEdgeType;
    } else if (TYPE_ALIASES[typeRaw]) {
      type = TYPE_ALIASES[typeRaw];
    }
    // Drop edges with unrecognized types — we no longer fall back to 'other'.
    if (!type) continue;
    const label =
      typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : "";
    let strength = typeof obj.strength === "number" ? obj.strength : 0.5;
    if (!Number.isFinite(strength)) strength = 0.5;
    if (strength < 0) strength = 0;
    if (strength > 1) strength = 1;
    // Honor the prompt's >=0.35 contract; drop anything weaker as the LLM
    // was told not to emit it.
    if (strength < 0.35) continue;
    const evidence = toStringArray(obj.evidence) || (typeof obj.evidence === "string" ? [obj.evidence.trim()].filter(Boolean) : undefined);
    const sourceFields = toStringArray(obj.sourceFields);
    const matchedAliases = toStringArray(obj.matchedAliases);
    const rationale =
      typeof obj.rationale === "string" && obj.rationale.trim() ? obj.rationale.trim() : undefined;
    if (type === "cites" && !(evidence?.length || matchedAliases?.length)) {
      continue;
    }
    edges.push({
      from: fromKey,
      to,
      type,
      label,
      strength,
      evidence,
      rationale,
      sourceFields,
      matchedAliases,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Profile schema migration helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when an existing summary was produced under an older profile
 * schema and should be regenerated. Drives stage-1 re-analysis on startup.
 */
function summaryNeedsProfileUpgrade(p: KGPaperState): boolean {
  if ((p.profileVersion || 0) < CURRENT_PROFILE_SCHEMA_VERSION) return true;
  const s = p.summary;
  if (!s) return true;
  // The v9 schema replaced 4 method/dataset fields with role-tagged lists.
  // A summary missing both new lists AND containing none of the old fallback
  // signals is unusable for stage-2 / stage-3.
  return !(
    s.targetTask ||
    (s.contributions && s.contributions.length) ||
    (s.ownedMethodNames && s.ownedMethodNames.length) ||
    (s.proposedDatasets && s.proposedDatasets.length) ||
    (s.referencedMethods && s.referencedMethods.length) ||
    (s.referencedDatasets && s.referencedDatasets.length) ||
    (s.references && s.references.length)
  );
}

// ===========================================================================
// Stage 3 task wrapper
// ===========================================================================

/**
 * Run global concept canonicalization. Only invoked once after every paper's
 * stage-1 + stage-2 passes have completed (or when the canonical schema bumps).
 *
 * Output:
 *   - `state.concepts` is replaced with canonical concept nodes.
 *   - All paper→concept edges are rebuilt under the new canonical ids and
 *     merged with the existing paper→paper edges.
 *   - `canonicalizedAt` and `conceptCanonicalVersion` are bumped so we don't
 *     repeat the work on subsequent startups.
 */
async function processCanonicalize(): Promise<void> {
  const state = kgStore.getState();
  const readyPapers = state.papers.filter((p) => p.status === "ready" && p.summary);
  if (readyPapers.length === 0) {
    fileLog("KGPipeline canonicalize: no ready papers, skipping");
    await kgStore.setConceptCanonicalVersion(CURRENT_CONCEPT_CANONICAL_VERSION);
    await kgStore.setCanonicalizedAt(Date.now());
    return;
  }
  fileLog(`KGPipeline canonicalize: starting on ${readyPapers.length} papers`);
  // Surface the running phase to the UI (CurrentGraphView renders a banner).
  // The flag is ephemeral — never persisted — so even a hard crash here
  // leaves no stuck "正在规范化概念..." indicator on next launch.
  kgStore.setPipelinePhase("stage3");
  try {
    const result = await canonicalizeConcepts(readyPapers);
    // IMPORTANT: bump version + timestamp BEFORE the notifying writes below.
    // replaceConcepts and setAllEdges both call notify(), which fires the
    // scan() subscriber. If `canonicalStale` is still true at that moment,
    // scan will re-queue another canonicalize task and we waste an LLM
    // round-trip. Doing the version bump first (these methods don't notify)
    // makes scan see a settled flag during the subsequent writes.
    await kgStore.setConceptCanonicalVersion(CURRENT_CONCEPT_CANONICAL_VERSION);
    await kgStore.setCanonicalizedAt(Date.now());
    await kgStore.replaceConcepts(result.concepts);
    // Rebuild edge list: keep paper→paper edges from setEdgesFrom, replace
    // every paper→concept edge with the freshly canonicalized batch.
    const conceptIds = new Set(result.concepts.map((c) => c.id));
    const allEdges = kgStore.getState().edges;
    const paperPaperEdges = allEdges.filter(
      (e) => !conceptIds.has(e.to) && !e.to.startsWith("concept:"),
    );
    await kgStore.setAllEdges([...paperPaperEdges, ...result.edges]);
    fileLog(
      `KGPipeline canonicalize: done. raw=${result.metrics.rawCandidates} preClusters=${result.metrics.preClusters} canonicalClusters=${result.metrics.canonicalClusters} prunedLeaves=${result.metrics.prunedLeaves ?? 0} llmCalls=${result.metrics.llmCalls}`,
    );
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 240);
    fileLog(`KGPipeline canonicalize ERROR: ${msg}`);
    Zotero.debug("[RA] KGPipeline canonicalize error: " + msg);
    // Don't bump canonical version: scan loop will retry next session/notify.
  } finally {
    kgStore.setPipelinePhase("idle");
  }
}
