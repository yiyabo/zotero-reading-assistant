import type { AINote, AINotesChangeListener, AINotesFile } from "./types";
import { DEFAULT_NOTE_COLOR } from "./types";

declare const Cc: any;
declare const Ci: any;

function baseDir(): string {
  const dir = (Zotero as any).DataDirectory?.dir || (Zotero as any).Profile?.dir || "";
  return dir + "/reading-assistant/ai-notes";
}

function filePath(attachmentKey: string): string {
  return baseDir() + "/" + attachmentKey + ".json";
}

function readFileSync(path: string): string | null {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    if (!file.exists()) return null;
    const zoteroFile = (Zotero as any).File;
    if (zoteroFile?.getContents) return zoteroFile.getContents(file, "utf-8");
    return null;
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
      .catch((e: any) => Zotero.debug("[RA] AINotesStore write: " + (e?.message || e)));
  } catch (e: any) {
    Zotero.debug("[RA] AINotesStore write: " + (e?.message || e));
  }
}

function genId(): string {
  return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function emptyFile(attachmentKey: string, parentItemKey: string): AINotesFile {
  return { version: 1, attachmentKey, parentItemKey, notes: [] };
}

function normalizeNote(raw: any, attachmentKey: string, parentItemKey: string): AINote | null {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const rect = Array.isArray(raw.rect) && raw.rect.length === 4
    ? raw.rect.map((n: any) => Number(n) || 0) as [number, number, number, number]
    : null;
  if (!rect) return null;
  return {
    id,
    number: Math.max(1, Math.floor(Number(raw.number) || 1)),
    attachmentKey: String(raw.attachmentKey || attachmentKey),
    parentItemKey: String(raw.parentItemKey || parentItemKey),
    pageIndex: Math.max(0, Math.floor(Number(raw.pageIndex) || 0)),
    rect,
    content: String(raw.content || ""),
    color: String(raw.color || DEFAULT_NOTE_COLOR),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    zoteroAnnotationKey: raw.zoteroAnnotationKey ? String(raw.zoteroAnnotationKey) : undefined,
  };
}

class AINotesStore {
  private cache = new Map<string, AINotesFile>();
  private listeners = new Set<AINotesChangeListener>();

  subscribe(fn: AINotesChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(attachmentKey: string): void {
    for (const fn of this.listeners) {
      try { fn(attachmentKey); } catch (_) {}
    }
  }

  private load(attachmentKey: string, parentItemKey = ""): AINotesFile {
    const cached = this.cache.get(attachmentKey);
    if (cached) return cached;
    const raw = readFileSync(filePath(attachmentKey));
    if (!raw) {
      const empty = emptyFile(attachmentKey, parentItemKey);
      this.cache.set(attachmentKey, empty);
      return empty;
    }
    try {
      const parsed = JSON.parse(raw);
      const notes = Array.isArray(parsed?.notes)
        ? parsed.notes
            .map((n: any) => normalizeNote(n, attachmentKey, parentItemKey || String(parsed.parentItemKey || "")))
            .filter(Boolean) as AINote[]
        : [];
      const file: AINotesFile = {
        version: 1,
        attachmentKey,
        parentItemKey: String(parsed.parentItemKey || parentItemKey || ""),
        notes: notes.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt),
      };
      this.cache.set(attachmentKey, file);
      return file;
    } catch (_) {
      const empty = emptyFile(attachmentKey, parentItemKey);
      this.cache.set(attachmentKey, empty);
      return empty;
    }
  }

  private persist(file: AINotesFile): void {
    this.cache.set(file.attachmentKey, file);
    writeFileAsync(filePath(file.attachmentKey), JSON.stringify(file, null, 2));
    this.notify(file.attachmentKey);
  }

  getNotes(attachmentKey: string, parentItemKey = ""): AINote[] {
    if (!attachmentKey) return [];
    return [...this.load(attachmentKey, parentItemKey).notes];
  }

  getNote(attachmentKey: string, noteId: string): AINote | null {
    return this.getNotes(attachmentKey).find((n) => n.id === noteId) || null;
  }

  nextNumber(attachmentKey: string, parentItemKey = ""): number {
    const notes = this.getNotes(attachmentKey, parentItemKey);
    let max = 0;
    for (const n of notes) max = Math.max(max, n.number);
    return max + 1;
  }

  createNote(input: {
    attachmentKey: string;
    parentItemKey: string;
    pageIndex: number;
    rect: [number, number, number, number];
    content?: string;
    color?: string;
  }): AINote {
    const file = this.load(input.attachmentKey, input.parentItemKey);
    file.parentItemKey = input.parentItemKey || file.parentItemKey;
    const now = Date.now();
    const note: AINote = {
      id: genId(),
      number: this.nextNumber(input.attachmentKey, input.parentItemKey),
      attachmentKey: input.attachmentKey,
      parentItemKey: input.parentItemKey,
      pageIndex: input.pageIndex,
      rect: input.rect,
      content: input.content || "",
      color: input.color || DEFAULT_NOTE_COLOR,
      createdAt: now,
      updatedAt: now,
    };
    file.notes.push(note);
    file.notes.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
    this.persist(file);
    return note;
  }

  updateNote(
    attachmentKey: string,
    noteId: string,
    patch: Partial<Pick<AINote, "content" | "rect" | "pageIndex" | "color" | "zoteroAnnotationKey">>,
  ): AINote | null {
    const file = this.load(attachmentKey);
    const idx = file.notes.findIndex((n) => n.id === noteId);
    if (idx < 0) return null;
    const prev = file.notes[idx];
    const next: AINote = {
      ...prev,
      ...patch,
      id: prev.id,
      number: prev.number,
      attachmentKey: prev.attachmentKey,
      parentItemKey: prev.parentItemKey,
      updatedAt: Date.now(),
    };
    file.notes[idx] = next;
    this.persist(file);
    return next;
  }

  deleteNote(attachmentKey: string, noteId: string): boolean {
    const file = this.load(attachmentKey);
    const before = file.notes.length;
    file.notes = file.notes.filter((n) => n.id !== noteId);
    if (file.notes.length === before) return false;
    this.persist(file);
    return true;
  }

  formatForLLM(attachmentKey: string, parentItemKey = ""): string {
    const notes = this.getNotes(attachmentKey, parentItemKey);
    if (!notes.length) return "";
    const blocks = notes.map((n) => {
      const body = (n.content || "").trim() || "[empty note]";
      return `[AI Note #${n.number}] (id=${n.id}, page ${n.pageIndex + 1})\n${body}`;
    });
    return [
      "AI sticky notes placed on the current PDF by the user.",
      "The user may refer to them as #1, #2, Note 1, 便签1, etc.",
      "When answering, use these notes when relevant and cite them by number.",
      "",
      ...blocks,
    ].join("\n");
  }

  /** Resolve note numbers mentioned in user text (#1, Note 2, 便签3). */
  findReferencedNotes(attachmentKey: string, userText: string, parentItemKey = ""): AINote[] {
    const notes = this.getNotes(attachmentKey, parentItemKey);
    if (!notes.length || !userText) return [];
    const wanted = new Set<number>();
    const re = /(?:#|note\s*|便签\s*|笔记\s*)(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(userText))) {
      wanted.add(parseInt(m[1], 10));
    }
    if (!wanted.size) return notes;
    return notes.filter((n) => wanted.has(n.number));
  }
}

export const aiNotesStore = new AINotesStore();
