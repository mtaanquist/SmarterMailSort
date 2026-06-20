// Two-pass "triage-first" classification. A cheap first pass decides from a
// header-only summary (subject + sender, no body fetched); only the messages the
// model flags as ambiguous are hydrated with their body and re-classified. This
// keeps the common path body-free — a large speed-up on big folders — and tends
// to be more accurate, since incidental body keywords are a frequent cause of
// misclassification. Pure: the three collaborators are injected, so the
// escalation/merge logic is unit-testable without an LLM or the platform.

import type { Decision, MessageSummary, Triage } from "./types.js";

/** Fallback when the full pass omits a decision for an escalated message. */
const KEEP_FALLBACK: Decision = {
  action: "keep",
  folder: null,
  reason: "model omitted a decision for this email",
  confidence: 0,
};

export interface EscalationClassifier {
  /**
   * First pass over header-only summaries, returning one outcome per input (by
   * index): a final decision, or an escalate request.
   */
  triage: (summaries: MessageSummary[]) => Promise<Triage[]>;
  /** Fetch the full body for a message that needs a closer look. */
  hydrate: (summary: MessageSummary) => Promise<MessageSummary>;
  /**
   * Second pass over the hydrated (body-bearing) summaries, returning a final
   * decision per input (by index).
   */
  classifyFull: (summaries: MessageSummary[]) => Promise<Decision[]>;
}

/**
 * Classify a batch via triage-then-escalate. Triaged decisions pass straight
 * through; only the escalated subset is hydrated and sent through the full pass.
 * Returns one decision per input summary, in input order.
 */
export async function classifyWithEscalation(
  summaries: MessageSummary[],
  classifier: EscalationClassifier,
): Promise<Decision[]> {
  const triaged = await classifier.triage(summaries);

  const escalateIndexes: number[] = [];
  const out: Decision[] = summaries.map((_, i) => {
    const t = triaged[i];
    if (t && t.kind === "decided") return t.decision;
    escalateIndexes.push(i);
    return KEEP_FALLBACK;
  });

  if (escalateIndexes.length === 0) return out;

  const hydrated = await Promise.all(
    escalateIndexes.map((i) => classifier.hydrate(summaries[i])),
  );
  const full = await classifier.classifyFull(hydrated);
  escalateIndexes.forEach((index, j) => {
    out[index] = full[j] ?? KEEP_FALLBACK;
  });
  return out;
}
