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

  // Logo: render as a text emoji rather than an <img>. This avoids any
  // image-scaling/aspect-ratio issues entirely and reads as a friendly
  // AI avatar regardless of platform DPI.
  const logoWrap = createHTMLElement(doc, "div", `${addonRef}-empty-logo`);
  logoWrap.setAttribute("aria-hidden", "true");
  logoWrap.textContent = "🤖";

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
  const items: { icon: string; key: string }[] = [
    { icon: "📋", key: "empty-suggestion-summary" },
    { icon: "🧪", key: "empty-suggestion-method" },
    { icon: "📊", key: "empty-suggestion-results" },
    { icon: "⚠️", key: "empty-suggestion-limitations" },
  ];
  for (const it of items) {
    const card = createHTMLElement(doc, "button", `${addonRef}-empty-suggestion`);
    card.type = "button";
    const iconSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-icon`);
    iconSpan.textContent = it.icon;
    const textSpan = createHTMLElement(doc, "span", `${addonRef}-empty-suggestion-text`);
    textSpan.textContent = t(it.key);
    card.append(iconSpan, textSpan);
    card.addEventListener("click", () => onSuggestionClick(textSpan.textContent || ""));
    suggestions.appendChild(card);
  }

  const tip = createHTMLElement(doc, "p", `${addonRef}-empty-tip`);
  tip.textContent = t("empty-tip");

  empty.append(logoWrap, title, desc, suggestionsLabel, suggestions, tip);
  return empty;
}
