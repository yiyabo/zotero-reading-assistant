import { config } from "../../../package.json";

export type WikiNote = {
  pageId: string;
  body: string;
  updatedAt: number;
};

export type WikiState = {
  version: 1;
  notes: Record<string, WikiNote>;
  createdAt: number;
  updatedAt: number;
};

type WikiStoreListener = (state: WikiState) => void;

function makeEmptyState(): WikiState {
  const now = Date.now();
  return { version: 1, notes: {}, createdAt: now, updatedAt: now };
}

function resolveStateFilePath(): string {
  const dataDir =
    (Zotero as any).DataDirectory?.dir ||
    (Zotero.Prefs as any).get?.("dataDir") ||
    "";
  if (!dataDir) throw new Error("[RA] WikiStore: no data directory available");
  const PU = (globalThis as any).PathUtils;
  if (PU?.join) return PU.join(dataDir, "zotero-reading-assistant", "wiki-state.json");
  return dataDir.replace(/[\\/]+$/, "") + "/zotero-reading-assistant/wiki-state.json";
}

async function ensureDirectoryFor(filePath: string): Promise<void> {
  const PU = (globalThis as any).PathUtils;
  const IOU = (globalThis as any).IOUtils;
  if (!PU?.parent || !IOU?.makeDirectory) return;
  await IOU.makeDirectory(PU.parent(filePath), { ignoreExisting: true, createAncestors: true });
}

async function readJSONFile<T>(filePath: string): Promise<T | null> {
  try {
    const txt = await (Zotero.File as any).getContentsAsync(filePath);
    return txt ? (JSON.parse(txt) as T) : null;
  } catch (e: any) {
    Zotero.debug("[RA] WikiStore read miss: " + (e?.message || e));
    return null;
  }
}

async function writeJSONFile(filePath: string, data: unknown): Promise<void> {
  await (Zotero.File as any).putContentsAsync(filePath, JSON.stringify(data, null, 2));
}

function normalizeLoadedState(raw: Partial<WikiState> | null): WikiState {
  const empty = makeEmptyState();
  if (!raw || typeof raw !== "object") return empty;
  const notes: Record<string, WikiNote> = {};
  for (const [pageId, note] of Object.entries(raw.notes || {})) {
    if (!pageId || !note) continue;
    notes[pageId] = {
      pageId,
      body: String((note as WikiNote).body || ""),
      updatedAt: Number((note as WikiNote).updatedAt || 0),
    };
  }
  return {
    version: 1,
    notes,
    createdAt: Number(raw.createdAt || empty.createdAt),
    updatedAt: Number(raw.updatedAt || empty.updatedAt),
  };
}

class WikiStore {
  private state: WikiState = makeEmptyState();
  private listeners = new Set<WikiStoreListener>();
  private filePath: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.filePath = resolveStateFilePath();
      await ensureDirectoryFor(this.filePath);
      this.state = normalizeLoadedState(await readJSONFile<WikiState>(this.filePath));
    } catch (e: any) {
      Zotero.debug("[RA] WikiStore init error: " + (e?.message || e));
      this.state = makeEmptyState();
    } finally {
      this.initialized = true;
    }
  }

  getState(): WikiState {
    return this.state;
  }

  getNote(pageId: string): WikiNote | undefined {
    return this.state.notes[pageId];
  }

  async setNote(pageId: string, body: string): Promise<void> {
    const trimmedId = String(pageId || "").trim();
    if (!trimmedId) return;
    const now = Date.now();
    this.state.notes[trimmedId] = { pageId: trimmedId, body, updatedAt: now };
    this.state.updatedAt = now;
    await this.persist();
    this.notify();
  }

  subscribe(listener: WikiStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const path = this.filePath;
    const snapshot = JSON.parse(JSON.stringify(this.state)) as WikiState;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeJSONFile(path, snapshot);
      } catch (e: any) {
        Zotero.debug("[RA] WikiStore persist error: " + (e?.message || e));
      }
    });
    return this.writeQueue;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e: any) {
        Zotero.debug("[RA] WikiStore listener threw: " + (e?.message || e));
      }
    }
  }
}

export const wikiStore = new WikiStore();

try {
  (Zotero as any)[`${config.addonInstance}_wikiStore`] = wikiStore;
} catch (_) {}
