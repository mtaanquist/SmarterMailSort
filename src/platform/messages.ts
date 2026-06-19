// Thin wrapper over the messages WebExtension API: paginated iteration over a
// folder, building summaries via getFull, and batched moves. Kept minimal so
// the testable logic lives in core/.

import { buildSummary, type RawHeader, type RawPart } from "../core/messageSummary.js";
import type { MessageSummary } from "../core/types.js";

type MessageList = {
  id: string | null;
  messages: RawHeader[];
};

/**
 * Lazily yield every message header in a folder, paging through the list with
 * continueList so even folders with tens of thousands of messages stream
 * without being held in memory all at once.
 */
export async function* iterateFolderHeaders(
  folderId: string,
): AsyncGenerator<RawHeader> {
  // The MV3 API accepts a folder id string for list().
  let page = (await messenger.messages.list(
    folderId as unknown as Parameters<typeof messenger.messages.list>[0],
  )) as unknown as MessageList;
  for (;;) {
    for (const header of page.messages) yield header;
    if (!page.id) return;
    page = (await messenger.messages.continueList(
      page.id,
    )) as unknown as MessageList;
  }
}

/** Count messages in a folder (used to show progress totals). */
export async function countFolder(folderId: string): Promise<number> {
  let total = 0;
  for await (const _ of iterateFolderHeaders(folderId)) total++;
  return total;
}

/** Build a model-ready summary for a single message id. */
export async function getSummary(
  header: RawHeader,
  maxBodyChars: number,
): Promise<MessageSummary> {
  const full = (await messenger.messages.getFull(
    header.id,
  )) as unknown as RawPart;
  return buildSummary(header, full, maxBodyChars);
}

/**
 * Apply moves grouped by destination folder id. Returns per-folder results so
 * the caller can report partial failures.
 */
export async function moveBatched(
  movesByFolderId: Map<string, number[]>,
): Promise<Array<{ folderId: string; moved: number; error?: string }>> {
  const results: Array<{ folderId: string; moved: number; error?: string }> = [];
  for (const [folderId, ids] of movesByFolderId) {
    if (!ids.length) continue;
    try {
      await messenger.messages.move(
        ids,
        folderId as unknown as Parameters<typeof messenger.messages.move>[1],
      );
      results.push({ folderId, moved: ids.length });
    } catch (err) {
      results.push({ folderId, moved: 0, error: (err as Error).message });
    }
  }
  return results;
}
