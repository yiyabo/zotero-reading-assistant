/**
 * Sidebar style template
 * ----------------------------------------------------------------------------
 * Extracted from `SidebarView.ts` to keep that file focused on rendering and
 * lifecycle logic. The CSS is a single function returning a template literal
 * so callers can interpolate the addon ref (the namespace prefix used to
 * scope all selectors). All visual behavior is **byte-for-byte identical**
 * to the inline template that previously lived in `ensureStyles()`.
 *
 * To add new styles, edit this file directly. To add a new dynamic value
 * (e.g. theme color override at runtime), add a parameter to
 * `buildSidebarStyles()` and reference it inside the template.
 */
export function buildSidebarStyles(addonRef: string): string {
  return `
      .${addonRef}-panel,
      .${addonRef}-panel * {
        box-sizing: border-box;
      }

      /* CSS-level fallback for the section body — the inline !important rules in
         applyBodyHostStyles() are the primary mechanism, but these keep things
         sane if the inline styles ever get cleared. Dual-mode flex: stretches in
         focus/single-section mode, degrades to content sizing in multi-section. */
      .${addonRef}-panel-host {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        min-width: 0;
        max-width: 100%;
        overflow-x: hidden;
        box-sizing: border-box;
      }

      .${addonRef}-panel {
        --ra-primary: #8B5CF6;
        --ra-primary-soft: #A78BFA;
        --ra-secondary: #7C3AED;
        --ra-accent: #A855F7;
        --ra-gradient: linear-gradient(135deg, #7C3AED 0%, #8B5CF6 55%, #A855F7 100%);
        --ra-gradient-soft: linear-gradient(135deg, rgba(139,92,246,0.10) 0%, rgba(168,85,247,0.10) 100%);
        --ra-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
        --ra-shadow-md: 0 4px 12px rgba(139, 92, 246, 0.18);
        --ra-shadow-lg: 0 10px 28px rgba(139, 92, 246, 0.22);
        --ra-radius: 16px;
        --ra-radius-lg: 22px;
        --ra-radius-xl: 26px;
        --ra-bg: var(--material-background, #ffffff);
        --ra-text: var(--fill-primary, #1f2937);
        --ra-text-muted: var(--fill-secondary, #6b7280);
        --ra-border: var(--color-border, #e5e7eb);

        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        width: 100%;
        max-width: 100%;
        inline-size: 100%;
        max-inline-size: 100%;
        min-width: 0;
        /* Force panel height to exactly (viewport_bottom − panel_top). Setting
           min and max to the same variable is equivalent to height: <var> but
           plays nicer inside flex contexts. The variable is updated by
           setupPanelMaxHeight() based on real geometry, so it adapts to
           Zotero's chrome (paper title, section header, sibling sections) and
           right-pane scrolls. The fallback (calc) keeps things sane before the
           first JS measurement. This is what anchors the input dock at viewport
           bottom AND eliminates empty space below the panel for short chats. */
        min-height: var(--ra-panel-height, calc(100vh - 160px));
        max-height: var(--ra-panel-height, calc(100vh - 160px));
        gap: 10px;
        overflow-x: hidden;
        padding: 12px;
        position: relative;
        color: var(--ra-text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        background:
          radial-gradient(circle at 0% 0%, rgba(139, 92, 246, 0.08) 0%, transparent 45%),
          radial-gradient(circle at 100% 100%, rgba(168, 85, 247, 0.07) 0%, transparent 50%),
          var(--ra-bg);
      }

      .${addonRef}-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        max-width: 100%;
        flex: 0 0 auto;
        min-width: 0;
      }

      .${addonRef}-status {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ra-text-muted);
        font-size: 11px;
        text-align: right;
        flex: 1 1 auto;
      }

      .${addonRef}-status:not(:empty) {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        justify-content: flex-end;
      }

      .${addonRef}-status:not(:empty)::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ra-secondary);
        box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.6);
        animation: ra-pulse 1.4s ease-in-out infinite;
      }

      @keyframes ra-pulse {
        0% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); }
        70% { box-shadow: 0 0 0 6px rgba(139, 92, 246, 0); }
        100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0); }
      }

      .${addonRef}-toolbar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: none;
        border-radius: 10px;
        background: var(--ra-gradient-soft);
        color: var(--ra-secondary);
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        flex-shrink: 0;
      }

      .${addonRef}-toolbar-btn:hover {
        background: var(--ra-gradient);
        color: #fff;
        transform: translateY(-1px);
        box-shadow: var(--ra-shadow-md);
      }

      .${addonRef}-toolbar-btn:active {
        transform: translateY(0) scale(0.96);
      }

      .${addonRef}-messages {
        display: flex;
        flex-direction: column;
        /* basis: auto (content) so when the parent is unbounded (multi-section
           mode) we still get content height; grow:1 + shrink:1 lets us fill the
           panel in focus mode and shrink when content overflows. */
        flex: 1 1 auto;
        width: 100%;
        max-width: 100%;
        inline-size: 100%;
        max-inline-size: 100%;
        min-width: 0;
        min-height: 0;
        gap: 18px;
        /* No max-height: in focus mode flex:1 stretches to fill the panel and
           the input dock sticks to the bottom; in multi-section mode the parent
           is non-flex so flex:1 degrades and messages size to their content. */
        overflow-y: auto;
        overflow-x: hidden;
        padding: 16px 14px 18px;
        border: 1px solid color-mix(in srgb, var(--ra-border) 90%, var(--ra-primary));
        border-radius: var(--ra-radius-lg);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.96) 100%),
          var(--ra-bg);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.65),
          0 1px 2px rgba(15, 23, 42, 0.03);
        -moz-user-select: text;
        overscroll-behavior: contain;
        /* No "scroll-behavior: smooth" here — per spec it only affects programmatic
           scrolls, but some browsers leak it into wheel/trackpad scrolling, making
           inertial fling feel sluggish. scrollMessagesToBottom() passes
           behavior: smooth explicitly when it wants animation, so this isn't
           needed and removing it keeps native momentum scrolling snappy. */
      }

      .${addonRef}-messages::-webkit-scrollbar {
        width: 8px;
      }
      .${addonRef}-messages::-webkit-scrollbar-track {
        background: transparent;
      }
      .${addonRef}-messages::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--ra-secondary) 30%, transparent);
        border-radius: 4px;
      }
      .${addonRef}-messages::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--ra-secondary) 55%, transparent);
      }

      .${addonRef}-empty {
        margin: auto;
        padding: 20px 14px 16px;
        border: none;
        border-radius: 0;
        color: var(--ra-text-muted);
        line-height: 1.5;
        text-align: center;
        background: transparent;
        max-width: 360px;
        width: 100%;
      }

      .${addonRef}-empty-logo {
        display: flex;
        justify-content: center;
        align-items: center;
        margin: 0 0 12px;
        font-size: 48px;
        line-height: 1;
        height: 52px;
        user-select: none;
        filter: drop-shadow(0 6px 14px rgba(139, 92, 246, 0.20));
      }

      .${addonRef}-empty-title {
        margin: 0 0 6px;
        color: var(--ra-text);
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.1px;
      }

      .${addonRef}-empty-desc {
        margin: 0 0 16px;
        font-size: 12px;
        line-height: 1.55;
      }

      .${addonRef}-empty-suggestions-label {
        margin: 4px 0 8px;
        font-size: 11px;
        font-weight: 650;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--ra-text-muted) 88%, transparent);
      }

      .${addonRef}-empty-suggestions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin: 0 0 14px;
        text-align: left;
      }

      .${addonRef}-empty-suggestion {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 9px 12px;
        border: 1px solid color-mix(in srgb, var(--ra-secondary) 22%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--ra-secondary) 6%, transparent);
        color: var(--ra-text);
        font-size: 12.5px;
        line-height: 1.4;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        text-align: left;
        font-family: inherit;
      }

      .${addonRef}-empty-suggestion:hover {
        background: color-mix(in srgb, var(--ra-secondary) 14%, transparent);
        border-color: color-mix(in srgb, var(--ra-secondary) 45%, transparent);
      }

      .${addonRef}-empty-suggestion:active {
        transform: scale(0.98);
      }

      .${addonRef}-empty-suggestion-icon {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        line-height: 1;
      }

      .${addonRef}-empty-suggestion-text {
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .${addonRef}-empty-tip {
        margin: 6px 0 0;
        padding: 8px 10px;
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--ra-text-muted);
        background: color-mix(in srgb, var(--ra-secondary) 5%, transparent);
        border-radius: 8px;
        text-align: left;
      }

      .${addonRef}-empty-setup-card {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        margin: 4px 0 0;
        padding: 14px 16px;
        border: none;
        border-radius: 14px;
        background: var(--ra-gradient);
        color: #fff;
        cursor: pointer;
        text-align: left;
        font-family: inherit;
        box-shadow: var(--ra-shadow-md);
        transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.2s ease;
      }

      .${addonRef}-empty-setup-card:hover {
        transform: translateY(-1px);
        box-shadow: var(--ra-shadow-lg);
        filter: brightness(1.05);
      }

      .${addonRef}-empty-setup-card:active {
        transform: translateY(0) scale(0.99);
      }

      .${addonRef}-empty-setup-icon {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        line-height: 1;
        background: rgba(255, 255, 255, 0.18);
        border-radius: 10px;
      }

      .${addonRef}-empty-setup-content {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .${addonRef}-empty-setup-title {
        font-size: 13.5px;
        font-weight: 650;
        letter-spacing: 0.1px;
      }

      .${addonRef}-empty-setup-desc {
        font-size: 11.5px;
        line-height: 1.4;
        opacity: 0.88;
      }

      .${addonRef}-empty-setup-arrow {
        flex: 0 0 auto;
        font-size: 16px;
        line-height: 1;
        opacity: 0.85;
      }

      /* Keyboard focus indicators: only show on Tab/keyboard focus, not on
         mouse clicks. This is critical for keyboard accessibility because
         our custom-styled buttons would otherwise have no visible focus. */
      .${addonRef}-empty-suggestion:focus-visible,
      .${addonRef}-empty-setup-card:focus-visible,
      .${addonRef}-send-btn:focus-visible,
      .${addonRef}-scroll-bottom-btn:focus-visible,
      .${addonRef}-regenerate-btn:focus-visible,
      .${addonRef}-retry-btn:focus-visible,
      .${addonRef}-copy-btn:focus-visible,
      .${addonRef}-image-remove:focus-visible,
      .${addonRef}-input:focus-visible {
        outline: 2px solid var(--ra-primary);
        outline-offset: 2px;
      }
      /* Inside the gradient setup card, the brand-colored outline would
         clash with the brand-colored background; use a brighter contrast. */
      .${addonRef}-empty-setup-card:focus-visible {
        outline-color: #fff;
        outline-offset: 3px;
      }

      .${addonRef}-deep-read-progress {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin: auto;
        padding: 24px 16px;
        text-align: center;
      }

      .${addonRef}-deep-read-spinner {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: conic-gradient(from 0deg, transparent 0%, var(--ra-secondary) 100%);
        mask: radial-gradient(farthest-side, transparent 60%, black 62%);
        -webkit-mask: radial-gradient(farthest-side, transparent 60%, black 62%);
        animation: ra-spin 0.9s linear infinite;
      }

      @keyframes ra-spin {
        to { transform: rotate(360deg); }
      }

      .${addonRef}-deep-read-progress-text {
        color: var(--ra-text-muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .${addonRef}-message {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        gap: 4px;
        max-width: 100%;
        animation: ra-msg-in 0.28s ease-out both;
      }

      @keyframes ra-msg-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .${addonRef}-message.user {
        align-items: flex-end;
        padding-left: 32px;
      }

      .${addonRef}-message.assistant {
        align-items: stretch;
        padding-right: 0;
      }

      .${addonRef}-message-label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--ra-text-muted);
        font-size: 10.5px;
        font-weight: 650;
        padding: 0 4px;
        letter-spacing: 0.3px;
        text-transform: uppercase;
      }

      .${addonRef}-message.assistant .${addonRef}-message-label::before {
        content: "";
        display: inline-block;
        width: 12px;
        height: 12px;
        border-radius: 4px;
        background: var(--ra-gradient);
        box-shadow: 0 1px 3px rgba(139, 92, 246, 0.4);
      }

      .${addonRef}-message.user .${addonRef}-message-label {
        text-align: right;
      }

      .${addonRef}-message-content {
        width: fit-content;
        max-width: 100%;
        min-width: 0;
        max-inline-size: 100%;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        white-space: normal;
        padding: 11px 14px;
        border-radius: 16px;
        line-height: 1.55;
        border: 1px solid transparent;
        box-shadow: var(--ra-shadow-sm);
        user-select: text;
        -moz-user-select: text;
        cursor: text;
      }

      .${addonRef}-message.user .${addonRef}-message-content {
        width: auto;
        max-width: 86%;
        color: #fff;
        border: none;
        border-radius: 16px 16px 4px 16px;
        background: var(--ra-gradient);
        box-shadow: 0 6px 16px rgba(139, 92, 246, 0.28);
      }

      .${addonRef}-message.user .${addonRef}-message-content a {
        color: #fff;
        text-decoration: underline;
      }

      .${addonRef}-message.assistant .${addonRef}-message-content {
        width: 100%;
        max-width: 100%;
        min-width: 0;
        color: var(--ra-text);
        border: 1px solid color-mix(in srgb, var(--ra-border) 92%, var(--ra-primary));
        border-radius: 4px 16px 16px 16px;
        background: var(--ra-bg);
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
      }

      .${addonRef}-message-content.streaming::after {
        content: "";
        display: inline-block;
        width: 7px;
        height: 14px;
        margin-left: 3px;
        vertical-align: -2px;
        border-radius: 2px;
        background: var(--ra-gradient);
        animation: ra-blink 1s ease-in-out infinite;
      }

      @keyframes ra-blink {
        0%, 60% { opacity: 1; transform: scaleY(1); }
        70%, 100% { opacity: 0.15; transform: scaleY(0.85); }
      }

      .${addonRef}-message-actions {
        display: flex;
        gap: 4px;
        margin-top: 4px;
        opacity: 0;
        transition: opacity 0.18s ease;
      }

      .${addonRef}-message-actions-visible {
        opacity: 1 !important;
      }

      .${addonRef}-message:hover .${addonRef}-message-actions {
        opacity: 1;
      }

      .${addonRef}-retry-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 4px 10px;
        border: 1px solid color-mix(in srgb, var(--ra-primary) 22%, transparent);
        border-radius: 8px;
        background: var(--ra-gradient-soft);
        color: var(--ra-primary);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.1s ease;
      }

      .${addonRef}-retry-btn:hover {
        background: color-mix(in srgb, var(--ra-primary) 18%, var(--ra-bg));
      }

      .${addonRef}-retry-btn:active {
        transform: scale(0.96);
      }

      .${addonRef}-regenerate-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--ra-text-muted);
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }

      .${addonRef}-regenerate-btn:hover {
        background: var(--ra-gradient-soft);
        color: var(--ra-primary);
      }

      .${addonRef}-regenerate-btn:active {
        transform: scale(0.92);
      }

      .${addonRef}-message-thoughts {
        margin-bottom: 6px;
        border: 1px solid color-mix(in srgb, var(--ra-border) 60%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--ra-bg) 88%, var(--ra-secondary));
        overflow: hidden;
      }

      .${addonRef}-message-thoughts summary {
        padding: 6px 10px;
        color: var(--ra-text-muted);
        font-size: 12px;
        font-weight: 650;
        cursor: pointer;
        user-select: none;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: opacity 0.3s ease;
      }

      .${addonRef}-message-thoughts:not([open]) summary {
        opacity: 0.55;
        font-style: italic;
      }

      .${addonRef}-message-thoughts summary::before {
        content: "";
        display: inline-block;
        width: 0;
        height: 0;
        border-left: 5px solid var(--ra-secondary);
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        transition: transform 0.18s ease;
      }

      .${addonRef}-message-thoughts[open] summary::before {
        transform: rotate(90deg);
      }

      .${addonRef}-message-thoughts-body {
        padding: 0 10px 8px;
        color: var(--ra-text-muted);
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      /* KG context bar — sits between messages and the input dock */
      .${addonRef}-context-bar {
        display: flex;
        flex: 0 0 auto;
        gap: 8px;
        margin: 0 0 8px 0;
        align-items: stretch;
      }
      .${addonRef}-context-bar-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 600;
        color: #1f2937;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid color-mix(in srgb, var(--ra-border) 88%, var(--ra-secondary));
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease, color 0.15s ease;
        white-space: nowrap;
      }
      .${addonRef}-context-bar-btn:hover:not(:disabled) {
        background: color-mix(in srgb, var(--ra-secondary) 8%, white);
        border-color: color-mix(in srgb, var(--ra-secondary) 35%, transparent);
      }
      .${addonRef}-context-bar-btn:active:not(:disabled) { transform: scale(0.98); }
      .${addonRef}-context-bar-btn:focus-visible {
        outline: 2px solid var(--ra-secondary);
        outline-offset: 1px;
      }
      .${addonRef}-context-bar-btn-disabled,
      .${addonRef}-context-bar-btn:disabled {
        cursor: not-allowed;
        color: #9ca3af;
        background: rgba(243, 244, 246, 0.7);
        border-color: rgba(229, 231, 235, 0.9);
      }
      .${addonRef}-context-bar-add {
        flex: 1 1 auto;
        min-width: 0;
        justify-content: center;
        color: #6D28D9;
        background: linear-gradient(180deg, #F5F3FF, #EDE9FE);
        border-color: rgba(139, 92, 246, 0.35);
      }
      .${addonRef}-context-bar-add:hover:not(:disabled) {
        background: linear-gradient(180deg, #EDE9FE, #DDD6FE);
        border-color: rgba(139, 92, 246, 0.55);
      }
      .${addonRef}-context-bar-add.${addonRef}-context-bar-btn-disabled {
        background: rgba(243, 244, 246, 0.7);
        color: #9ca3af;
        border-color: rgba(229, 231, 235, 0.9);
      }
      .${addonRef}-context-bar-icon {
        font-size: 13px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
      }
      .${addonRef}-context-bar-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${addonRef}-input-dock {
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        gap: 8px;
        position: relative;
        z-index: 3;
        padding: 10px;
        border: 1px solid color-mix(in srgb, var(--ra-border) 88%, var(--ra-secondary));
        border-radius: var(--ra-radius-xl);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.92)),
          var(--ra-bg);
        box-shadow:
          0 12px 28px rgba(139, 92, 246, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.72);
      }

      .${addonRef}-input-dock:focus-within {
        border-color: color-mix(in srgb, var(--ra-secondary) 55%, transparent);
        box-shadow:
          0 14px 32px rgba(139, 92, 246, 0.18),
          0 0 0 3px color-mix(in srgb, var(--ra-secondary) 14%, transparent);
      }

      .${addonRef}-input-wrapper {
        display: flex;
        flex-direction: column;
        position: relative;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        gap: 0;
      }

      .${addonRef}-image-preview {
        display: none;
        gap: 4px;
        flex-wrap: wrap;
        padding: 0 6px;
        align-items: center;
      }

      .${addonRef}-image-preview.has-images {
        display: flex;
      }

      .${addonRef}-image-preview-item {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .${addonRef}-image-preview-item img {
        width: 32px;
        height: 32px;
        object-fit: cover;
        border-radius: 6px;
        border: 1px solid var(--ra-border);
      }

      .${addonRef}-image-preview-item .${addonRef}-image-remove {
        position: absolute;
        top: -5px;
        right: -5px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border: none;
        border-radius: 50%;
        background: rgba(0,0,0,0.5);
        color: #fff;
        font-size: 9px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
      }

      .${addonRef}-image-preview-item .${addonRef}-image-remove:hover {
        background: rgba(220,38,38,0.85);
      }

      .${addonRef}-message-images {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 4px;
      }

      .${addonRef}-message-images img {
        max-width: 120px;
        max-height: 80px;
        border-radius: 6px;
        border: 1px solid var(--ra-border);
        object-fit: contain;
      }

      textarea.${addonRef}-input {
        width: 100%;
        min-height: 60px;
        max-height: 220px;
        resize: none;
        padding: 10px 44px 10px 12px;
        border: none;
        border-radius: 14px;
        outline: none;
        background: transparent;
        color: var(--ra-text);
        font: inherit;
        font-size: 13px;
        line-height: 1.5;
      }

      textarea.${addonRef}-input::placeholder {
        color: color-mix(in srgb, var(--ra-text-muted) 88%, transparent);
        opacity: 1;
      }

      textarea.${addonRef}-input:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .${addonRef}-send-btn {
        position: absolute;
        right: 6px;
        bottom: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 10px;
        background: var(--ra-gradient);
        color: #fff;
        cursor: pointer;
        transition: transform 0.12s ease, box-shadow 0.18s ease, filter 0.2s ease;
        box-shadow: 0 4px 12px rgba(139, 92, 246, 0.18);
      }

      .${addonRef}-send-btn .${addonRef}-send-icon {
        display: block;
        width: 17px;
        height: 17px;
        color: #ffffff;
        flex: 0 0 auto;
        transform: translate(-1px, 1px);
      }

      .${addonRef}-send-btn .${addonRef}-stop-icon {
        display: block;
        width: 14px;
        height: 14px;
        color: #ffffff;
        flex: 0 0 auto;
      }

      .${addonRef}-send-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 18px rgba(139, 92, 246, 0.45);
        filter: brightness(1.06);
      }

      .${addonRef}-send-btn:active {
        transform: translateY(0) scale(0.94);
      }

      .${addonRef}-send-btn:disabled {
        cursor: default;
        background: color-mix(in srgb, var(--ra-border) 60%, var(--ra-bg));
        color: var(--ra-text-muted);
        box-shadow: none;
        filter: none;
        transform: none;
      }

      .${addonRef}-scroll-bottom-btn {
        position: absolute;
        bottom: calc(var(--readingassistant-input-dock-height, 124px) + 18px);
        right: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 1px solid color-mix(in srgb, var(--ra-border) 88%, var(--ra-primary));
        border-radius: 50%;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,255,255,0.94)),
          var(--ra-bg);
        color: var(--ra-secondary);
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease, color 0.15s ease;
        box-shadow: 0 6px 16px rgba(139, 92, 246, 0.18);
        z-index: 10;
      }

      .${addonRef}-scroll-bottom-btn.visible {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }

      .${addonRef}-scroll-bottom-btn:hover {
        color: #fff;
        background: var(--ra-gradient);
        border-color: transparent;
        box-shadow: 0 8px 22px rgba(139, 92, 246, 0.35);
      }

      .${addonRef}-scroll-bottom-btn:active {
        transform: scale(0.92);
      }

      math {
        font-size: 1.04em;
      }

      .katex-display {
        display: block;
        overflow-x: auto;
        margin: 10px 0;
        padding: 6px 0;
      }

      .${addonRef}-message-content.markdown-body {
        color: var(--ra-text);
        font-size: 13.5px;
        line-height: 1.62;
        letter-spacing: 0.01em;
        width: 100%;
        max-width: 100%;
        min-width: 0;
      }

      .${addonRef}-message-content.markdown-body > * {
        max-width: 100%;
      }

      .${addonRef}-message-content.markdown-body p {
        margin: 0 0 10px;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .${addonRef}-message-content.markdown-body p:last-child {
        margin-bottom: 0;
      }

      .${addonRef}-message-content.markdown-body h1,
      .${addonRef}-message-content.markdown-body h2,
      .${addonRef}-message-content.markdown-body h3,
      .${addonRef}-message-content.markdown-body h4 {
        margin: 16px 0 8px;
        line-height: 1.3;
        font-weight: 700;
        color: var(--ra-text);
      }
      .${addonRef}-message-content.markdown-body h1:first-child,
      .${addonRef}-message-content.markdown-body h2:first-child,
      .${addonRef}-message-content.markdown-body h3:first-child,
      .${addonRef}-message-content.markdown-body h4:first-child {
        margin-top: 2px;
      }
      .${addonRef}-message-content.markdown-body h1 { font-size: 1.32em; padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--ra-border) 70%, transparent); }
      .${addonRef}-message-content.markdown-body h2 { font-size: 1.18em; }
      .${addonRef}-message-content.markdown-body h3 { font-size: 1.08em; color: var(--ra-secondary); }
      .${addonRef}-message-content.markdown-body h4 { font-size: 1em; color: var(--ra-secondary); }

      .${addonRef}-message-content.markdown-body strong {
        font-weight: 650;
        color: color-mix(in srgb, var(--ra-text) 92%, var(--ra-primary));
      }

      .${addonRef}-message-content.markdown-body em {
        color: color-mix(in srgb, var(--ra-text) 88%, var(--ra-secondary));
      }

      .${addonRef}-message-content.markdown-body a {
        color: var(--ra-primary);
        text-decoration: none;
        border-bottom: 1px solid color-mix(in srgb, var(--ra-primary) 35%, transparent);
        transition: color 0.15s ease, border-color 0.15s ease;
      }
      .${addonRef}-message-content.markdown-body a:hover {
        color: var(--ra-secondary);
        border-bottom-color: var(--ra-secondary);
      }

      .${addonRef}-message-content.markdown-body ul,
      .${addonRef}-message-content.markdown-body ol {
        margin: 6px 0 10px;
        padding-left: 1.5em;
      }

      .${addonRef}-message-content.markdown-body li {
        margin: 3px 0;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .${addonRef}-message-content.markdown-body li::marker {
        color: var(--ra-secondary);
      }
      .${addonRef}-message-content.markdown-body li > p {
        margin: 0 0 4px;
      }

      .${addonRef}-message-content.markdown-body blockquote {
        margin: 8px 0;
        padding: 6px 12px;
        border-left: 3px solid var(--ra-secondary);
        background: var(--ra-gradient-soft);
        color: color-mix(in srgb, var(--ra-text) 85%, transparent);
        border-radius: 0 8px 8px 0;
      }
      .${addonRef}-message-content.markdown-body blockquote > :first-child { margin-top: 0; }
      .${addonRef}-message-content.markdown-body blockquote > :last-child { margin-bottom: 0; }

      .${addonRef}-message-content.markdown-body hr {
        border: none;
        height: 1px;
        margin: 14px 0;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ra-secondary) 40%, transparent), transparent);
      }

      .${addonRef}-message-content.markdown-body .readingassistant-table-scroll {
        display: block;
        width: 100%;
        max-width: 100%;
        overflow-x: hidden;
        margin: 10px 0;
        border-radius: 8px;
        border: 1px solid var(--ra-border);
        background: var(--ra-bg);
        -webkit-overflow-scrolling: touch;
      }

      .${addonRef}-message-content.markdown-body .readingassistant-table-scroll::-webkit-scrollbar {
        height: 8px;
      }
      .${addonRef}-message-content.markdown-body .readingassistant-table-scroll::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--ra-secondary) 35%, transparent);
        border-radius: 999px;
      }

      .${addonRef}-message-content.markdown-body table {
        width: 100%;
        min-width: 0;
        table-layout: fixed;
        border-collapse: collapse;
        margin: 0;
      }

      .${addonRef}-message-content.markdown-body colgroup {
        display: none;
      }

      .${addonRef}-message-content.markdown-body th,
      .${addonRef}-message-content.markdown-body td {
        border: 1px solid var(--ra-border);
        padding: 6px 10px;
        vertical-align: top;
        color: var(--ra-text);
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .${addonRef}-message-content.markdown-body th {
        background: var(--ra-gradient-soft);
        color: var(--ra-text);
        font-weight: 650;
      }
      .${addonRef}-message-content.markdown-body tr:nth-child(2n) td {
        background: color-mix(in srgb, var(--ra-bg) 96%, var(--ra-primary));
      }

      .${addonRef}-message-content.markdown-body code {
        padding: 0.16em 0.42em;
        border-radius: 5px;
        background: color-mix(in srgb, var(--ra-bg) 78%, var(--ra-primary));
        color: color-mix(in srgb, var(--ra-text) 80%, var(--ra-primary));
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
        font-size: 0.92em;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .${addonRef}-message-content.markdown-body pre {
        position: relative;
        width: 100%;
        max-width: 100%;
        overflow: auto;
        margin: 10px 0;
        padding: 30px 14px 12px;
        border-radius: 12px;
        background: linear-gradient(135deg, #1e1b4b 0%, #312e81 60%, #4c1d95 100%);
        color: #e0e7ff;
        box-shadow: 0 6px 16px rgba(30, 27, 75, 0.25), inset 0 1px 0 rgba(255,255,255,0.05);
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
        font-size: 12.5px;
        line-height: 1.55;
      }

      .${addonRef}-message-content.markdown-body pre::before {
        content: "";
        position: absolute;
        top: 10px;
        left: 12px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow:
          14px 0 0 #f59e0b,
          28px 0 0 #10b981;
        opacity: 0.85;
      }

      .${addonRef}-message-content.markdown-body pre[data-lang]::after {
        content: attr(data-lang);
        position: absolute;
        top: 8px;
        right: 60px;
        padding: 1px 8px;
        border-radius: 4px;
        background: rgba(255,255,255,0.10);
        color: rgba(255,255,255,0.62);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .${addonRef}-message-content.markdown-body pre code {
        padding: 0;
        background: transparent;
        color: inherit;
        font-size: inherit;
      }

      /* Highlight.js — Atom One Dark inspired palette tuned for indigo bg */
      .${addonRef}-message-content.markdown-body .hljs { color: #e0e7ff; background: transparent; }
      .${addonRef}-message-content.markdown-body .hljs-comment,
      .${addonRef}-message-content.markdown-body .hljs-quote { color: #a5a3d4; font-style: italic; }
      .${addonRef}-message-content.markdown-body .hljs-keyword,
      .${addonRef}-message-content.markdown-body .hljs-selector-tag,
      .${addonRef}-message-content.markdown-body .hljs-literal,
      .${addonRef}-message-content.markdown-body .hljs-section,
      .${addonRef}-message-content.markdown-body .hljs-link { color: #c4b5fd; }
      .${addonRef}-message-content.markdown-body .hljs-function .hljs-keyword { color: #c4b5fd; }
      .${addonRef}-message-content.markdown-body .hljs-subst { color: #e0e7ff; }
      .${addonRef}-message-content.markdown-body .hljs-string,
      .${addonRef}-message-content.markdown-body .hljs-doctag { color: #86efac; }
      .${addonRef}-message-content.markdown-body .hljs-title,
      .${addonRef}-message-content.markdown-body .hljs-name,
      .${addonRef}-message-content.markdown-body .hljs-selector-id,
      .${addonRef}-message-content.markdown-body .hljs-selector-class { color: #fbcfe8; }
      .${addonRef}-message-content.markdown-body .hljs-attr,
      .${addonRef}-message-content.markdown-body .hljs-attribute,
      .${addonRef}-message-content.markdown-body .hljs-variable,
      .${addonRef}-message-content.markdown-body .hljs-template-variable,
      .${addonRef}-message-content.markdown-body .hljs-class .hljs-title,
      .${addonRef}-message-content.markdown-body .hljs-type { color: #fcd34d; }
      .${addonRef}-message-content.markdown-body .hljs-symbol,
      .${addonRef}-message-content.markdown-body .hljs-bullet,
      .${addonRef}-message-content.markdown-body .hljs-number,
      .${addonRef}-message-content.markdown-body .hljs-meta,
      .${addonRef}-message-content.markdown-body .hljs-built_in,
      .${addonRef}-message-content.markdown-body .hljs-builtin-name { color: #fdba74; }
      .${addonRef}-message-content.markdown-body .hljs-regexp,
      .${addonRef}-message-content.markdown-body .hljs-deletion { color: #fca5a5; }
      .${addonRef}-message-content.markdown-body .hljs-addition { color: #86efac; }
      .${addonRef}-message-content.markdown-body .hljs-emphasis { font-style: italic; }
      .${addonRef}-message-content.markdown-body .hljs-strong { font-weight: 700; }

      .${addonRef}-copy-btn {
        position: absolute;
        top: 8px;
        right: 10px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 5px;
        background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.78);
        font-size: 10.5px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .${addonRef}-message-content.markdown-body pre:hover .${addonRef}-copy-btn {
        opacity: 1;
      }

      .${addonRef}-copy-btn:hover {
        background: rgba(255,255,255,0.18);
        color: #fff;
      }

      .${addonRef}-page-citation {
        cursor: pointer;
        color: var(--ra-primary);
        background: var(--ra-gradient-soft);
        padding: 1px 6px;
        border-radius: 4px;
        text-decoration: none;
        font-weight: 600;
        font-size: 0.92em;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .${addonRef}-page-citation:hover {
        background: var(--ra-gradient);
        color: #fff;
      }

      .${addonRef}-followup-bar {
        display: flex;
        flex-wrap: wrap;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        gap: 6px;
        margin-top: 8px;
        padding-left: 2px;
        opacity: 0;
        transition: opacity 0.25s ease 0.3s;
      }

      .${addonRef}-message.assistant:hover .${addonRef}-followup-bar {
        opacity: 1;
      }

      .${addonRef}-message-actions-visible ~ .${addonRef}-followup-bar {
        opacity: 1 !important;
      }

      .${addonRef}-followup-btn {
        display: inline-flex;
        align-items: center;
        padding: 4px 12px;
        border: 1px solid var(--ra-border);
        border-radius: 14px;
        background: var(--ra-bg);
        color: var(--ra-text-muted);
        font-size: 11px;
        font-family: inherit;
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        cursor: pointer;
        transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease, transform 0.1s ease;
        white-space: nowrap;
      }

      .${addonRef}-followup-btn:hover {
        border-color: transparent;
        color: #fff;
        background: var(--ra-gradient);
        transform: translateY(-1px);
        box-shadow: var(--ra-shadow-md);
      }

      .${addonRef}-followup-btn:active {
        transform: translateY(0) scale(0.97);
      }

      /* ------------------------------------------------------------------
         Dark mode overrides
         ------------------------------------------------------------------
         Most of our chrome already adapts automatically because we use
         var(--material-background) / var(--fill-primary) / var(--color-border)
         which Zotero re-defines per theme. The block below only patches the
         spots where we composite a white-glass overlay over var(--ra-bg)
         (would render almost-white on dark backgrounds) and the navy-tinted
         drop shadows (invisible on dark). */
      @media (prefers-color-scheme: dark) {
        .${addonRef}-panel {
          /* Lift shadows so containers still have a perceivable elevation. */
          --ra-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.45);
          --ra-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.55);
          --ra-shadow-lg: 0 10px 28px rgba(0, 0, 0, 0.60);
          /* Make the ambient brand-tinted radial a touch brighter so it
             shows up against the dark background. */
          background:
            radial-gradient(circle at 0% 0%, rgba(139, 92, 246, 0.12) 0%, transparent 45%),
            radial-gradient(circle at 100% 100%, rgba(168, 85, 247, 0.10) 0%, transparent 50%),
            var(--ra-bg);
        }

        .${addonRef}-messages {
          background: var(--ra-bg);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.04),
            0 1px 2px rgba(0, 0, 0, 0.35);
        }

        .${addonRef}-input-dock {
          background: var(--ra-bg);
          box-shadow:
            0 12px 28px rgba(0, 0, 0, 0.45),
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }

        .${addonRef}-scroll-bottom-btn {
          background: var(--ra-bg);
        }

        .${addonRef}-message.assistant .${addonRef}-message-content {
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        }

        /* Slightly brighten our subtle suggestion-card surface so it
           remains distinguishable from the panel background in dark. */
        .${addonRef}-empty-suggestion {
          background: color-mix(in srgb, var(--ra-secondary) 14%, transparent);
          border-color: color-mix(in srgb, var(--ra-secondary) 35%, transparent);
        }
        .${addonRef}-empty-suggestion:hover {
          background: color-mix(in srgb, var(--ra-secondary) 24%, transparent);
          border-color: color-mix(in srgb, var(--ra-secondary) 60%, transparent);
        }

        .${addonRef}-empty-tip {
          background: color-mix(in srgb, var(--ra-secondary) 14%, transparent);
        }

        /* Brighter placeholder so the input prompt stays readable on dark. */
        textarea.${addonRef}-input::placeholder {
          color: var(--ra-text-muted);
          opacity: 0.85;
        }

        /* Lift <pre> code blocks above the dark panel with a subtle purple
           edge + stronger shadow; the dark navy gradient otherwise tends to
           merge with the surrounding dark surface. */
        .${addonRef}-message-content.markdown-body pre {
          border: 1px solid color-mix(in srgb, var(--ra-secondary) 32%, transparent);
          box-shadow:
            0 6px 18px rgba(0, 0, 0, 0.5),
            inset 0 1px 0 rgba(255, 255, 255, 0.06);
        }
      }
    `;
}
