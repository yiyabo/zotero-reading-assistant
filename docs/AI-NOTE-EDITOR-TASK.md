# Task: AI-Assisted Note Editor for Zotero Reading Assistant

## Project context

**Repo:** `/Users/apple/work/zotero-llm/zotero-reading-assistant`
**What it is:** A Zotero 7 plugin (TypeScript, bundled with esbuild into a single XPI). One of its features is **AI sticky notes** — numbered Markdown notes overlaid on the PDF reader. Notes persist per PDF attachment as JSON and are injected into the sidebar LLM chat context (cited as `#1`, `#2`, ...).

**Important platform constraints:**
- Zotero 7 runs on the **Gecko (Firefox) engine**. No `console.*` in bundled code — use `Zotero.debug(...)`.
- Build/typecheck: `npx tsc --noEmit` (must pass) then `npm run build-dev` then `npm run link-dev`. User restarts Zotero to load.
- All DOM is built programmatically (`doc.createElement`), CSS injected via a `<style>` tag.

## Files you will work in

| File | Role |
|------|------|
| `src/features/ai-notes/AINotesOverlay.ts` | The reader overlay: place/edit/drag/resize notes, and the **fixed editor modal**. **This is the main file to change.** |
| `src/features/ai-notes/overlayCss.ts` | CSS injected into the reader document (note card + fixed editor styles). |
| `src/features/ai-notes/AINotesStore.ts` | JSON persistence. `aiNotesStore` singleton with `createNote / updateNote / deleteNote / getNotes`. |
| `src/features/ai-notes/types.ts` | `AINote` type + `DEFAULT_NOTE_*` consts. |
| `src/modules/llm/LLMManager.ts` | LLM singleton. Use `getLLMManager()`. |
| `src/modules/llm/types.ts` | `Message`, `StreamCallback`, `LLMProvider`. |
| `src/modules/zotero/PDFReader.ts` | PDF text extraction helpers. |

## The task (confirmed scope — first version)

Add an **AI toolbar to the note's fixed editor** with three AI actions, reusing the existing sidebar LLM configuration (do NOT add a separate LLM config):

- **A. AI Generate** — generate note content automatically from context.
- **B. AI Optimize Format** — take the user's rough free-text in the textarea and rewrite it as clean, structured Markdown.
- **C. AI Rewrite Selection** — when the user has selected a span of text in the textarea, rewrite only that selected span (the rest stays untouched).

**Context given to the AI:** the text of the PDF page the note sits on + the current selection (if any). Out of scope for v1 (do NOT build): live/split Markdown preview.

## Key integration details (use these exact signatures — do not guess)

### LLM call (streaming, singleton)

```ts
import { getLLMManager } from "../../modules/llm/LLMManager";
import type { Message, StreamCallback } from "../../modules/llm/types";

const mgr = getLLMManager();
if (!mgr.isReady()) { mgr.showConfigError(); /* bail out */ }

const messages: Message[] = [
  { role: "system", content: "..." },
  { role: "user", content: "..." },
];

await mgr.chat(messages, {
  onToken: (t) => { /* append streaming token into the textarea */ },
  onComplete: (full) => { /* finalize */ },
  onError: (e) => { /* show error state, restore */ },
} as StreamCallback);
// chat() resolves to the full string; it can also be captured via onComplete.
```

- `Message.content` is `string` for these text-only calls.
- There is an in-flight `abort()` on the manager if you add a cancel button (optional).

### PDF page text + selection

```ts
import { getPDFSelection } from "../../modules/zotero/PDFReader";
// getPDFSelection(item?) -> Promise<string>  (current PDF selection, "" if none)
```

- The note already knows its page: each `AINote` has `pageIndex` (0-based) and `attachmentKey`.
- The overlay (`AINotesOverlay.ts`) already has access to the PDF.js page objects via `getPdfApp(binding.reader)?.pdfViewer?._pages[note.pageIndex]`. To extract that page's text you can call `pageView.pdfPage.getTextContent()` and join `items[].str` (same approach as `PDFReader.getPDFPageTexts`). Reuse that pattern rather than re-deriving it.

## Current state of AINotesOverlay.ts (important — read before editing)

- **Fixed editor:** `renderFixedEditor(binding, note)` builds a centered modal (`.ra-ainote-fixed-editor` overlay + `.ra-ainote-fixed-card`) appended to the **reader chrome window document** (not the PDF iframe doc). It has a header (badge + title + close ×), a `<textarea class="ra-ainote-fixed-textarea">`, and a footer (`删除 / 取消 / 保存`).
- The editor is **not recreated while open** — `renderFixedEditor` early-returns if `findFixedEditor(binding, note.id)` finds it (the 1.2s reader poll calls `renderReader` repeatedly).
- Close paths: header ×, footer 取消, `Escape`, and clicking the overlay backdrop all call `closeEditor(binding, noteId)`.
- **Drag/resize** uses window-capture-phase listeners + `stopImmediatePropagation()` so Zotero's PDF viewer never sees the gesture (this fixed page-pan and text-selection bugs — do not regress it).
- CSS prefix is `ra-ainote`; styles come from `buildOverlayCss(PREFIX)` in `overlayCss.ts`, refreshed on every `ensureStyle(doc)` call.

## What to build (concrete)

1. **AI toolbar row** inside `.ra-ainote-fixed-card`, between the textarea and the footer (or as a row above the footer). Buttons:
   - `✨ 生成` (Generate)
   - `整理格式` (Optimize)
   - `重写选中` (Rewrite selection) — disabled unless `textarea.selectionStart !== textarea.selectionEnd`.
2. **Behavior per action:**
   - **Generate:** prompt = system (you are a research-note assistant; output concise structured Markdown only, no preamble) + user (page text + instruction). Stream the result into the textarea (replace current value progressively). Show a busy/spinner state on the button; disable all three AI buttons while a request is in flight.
   - **Optimize:** prompt = current textarea content + "rewrite as clean structured Markdown, keep meaning, output only the markdown". Stream result back into the textarea (replace all).
   - **Rewrite selection:** capture `selectionStart/End`, prompt = the selected text + surrounding context + rewrite instruction. On completion, splice the result back in place of the selection (`value.slice(0,start) + result + value.slice(end)`), restore a sensible cursor position.
3. **Keyboard in the textarea must keep working.** A recent fix added `stopImmediatePropagation()` on `keydown/keyup/keypress` at the textarea to stop Zotero's global reader shortcuts (arrow keys = page nav, Ctrl+A) from hijacking the editor. Do not remove this. Verify arrow keys and Ctrl/Cmd+A still work after your changes.
4. **Errors:** if LLM not configured, call `mgr.showConfigError()`; on `onError`, show a transient inline error and restore the previous textarea content if it was clobbered.
5. **Do not** save automatically — the user still presses 保存 to persist via `aiNotesStore.updateNote(...)`.

## Acceptance criteria

- `npx tsc --noEmit` passes; `npm run build-dev` succeeds.
- Fixed editor shows the AI toolbar; all three actions work and stream text into the textarea.
- Rewrite-selection only modifies the selected span.
- Arrow keys, Ctrl/Cmd+A, and Escape-to-close all still work inside the textarea.
- No `console.*` calls; use `Zotero.debug` for logging.
- No regression to note drag/resize (no page-pan, no text-selection during drag).

## Suggested prompts (starting point, tune as needed)

- Generate system: "You write concise, well-structured Markdown study notes for an academic PDF. Output only the note body in Markdown — no preamble, no commentary."
- Optimize user: "Rewrite the following rough note as clean, structured Markdown. Preserve all meaning. Output only the Markdown.\n\n<current text>"
- Rewrite user: "Rewrite the selected passage according to this instruction: <instruction if provided, else 'improve clarity and concision'>. Output only the rewritten passage, nothing else.\n\nContext (for reference only, do not include): <surrounding text>\n\nPassage to rewrite:\n<selected text>"
