// Thin wrapper over the messages WebExtension API: paginated iteration over a
// folder, building summaries via getFull, and batched moves. Kept minimal so
// the testable logic lives in core/.

import {
  buildSummary,
  hydrateSummary,
  type RawHeader,
  type RawPart,
} from "../core/messageSummary.js";
import type {
  MessageSummary,
  UndoOutcome,
  UndoRecord,
} from "../core/types.js";

type MessageList = {
  id: string | null;
  messages: RawHeader[];
};

/** Cast helper for the folder-id argument of `messenger.messages.move`. */
type MoveFolderArg = Parameters<typeof messenger.messages.move>[1];

/**
 * Tuning for chunked moves. A single `messages.move()` of thousands of ids
 * aborts partway through with a MailNews copy error (e.g. `onStopCopy` status
 * `2153054241` / `0x80550021`): the underlying copy service can only carry a
 * limited batch, and the folder is briefly "busy" between copies. So we move in
 * modest chunks, sequentially, and retry a chunk a few times before giving up.
 */
const MOVE_CHUNK_SIZE = 100;
const MOVE_CHUNK_RETRIES = 3;
const MOVE_RETRY_DELAY_MS = 500;

export interface MoveOptions {
  chunkSize?: number;
  retries?: number;
  /** Base back-off between retries (multiplied by the attempt number). */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Move `ids` into `folderId` in sequential chunks, retrying a chunk that fails
 * with a transient copy/aborted error before giving up. Returns how many were
 * moved and, if it stopped early, the error from the chunk that failed. Stops at
 * the first chunk that exhausts its retries so we don't keep hammering a folder
 * that is genuinely failing; the already-moved messages stay moved.
 */
async function moveInChunks(
  ids: number[],
  folderId: string,
  opts: MoveOptions = {},
): Promise<{ moved: number; error?: string }> {
  const chunkSize = opts.chunkSize ?? MOVE_CHUNK_SIZE;
  const retries = opts.retries ?? MOVE_CHUNK_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? MOVE_RETRY_DELAY_MS;

  let moved = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await messenger.messages.move(chunk, folderId as unknown as MoveFolderArg);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    if (lastError) return { moved, error: lastError.message };
    moved += chunk.length;
  }
  return { moved };
}

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
 * Fetch the body for a header-only summary and fill in its body excerpt and
 * interesting headers. Used by the triage-first pass to "escalate" only the
 * messages the model couldn't decide from headers alone.
 */
export async function hydrateBody(
  summary: MessageSummary,
  maxBodyChars: number,
): Promise<MessageSummary> {
  const full = (await messenger.messages.getFull(
    summary.id,
  )) as unknown as RawPart;
  return hydrateSummary(summary, full, maxBodyChars);
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
 * Map move-stable RFC Message-ID -> current numeric id for the requested
 * messages, by scanning the folder once. Used to recover a review restored from
 * a snapshot after a Thunderbird restart, where the stored numeric ids may be
 * stale (they no more survive a restart than a move does). Only ids still
 * present in the folder appear in the map; the rest were moved/deleted since.
 */
export async function resolveCurrentIds(
  folderId: string,
  headerMessageIds: string[],
): Promise<Map<string, number>> {
  const wanted = new Set(headerMessageIds);
  const found = new Map<string, number>();
  if (wanted.size === 0) return found;
  for await (const header of iterateFolderHeaders(folderId)) {
    const hmid = header.headerMessageId;
    if (hmid && wanted.has(hmid) && !found.has(hmid)) {
      found.set(hmid, header.id);
      if (found.size === wanted.size) break;
    }
  }
  return found;
}

/**
 * Reverse a previously-applied batch: for each moved message, re-locate it in
 * the folder it was moved into (by RFC Message-ID, since numeric ids don't
 * survive a move) and move it back to the original source folder. Reports any
 * message it could not find (moved/deleted since) or could not move.
 */
export async function moveBackByHeaderId(
  record: UndoRecord,
  opts: MoveOptions = {},
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
    // Chunk the move-back the same way as the forward move (see moveInChunks):
    // a single large move aborts on big folders.
    const { moved, error } = await moveInChunks(ids, record.sourceFolderId, opts);
    outcome.restored += moved;
    if (error) {
      // The move-back stopped early; attribute the failure to those messages.
      for (const headerMessageId of headerMessageIds) {
        outcome.failures.push({ headerMessageId, destFolderId, error });
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
  opts: MoveOptions = {},
): Promise<Array<{ folderId: string; moved: number; error?: string }>> {
  const results: Array<{ folderId: string; moved: number; error?: string }> = [];
  for (const [folderId, ids] of movesByFolderId) {
    if (!ids.length) continue;
    const { moved, error } = await moveInChunks(ids, folderId, opts);
    results.push(error ? { folderId, moved, error } : { folderId, moved });
  }
  return results;
}
