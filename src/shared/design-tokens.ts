/**
 * Shared design tokens for all UI modules (Sidebar / Wiki / Knowledge Graph).
 *
 * Usage:
 *   import { injectSharedStyles } from "../shared/design-tokens";
 *   // At the top of your renderer, before inserting any other styles:
 *   injectSharedStyles(doc, addonRef);
 */

// ─── Purple scale (Tailwind violet, 9 stops) ─────────────────────────────────
export const PURPLE = {
  50: "#F5F3FF",
  100: "#EDE9FE",
  200: "#DDD6FE",
  300: "#C4B5FD",
  400: "#A78BFA",
  500: "#8B5CF6",
  600: "#7C3AED",
  700: "#6D28D9",
  800: "#5B21B6",
  900: "#4C1D95",
} as const;

// ─── Shared keyframe animations ───────────────────────────────────────────────
export const SHARED_KEYFRAMES = `
  @keyframes ra-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes ra-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ra-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ra-brand) 55%, transparent); }
    70%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ra-brand) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ra-brand) 0%, transparent); }
  }
  @keyframes ra-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position:  200% 0; }
  }
`;

/**
 * Returns a CSS block declaring all shared design tokens under `scope`.
 *
 * @param scope  CSS selector to wrap the variables in.
 *               Use ":root" for standalone windows (Wiki / KG).
 *               Use ".${addonRef}-panel" when scoping to a Sidebar panel.
 */
export function buildSharedTokens(scope = ":root"): string {
  return `
  ${scope} {
    /* ── Purple scale ─────────────────────────────────────────────── */
    --ra-purple-50:  ${PURPLE[50]};
    --ra-purple-100: ${PURPLE[100]};
    --ra-purple-200: ${PURPLE[200]};
    --ra-purple-300: ${PURPLE[300]};
    --ra-purple-400: ${PURPLE[400]};
    --ra-purple-500: ${PURPLE[500]};
    --ra-purple-600: ${PURPLE[600]};
    --ra-purple-700: ${PURPLE[700]};
    --ra-purple-800: ${PURPLE[800]};
    --ra-purple-900: ${PURPLE[900]};

    /* ── Semantic brand ───────────────────────────────────────────── */
    --ra-brand:         var(--ra-purple-500);
    --ra-brand-hover:   var(--ra-purple-600);
    --ra-brand-active:  var(--ra-purple-700);
    --ra-brand-soft:    var(--ra-purple-100);
    --ra-on-brand:      #ffffff;
    --ra-gradient:      linear-gradient(
      135deg,
      var(--ra-purple-700) 0%,
      var(--ra-purple-500) 55%,
      var(--ra-purple-400) 100%
    );
    --ra-gradient-soft: linear-gradient(
      135deg,
      color-mix(in srgb, var(--ra-purple-500) 10%, transparent),
      color-mix(in srgb, var(--ra-purple-400) 10%, transparent)
    );
    --ra-ring: color-mix(in srgb, var(--ra-purple-500) 35%, transparent);

    /* ── Border radius (semantic) ─────────────────────────────────── */
    --ra-radius-pill:    999px;   /* chip, pill button */
    --ra-radius-control: 10px;    /* button, input, icon-btn */
    --ra-radius-card:    16px;    /* card, message bubble */
    --ra-radius-surface: 22px;    /* hero, section panel */
    --ra-radius-window:  26px;    /* outermost dock / sheet */

    /* ── Spacing (4-based scale) ──────────────────────────────────── */
    --ra-space-1: 4px;
    --ra-space-2: 8px;
    --ra-space-3: 12px;
    --ra-space-4: 16px;
    --ra-space-5: 20px;
    --ra-space-6: 24px;
    --ra-space-8: 32px;

    /* ── Shadows (purple-tinted) ──────────────────────────────────── */
    --ra-shadow-xs:   0 1px 2px rgba(15, 23, 42, 0.05);
    --ra-shadow-sm:   0 4px 12px color-mix(in srgb, var(--ra-purple-500) 18%, transparent);
    --ra-shadow-md:   0 10px 28px color-mix(in srgb, var(--ra-purple-500) 22%, transparent);
    --ra-shadow-lg:   0 18px 42px color-mix(in srgb, var(--ra-purple-900) 14%, transparent);
    --ra-shadow-glow: 0 0 0 3px var(--ra-ring);

    /* ── Motion ───────────────────────────────────────────────────── */
    --ra-motion-fast: 120ms;
    --ra-motion-base: 200ms;
    --ra-motion-slow: 320ms;
    --ra-ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
    --ra-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

    /* ── Typography (1.25 modular scale) ─────────────────────────── */
    --ra-fs-xs:   11px;
    --ra-fs-sm:   12px;
    --ra-fs-base: 13px;
    --ra-fs-md:   15px;
    --ra-fs-lg:   17px;
    --ra-fs-xl:   20px;
    --ra-fs-2xl:  24px;
    --ra-lh-tight: 1.3;
    --ra-lh-base:  1.55;
    --ra-lh-loose: 1.75;
    --ra-fw-regular: 400;
    --ra-fw-medium:  600;
    --ra-fw-bold:    700;
    --ra-fw-display: 800;

    /* ── Surfaces & text (light-mode, fallback to Zotero vars) ───── */
    --ra-surface:       var(--material-background, #ffffff);
    --ra-surface-1:     color-mix(in srgb, var(--ra-surface) 86%, ${PURPLE[50]} 14%);
    --ra-surface-2:     color-mix(in srgb, var(--ra-surface) 70%, ${PURPLE[100]} 30%);
    --ra-surface-glass: color-mix(in srgb, var(--ra-surface) 82%, transparent);
    --ra-text:          var(--fill-primary, #1f2937);
    --ra-text-strong:   var(--fill-primary, #111827);
    --ra-text-muted:    var(--fill-secondary, #6b7280);
    --ra-text-brand:    var(--ra-purple-700);
    --ra-border:        color-mix(in srgb, var(--ra-purple-500) 16%, transparent);
    --ra-border-strong: color-mix(in srgb, var(--ra-purple-500) 32%, transparent);

    /* ── Icon sizes ───────────────────────────────────────────────── */
    --ra-icon-sm: 14px;
    --ra-icon-md: 16px;
    --ra-icon-lg: 20px;
  }

  @media (prefers-color-scheme: dark) {
    ${scope} {
      --ra-surface:       var(--material-background, #1e1e2e);
      --ra-surface-1:     color-mix(in srgb, var(--ra-surface) 86%, ${PURPLE[900]} 14%);
      --ra-surface-2:     color-mix(in srgb, var(--ra-surface) 70%, ${PURPLE[800]} 30%);
      --ra-surface-glass: color-mix(in srgb, var(--ra-surface) 82%, transparent);
      --ra-text:          var(--fill-primary, #e5e7eb);
      --ra-text-strong:   var(--fill-primary, #f9fafb);
      --ra-text-muted:    var(--fill-secondary, #9ca3af);
      --ra-text-brand:    var(--ra-purple-300);
      --ra-border:        color-mix(in srgb, var(--ra-purple-400) 20%, transparent);
      --ra-border-strong: color-mix(in srgb, var(--ra-purple-400) 40%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition-duration: 0ms !important;
      animation-duration:  0ms !important;
    }
  }

  ${SHARED_KEYFRAMES}
  `;
}

/**
 * Inject shared design tokens and keyframes into a document's <head>.
 * Idempotent — calling it multiple times is safe.
 *
 * @param doc       The document to inject into (from the renderer's win.document)
 * @param _addonRef Addon ref string (reserved for future per-addon scoping)
 */
export function injectSharedStyles(doc: Document, _addonRef: string, scope = ":root"): void {
  const STYLE_ID = `ra-shared-tokens-${scope.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildSharedTokens(scope);
  (doc.head ?? doc.documentElement).appendChild(style);
}
