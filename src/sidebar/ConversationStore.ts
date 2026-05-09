/**
 * Conversation persistence
 * ----------------------------------------------------------------------------
 * Loads and saves chat history per Zotero item, keyed by item ID. Uses two
 * storage backends in priority order:
 *
 *   1. **File**: JSON under Zotero's data directory at
 *      `<DataDirectory>/reading-assistant/conversations/<key>.json`. Primary
 *      storage — preferred because it scales with conversation length.
 *   2. **Preference**: legacy fallback at
 *      `extensions.zotero.<addonRef>.conversation.<key>`. Only read on first
 *      load to migrate users from older plugin versions; new saves always
 *      go to disk.
 *
 * Repair pass: stored messages are run through a UTF-8 mojibake fix
 * (`maybeRepairMojibake`) at parse time to clean up double-encoded data
 * that older plugin versions sometimes wrote.
 */
import { Message } from "../modules/llm/types";
import { getPref } from "../modules/utils/prefs";

declare const Cc: any;
declare const Ci: any;

export type StoredConversation = {
  messages: Message[];
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function conversationFilePath(key: string): string {
  const dir = (Zotero as any).DataDirectory?.dir || (Zotero as any).Profile?.dir || "";
  return dir + "/reading-assistant/conversations/" + key + ".json";
}

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

// ---------------------------------------------------------------------------
// Public load / save
// ---------------------------------------------------------------------------

/**
 * Load conversation history for the given key (item ID).
 *
 * Tries the JSON file on disk first; if missing or malformed, falls back to
 * the legacy Pref-based storage. Returns an empty array when nothing exists.
 *
 * Only `user` and `assistant` messages are returned; any system or tool
 * messages stored historically are filtered out so callers can append fresh
 * system prompts at runtime.
 */
export function loadConversation(addonRef: string, key: string): Message[] {
  const filePath = conversationFilePath(key);
  const fileContent = readFileSync(filePath);
  const fromFile = safeParseConversation(fileContent);
  if (fromFile) {
    return fromFile.messages.filter((m) => m.role === "user" || m.role === "assistant");
  }
  const fromPref = safeParseConversation(
    getPref("extensions.zotero." + addonRef + ".conversation." + key),
  );
  return (
    fromPref?.messages?.filter((m) => m.role === "user" || m.role === "assistant") || []
  );
}

/**
 * Persist the (last 40 messages of the) conversation history to disk.
 *
 * Errors are swallowed and logged; persistence failures should never crash
 * the chat UI. The 40-message cap matches the previous in-class behavior —
 * keeps storage bounded for very long sessions while still being plenty for
 * context retention.
 *
 * `addonRef` is currently unused (file path is hardcoded under
 * `reading-assistant/`) but accepted for API symmetry with `loadConversation`
 * and to keep the public surface stable if we later want per-addon paths.
 */
export function saveConversation(
  _addonRef: string,
  key: string,
  messages: Message[],
): void {
  try {
    const data: StoredConversation = {
      messages: messages.slice(-40),
      updatedAt: Date.now(),
    };
    writeFileAsync(conversationFilePath(key), JSON.stringify(data));
  } catch (e: any) {
    Zotero.debug("[RA] Save conversation failed: " + (e.message || e));
  }
}
