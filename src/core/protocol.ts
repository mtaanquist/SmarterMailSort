// Message contract between the UI pages and the background event page. Kept in
// core/ (pure types only) so both sides import the same definitions.

import type {
  ClassifiedMessage,
  ClassifyProgress,
  FolderNode,
  Settings,
} from "./types.js";

/** Requests sent from a UI page to the background. */
export type UiRequest =
  | { type: "getSettings" }
  | { type: "saveSettings"; settings: Settings }
  | { type: "testConnection"; settings: Settings }
  | { type: "listFolders" }
  | { type: "startClassify"; sourceFolderId: string; instruction: string }
  | { type: "abort" }
  | { type: "getState" }
  | { type: "applyMoves"; messageIds: number[] };

/** Phase of the background job state machine. */
export type JobPhase = "idle" | "classifying" | "review" | "applying" | "done";

/** Snapshot of the current job the UI renders. */
export interface JobState {
  phase: JobPhase;
  sourceFolderId: string | null;
  instruction: string;
  progress: ClassifyProgress | null;
  results: ClassifiedMessage[];
  error: string | null;
}

/** Push events the background sends to a connected UI port. */
export type BgEvent =
  | { type: "state"; state: JobState }
  | { type: "progress"; progress: ClassifyProgress };

export const PORT_NAME = "smartermailsort";

/** Responses to one-shot UiRequests handled via runtime.sendMessage. */
export type UiResponse =
  | { ok: true; settings: Settings }
  | { ok: true; folders: FolderNode[] }
  | { ok: true; models: string[] }
  | { ok: true; state: JobState }
  | { ok: true }
  | { ok: false; error: string };
