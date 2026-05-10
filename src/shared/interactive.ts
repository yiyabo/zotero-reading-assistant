/**
 * CSS mixin helpers for interactive elements.
 *
 * These return CSS strings to interpolate into a module's style template.
 * All generated rules rely on design tokens from `design-tokens.ts`, so
 * `injectSharedStyles()` must be called before these styles take effect.
 *
 * Usage:
 *   import { interactiveBase, glassSurface, ambientBg } from "../shared/interactive";
 *
 *   function buildStyles(ref: string): string {
 *     return `
 *       ${interactiveBase(`.${ref}-btn`)}
 *       ${glassSurface(`.${ref}-header`)}
 *       ${ambientBg(`.${ref}-root`)}
 *     `;
 *   }
 */

/**
 * Generate four-state interactive CSS (hover / active / focus-visible / disabled)
 * for a selector. Applies a subtle lift-and-shadow pattern on hover.
 *
 * The generated `:disabled` rule uses `pointer-events: none` so hovered-disabled
 * elements produce no visual feedback, matching native browser behavior.
 */
export function interactiveBase(selector: string): string {
  return `
  ${selector} {
    transition:
      transform       var(--ra-motion-fast) var(--ra-ease-out),
      box-shadow      var(--ra-motion-fast) var(--ra-ease-out),
      background      var(--ra-motion-fast) var(--ra-ease-out),
      border-color    var(--ra-motion-fast) var(--ra-ease-out),
      color           var(--ra-motion-fast) var(--ra-ease-out);
    cursor: pointer;
  }
  ${selector}:hover:not(:disabled):not([aria-disabled="true"]) {
    transform:    translateY(-1px);
    box-shadow:   var(--ra-shadow-sm);
    border-color: var(--ra-border-strong);
  }
  ${selector}:active:not(:disabled):not([aria-disabled="true"]) {
    transform:  translateY(0) scale(0.98);
    box-shadow: var(--ra-shadow-xs);
  }
  ${selector}:focus-visible {
    outline:        2px solid var(--ra-brand);
    outline-offset: 2px;
    box-shadow:     var(--ra-shadow-glow);
  }
  ${selector}:disabled,
  ${selector}[aria-disabled="true"] {
    opacity:        0.45;
    cursor:         not-allowed;
    pointer-events: none;
    transform:      none;
    box-shadow:     none;
  }
  `;
}

/**
 * Generate glass-morphism surface CSS for a selector.
 * Produces a frosted-glass effect via backdrop-filter + high-light inner border.
 *
 * Requires the element to sit on top of a non-opaque background for the blur
 * to be visible (e.g. a radial-gradient or image layer beneath it).
 */
export function glassSurface(selector: string): string {
  return `
  ${selector} {
    background:             var(--ra-surface-glass);
    backdrop-filter:        blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border:                 1px solid rgba(255, 255, 255, 0.5);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      var(--ra-shadow-sm);
  }
  `;
}

/**
 * Generate an ambient purple radial-glow background for a container element.
 * Matches the pattern already in use in the Sidebar panel background.
 */
export function ambientBg(selector: string): string {
  return `
  ${selector} {
    background:
      radial-gradient(
        circle at 0% 0%,
        color-mix(in srgb, var(--ra-purple-500) 8%, transparent) 0%,
        transparent 45%
      ),
      radial-gradient(
        circle at 100% 100%,
        color-mix(in srgb, var(--ra-purple-400) 7%, transparent) 0%,
        transparent 50%
      ),
      var(--ra-surface);
  }
  `;
}

/**
 * Generate a visual surface layer with three-tier depth.
 *
 * @param selector   Container selector
 * @param tier       "l1" (base), "l2" (raised), "l3" (floating card)
 */
export function surfaceTier(selector: string, tier: "l1" | "l2" | "l3"): string {
  const styles: Record<string, string> = {
    l1: `background: var(--ra-surface); box-shadow: none;`,
    l2: `background: var(--ra-surface-1); box-shadow: var(--ra-shadow-xs);`,
    l3: `
      background: var(--ra-surface-glass);
      backdrop-filter: blur(16px) saturate(160%);
      -webkit-backdrop-filter: blur(16px) saturate(160%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), var(--ra-shadow-md);
    `,
  };

  return `
  ${selector} {
    ${styles[tier]}
  }
  `;
}
