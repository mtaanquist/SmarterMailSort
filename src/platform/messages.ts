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
 * Run a chunked, sequential transfer of `ids`, retrying a chunk that fails with
 * a transient copy/aborted error before giving up. `run` performs one chunk
 * (move, copy, or delete). Returns how many ids were handled and, if it stopped
 * early, the error from the chunk that failed. Stops at the first chunk that
 * exhausts its retries so we don't keep hammering a folder that is genuinely
 * failing; the already-handled messages stay handled.
 */
async function runChunked(
  ids: number[],
  run: (chunk: number[]) => Promise<unknown>,
  opts: MoveOptions = {},
): Promise<{ done: number; error?: string }> {
  const chunkSize = opts.chunkSize ?? MOVE_CHUNK_SIZE;
  const retries = opts.retries ?? MOVE_CHUNK_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? MOVE_RETRY_DELAY_MS;

  let done = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await run(chunk);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    if (lastError) return { done, error: lastError.message };
    done += chunk.length;
  }
  return { done };
}

/** Chunked move of `ids` into `folderId`. */
const moveInChunks = (ids: number[], folderId: string, opts: MoveOptions = {}) =>
  runChunked(
    ids,
    (chunk) => messenger.messages.move(chunk, folderId as unknown as MoveFolderArg),
    opts,
  );

/** Chunked copy of `ids` into `folderId` (originals stay put). */
const copyInChunks = (ids: number[], folderId: string, opts: MoveOptions = {}) =>
  runChunked(
    ids,
    (chunk) => messenger.messages.copy(chunk, folderId as unknown as MoveFolderArg),
    opts,
  );

/** Chunked delete of `ids` (moved to the trash, not erased permanently). */
const deleteInChunks = (ids: number[], opts: MoveOptions = {}) =>
  runChunked(ids, (chunk) => messenger.messages.delete(chunk), opts);

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
 * Resolve a destination folder's undo items to current numeric ids by RFC
 * Message-ID (numeric ids don't survive a move), recording a failure for any
 * that can no longer be found or that error during lookup.
 */
async function resolveUndoIds(
  destFolderId: string,
  headerMessageIds: string[],
  outcome: UndoOutcome,
): Promise<number[]> {
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
  return ids;
}

/**
 * Reverse a previously-applied batch. Each item carries how it was applied:
 * - `move` (default): the message was moved into `destFolderId`, so undo
 *   re-locates it there (by RFC Message-ID) and moves it back to the source.
 * - `copy`: the original stayed in the source and a copy was placed in
 *   `destFolderId` (a cross-account keep-original apply), so undo deletes that
 *   copy (to the trash) rather than moving anything back, which would duplicate.
 * Reports any message it could not find (moved/deleted since) or could not act on.
 */
export async function moveBackByHeaderId(
  record: UndoRecord,
  opts: MoveOptions = {},
): Promise<UndoOutcome> {
  // Group by destination folder, splitting each into move-backs vs copy-deletes
  // so a folder's reversible ids are acted on in one chunked pass per kind.
  const byDest = new Map<string, { move: string[]; copy: string[] }>();
  for (const item of record.items) {
    const group = byDest.get(item.destFolderId) ?? { move: [], copy: [] };
    (item.kind === "copy" ? group.copy : group.move).push(item.headerMessageId);
    byDest.set(item.destFolderId, group);
  }

  const outcome: UndoOutcome = { restored: 0, failures: [] };
  for (const [destFolderId, group] of byDest) {
    // Move-backs: relocate the moved messages to the original source folder.
    if (group.move.length) {
      const ids = await resolveUndoIds(destFolderId, group.move, outcome);
      if (ids.length) {
        const { done, error } = await moveInChunks(ids, record.sourceFolderId, opts);
        outcome.restored += done;
        if (error)
          for (const headerMessageId of group.move)
            outcome.failures.push({ headerMessageId, destFolderId, error });
      }
    }
    // Copy-deletes: remove the cross-account copies left in the destination.
    if (group.copy.length) {
      const ids = await resolveUndoIds(destFolderId, group.copy, outcome);
      if (ids.length) {
        const { done, error } = await deleteInChunks(ids, opts);
        outcome.restored += done;
        if (error)
          for (const headerMessageId of group.copy)
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
    const { done, error } = await moveInChunks(ids, folderId, opts);
    results.push(error ? { folderId, moved: done, error } : { folderId, moved: done });
  }
  return results;
}

/**
 * Copy messages grouped by destination folder id, leaving the originals in
 * place. Used for cross-account "keep original" applies. Same shape as
 * `moveBatched` so the caller can report partial failures identically.
 */
export async function copyBatched(
  copiesByFolderId: Map<string, number[]>,
  opts: MoveOptions = {},
): Promise<Array<{ folderId: string; moved: number; error?: string }>> {
  const results: Array<{ folderId: string; moved: number; error?: string }> = [];
  for (const [folderId, ids] of copiesByFolderId) {
    if (!ids.length) continue;
    const { done, error } = await copyInChunks(ids, folderId, opts);
    results.push(error ? { folderId, moved: done, error } : { folderId, moved: done });
  }
  return results;
}
