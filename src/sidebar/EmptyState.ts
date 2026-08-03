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

const SVG_ATTRS =
  'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/**
 * One stroke icon per suggestion, drawn on the same 24-unit grid so every row
 * lines up. Emoji were inconsistent in size, weight and colour across
 * platforms, which is what made the list look misaligned.
 */
const SUGGESTION_ICONS: Record<string, string> = {
  // summary: document with lines
  "empty-suggestion-summary":
    '<path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  // method: flask
  "empty-suggestion-method":
    '<path d="M9 3h6"/><path d="M10 3v5.5L5.5 17A2.5 2.5 0 0 0 7.8 21h8.4a2.5 2.5 0 0 0 2.3-4L14 8.5V3"/><path d="M7 15h10"/>',
  // results: bar chart
  "empty-suggestion-results":
    '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V6"/><path d="M17 20v-9"/>',
  // limitations: magnifier over a gap
  "empty-suggestion-limitations":
    '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/><path d="M11 8.5v3"/><path d="M11 14h.01"/>',
};

const LOGO_MARK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>' +
  '<path d="M13.5 4v5.5H19"/>' +
  '<path d="M9.4 12.1l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85L6.8 14.7l1.85-.75z"/>' +
  '<path d="M14.6 16.2l.45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45z"/>' +
  "</svg>";

const CHEVRON =
  `<svg ${SVG_ATTRS} stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>`;

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
 */
export function buildEmptyState(opts: EmptyStateOptions): HTMLElement {
  const { doc, addonRef, hasApiKey, onSuggestionClick, onSetupClick } = opts;

  const empty = createHTMLElement(doc, "div", `${addonRef}-empty`);

  // Inline SVG on a gradient chip rather than an <img> or an emoji: no
  // scaling/aspect-ratio issues, and it renders identically on every platform.
  const logoWrap = createHTMLElement(doc, "div", `${addonRef}-empty-logo`);
  logoWrap.setAttribute("aria-hidden", "true");
  const logoMark = createHTMLElement(doc, "span", `${addonRef}-empty-logo-mark`);
  logoMark.innerHTML = LOGO_MARK;
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
    const card = createHTMLElement(doc, "button", `${addonRef}-empty-suggestion`);
    card.type = "button";
    const iconSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-icon`);
    iconSpan.innerHTML = `<svg ${SVG_ATTRS}>${SUGGESTION_ICONS[key] || ""}</svg>`;
    const textSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-text`);
    textSpan.textContent = t(key);
    const goSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-go`);
    goSpan.innerHTML = CHEVRON;
    card.append(iconSpan, textSpan, goSpan);
    card.addEventListener("click", () => onSuggestionClick(textSpan.textContent || ""));
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
