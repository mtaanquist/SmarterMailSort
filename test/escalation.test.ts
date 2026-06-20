import { describe, expect, it, vi } from "vitest";
import { classifyWithEscalation } from "../src/core/escalation.js";
import type { Decision, MessageSummary, Triage } from "../src/core/types.js";

function summary(id: number): MessageSummary {
  return {
    id,
    headerMessageId: `<m-${id}>`,
    author: `a${id}`,
    recipients: [],
    ccList: [],
    subject: `s${id}`,
    date: "",
    headers: {},
    bodyExcerpt: "",
  };
}

const move = (folder: string): Decision => ({
  action: "move",
  folder,
  reason: "r",
  confidence: 1,
});
const keep: Decision = { action: "keep", folder: null, reason: "r", confidence: 0 };
const decided = (decision: Decision): Triage => ({ kind: "decided", decision });
const escalate: Triage = { kind: "escalate" };

describe("classifyWithEscalation", () => {
  it("returns triaged decisions without hydrating when nothing escalates", async () => {
    const hydrate = vi.fn(async (s: MessageSummary) => s);
    const classifyFull = vi.fn(async () => [] as Decision[]);
    const out = await classifyWithEscalation([summary(1), summary(2)], {
      triage: async () => [decided(move("Archive")), decided(keep)],
      hydrate,
      classifyFull,
    });
    expect(out).toEqual([move("Archive"), keep]);
    expect(hydrate).not.toHaveBeenCalled();
    expect(classifyFull).not.toHaveBeenCalled();
  });

  it("hydrates and re-classifies only the escalated messages, preserving order", async () => {
    const summaries = [summary(1), summary(2), summary(3)];
    const hydrate = vi.fn(async (s: MessageSummary) => ({
      ...s,
      bodyExcerpt: `body-${s.id}`,
    }));
    const classifyFull = vi.fn(async (ss: MessageSummary[]) =>
      ss.map((s) => move(`Full/${s.id}`)),
    );

    const out = await classifyWithEscalation(summaries, {
      // Decide #1 up front; escalate #2 and #3.
      triage: async () => [decided(keep), escalate, escalate],
      hydrate,
      classifyFull,
    });

    expect(out).toEqual([keep, move("Full/2"), move("Full/3")]);
    // Only the escalated subset is hydrated, and with its body fetched.
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(classifyFull).toHaveBeenCalledTimes(1);
    expect(classifyFull.mock.calls[0][0].map((s) => s.id)).toEqual([2, 3]);
    expect(classifyFull.mock.calls[0][0].map((s) => s.bodyExcerpt)).toEqual([
      "body-2",
      "body-3",
    ]);
  });

  it("defaults a missing full-pass decision to keep", async () => {
    const out = await classifyWithEscalation([summary(1)], {
      triage: async () => [escalate],
      hydrate: async (s) => s,
      classifyFull: async () => [], // omitted
    });
    expect(out[0].action).toBe("keep");
  });

  it("treats a missing triage outcome as an escalation", async () => {
    const classifyFull = vi.fn(async (ss: MessageSummary[]) =>
      ss.map(() => move("X")),
    );
    const out = await classifyWithEscalation([summary(1)], {
      triage: async () => [], // shorter than input
      hydrate: async (s) => s,
      classifyFull,
    });
    expect(classifyFull).toHaveBeenCalledTimes(1);
    expect(out).toEqual([move("X")]);
  });
});
