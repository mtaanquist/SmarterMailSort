import { describe, expect, it } from "vitest";
import { buildClassificationMessages, SYSTEM_PROMPT } from "../src/core/promptBuilder.js";
import type { FolderRef, MessageSummary } from "../src/core/types.js";

const folders: FolderRef[] = [
  { id: "a", path: "Local Folders/to_be_deleted" },
  { id: "b", path: "Local Folders/archive" },
];

const summary: MessageSummary = {
  id: 1,
  author: "news@example.com",
  recipients: ["me@example.com"],
  ccList: ["cc@example.com"],
  subject: "Sale!",
  date: "2026-01-01T00:00:00.000Z",
  headers: { "list-id": "<promo>" },
  bodyExcerpt: "Buy now",
};

describe("buildClassificationMessages", () => {
  const messages = buildClassificationMessages("move newsletters", folders, summary);

  it("emits a system then user message", () => {
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages[1].role).toBe("user");
  });

  it("includes the instruction, folder paths and message fields", () => {
    const user = messages[1].content;
    expect(user).toContain("move newsletters");
    expect(user).toContain("- Local Folders/to_be_deleted");
    expect(user).toContain("- Local Folders/archive");
    expect(user).toContain("Subject: Sale!");
    expect(user).toContain("Cc: cc@example.com");
    expect(user).toContain("list-id: <promo>");
    expect(user).toContain("Buy now");
  });

  it("handles an empty folder list", () => {
    const m = buildClassificationMessages("x", [], summary);
    expect(m[1].content).toContain("(no destination folders available)");
  });
});
