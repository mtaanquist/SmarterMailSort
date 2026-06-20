// Builds a compact MessageSummary from a Thunderbird MessagePart-like object.
// Kept pure: it accepts plain objects (the shapes returned by
// messenger.messages.get / getFull) rather than calling any API itself.

import type { MessageSummary } from "./types.js";

/** Subset of `messenger.messages.MessageHeader` we rely on. */
export interface RawHeader {
  id: number;
  /** RFC Message-ID; stable across folder moves (unlike `id`). */
  headerMessageId?: string;
  author?: string;
  recipients?: string[];
  ccList?: string[];
  subject?: string;
  date?: Date | string | number;
}

/**
 * Subset of `messenger.messages.MessagePart` we rely on. Bodies live on leaf
 * parts; `headers` is a map of lowercase header name -> array of values.
 */
export interface RawPart {
  contentType?: string;
  headers?: Record<string, string[]>;
  body?: string;
  parts?: RawPart[];
}

/** Headers worth surfacing to the model beyond the structured fields. */
const INTERESTING_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "precedence",
  "auto-submitted",
  "x-mailer",
  "x-spam-flag",
  "return-path",
];

function normaliseDate(date: RawHeader["date"]): string {
  if (date instanceof Date) return date.toISOString();
  if (typeof date === "number") return new Date(date).toISOString();
  if (typeof date === "string" && date) {
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
  }
  return "";
}

/** Depth-first walk collecting the first usable text/plain (or text/html) body. */
function extractBody(part: RawPart | undefined): string {
  if (!part) return "";
  const stack: RawPart[] = [part];
  let htmlFallback = "";
  while (stack.length) {
    const current = stack.shift()!;
    const type = (current.contentType ?? "").toLowerCase();
    if (current.body && current.body.trim()) {
      if (type.startsWith("text/plain")) return current.body;
      if (type.startsWith("text/html") && !htmlFallback) {
        htmlFallback = stripHtml(current.body);
      }
    }
    if (current.parts) stack.push(...current.parts);
  }
  return htmlFallback;
}

/** Minimal, dependency-free HTML-to-text reduction for body excerpts. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pickHeaders(part: RawPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = part?.headers;
  if (!headers) return out;
  for (const name of INTERESTING_HEADERS) {
    const values = headers[name];
    if (values && values.length) out[name] = values.join(", ");
  }
  return out;
}

/**
 * Combine a message header and its full MIME part into a model-ready summary,
 * truncating the body to `maxBodyChars`.
 */
export function buildSummary(
  header: RawHeader,
  full: RawPart | undefined,
  maxBodyChars: number,
): MessageSummary {
  const body = extractBody(full);
  const bodyExcerpt =
    body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body;

  return {
    id: header.id,
    headerMessageId: header.headerMessageId ?? "",
    author: header.author ?? "",
    recipients: header.recipients ?? [],
    ccList: header.ccList ?? [],
    subject: header.subject ?? "",
    date: normaliseDate(header.date),
    headers: pickHeaders(full),
    bodyExcerpt,
  };
}

/**
 * Build a header-only summary from a folder-listing header, WITHOUT fetching the
 * message body (no `getFull` call). Used by the triage-first pass: the model
 * decides from sender/subject/date alone, and only ambiguous messages are later
 * hydrated with their body via {@link hydrateSummary}.
 */
export function buildHeaderSummary(header: RawHeader): MessageSummary {
  return {
    id: header.id,
    headerMessageId: header.headerMessageId ?? "",
    author: header.author ?? "",
    recipients: header.recipients ?? [],
    ccList: header.ccList ?? [],
    subject: header.subject ?? "",
    date: normaliseDate(header.date),
    headers: {},
    bodyExcerpt: "",
  };
}

/**
 * Fill in the body excerpt and interesting headers of a previously header-only
 * summary, given its now-fetched full MIME part. Preserves the header fields
 * already resolved; only the body-derived parts are added.
 */
export function hydrateSummary(
  summary: MessageSummary,
  full: RawPart | undefined,
  maxBodyChars: number,
): MessageSummary {
  const body = extractBody(full);
  const bodyExcerpt =
    body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body;
  return { ...summary, headers: pickHeaders(full), bodyExcerpt };
}
