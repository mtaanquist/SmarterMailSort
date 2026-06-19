// Persistence for the proposed-moves snapshot awaiting review, via storage.local.
// Kept separate from the in-progress checkpoint (which it supersedes once
// classification finishes) and the undo record so each clears independently. The
// snapshot is what lets the review phase survive an event-page suspension.

import type { ReviewSnapshot } from "../core/types.js";

const KEY = "jobReview";

export async function loadReview(): Promise<ReviewSnapshot | null> {
  const stored = await messenger.storage.local.get(KEY);
  return (stored[KEY] as ReviewSnapshot | undefined) ?? null;
}

export async function saveReview(snapshot: ReviewSnapshot): Promise<void> {
  await messenger.storage.local.set({ [KEY]: snapshot });
}

export async function clearReview(): Promise<void> {
  await messenger.storage.local.remove(KEY);
}
