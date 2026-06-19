// Orchestrates classification of a stream of messages with a bounded worker
// pool. Decoupled from the LLM and the platform: callers inject a `classify`
// function and an async iterable of summaries, which makes the whole loop
// (concurrency, abort, progress, error capture) unit-testable.

import type {
  ClassifiedMessage,
  ClassifyProgress,
  Decision,
  MessageSummary,
} from "./types.js";

export interface RunClassificationOptions {
  /** Stream of messages to classify. */
  source: AsyncIterable<MessageSummary>;
  /**
   * Classifies a single message. Should reject only on unexpected errors.
   * Either this or `classifyBatch` must be provided; with `batchSize > 1`,
   * `classifyBatch` is preferred when present.
   */
  classify?: (summary: MessageSummary) => Promise<Decision>;
  /**
   * Classifies several messages in one call, returning decisions aligned by
   * index to the input. A returned array shorter than the input (or a missing
   * entry) defaults that message to "keep". Should reject only on unexpected
   * errors (which mark the whole batch as failed-but-kept).
   */
  classifyBatch?: (summaries: MessageSummary[]) => Promise<Decision[]>;
  /** Number of concurrent classify calls. Clamped to >= 1. 1 == serial. */
  concurrency: number;
  /** Messages per `classifyBatch` call. Clamped to >= 1. 1 == one at a time. */
  batchSize?: number;
  /** Optional known total, surfaced in progress for UI percentages. */
  total?: number | null;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Invoked after each message resolves (success or captured error). */
  onProgress?: (progress: ClassifyProgress) => void;
}

const FAILED_DECISION = (reason: string): Decision => ({
  action: "keep",
  folder: null,
  reason,
  confidence: 0,
});

/**
 * Drive classification to completion (or abort) and return every result in the
 * order messages were emitted by the source.
 */
export async function runClassification(
  opts: RunClassificationOptions,
): Promise<ClassifiedMessage[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency || 1));
  const batchSize = Math.max(1, Math.floor(opts.batchSize || 1));
  const results: ClassifiedMessage[] = [];
  const iterator = opts.source[Symbol.asyncIterator]();
  let processed = 0;
  let exhausted = false;
  let nextIndex = 0;

  // Normalise the two classify styles into a single batch function. A single
  // `classify` is run sequentially across a batch (so it can't be undermined by
  // a wrongly-sized return), preserving the legacy per-message contract.
  const classifyBatch = async (
    summaries: MessageSummary[],
  ): Promise<Decision[]> => {
    if (opts.classifyBatch && (batchSize > 1 || !opts.classify)) {
      return opts.classifyBatch(summaries);
    }
    if (!opts.classify) {
      throw new Error("runClassification: no classify or classifyBatch provided");
    }
    const out: Decision[] = [];
    for (const summary of summaries) out.push(await opts.classify(summary));
    return out;
  };

  const record = (index: number, result: ClassifiedMessage) => {
    results[index] = result;
    processed++;
    opts.onProgress?.({
      processed,
      total: opts.total ?? null,
      lastResult: result,
    });
  };

  const runBatch = async (
    batch: { index: number; summary: MessageSummary }[],
  ) => {
    let decisions: Decision[];
    try {
      decisions = await classifyBatch(batch.map((b) => b.summary));
    } catch (err) {
      const message = (err as Error).message;
      for (const { index, summary } of batch) {
        record(index, {
          summary,
          decision: FAILED_DECISION("classification failed"),
          error: message,
        });
      }
      return;
    }
    batch.forEach(({ index, summary }, i) => {
      const decision = decisions[i];
      record(
        index,
        decision
          ? { summary, decision }
          : {
              summary,
              decision: FAILED_DECISION("model omitted a decision for this email"),
            },
      );
    });
  };

  // A worker pulls the next batch of summaries from the shared iterator until
  // the source is exhausted or an abort is requested.
  const worker = async (): Promise<void> => {
    while (!exhausted) {
      if (opts.signal?.aborted) return;
      const batch: { index: number; summary: MessageSummary }[] = [];
      while (batch.length < batchSize) {
        const { value, done } = await iterator.next();
        if (done) {
          exhausted = true;
          break;
        }
        batch.push({ index: nextIndex++, summary: value });
      }
      if (batch.length === 0) return;
      if (opts.signal?.aborted) return;
      await runBatch(batch);
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Drop holes left by an early abort so the array stays dense.
  return results.filter((r): r is ClassifiedMessage => r !== undefined);
}

/** Group move-decisions by their target folder path (for review + apply). */
export function groupMovesByFolder(
  classified: ClassifiedMessage[],
): Map<string, ClassifiedMessage[]> {
  const groups = new Map<string, ClassifiedMessage[]>();
  for (const item of classified) {
    if (item.decision.action !== "move" || !item.decision.folder) continue;
    const list = groups.get(item.decision.folder) ?? [];
    list.push(item);
    groups.set(item.decision.folder, list);
  }
  return groups;
}
