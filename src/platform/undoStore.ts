// Persistence for the "undo last apply" record via storage.local, so the
// option to reverse the most recent batch survives an event-page suspension.
// Kept separate from settings so clearing one never disturbs the other.

import type { UndoRecord } from "../core/types.js";

const KEY = "lastApplyUndo";

export async function loadUndo(): Promise<UndoRecord | null> {
  const stored = await messenger.storage.local.get(KEY);
  return (stored[KEY] as UndoRecord | undefined) ?? null;
}

export async function saveUndo(record: UndoRecord): Promise<void> {
  await messenger.storage.local.set({ [KEY]: record });
}

export async function clearUndo(): Promise<void> {
  await messenger.storage.local.remove(KEY);
}
