/** Injected into the reader iframe document. */
export function buildOverlayCss(prefix: string): string {
  return `
.${prefix}-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 50;
  overflow: visible !important;
}

.${prefix}-note {
  position: absolute;
  pointer-events: auto;
  width: 200px;
  min-width: 96px;
  min-height: 72px;
  max-width: min(420px, 70vw);
  box-sizing: border-box;
  border: 1px solid rgba(124, 58, 237, 0.35);
  border-radius: 12px;
  background: linear-gradient(180deg, #faf5ff 0%, #ffffff 40%);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.8) inset,
    0 8px 24px rgba(91, 33, 182, 0.14),
    0 2px 6px rgba(15, 23, 42, 0.06);
  display: flex;
  flex-direction: column;
  overflow: visible;
  font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: #1f2937;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
  touch-action: none;
}
.${prefix}-note:hover {
  border-color: rgba(124, 58, 237, 0.55);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.9) inset,
    0 12px 28px rgba(91, 33, 182, 0.18),
    0 4px 10px rgba(15, 23, 42, 0.08);
}
.${prefix}-note.is-editing {
  z-index: 40;
  width: 300px !important;
  min-width: 300px !important;
  height: 240px !important;
  min-height: 240px !important;
  border-color: rgba(124, 58, 237, 0.65);
  box-shadow:
    0 0 0 3px rgba(124, 58, 237, 0.14),
    0 14px 34px rgba(91, 33, 182, 0.22);
  overflow: hidden;
}
.${prefix}-note.is-editing .${prefix}-footer {
  flex-shrink: 0;
}
.${prefix}-note.is-editing .${prefix}-editor {
  flex: 1 1 auto;
  min-height: 0;
}

.${prefix}-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 7px 8px 6px 8px;
  background: linear-gradient(180deg, rgba(124,58,237,0.12), rgba(124,58,237,0.05));
  border-bottom: 1px solid rgba(124, 58, 237, 0.12);
  cursor: grab;
  user-select: none;
}
.${prefix}-head:active { cursor: grabbing; }
.${prefix}-badge {
  flex: 0 0 auto;
  min-width: 28px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: #7c3aed;
  color: #fff;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.02em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 3px rgba(91, 33, 182, 0.35);
}
.${prefix}-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
  font-size: 11.5px;
  color: #5b21b6;
}
.${prefix}-actions {
  display: inline-flex;
  gap: 2px;
  flex: 0 0 auto;
}
.${prefix}-btn {
  border: none;
  background: transparent;
  color: #6d28d9;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.8;
}
.${prefix}-btn:hover {
  background: rgba(124, 58, 237, 0.14);
  opacity: 1;
}
.${prefix}-btn.danger:hover {
  background: rgba(239, 68, 68, 0.12);
  color: #b91c1c;
}
.${prefix}-btn.danger.is-armed {
  width: auto;
  min-width: 30px;
  padding: 0 5px;
  background: #dc2626;
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  opacity: 1;
  animation: ${prefix}-del-pulse 0.9s ease-in-out infinite;
}
@keyframes ${prefix}-del-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45); }
  50% { box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.12); }
}

.${prefix}-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 10px 14px;
  overflow: auto;
  cursor: text;
  word-break: break-word;
  overflow-wrap: anywhere;
  border-radius: 0 0 12px 12px;
}
.${prefix}-body.markdown-body {
  font-size: 12.5px;
  line-height: 1.55;
  color: #1f2937;
}
.${prefix}-body.markdown-body p { margin: 0 0 6px; }
.${prefix}-body.markdown-body p:last-child { margin-bottom: 0; }
.${prefix}-body.markdown-body ul,
.${prefix}-body.markdown-body ol { margin: 0 0 6px; padding-left: 1.25em; }
.${prefix}-body.markdown-body h1,
.${prefix}-body.markdown-body h2,
.${prefix}-body.markdown-body h3 {
  margin: 0 0 6px;
  font-size: 1.05em;
  color: #4c1d95;
}
.${prefix}-body.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: rgba(124, 58, 237, 0.08);
  padding: 0 3px;
  border-radius: 3px;
}
.${prefix}-body.markdown-body pre {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  overflow-x: auto;
  font-size: 11px;
}
.${prefix}-empty {
  color: #9ca3af;
  font-size: 12px;
  line-height: 1.5;
}
.${prefix}-empty em {
  color: #7c3aed;
  font-style: normal;
  font-weight: 650;
}

.${prefix}-editor {
  flex: 1 1 auto;
  min-height: 96px;
  width: 100%;
  box-sizing: border-box;
  border: none;
  resize: none;
  padding: 8px 10px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, "PingFang SC", monospace;
  color: #111827;
  background: #fff;
  outline: none;
}
.${prefix}-editor::placeholder {
  color: #9ca3af;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}

.${prefix}-footer {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px;
  border-top: 1px solid rgba(124, 58, 237, 0.12);
  background: rgba(250, 245, 255, 0.95);
}
.${prefix}-footer-btn {
  flex: 1 1 0;
  min-width: 0;
  border: 1px solid rgba(124, 58, 237, 0.28);
  background: #fff;
  color: #5b21b6;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 650;
  padding: 7px 6px;
  cursor: pointer;
  white-space: nowrap;
}
.${prefix}-footer-btn:hover { background: rgba(124, 58, 237, 0.06); }
.${prefix}-footer-btn.primary {
  background: #7c3aed;
  border-color: #7c3aed;
  color: #fff;
}
.${prefix}-footer-btn.primary:hover { background: #6d28d9; }
.${prefix}-footer-btn.danger {
  color: #b91c1c;
  border-color: #fecaca;
  flex: 0 0 auto;
  min-width: 52px;
}
.${prefix}-footer-btn.danger:hover { background: #fef2f2; }

.${prefix}-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  background:
    linear-gradient(135deg, transparent 50%, rgba(124,58,237,0.55) 50%),
    linear-gradient(135deg, transparent 68%, rgba(124,58,237,0.28) 68%);
  border-radius: 0 0 12px 0;
  pointer-events: auto;
  opacity: 0.85;
  z-index: 2;
}
.${prefix}-note:hover .${prefix}-resize,
.${prefix}-note.is-editing .${prefix}-resize { opacity: 1; }

.${prefix}-drag-shield {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483600 !important;
  background: transparent !important;
  pointer-events: auto !important;
  user-select: none !important;
}

.${prefix}-place-banner {
  position: fixed;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  pointer-events: none;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(91, 33, 182, 0.94);
  color: #fff;
  font: 600 12.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  box-shadow: 0 10px 28px rgba(91, 33, 182, 0.4);
  white-space: nowrap;
}

/* Dedicated host so we never inject into the page-number control */
.${prefix}-toolbar-host {
  display: inline-flex !important;
  align-items: center !important;
  margin-left: 8px !important;
  flex: 0 0 auto !important;
}
.${prefix}-toolbar-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
  margin: 0 !important;
  padding: 0 10px !important;
  height: 24px !important;
  border-radius: 999px !important;
  border: 1px solid rgba(124, 58, 237, 0.4) !important;
  background: rgba(124, 58, 237, 0.1) !important;
  color: #5b21b6 !important;
  font: 600 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  box-sizing: border-box !important;
}
.${prefix}-toolbar-btn:hover {
  background: rgba(124, 58, 237, 0.18) !important;
}
.${prefix}-toolbar-btn.is-active {
  background: #7c3aed !important;
  border-color: #7c3aed !important;
  color: #fff !important;
}

.${prefix}-fixed-editor {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: rgba(15, 23, 42, 0.4) !important;
  pointer-events: auto !important;
  padding: 24px !important;
  box-sizing: border-box !important;
}
.${prefix}-fixed-card {
  width: min(520px, 92vw);
  height: min(470px, 82vh);
  max-height: min(580px, 88vh);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 14px;
  border: 1px solid rgba(124, 58, 237, 0.35);
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.28);
  overflow: hidden;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  pointer-events: auto;
}
.${prefix}-fixed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  background: linear-gradient(180deg, #f5f3ff, #ede9fe);
  border-bottom: 1px solid rgba(124, 58, 237, 0.15);
  flex: 0 0 auto;
}
.${prefix}-fixed-head .${prefix}-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 700;
  color: #5b21b6;
}

/* Edit / split / preview switch */
.${prefix}-viewtabs {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px;
  gap: 2px;
  border-radius: 999px;
  background: rgba(124, 58, 237, 0.1);
  border: 1px solid rgba(124, 58, 237, 0.18);
}
.${prefix}-viewtab {
  border: none;
  background: transparent;
  color: #6d28d9;
  border-radius: 999px;
  padding: 3px 10px;
  font: 650 11.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.${prefix}-viewtab:hover { background: rgba(124, 58, 237, 0.14); }
.${prefix}-viewtab.is-active {
  background: #7c3aed;
  color: #fff;
  box-shadow: 0 1px 3px rgba(91, 33, 182, 0.3);
}

.${prefix}-fixed-main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
}
.${prefix}-fixed-textarea {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  border: none;
  resize: none;
  padding: 14px 16px;
  font: 13.5px/1.55 ui-monospace, SFMono-Regular, Menlo, "PingFang SC", monospace;
  color: #111827;
  outline: none;
  background: #fff;
}

.${prefix}-preview {
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px;
  box-sizing: border-box;
  background: #fdfcff;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.${prefix}-preview-empty {
  color: #b6b0c2;
  font-size: 12.5px;
}

/* The fixed editor lives in the reader chrome doc, which has none of the
   sidebar's markdown styles — restate what the preview needs. */
.${prefix}-preview.markdown-body {
  font: 13px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: #1f2937;
}
.${prefix}-preview.markdown-body > :first-child { margin-top: 0; }
.${prefix}-preview.markdown-body > :last-child { margin-bottom: 0; }
.${prefix}-preview.markdown-body p { margin: 0 0 8px; }
.${prefix}-preview.markdown-body ul,
.${prefix}-preview.markdown-body ol { margin: 0 0 8px; padding-left: 1.4em; }
.${prefix}-preview.markdown-body li { margin: 2px 0; }
.${prefix}-preview.markdown-body h1,
.${prefix}-preview.markdown-body h2,
.${prefix}-preview.markdown-body h3,
.${prefix}-preview.markdown-body h4 {
  margin: 14px 0 7px;
  line-height: 1.35;
  color: #4c1d95;
  font-weight: 700;
}
.${prefix}-preview.markdown-body h1 { font-size: 1.32em; }
.${prefix}-preview.markdown-body h2 { font-size: 1.18em; }
.${prefix}-preview.markdown-body h3 { font-size: 1.06em; }
.${prefix}-preview.markdown-body h4 { font-size: 1em; }
.${prefix}-preview.markdown-body strong { color: #111827; font-weight: 700; }
.${prefix}-preview.markdown-body a { color: #6d28d9; }
.${prefix}-preview.markdown-body hr {
  border: none;
  border-top: 1px solid rgba(124, 58, 237, 0.2);
  margin: 12px 0;
}
.${prefix}-preview.markdown-body blockquote {
  margin: 8px 0;
  padding: 2px 0 2px 10px;
  border-left: 3px solid rgba(124, 58, 237, 0.35);
  color: #4b5563;
}
.${prefix}-preview.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: rgba(124, 58, 237, 0.09);
  padding: 1px 4px;
  border-radius: 4px;
}
.${prefix}-preview.markdown-body pre {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  overflow-x: auto;
  font-size: 11.5px;
  line-height: 1.5;
}
.${prefix}-preview.markdown-body pre code {
  background: transparent;
  padding: 0;
  font-size: inherit;
  color: inherit;
}
.${prefix}-preview.markdown-body table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 0.94em;
}
.${prefix}-preview.markdown-body th,
.${prefix}-preview.markdown-body td {
  border: 1px solid rgba(124, 58, 237, 0.2);
  padding: 4px 8px;
  text-align: left;
}
.${prefix}-preview.markdown-body th { background: rgba(124, 58, 237, 0.07); }
.${prefix}-preview.markdown-body img { max-width: 100%; }
.${prefix}-preview .readingassistant-table-scroll { overflow-x: auto; }

/* Layout per view mode */
.${prefix}-fixed-card[data-view="edit"] .${prefix}-preview { display: none; }
.${prefix}-fixed-card[data-view="preview"] .${prefix}-fixed-textarea { display: none; }
.${prefix}-fixed-card[data-view="preview"] .${prefix}-preview { flex: 1 1 100%; }
.${prefix}-fixed-card[data-view="split"] { width: min(880px, 94vw); }
.${prefix}-fixed-card[data-view="split"] .${prefix}-fixed-textarea {
  flex: 1 1 50%;
  border-right: 1px solid rgba(124, 58, 237, 0.16);
}
@media (max-width: 720px) {
  .${prefix}-fixed-card[data-view="split"] .${prefix}-fixed-main { flex-direction: column; }
  .${prefix}-fixed-card[data-view="split"] .${prefix}-fixed-textarea {
    flex: 1 1 50%;
    border-right: none;
    border-bottom: 1px solid rgba(124, 58, 237, 0.16);
  }
}
.${prefix}-fixed-textarea::placeholder {
  color: #9ca3af;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}
/* Locked while an AI request streams into it. */
.${prefix}-fixed-textarea:read-only {
  background: #fbfaff;
  cursor: default;
}
/* AI assist toolbar between the textarea and the footer */
.${prefix}-ai-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px 14px;
  border-top: 1px solid rgba(124, 58, 237, 0.12);
  background: linear-gradient(180deg, #ffffff, #f8f5ff);
}
.${prefix}-ai-bar [hidden] { display: none !important; }
.${prefix}-ai-btn {
  flex: 0 0 auto;
  border: 1px solid rgba(124, 58, 237, 0.3);
  background: #fff;
  color: #5b21b6;
  border-radius: 999px;
  padding: 6px 11px;
  font: 650 12px/1.15 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.${prefix}-ai-btn:hover:not(:disabled) {
  background: rgba(124, 58, 237, 0.09);
  border-color: rgba(124, 58, 237, 0.5);
}
.${prefix}-ai-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.${prefix}-ai-btn.is-running {
  background: #7c3aed;
  border-color: #7c3aed;
  color: #fff;
  opacity: 1;
}
.${prefix}-ai-btn.is-running::before {
  content: "";
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 5px;
  vertical-align: -1px;
  box-sizing: border-box;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ${prefix}-ai-spin 0.7s linear infinite;
}
@keyframes ${prefix}-ai-spin {
  to { transform: rotate(360deg); }
}
.${prefix}-ai-btn.ghost {
  border-style: dashed;
  border-color: #d1d5db;
  color: #6b7280;
}
.${prefix}-ai-btn.stop {
  background: #fff5f5;
  border-color: #fecaca;
  color: #b91c1c;
}
.${prefix}-ai-btn.stop:hover:not(:disabled) {
  background: #fee2e2;
  border-color: #fca5a5;
}
.${prefix}-ai-status {
  flex: 1 1 110px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.35;
  color: #6b7280;
}
.${prefix}-ai-status[data-tone="busy"] { color: #6d28d9; font-weight: 650; }
.${prefix}-ai-status[data-tone="ok"] { color: #047857; }
.${prefix}-ai-status[data-tone="warn"] { color: #b45309; }
.${prefix}-ai-status[data-tone="err"] { color: #b91c1c; }

.${prefix}-fixed-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid rgba(124, 58, 237, 0.12);
  background: #faf5ff;
  flex: 0 0 auto;
}
.${prefix}-fixed-spacer { flex: 1 1 auto; }
.${prefix}-fixed-footer .${prefix}-footer-btn {
  flex: 0 0 auto;
  min-width: 72px;
  padding: 8px 14px;
  font-size: 13px;
}
`;
}
