// Builds the system + user messages sent to the LLM. The model is constrained
// to choose among an enumerated list of existing folder paths and to reply
// with a strict JSON object that decisionParser can validate.

import type { FolderRef, MessageSummary } from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export const SYSTEM_PROMPT = [
  "You are an email-sorting assistant integrated into a mail client.",
  "For each email you are given, decide whether to KEEP it in place or MOVE it",
  "to exactly one of the destination folders provided.",
  "",
  "Rules:",
  '- Respond with a single JSON object and nothing else.',
  '- Schema: {"action":"move"|"keep","folder":<one of the listed folder paths or null>,"reason":<short string>,"confidence":<number 0..1>}.',
  '- When action is "keep", folder MUST be null.',
  '- When action is "move", folder MUST be EXACTLY one of the destination folder paths listed, copied verbatim.',
  "- Never invent a folder that is not in the list.",
  "- If you are unsure, prefer keep.",
].join("\n");

/**
 * System prompt for the first-pass triage over a HEADER-ONLY summary (no body).
 * Adds a third "unsure" action so the model can defer a decision it can't make
 * confidently from the sender and subject alone; those messages are then fetched
 * in full and re-classified with {@link SYSTEM_PROMPT}.
 */
export const TRIAGE_SYSTEM_PROMPT = [
  "You are an email-sorting assistant integrated into a mail client.",
  "You are shown only an email's sender, subject, and date — NOT its body.",
  "For the email, decide whether to KEEP it in place, MOVE it to exactly one of",
  "the destination folders provided, or — if the sender and subject are not",
  "enough to decide confidently — answer UNSURE so the full message can be",
  "fetched and shown to you.",
  "",
  "Rules:",
  "- Respond with a single JSON object and nothing else.",
  '- Schema: {"action":"move"|"keep"|"unsure","folder":<one of the listed folder paths or null>,"reason":<short string>,"confidence":<number 0..1>}.',
  "- Decide (move or keep) when the sender and subject already make the right destination clear.",
  '- Answer "unsure" only when reading the body would likely change your decision; do not overuse it.',
  '- When action is "keep" or "unsure", folder MUST be null.',
  '- When action is "move", folder MUST be EXACTLY one of the destination folder paths listed, copied verbatim.',
  "- Never invent a folder that is not in the list.",
].join("\n");

/** A named JSON Schema for endpoints that enforce `response_format: json_schema`. */
export interface NamedSchema {
  name: string;
  schema: Record<string, unknown>;
}

const DECISION_PROPS = {
  action: { type: "string", enum: ["move", "keep"] },
  folder: { type: ["string", "null"] },
  reason: { type: "string" },
  confidence: { type: "number" },
} as const;

const TRIAGE_DECISION_PROPS = {
  ...DECISION_PROPS,
  action: { type: "string", enum: ["move", "keep", "unsure"] },
} as const;

/** Schema matching the single-decision shape in {@link SYSTEM_PROMPT}. */
export const DECISION_SCHEMA: NamedSchema = {
  name: "email_decision",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "folder", "reason", "confidence"],
    properties: DECISION_PROPS,
  },
};

/** Schema matching the single triage shape in {@link TRIAGE_SYSTEM_PROMPT}. */
export const TRIAGE_DECISION_SCHEMA: NamedSchema = {
  name: "email_triage",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "folder", "reason", "confidence"],
    properties: TRIAGE_DECISION_PROPS,
  },
};

/** Schema matching the batched-decision shape in {@link BATCH_SYSTEM_PROMPT}. */
export const BATCH_DECISION_SCHEMA: NamedSchema = {
  name: "email_decisions",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "action", "folder", "reason", "confidence"],
          properties: { id: { type: "number" }, ...DECISION_PROPS },
        },
      },
    },
  },
};

/** Schema matching the batched triage shape in {@link BATCH_TRIAGE_SYSTEM_PROMPT}. */
export const BATCH_TRIAGE_DECISION_SCHEMA: NamedSchema = {
  name: "email_triage_batch",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "action", "folder", "reason", "confidence"],
          properties: { id: { type: "number" }, ...TRIAGE_DECISION_PROPS },
        },
      },
    },
  },
};

function renderFolders(folders: FolderRef[]): string {
  if (!folders.length) return "(no destination folders available)";
  return folders.map((f) => `- ${f.path}`).join("\n");
}

export const BATCH_SYSTEM_PROMPT = [
  "You are an email-sorting assistant integrated into a mail client.",
  "You are given a numbered list of emails. For EACH email, decide whether to",
  "KEEP it in place or MOVE it to exactly one of the destination folders provided.",
  "",
  "Rules:",
  '- Respond with a single JSON object and nothing else.',
  '- Schema: {"results":[{"id":<the email id>,"action":"move"|"keep","folder":<one of the listed folder paths or null>,"reason":<short string>,"confidence":<number 0..1>}]}.',
  "- Include EXACTLY one result object per email, each carrying that email's id.",
  '- When action is "keep", folder MUST be null.',
  '- When action is "move", folder MUST be EXACTLY one of the destination folder paths listed, copied verbatim.',
  "- Never invent a folder that is not in the list.",
  "- If you are unsure about an email, prefer keep.",
].join("\n");

/**
 * Batched counterpart to {@link TRIAGE_SYSTEM_PROMPT}: header-only triage over a
 * numbered list, with the extra "unsure" action per email.
 */
export const BATCH_TRIAGE_SYSTEM_PROMPT = [
  "You are an email-sorting assistant integrated into a mail client.",
  "You are given a numbered list of emails, each shown by sender, subject, and",
  "date only — NOT its body. For EACH email, decide whether to KEEP it in place,",
  "MOVE it to exactly one of the destination folders, or — if the sender and",
  "subject are not enough to decide confidently — answer UNSURE so its full",
  "message can be fetched and shown to you.",
  "",
  "Rules:",
  '- Respond with a single JSON object and nothing else.',
  '- Schema: {"results":[{"id":<the email id>,"action":"move"|"keep"|"unsure","folder":<one of the listed folder paths or null>,"reason":<short string>,"confidence":<number 0..1>}]}.',
  "- Include EXACTLY one result object per email, each carrying that email's id.",
  "- Decide (move or keep) when the sender and subject already make the destination clear.",
  '- Answer "unsure" only when reading the body would likely change your decision; do not overuse it.',
  '- When action is "keep" or "unsure", folder MUST be null.',
  '- When action is "move", folder MUST be EXACTLY one of the destination folder paths listed, copied verbatim.',
  "- Never invent a folder that is not in the list.",
].join("\n");

function renderSummary(summary: MessageSummary, id?: number): string {
  const lines =
    id === undefined
      ? [`From: ${summary.author}`, `To: ${summary.recipients.join(", ")}`]
      : [
          `Email id: ${id}`,
          `From: ${summary.author}`,
          `To: ${summary.recipients.join(", ")}`,
        ];
  if (summary.ccList.length) lines.push(`Cc: ${summary.ccList.join(", ")}`);
  lines.push(`Subject: ${summary.subject}`);
  if (summary.date) lines.push(`Date: ${summary.date}`);
  for (const [name, value] of Object.entries(summary.headers)) {
    lines.push(`${name}: ${value}`);
  }
  // Triage summaries carry no body; omit the section entirely so the prompt
  // stays a true subject-only payload rather than padding it with "(empty)".
  if (summary.bodyExcerpt) {
    lines.push("");
    lines.push("Body excerpt:");
    lines.push(summary.bodyExcerpt);
  }
  return lines.join("\n");
}

/**
 * Build the chat messages for one classification call.
 * @param instruction free-text user instruction (e.g. "move newsletters to ...")
 * @param folders the existing folders the model may target
 * @param summary the message to classify
 * @param systemPrompt which system prompt to use (defaults to the full-body
 *   prompt; pass {@link TRIAGE_SYSTEM_PROMPT} for the header-only triage pass)
 */
export function buildClassificationMessages(
  instruction: string,
  folders: FolderRef[],
  summary: MessageSummary,
  systemPrompt: string = SYSTEM_PROMPT,
): ChatMessage[] {
  const user = [
    `User instruction: ${instruction.trim()}`,
    "",
    "Destination folders (choose at most one, verbatim):",
    renderFolders(folders),
    "",
    "Email to classify:",
    renderSummary(summary),
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: user },
  ];
}

/**
 * Build the chat messages for one batched classification call covering several
 * messages. The model is asked to return one keyed result per email so results
 * can be mapped back even if it reorders or drops entries.
 * @param instruction free-text user instruction
 * @param folders the existing folders the model may target
 * @param summaries the messages to classify in this batch
 * @param systemPrompt which system prompt to use (defaults to the full-body
 *   batch prompt; pass {@link BATCH_TRIAGE_SYSTEM_PROMPT} for triage)
 */
export function buildBatchClassificationMessages(
  instruction: string,
  folders: FolderRef[],
  summaries: MessageSummary[],
  systemPrompt: string = BATCH_SYSTEM_PROMPT,
): ChatMessage[] {
  const emails = summaries
    .map(
      (summary, i) =>
        `Email ${i + 1} of ${summaries.length}:\n${renderSummary(summary, summary.id)}`,
    )
    .join("\n\n---\n\n");

  const user = [
    `User instruction: ${instruction.trim()}`,
    "",
    "Destination folders (choose at most one per email, verbatim):",
    renderFolders(folders),
    "",
    `Classify all ${summaries.length} emails below. Return one result object per`,
    "email, each echoing its \"Email id\".",
    "",
    emails,
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: user },
  ];
}
