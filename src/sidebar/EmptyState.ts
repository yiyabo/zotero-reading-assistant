/**
 * Empty-state DOM builder
 * ----------------------------------------------------------------------------
 * Renders the "first impression" view of the sidebar — what the user sees
 * before any messages exist for the current paper. Has two flavors:
 *
 *   1. **Configured**: shows the AI avatar, welcome heading, four suggestion
 *      cards, and a tip footer. Clicking a card pre-fills the input.
 *   2. **Not configured (no API key)**: replaces the suggestion cards with a
 *      single prominent CTA card that opens the Preferences pane on click,
 *      because the suggestion cards would all fail without an API key.
 *
 * The module is a pure DOM builder — it owns no state, registers no global
 * observers, and exposes no methods. The caller (`SidebarView`) decides
 * whether the user has configured an API key, supplies the click handlers,
 * and re-invokes the builder when state changes.
 */
import { createHTMLElement, t } from "./domUtils";
import { fileLog } from "../utils/fileLog";

const SVG_NS = "http://www.w3.org/2000/svg";

/** One SVG child: element name plus its attributes. */
type Shape = [string, Record<string, string>];

/** Shorthand for the overwhelmingly common `<path d="...">` case. */
function p(d: string): Shape {
  return ["path", { d }];
}

/**
 * Build an icon as real DOM instead of an `innerHTML` markup string.
 *
 * Zotero's window is XHTML (`application/xhtml+xml`), so `innerHTML` is handled
 * by the **XML** fragment parser, not the HTML one. That parser is strict in two
 * ways that both bit this file:
 *
 *   - It has no foreign-content rule, so an `<svg>` without an explicit `xmlns`
 *     inherits the surrounding XHTML namespace and silently renders nothing.
 *   - Any malformed fragment — a duplicate attribute, for instance — is a
 *     *fatal* error, so the setter throws where HTML would quietly recover.
 *     An uncaught throw escaped `buildEmptyState()` before it appended anything,
 *     turning one bad glyph into a completely blank sidebar.
 *
 * `createElementNS` sidesteps the parser entirely: the namespace is passed
 * explicitly and attributes are set one at a time, so neither failure mode is
 * expressible. This matches how `InputDock.ts` builds the send icon.
 */
function buildIcon(
  doc: Document,
  size: number,
  strokeWidth: number,
  shapes: Shape[],
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const shape of shapes) {
    const child = doc.createElementNS(SVG_NS, shape[0]);
    const attrs = shape[1];
    for (const key of Object.keys(attrs)) {
      child.setAttribute(key, attrs[key]);
    }
    svg.appendChild(child);
  }
  return svg;
}

/**
 * One stroke icon per suggestion, drawn on the same 24-unit grid so every row
 * lines up. Emoji were inconsistent in size, weight and colour across
 * platforms, which is what made the list look misaligned.
 */
const SUGGESTION_ICONS: Record<string, Shape[]> = {
  // summary: document with lines
  "empty-suggestion-summary": [
    p("M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"),
    p("M14 3v6h6"),
    p("M8 13h8"),
    p("M8 17h5"),
  ],
  // method: flask
  "empty-suggestion-method": [
    p("M9 3h6"),
    p("M10 3v5.5L5.5 17A2.5 2.5 0 0 0 7.8 21h8.4a2.5 2.5 0 0 0 2.3-4L14 8.5V3"),
    p("M7 15h10"),
  ],
  // results: bar chart
  "empty-suggestion-results": [
    p("M4 20h16"),
    p("M7 20v-6"),
    p("M12 20V6"),
    p("M17 20v-9"),
  ],
  // limitations: magnifier over a gap
  "empty-suggestion-limitations": [
    ["circle", { cx: "11", cy: "11", r: "6" }],
    p("M20 20l-4.5-4.5"),
    p("M11 8.5v3"),
    p("M11 14h.01"),
  ],
};

const LOGO_SHAPES: Shape[] = [
  p("M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"),
  p("M13.5 4v5.5H19"),
  p("M9.4 12.1l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85L6.8 14.7l1.85-.75z"),
  p("M14.6 16.2l.45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45z"),
];

const CHEVRON_SHAPES: Shape[] = [p("M9 6l6 6-6 6")];

/**
 * Build a clickable card as a `<div role="button">` rather than a `<button>`.
 *
 * A Gecko `<button>` lays its children out inside an anonymous content box that
 * it vertically centres and that does **not** grow for wrapped children, so any
 * multi-line label spills outside the card's own border. That quirk already
 * forced `.empty-setup-card` onto a `grid !important; height: auto !important`
 * workaround and killed an earlier AI-note card outright. A plain div has none
 * of it: grid/flex behave normally and the box grows, which the longer English
 * suggestion strings need in order to wrap instead of being ellipsised away.
 *
 * Keyboard parity with a real button is restored explicitly: `tabindex="0"` for
 * Tab reachability plus Enter/Space activation. `preventDefault()` on Space
 * stops the panel from scrolling instead of activating the card.
 */
function createCardButton(
  doc: Document,
  className: string,
  onActivate: () => void,
): HTMLElement {
  const el = createHTMLElement(doc, "div", className);
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.addEventListener("click", () => onActivate());
  el.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
      ev.preventDefault();
      onActivate();
    }
  });
  return el;
}

export type EmptyStateOptions = {
  /** Owning document — must be the chrome document the empty state will live in. */
  doc: Document;
  /** Addon ref / CSS class prefix (e.g. "readingassistant"). */
  addonRef: string;
  /** Whether the user has finished configuring an API key. */
  hasApiKey: boolean;
  /** Invoked with the suggestion's display text when a card is clicked. */
  onSuggestionClick: (text: string) => void;
  /** Invoked when the setup CTA card is clicked (API not configured). */
  onSetupClick: () => void;
};

/**
 * Build the empty-state DOM tree.
 *
 * Returns the outer `<div>` ready to be appended into the messages container.
 * The caller controls when to (re-)render — e.g. on item change or after the
 * SECRET_KEY preference is updated.
 *
 * `renderMessages()` calls this inline as
 * `container.appendChild(buildEmptyState(...))`, so anything thrown in here
 * means `appendChild` never runs and the user gets a totally blank panel with no
 * clue why. The wrapper below converts that into a readable heading plus a
 * stack trace in /tmp/ra-bootstrap.log.
 */
export function buildEmptyState(opts: EmptyStateOptions): HTMLElement {
  try {
    return buildEmptyStateInner(opts);
  } catch (e: any) {
    fileLog(
      "buildEmptyState FAILED: " + (e?.message || e) + "\n" + (e?.stack || "(no stack)"),
    );
    const fallback = createHTMLElement(opts.doc, "div", `${opts.addonRef}-empty`);
    const heading = createHTMLElement(opts.doc, "h3", `${opts.addonRef}-empty-title`);
    try {
      heading.textContent = t("empty-title");
    } catch (_) {
      heading.textContent = "AI Reading Assistant";
    }
    fallback.appendChild(heading);
    return fallback;
  }
}

function buildEmptyStateInner(opts: EmptyStateOptions): HTMLElement {
  const { doc, addonRef, hasApiKey, onSuggestionClick, onSetupClick } = opts;

  const empty = createHTMLElement(doc, "div", `${addonRef}-empty`);

  // SVG on a gradient chip rather than an <img> or an emoji: no scaling or
  // aspect-ratio issues, and it renders identically on every platform.
  const logoWrap = createHTMLElement(doc, "div", `${addonRef}-empty-logo`);
  logoWrap.setAttribute("aria-hidden", "true");
  const logoMark = createHTMLElement(doc, "span", `${addonRef}-empty-logo-mark`);
  logoMark.appendChild(buildIcon(doc, 26, 1.9, LOGO_SHAPES));
  logoWrap.appendChild(logoMark);

  const title = createHTMLElement(doc, "h3", `${addonRef}-empty-title`);
  title.textContent = t("empty-title");

  const desc = createHTMLElement(doc, "p", `${addonRef}-empty-desc`);
  desc.textContent = hasApiKey ? t("empty-desc") : t("empty-desc-noapi");

  // First-time guidance: if no API key is configured, the suggestions
  // would all fail when sent. Replace them with a single prominent
  // CTA card that opens Preferences directly.
  if (!hasApiKey) {
    const setupCard = createHTMLElement(doc, "button", `${addonRef}-empty-setup-card`);
    setupCard.type = "button";

    const setupIcon = createHTMLElement(doc, "span", `${addonRef}-empty-setup-icon`);
    setupIcon.textContent = "⚙️";
    setupIcon.setAttribute("aria-hidden", "true");

    const setupContent = createHTMLElement(doc, "span", `${addonRef}-empty-setup-content`);
    const setupTitle = createHTMLElement(doc, "span", `${addonRef}-empty-setup-title`);
    setupTitle.textContent = t("empty-setup-title");
    const setupDesc = createHTMLElement(doc, "span", `${addonRef}-empty-setup-desc`);
    setupDesc.textContent = t("empty-setup-desc");
    setupContent.append(setupTitle, setupDesc);

    const setupArrow = createHTMLElement(doc, "span", `${addonRef}-empty-setup-arrow`);
    setupArrow.textContent = "→";
    setupArrow.setAttribute("aria-hidden", "true");

    setupCard.append(setupIcon, setupContent, setupArrow);
    setupCard.addEventListener("click", () => onSetupClick());

    empty.append(logoWrap, title, desc, setupCard);
    return empty;
  }

  const suggestionsLabel = createHTMLElement(doc, "div", `${addonRef}-empty-suggestions-label`);
  suggestionsLabel.textContent = t("empty-suggestions-label");

  const suggestions = createHTMLElement(doc, "div", `${addonRef}-empty-suggestions`);
  const keys = [
    "empty-suggestion-summary",
    "empty-suggestion-method",
    "empty-suggestion-results",
    "empty-suggestion-limitations",
  ];
  for (const key of keys) {
    const label = t(key);
    const card = createCardButton(doc, `${addonRef}-empty-suggestion`, () =>
      onSuggestionClick(label),
    );
    const iconSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-icon`);
    iconSpan.appendChild(buildIcon(doc, 14, 2, SUGGESTION_ICONS[key] || []));
    const textSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-text`);
    textSpan.textContent = label;
    const goSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-go`);
    goSpan.appendChild(buildIcon(doc, 14, 2.4, CHEVRON_SHAPES));
    card.append(iconSpan, textSpan, goSpan);
    suggestions.appendChild(card);
  }

  const tip = createHTMLElement(doc, "p", `${addonRef}-empty-tip`);
  tip.textContent = t("empty-tip");

  // No AI-note card here on purpose: the context bar already carries an
  // "AI 便签" button with this exact label, and multi-line content inside a
  // <button> does not grow the button box in Gecko — the card's description
  // spilled out of its own border and collided with the tip below.
  empty.append(logoWrap, title, desc, suggestionsLabel, suggestions, tip);
  return empty;
}
