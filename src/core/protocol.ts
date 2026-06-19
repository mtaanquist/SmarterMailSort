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
  | { type: "applyMoves"; messageIds: number[] }
  | { type: "undo" }
  | { type: "resume" }
  | { type: "discardResume" };

/** Phase of the background job state machine. */
export type JobPhase = "idle" | "classifying" | "review" | "applying" | "done";

/** Lightweight, UI-facing view of the available "undo last apply". */
export interface UndoSummary {
  /** Number of messages that can be moved back. */
  count: number;
}

/** UI-facing view of an interrupted run that can be resumed. */
export interface ResumableSummary {
  sourceFolderId: string;
  instruction: string;
  /** How many messages had already been classified before interruption. */
  count: number;
}

/** Snapshot of the current job the UI renders. */
export interface JobState {
  phase: JobPhase;
  sourceFolderId: string | null;
  instruction: string;
  progress: ClassifyProgress | null;
  results: ClassifiedMessage[];
  error: string | null;
  /** True when the last classification run was stopped early by the user. */
  stopped: boolean;
  /** Present when the most recent apply can be undone; else null. */
  undo: UndoSummary | null;
  /** Present when an interrupted run is available to resume; else null. */
  resumable: ResumableSummary | null;
}

/** A transient, non-state message surfaced to the UI (e.g. a retry notice). */
export interface JobNotice {
  kind: "retry";
  message: string;
}

/** Push events the background sends to a connected UI port. */
export type BgEvent =
  | { type: "state"; state: JobState }
  | { type: "progress"; progress: ClassifyProgress }
  | { type: "notice"; notice: JobNotice };

export const PORT_NAME = "smartermailsort";

/** Responses to one-shot UiRequests handled via runtime.sendMessage. */
export type UiResponse =
  | { ok: true; settings: Settings }
  | { ok: true; folders: FolderNode[] }
  | { ok: true; models: string[] }
  | { ok: true; state: JobState }
  | { ok: true }
  | { ok: false; error: string };
