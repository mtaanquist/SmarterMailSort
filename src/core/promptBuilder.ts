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

function renderSummary(summary: MessageSummary): string {
  const lines = [
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
