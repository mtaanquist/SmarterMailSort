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

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
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
