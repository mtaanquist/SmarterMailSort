// Thin wrapper over the messages WebExtension API: paginated iteration over a
// folder, building summaries via getFull, and batched moves. Kept minimal so
// the testable logic lives in core/.

import { buildSummary, type RawHeader, type RawPart } from "../core/messageSummary.js";
import type {
  MessageSummary,
  UndoOutcome,
  UndoRecord,
} from "../core/types.js";

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
 * Find the current ids of a message (by its move-stable RFC Message-ID) within
 * a specific folder. Returns every match; normally 0 (gone) or 1.
 */
async function findIdsByHeaderId(
  folderId: string,
  headerMessageId: string,
): Promise<number[]> {
  const ids: number[] = [];
  let page = (await messenger.messages.query({
    folderId,
    headerMessageId,
  } as Parameters<typeof messenger.messages.query>[0])) as unknown as MessageList;
  for (;;) {
    for (const header of page.messages) ids.push(header.id);
    if (!page.id) break;
    page = (await messenger.messages.continueList(
      page.id,
    )) as unknown as MessageList;
  }
  return ids;
}

/**
 * Reverse a previously-applied batch: for each moved message, re-locate it in
 * the folder it was moved into (by RFC Message-ID, since numeric ids don't
 * survive a move) and move it back to the original source folder. Reports any
 * message it could not find (moved/deleted since) or could not move.
 */
export async function moveBackByHeaderId(
  record: UndoRecord,
): Promise<UndoOutcome> {
  // Group by destination folder so each folder's restorable ids move in one call.
  const byDest = new Map<string, string[]>();
  for (const item of record.items) {
    const list = byDest.get(item.destFolderId) ?? [];
    list.push(item.headerMessageId);
    byDest.set(item.destFolderId, list);
  }

  const outcome: UndoOutcome = { restored: 0, failures: [] };
  for (const [destFolderId, headerMessageIds] of byDest) {
    const ids: number[] = [];
    for (const headerMessageId of headerMessageIds) {
      try {
        const found = await findIdsByHeaderId(destFolderId, headerMessageId);
        if (found.length) ids.push(...found);
        else
          outcome.failures.push({
            headerMessageId,
            destFolderId,
            error: "not found (moved or deleted since apply)",
          });
      } catch (err) {
        outcome.failures.push({
          headerMessageId,
          destFolderId,
          error: (err as Error).message,
        });
      }
    }
    if (!ids.length) continue;
    try {
      await messenger.messages.move(
        ids,
        record.sourceFolderId as unknown as Parameters<
          typeof messenger.messages.move
        >[1],
      );
      outcome.restored += ids.length;
    } catch (err) {
      // The whole folder's move-back failed; attribute it to those messages.
      for (const headerMessageId of headerMessageIds) {
        outcome.failures.push({
          headerMessageId,
          destFolderId,
          error: (err as Error).message,
        });
      }
    }
  }
  return outcome;
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
