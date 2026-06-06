# Shared UI Infrastructure

## OVERVIEW

Design system and reusable UI primitives shared across Sidebar, Knowledge Graph, and Wiki.

## STRUCTURE

```
shared/
├── design-tokens.ts   # CSS custom properties, purple scale, keyframes, injectSharedStyles
├── icons.ts           # SVG icon strings (sidebar logo, UI icons)
└── interactive.ts     # Shared interactive helpers (toast, confirm dialogs)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Color palette | `design-tokens.ts:PURPLE` | 9-stop scale (50–900) from Tailwind violet |
| CSS variables | `design-tokens.ts:buildSharedTokens` | All `--ra-*` custom properties |
| Style injection | `design-tokens.ts:injectSharedStyles` | Idempotent style injection into any document |
| Keyframe animations | `design-tokens.ts:SHARED_KEYFRAMES` | `ra-spin`, `ra-fade-in`, `ra-pulse`, `ra-shimmer` |

## CONVENTIONS

- **All UI modules must call `injectSharedStyles(doc, addonRef)`** before rendering any DOM.
- **Scope parameter**: Use `":root"` for standalone windows (KG, Wiki). Use `".readingassistant-panel"` for sidebar scoping.
- **CSS variable naming**: `--ra-{category}-{name}` — e.g. `--ra-brand`, `--ra-space-4`, `--ra-fs-base`, `--ra-shadow-sm`.
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` zeroes all transition/animation durations.
