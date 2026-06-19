import { describe, expect, it, vi } from "vitest";
import { groupMovesByFolder, runClassification } from "../src/core/classifier.js";
import type { Decision, MessageSummary } from "../src/core/types.js";

function summary(id: number): MessageSummary {
  return {
    id,
    headerMessageId: `<msg-${id}@example.com>`,
    author: `a${id}`,
    recipients: [],
    ccList: [],
    subject: `s${id}`,
    date: "",
    headers: {},
    bodyExcerpt: "",
  };
}

async function* stream(ids: number[]): AsyncGenerator<MessageSummary> {
  for (const id of ids) yield summary(id);
}

const move = (folder: string): Decision => ({
  action: "move",
  folder,
  reason: "r",
  confidence: 1,
});
const keep: Decision = { action: "keep", folder: null, reason: "r", confidence: 0 };

describe("runClassification", () => {
  it("classifies every message and preserves source order", async () => {
    const results = await runClassification({
      source: stream([1, 2, 3]),
      classify: async (s) => (s.id === 2 ? keep : move("X")),
      concurrency: 1,
    });
    expect(results.map((r) => r.summary.id)).toEqual([1, 2, 3]);
    expect(results[1].decision.action).toBe("keep");
  });

  it("captures per-message errors without aborting the run", async () => {
    const results = await runClassification({
      source: stream([1, 2]),
      classify: async (s) => {
        if (s.id === 1) throw new Error("boom");
        return move("X");
      },
      concurrency: 2,
    });
    const first = results.find((r) => r.summary.id === 1)!;
    expect(first.error).toBe("boom");
    expect(first.decision.action).toBe("keep");
  });

  it("reports progress for each processed message", async () => {
    const onProgress = vi.fn();
    await runClassification({
      source: stream([1, 2, 3]),
      classify: async () => keep,
      concurrency: 1,
      total: 3,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ processed: 3, total: 3 }),
    );
  });

  it("stops pulling new work once aborted", async () => {
    const controller = new AbortController();
    const classify = vi.fn(async (s: MessageSummary) => {
      if (s.id === 1) controller.abort();
      return keep;
    });
    const results = await runClassification({
      source: stream([1, 2, 3, 4]),
      classify,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(results.length).toBeLessThan(4);
  });
});

describe("runClassification (batched)", () => {
  it("groups the source into batches of batchSize and preserves order", async () => {
    const calls: number[][] = [];
    const results = await runClassification({
      source: stream([1, 2, 3, 4, 5]),
      classifyBatch: async (summaries) => {
        calls.push(summaries.map((s) => s.id));
        return summaries.map((s) => (s.id % 2 === 0 ? keep : move("X")));
      },
      concurrency: 1,
      batchSize: 2,
    });
    expect(calls).toEqual([[1, 2], [3, 4], [5]]);
    expect(results.map((r) => r.summary.id)).toEqual([1, 2, 3, 4, 5]);
    expect(results[1].decision.action).toBe("keep");
    expect(results[0].decision.action).toBe("move");
  });

  it("defaults missing entries in a short batch result to keep", async () => {
    const results = await runClassification({
      source: stream([1, 2, 3]),
      // Model only returned one decision for a 3-message batch.
      classifyBatch: async () => [move("X")],
      concurrency: 1,
      batchSize: 3,
    });
    expect(results[0].decision.action).toBe("move");
    expect(results[1].decision.action).toBe("keep");
    expect(results[2].decision.action).toBe("keep");
    expect(results[2].decision.reason).toContain("omitted");
  });

  it("marks an entire batch as kept-with-error when classifyBatch throws", async () => {
    const results = await runClassification({
      source: stream([1, 2]),
      classifyBatch: async () => {
        throw new Error("batch boom");
      },
      concurrency: 1,
      batchSize: 2,
    });
    expect(results.every((r) => r.error === "batch boom")).toBe(true);
    expect(results.every((r) => r.decision.action === "keep")).toBe(true);
  });

  it("reports progress per message even when batched", async () => {
    const onProgress = vi.fn();
    await runClassification({
      source: stream([1, 2, 3, 4]),
      classifyBatch: async (summaries) => summaries.map(() => keep),
      concurrency: 1,
      batchSize: 2,
      total: 4,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ processed: 4, total: 4 }),
    );
  });

  it("prefers single classify when batchSize is 1 even if classifyBatch exists", async () => {
    const classifyBatch = vi.fn(async (summaries: MessageSummary[]) =>
      summaries.map(() => keep),
    );
    const results = await runClassification({
      source: stream([1, 2]),
      classify: async () => move("X"),
      classifyBatch,
      concurrency: 1,
      batchSize: 1,
    });
    expect(classifyBatch).not.toHaveBeenCalled();
    expect(results.every((r) => r.decision.action === "move")).toBe(true);
  });
});

describe("groupMovesByFolder", () => {
  it("groups only move decisions by target folder", async () => {
    const results = await runClassification({
      source: stream([1, 2, 3]),
      classify: async (s) => (s.id === 3 ? keep : move(s.id === 1 ? "A" : "B")),
      concurrency: 1,
    });
    const groups = groupMovesByFolder(results);
    expect(groups.get("A")).toHaveLength(1);
    expect(groups.get("B")).toHaveLength(1);
    expect(groups.has("keep")).toBe(false);
  });
});
