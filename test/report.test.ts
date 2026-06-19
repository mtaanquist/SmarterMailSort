import { describe, expect, it } from "vitest";
import { buildMarkdownReport } from "../src/core/report.js";
import type { ClassifiedMessage } from "../src/core/types.js";

function item(id: number, action: "move" | "keep", folder: string | null, error?: string): ClassifiedMessage {
  return {
    summary: {
      id,
      author: `a${id}`,
      recipients: [],
      ccList: [],
      subject: `s${id}`,
      date: "",
      headers: {},
      bodyExcerpt: "",
    },
    decision: { action, folder, reason: "because", confidence: 0.5 },
    error,
  };
}

describe("buildMarkdownReport", () => {
  const classified = [
    item(1, "move", "Archive"),
    item(2, "move", "Archive"),
    item(3, "keep", null),
    item(4, "keep", null, "failed"),
  ];

  const md = buildMarkdownReport(classified, {
    sourceFolder: "Inbox",
    instruction: "sort it",
    dryRun: true,
    generatedAt: "2026-06-19T00:00:00.000Z",
  });

  it("reports accurate counts", () => {
    expect(md).toContain("Total classified: 4");
    expect(md).toContain("Proposed moves: 2");
    expect(md).toContain("Kept in place: 1");
    expect(md).toContain("Errors: 1");
  });

  it("groups moves under their folder heading", () => {
    expect(md).toContain("## → Archive (2)");
  });

  it("notes dry-run mode", () => {
    expect(md).toContain("dry-run");
  });
});
