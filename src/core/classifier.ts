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
  /** Classifies a single message. Should reject only on unexpected errors. */
  classify: (summary: MessageSummary) => Promise<Decision>;
  /** Number of concurrent classify calls. Clamped to >= 1. 1 == serial. */
  concurrency: number;
  /** Optional known total, surfaced in progress for UI percentages. */
  total?: number | null;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Invoked after each message resolves (success or captured error). */
  onProgress?: (progress: ClassifyProgress) => void;
}

/**
 * Drive classification to completion (or abort) and return every result in the
 * order messages were emitted by the source.
 */
export async function runClassification(
  opts: RunClassificationOptions,
): Promise<ClassifiedMessage[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency || 1));
  const results: ClassifiedMessage[] = [];
  const iterator = opts.source[Symbol.asyncIterator]();
  let processed = 0;
  let exhausted = false;
  let nextIndex = 0;

  const classifyInto = async (index: number, summary: MessageSummary) => {
    let result: ClassifiedMessage;
    try {
      const decision = await opts.classify(summary);
      result = { summary, decision };
    } catch (err) {
      result = {
        summary,
        decision: {
          action: "keep",
          folder: null,
          reason: "classification failed",
          confidence: 0,
        },
        error: (err as Error).message,
      };
    }
    results[index] = result;
    processed++;
    opts.onProgress?.({
      processed,
      total: opts.total ?? null,
      lastResult: result,
    });
  };

  // A worker pulls the next summary from the shared iterator until the source
  // is exhausted or an abort is requested.
  const worker = async (): Promise<void> => {
    while (!exhausted) {
      if (opts.signal?.aborted) return;
      const { value, done } = await iterator.next();
      if (done) {
        exhausted = true;
        return;
      }
      const index = nextIndex++;
      await classifyInto(index, value);
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
