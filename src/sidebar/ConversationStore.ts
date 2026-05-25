/**
 * Conversation persistence (multi-conversation per paper)
 * ----------------------------------------------------------------------------
 * Each Zotero parent item ("paper") owns its own folder containing one JSON
 * file per chat thread plus an index meta file:
 *
 *   <DataDirectory>/reading-assistant/conversations/
 *     <paperKey>/
 *       _meta.json          # { activeId, conversations: ConversationMeta[] }
 *       <convId>.json       # { messages, updatedAt }
 *     <paperKey>.json       # legacy single-conversation file (preserved as backup)
 *
 * Migration:
 *   On first access to a paper, if the new folder doesn't exist but the legacy
 *   `<paperKey>.json` does, its messages are imported as the first conversation
 *   in the new folder. The legacy file is kept untouched as a safety backup.
 *   Even older preference-based history (`extensions.zotero.<addonRef>.conversation.<key>`)
 *   is migrated as a last-resort fallback.
 *
 * In-memory cache:
 *   `indexCache` holds the parsed `_meta.json` per paperKey for the lifetime
 *   of the session, so toggling between conversations doesn't re-hit disk.
 *
 * Repair pass:
 *   Stored messages are run through a UTF-8 mojibake fix (`maybeRepairMojibake`)
 *   at parse time to clean up double-encoded data that older plugin versions
 *   sometimes wrote.
 */
import { Message } from "../modules/llm/types";
import { getPref } from "../modules/utils/prefs";

declare const Cc: any;
declare const Ci: any;

const MAX_MESSAGES = 40;
const MAX_THREAD_MESSAGES = 40;
const MAX_TITLE_LEN = 40;
const MAX_ANCHOR_LEN = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StoredConversation = {
  messages: Message[];
  updatedAt: number;
};

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type PaperConversationsIndex = {
  activeId: string;
  conversations: ConversationMeta[];
};

export type FollowupThreadMeta = {
  id: string;
  title: string;
  parentMessageIndex: number;
  anchorText: string;
  createdAt: number;
  updatedAt: number;
};

export type FollowupThreadIndex = {
  threads: FollowupThreadMeta[];
};

export type FollowupThread = FollowupThreadMeta & {
  paperKey: string;
  conversationId: string;
  messages: Message[];
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function baseDir(): string {
  const dir = (Zotero as any).DataDirectory?.dir || (Zotero as any).Profile?.dir || "";
  return dir + "/reading-assistant/conversations";
}

function paperFolder(paperKey: string): string {
  return baseDir() + "/" + paperKey;
}

function indexFilePath(paperKey: string): string {
  return paperFolder(paperKey) + "/_meta.json";
}

function conversationFilePath(paperKey: string, convId: string): string {
  return paperFolder(paperKey) + "/" + convId + ".json";
}

function legacyConversationFilePath(paperKey: string): string {
  return baseDir() + "/" + paperKey + ".json";
}

function threadFolder(paperKey: string): string {
  return paperFolder(paperKey) + "/threads";
}

function threadIndexFilePath(paperKey: string, convId: string): string {
  return threadFolder(paperKey) + "/" + convId + "_meta.json";
}

function threadFilePath(paperKey: string, threadId: string): string {
  return threadFolder(paperKey) + "/" + threadId + ".json";
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readFileSync(path: string): string | null {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    if (!file.exists()) return null;
    const zoteroFile = (Zotero as any).File;
    if (zoteroFile?.getContents) {
      return zoteroFile.getContents(file, "utf-8");
    }

    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0o444, Ci.nsIFileInputStream.CLOSE_ON_EOF);
    const binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    binaryStream.setInputStream(stream);
    const bytes = binaryStream.readByteArray(binaryStream.available());
    binaryStream.close();
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch (_) {
    return null;
  }
}

function writeFileAsync(path: string, data: string): void {
  try {
    const dir = path.substring(0, path.lastIndexOf("/"));
    (Zotero as any).File
      .createDirectoryIfMissingAsync(dir)
      .then(() => (Zotero as any).File.putContentsAsync(path, data))
      .catch((e: any) => Zotero.debug("[RA] writeFileAsync: " + (e.message || e)));
  } catch (e: any) {
    Zotero.debug("[RA] writeFileAsync: " + (e.message || e));
  }
}

function deleteFileSync(path: string): void {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    if (file.exists()) file.remove(false);
  } catch (e: any) {
    Zotero.debug("[RA] deleteFileSync: " + (e.message || e));
  }
}

// ---------------------------------------------------------------------------
// UTF-8 mojibake repair
// ---------------------------------------------------------------------------
//
// Some older plugin versions wrote UTF-8 bytes interpreted as Latin-1, which
// shows up as garbled "Ã©" sequences. This pass detects those characters and
// re-decodes the string. If the result has fewer bad chars, we keep it; else
// we leave the original alone.

function maybeRepairMojibake(text: string): string {
  if (!/[ÃÂâäåæçèéêëìíîïðñòóôõöùúûüýþÿ]/.test(text)) return text;
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 255) return text;
      bytes[i] = code;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const badBefore = (text.match(/[ÃÂâäåæçèéêëìíîïðñòóôõöùúûüýþÿ]/g) || []).length;
    const badAfter = (decoded.match(/[ÃÂâäåæçèéêëìíîïðñòóôõöùúûüýþÿ]/g) || []).length;
    return badAfter < badBefore ? decoded : text;
  } catch (_) {
    return text;
  }
}

function repairMessageContent(content: Message["content"]): Message["content"] {
  if (typeof content === "string") {
    return maybeRepairMojibake(content);
  }
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { ...part, text: maybeRepairMojibake(part.text) };
    }
    return part;
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a `StoredConversation`. Returns `null` when
 * the input is empty, malformed, or missing the required `messages` array.
 */
export function safeParseConversation(raw: unknown): StoredConversation | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as StoredConversation;
    if (!Array.isArray(parsed.messages)) return null;
    parsed.messages = parsed.messages.map((message) => ({
      ...message,
      content: repairMessageContent(message.content),
    }));
    return parsed;
  } catch (e) {
    return null;
  }
}

function safeParseIndex(raw: unknown): PaperConversationsIndex | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as PaperConversationsIndex;
    if (!parsed || !Array.isArray(parsed.conversations)) return null;
    parsed.conversations = parsed.conversations.filter(
      (c) => c && typeof c.id === "string" && c.id.length > 0,
    );
    parsed.conversations.forEach((c) => {
      if (typeof c.title !== "string") c.title = "";
      if (typeof c.createdAt !== "number") c.createdAt = Date.now();
      if (typeof c.updatedAt !== "number") c.updatedAt = c.createdAt;
    });
    if (
      !parsed.activeId ||
      !parsed.conversations.some((c) => c.id === parsed.activeId)
    ) {
      parsed.activeId = parsed.conversations[0]?.id || "";
    }
    return parsed;
  } catch (_) {
    return null;
  }
}


function safeParseFollowupIndex(raw: unknown): FollowupThreadIndex | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as FollowupThreadIndex;
    if (!parsed || !Array.isArray(parsed.threads)) return null;
    parsed.threads = parsed.threads.filter(
      (t) => t && typeof t.id === "string" && t.id.length > 0,
    );
    parsed.threads.forEach((t) => {
      if (typeof t.title !== "string") t.title = "";
      if (typeof t.parentMessageIndex !== "number") t.parentMessageIndex = -1;
      if (typeof t.anchorText !== "string") t.anchorText = "";
      if (typeof t.createdAt !== "number") t.createdAt = Date.now();
      if (typeof t.updatedAt !== "number") t.updatedAt = t.createdAt;
    });
    return parsed;
  } catch (_) {
    return null;
  }
}

function safeParseFollowupThread(
  raw: unknown,
  paperKey: string,
  conversationId: string,
  meta: FollowupThreadMeta,
): FollowupThread | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as FollowupThread;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((message) => ({
            ...message,
            content: repairMessageContent(message.content),
          }))
      : [];
    return {
      ...meta,
      paperKey,
      conversationId,
      messages,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Title derivation
// ---------------------------------------------------------------------------

export function deriveTitleFromMessages(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join(" ");
    }
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed) return truncateTitle(trimmed);
  }
  return "";
}

export function truncateTitle(title: string): string {
  const t = title.trim();
  if (t.length <= MAX_TITLE_LEN) return t;
  return t.slice(0, MAX_TITLE_LEN - 1) + "…";
}

// ---------------------------------------------------------------------------
// Conversation IDs
// ---------------------------------------------------------------------------

export function generateConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `c_${ts}_${rand}`;
}

function generateFollowupThreadId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `t_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const indexCache: Map<string, PaperConversationsIndex> = new Map();
const followupIndexCache: Map<string, FollowupThreadIndex> = new Map();

function persistIndex(paperKey: string, index: PaperConversationsIndex): void {
  indexCache.set(paperKey, index);
  writeFileAsync(indexFilePath(paperKey), JSON.stringify(index));
}

function followupCacheKey(paperKey: string, convId: string): string {
  return paperKey + "::" + convId;
}

function persistFollowupIndex(
  paperKey: string,
  convId: string,
  index: FollowupThreadIndex,
): void {
  followupIndexCache.set(followupCacheKey(paperKey, convId), index);
  writeFileAsync(threadIndexFilePath(paperKey, convId), JSON.stringify(index));
}

// ---------------------------------------------------------------------------
// Public API — multi-conversation per paper
// ---------------------------------------------------------------------------

/**
 * Load (or initialize + migrate) the conversations index for a paper.
 *
 * Resolution order:
 *   1. In-memory cache (fastest, set during this session).
 *   2. `<paperKey>/_meta.json` on disk (new format).
 *   3. Legacy `<paperKey>.json` (single-conversation file) — migrated to a
 *      first conversation in the new folder. The legacy file is kept as a
 *      backup.
 *   4. Legacy preference (`extensions.zotero.<addonRef>.conversation.<key>`)
 *      — migrated likewise.
 *   5. Empty index. Caller is expected to seed a fresh conversation via
 *      `createConversation` before showing the UI.
 */
export function loadPaperIndex(
  addonRef: string,
  paperKey: string,
): PaperConversationsIndex {
  const cached = indexCache.get(paperKey);
  if (cached) return cached;

  // New format
  const indexRaw = readFileSync(indexFilePath(paperKey));
  const fromDisk = safeParseIndex(indexRaw);
  if (fromDisk) {
    indexCache.set(paperKey, fromDisk);
    return fromDisk;
  }

  // Legacy single-conversation file → migrate
  const legacyRaw = readFileSync(legacyConversationFilePath(paperKey));
  const legacy = safeParseConversation(legacyRaw);
  if (legacy && legacy.messages.length > 0) {
    const filtered = legacy.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const convId = generateConversationId();
    const updatedAt = legacy.updatedAt || Date.now();
    const meta: ConversationMeta = {
      id: convId,
      title: deriveTitleFromMessages(filtered),
      createdAt: updatedAt,
      updatedAt,
    };
    const index: PaperConversationsIndex = {
      activeId: convId,
      conversations: [meta],
    };
    writeFileAsync(
      conversationFilePath(paperKey, convId),
      JSON.stringify({ messages: filtered.slice(-MAX_MESSAGES), updatedAt }),
    );
    persistIndex(paperKey, index);
    return index;
  }

  // Even older preference-based history → migrate
  const fromPref = safeParseConversation(
    getPref("extensions.zotero." + addonRef + ".conversation." + paperKey),
  );
  if (fromPref && fromPref.messages.length > 0) {
    const filtered = fromPref.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const convId = generateConversationId();
    const now = Date.now();
    const meta: ConversationMeta = {
      id: convId,
      title: deriveTitleFromMessages(filtered),
      createdAt: now,
      updatedAt: now,
    };
    const index: PaperConversationsIndex = {
      activeId: convId,
      conversations: [meta],
    };
    writeFileAsync(
      conversationFilePath(paperKey, convId),
      JSON.stringify({
        messages: filtered.slice(-MAX_MESSAGES),
        updatedAt: now,
      }),
    );
    persistIndex(paperKey, index);
    return index;
  }

  // Nothing on disk
  const empty: PaperConversationsIndex = { activeId: "", conversations: [] };
  indexCache.set(paperKey, empty);
  return empty;
}

/** Load the messages for a single conversation. Returns [] if missing/empty. */
export function loadMessages(paperKey: string, convId: string): Message[] {
  if (!paperKey || !convId) return [];
  const raw = readFileSync(conversationFilePath(paperKey, convId));
  const parsed = safeParseConversation(raw);
  if (!parsed) return [];
  return parsed.messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
}

/**
 * Persist messages for the given conversation and bump its `updatedAt` in
 * the index. If the conversation has no title yet, derive one from the
 * first user message.
 */
export function saveMessages(
  paperKey: string,
  convId: string,
  messages: Message[],
): void {
  if (!paperKey || !convId) return;
  const trimmed = messages.slice(-MAX_MESSAGES);
  const stored: StoredConversation = {
    messages: trimmed,
    updatedAt: Date.now(),
  };
  writeFileAsync(
    conversationFilePath(paperKey, convId),
    JSON.stringify(stored),
  );
  const index = indexCache.get(paperKey);
  if (index) {
    const entry = index.conversations.find((c) => c.id === convId);
    if (entry) {
      entry.updatedAt = stored.updatedAt;
      if (!entry.title) {
        entry.title = deriveTitleFromMessages(trimmed);
      }
      persistIndex(paperKey, index);
    }
  }
}

/** Create a new (empty) conversation under the paper, marking it active. */
export function createConversation(
  addonRef: string,
  paperKey: string,
  title?: string,
): ConversationMeta {
  const index = loadPaperIndex(addonRef, paperKey);
  const id = generateConversationId();
  const now = Date.now();
  const meta: ConversationMeta = {
    id,
    title: truncateTitle(title || ""),
    createdAt: now,
    updatedAt: now,
  };
  index.conversations.push(meta);
  index.activeId = id;
  // Initialize an empty messages file so subsequent reads always succeed.
  writeFileAsync(
    conversationFilePath(paperKey, id),
    JSON.stringify({ messages: [], updatedAt: now }),
  );
  persistIndex(paperKey, index);
  return meta;
}

/**
 * Delete a conversation. Returns the new `activeId` (may be empty if no
 * conversations remain — caller should create a fresh one in that case).
 */
export function deleteConversation(
  addonRef: string,
  paperKey: string,
  convId: string,
): string {
  const index = loadPaperIndex(addonRef, paperKey);
  const idx = index.conversations.findIndex((c) => c.id === convId);
  if (idx < 0) return index.activeId;
  index.conversations.splice(idx, 1);
  if (index.activeId === convId) {
    const sorted = [...index.conversations].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    index.activeId = sorted[0]?.id || "";
  }
  deleteFileSync(conversationFilePath(paperKey, convId));
  persistIndex(paperKey, index);
  return index.activeId;
}

/** Rename a conversation (truncates to 40 chars). */
export function renameConversation(
  addonRef: string,
  paperKey: string,
  convId: string,
  title: string,
): void {
  const index = loadPaperIndex(addonRef, paperKey);
  const entry = index.conversations.find((c) => c.id === convId);
  if (!entry) return;
  entry.title = truncateTitle(title || "");
  entry.updatedAt = Date.now();
  persistIndex(paperKey, index);
}

/** Mark a conversation as the active one for the paper. No-op if missing. */
export function setActiveConversation(
  addonRef: string,
  paperKey: string,
  convId: string,
): void {
  const index = loadPaperIndex(addonRef, paperKey);
  if (!index.conversations.some((c) => c.id === convId)) return;
  if (index.activeId === convId) return;
  index.activeId = convId;
  persistIndex(paperKey, index);
}

// ---------------------------------------------------------------------------
// Backward-compatible single-conversation API
// ---------------------------------------------------------------------------
//
// Older callers used `loadConversation` / `saveConversation` to read/write a
// single conversation per paper. These wrappers now operate on the active
// conversation in the new index, auto-creating one if none exists. New code
// should prefer the multi-conversation API above.

export function loadConversation(addonRef: string, paperKey: string): Message[] {
  const index = loadPaperIndex(addonRef, paperKey);
  if (!index.activeId) return [];
  return loadMessages(paperKey, index.activeId);
}

export function saveConversation(
  addonRef: string,
  paperKey: string,
  messages: Message[],
): void {
  const index = loadPaperIndex(addonRef, paperKey);
  let convId = index.activeId;
  if (!convId) {
    const meta = createConversation(addonRef, paperKey);
    convId = meta.id;
  }
  saveMessages(paperKey, convId, messages);
}

export function loadFollowupIndex(
  paperKey: string,
  convId: string,
): FollowupThreadIndex {
  if (!paperKey || !convId) return { threads: [] };
  const key = followupCacheKey(paperKey, convId);
  const cached = followupIndexCache.get(key);
  if (cached) return cached;
  const parsed = safeParseFollowupIndex(readFileSync(threadIndexFilePath(paperKey, convId)));
  const index = parsed || { threads: [] };
  followupIndexCache.set(key, index);
  return index;
}

export function loadFollowupThread(
  paperKey: string,
  convId: string,
  threadId: string,
): FollowupThread | null {
  if (!paperKey || !convId || !threadId) return null;
  const index = loadFollowupIndex(paperKey, convId);
  const meta = index.threads.find((t) => t.id === threadId);
  if (!meta) return null;
  const parsed = safeParseFollowupThread(
    readFileSync(threadFilePath(paperKey, threadId)),
    paperKey,
    convId,
    meta,
  );
  if (parsed) return parsed;
  return {
    ...meta,
    paperKey,
    conversationId: convId,
    messages: [],
  };
}

export function getOrCreateFollowupThread(
  paperKey: string,
  convId: string,
  parentMessageIndex: number,
  anchorText: string,
): FollowupThread {
  const index = loadFollowupIndex(paperKey, convId);
  const existing = index.threads
    .filter((t) => t.parentMessageIndex === parentMessageIndex)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (existing) {
    const loaded = loadFollowupThread(paperKey, convId, existing.id);
    if (loaded) return loaded;
  }

  const now = Date.now();
  const normalizedAnchor = truncateAnchor(anchorText);
  const title = truncateTitle(deriveTitleFromText(normalizedAnchor) || "Follow-up");
  const meta: FollowupThreadMeta = {
    id: generateFollowupThreadId(),
    title,
    parentMessageIndex,
    anchorText: normalizedAnchor,
    createdAt: now,
    updatedAt: now,
  };
  const thread: FollowupThread = {
    ...meta,
    paperKey,
    conversationId: convId,
    messages: [],
  };
  index.threads.push(meta);
  persistFollowupIndex(paperKey, convId, index);
  writeFileAsync(threadFilePath(paperKey, meta.id), JSON.stringify(thread));
  return thread;
}

export function saveFollowupThreadMessages(
  paperKey: string,
  convId: string,
  threadId: string,
  messages: Message[],
): FollowupThread | null {
  const index = loadFollowupIndex(paperKey, convId);
  const meta = index.threads.find((t) => t.id === threadId);
  if (!meta) return null;
  const trimmed = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_THREAD_MESSAGES);
  const now = Date.now();
  meta.updatedAt = now;
  if (!meta.title) {
    meta.title = truncateTitle(deriveTitleFromMessages(trimmed) || deriveTitleFromText(meta.anchorText) || "Follow-up");
  }
  const thread: FollowupThread = {
    ...meta,
    paperKey,
    conversationId: convId,
    messages: trimmed,
  };
  persistFollowupIndex(paperKey, convId, index);
  writeFileAsync(threadFilePath(paperKey, threadId), JSON.stringify(thread));
  return thread;
}

function deriveTitleFromText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LEN);
}

function truncateAnchor(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= MAX_ANCHOR_LEN) return t;
  return t.slice(0, MAX_ANCHOR_LEN - 1) + "…";
}
