// Persistence for an in-progress classification checkpoint via storage.local,
// so a run interrupted by event-page suspension or a restart can resume. Kept
// separate from settings and the undo record so each clears independently.

import type { JobCheckpoint } from "../core/types.js";

const KEY = "jobCheckpoint";

export async function loadCheckpoint(): Promise<JobCheckpoint | null> {
  const stored = await messenger.storage.local.get(KEY);
  return (stored[KEY] as JobCheckpoint | undefined) ?? null;
}

export async function saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
  await messenger.storage.local.set({ [KEY]: checkpoint });
}

export async function clearCheckpoint(): Promise<void> {
  await messenger.storage.local.remove(KEY);
}
