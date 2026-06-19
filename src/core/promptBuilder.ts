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
  lines.push("");
  lines.push("Body excerpt:");
  lines.push(summary.bodyExcerpt || "(empty)");
  return lines.join("\n");
}

/**
 * Build the chat messages for one classification call.
 * @param instruction free-text user instruction (e.g. "move newsletters to ...")
 * @param folders the existing folders the model may target
 * @param summary the message to classify
 */
export function buildClassificationMessages(
  instruction: string,
  folders: FolderRef[],
  summary: MessageSummary,
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
    { role: "system", content: SYSTEM_PROMPT },
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
 */
export function buildBatchClassificationMessages(
  instruction: string,
  folders: FolderRef[],
  summaries: MessageSummary[],
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
    { role: "system", content: BATCH_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}
