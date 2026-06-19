// Parses and validates the model's JSON reply into a normalised Decision.
// Defensive: tolerates code fences and surrounding prose, and re-validates the
// chosen folder against the allowed set so the model can never target a folder
// that does not exist.

import type { Decision } from "./types.js";

const KEEP = (reason: string): Decision => ({
  action: "keep",
  folder: null,
  reason,
  confidence: 0,
});

/**
 * Extract the first balanced bracketed span (`open`..`close`) from arbitrary
 * model text, ignoring brackets that appear inside JSON strings.
 */
function extractBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJsonObject(text: string): string | null {
  return extractBalanced(text, "{", "}");
}

/** Extract the first balanced JSON array from arbitrary model text. */
export function extractJsonArray(text: string): string | null {
  return extractBalanced(text, "[", "]");
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Validate one parsed decision object against the allowed folder set. */
function normaliseDecision(
  obj: Record<string, unknown>,
  allowedFolders: ReadonlySet<string>,
): Decision {
  const action = String(obj.action ?? "").toLowerCase();
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : "(no reason given)";
  const confidence = clampConfidence(obj.confidence);

  if (action !== "move") {
    return { action: "keep", folder: null, reason, confidence };
  }

  const folder = typeof obj.folder === "string" ? obj.folder.trim() : "";
  if (!folder || !allowedFolders.has(folder)) {
    return KEEP(
      `model targeted unknown folder "${folder}"; keeping for review`,
    );
  }

  return { action: "move", folder, reason, confidence };
}

/**
 * Parse a raw model reply into a validated Decision.
 * @param raw the model's text output
 * @param allowedFolders the set of folder paths the model may legally target
 */
export function parseDecision(
  raw: string,
  allowedFolders: ReadonlySet<string>,
): Decision {
  const json = extractJsonObject(raw ?? "");
  if (!json) return KEEP("could not parse model response");

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return KEEP("invalid JSON in model response");
  }

  return normaliseDecision(obj, allowedFolders);
}

/** Pull a list of raw decision objects from a model reply, if one is present. */
function extractDecisionList(raw: string): Record<string, unknown>[] | null {
  const text = raw ?? "";
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");

  // Try a bare top-level array first when it appears before any object.
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) {
    const arr = extractJsonArray(text);
    if (arr) {
      try {
        const parsed = JSON.parse(arr) as unknown;
        if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      } catch {
        /* fall through to object handling */
      }
    }
  }

  const obj = extractJsonObject(text);
  if (obj) {
    try {
      const parsed = JSON.parse(obj) as Record<string, unknown>;
      for (const key of ["results", "decisions", "items", "emails"]) {
        if (Array.isArray(parsed[key])) {
          return parsed[key] as Record<string, unknown>[];
        }
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Parse a batched model reply into validated decisions keyed by message id.
 * Any id the model omitted (or returned an unusable entry for) is left out of
 * the map, so callers can default those messages to "keep".
 * @param raw the model's text output
 * @param allowedFolders the set of folder paths the model may legally target
 * @param ids the message ids that were sent in this batch (for validation)
 */
export function parseDecisions(
  raw: string,
  allowedFolders: ReadonlySet<string>,
  ids: readonly number[],
): Map<number, Decision> {
  const out = new Map<number, Decision>();
  const valid = new Set(ids);
  const list = extractDecisionList(raw);
  if (!list) return out;

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const idRaw = (entry as Record<string, unknown>).id;
    const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
    if (!Number.isFinite(id) || !valid.has(id) || out.has(id)) continue;
    out.set(id, normaliseDecision(entry, allowedFolders));
  }
  return out;
}
