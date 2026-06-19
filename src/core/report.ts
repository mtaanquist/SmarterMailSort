// Renders a human-readable Markdown report from classification results. Pure
// so it can be tested and reused for both dry-run output and post-apply logs.

import type { ClassifiedMessage } from "./types.js";
import { groupMovesByFolder } from "./classifier.js";

export interface ReportMeta {
  sourceFolder: string;
  instruction: string;
  dryRun: boolean;
  /** True when classification was stopped early by the user. */
  stopped?: boolean;
  generatedAt: string;
}

export function buildMarkdownReport(
  classified: ClassifiedMessage[],
  meta: ReportMeta,
): string {
  const moves = groupMovesByFolder(classified);
  const kept = classified.filter((c) => c.decision.action === "keep" && !c.error);
  const errored = classified.filter((c) => c.error);
  const movedCount = classified.length - kept.length - errored.length;

  const lines: string[] = [];
  lines.push(`# SmarterMailSort report`);
  lines.push("");
  lines.push(`- Generated: ${meta.generatedAt}`);
  lines.push(`- Mode: ${meta.dryRun ? "dry-run (no changes applied)" : "applied"}`);
  lines.push(`- Source folder: ${meta.sourceFolder}`);
  lines.push(`- Instruction: ${meta.instruction}`);
  if (meta.stopped) {
    lines.push(
      `- **Stopped early**: classification was halted by the user; this covers only the messages processed so far.`,
    );
  }
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Total classified: ${classified.length}`);
  lines.push(`- Proposed moves: ${movedCount}`);
  lines.push(`- Kept in place: ${kept.length}`);
  lines.push(`- Errors: ${errored.length}`);
  lines.push("");

  for (const [folder, items] of moves) {
    lines.push(`## → ${folder} (${items.length})`);
    lines.push("");
    for (const item of items) {
      const conf = item.decision.confidence.toFixed(2);
      lines.push(
        `- **${item.summary.subject || "(no subject)"}** — ${item.summary.author}`,
      );
      lines.push(`  - reason: ${item.decision.reason} (confidence ${conf})`);
    }
    lines.push("");
  }

  if (errored.length) {
    lines.push(`## Errors`);
    lines.push("");
    for (const item of errored) {
      lines.push(
        `- ${item.summary.subject || "(no subject)"} — ${item.error}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
