// Pure keyword-matching helpers for bulk-selecting proposed moves in the review
// list. Kept free of the DOM so the matching rules are unit-testable; the UI
// layer feeds in each row's searchable text and flips checkboxes accordingly.

/**
 * Split a raw filter string into normalised search terms. Terms are separated
 * by commas (so a term can itself contain spaces, e.g. "black friday"),
 * trimmed, lowercased, and empties dropped.
 */
export function parseKeywords(query: string): string[] {
  return query
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
}

/**
 * True if `text` contains ANY of the keywords (case-insensitive substring).
 * An empty keyword list matches nothing, so a bulk action with no query is a
 * deliberate no-op rather than selecting everything.
 */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}
