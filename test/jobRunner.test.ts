import { describe, expect, it, vi } from "vitest";
import {
  JobRunner,
  trimResultsForReview,
  type ClassifierContext,
  type Classifiers,
  type JobRunnerDeps,
  type MoveOutcome,
} from "../src/core/jobRunner.js";
import { toFolderIndex } from "../src/platform/folders.js";
import type { BgEvent } from "../src/core/protocol.js";
import type {
  ClassifiedMessage,
  Decision,
  FolderNode,
  JobCheckpoint,
  MessageSummary,
  ReviewSnapshot,
  Settings,
  UndoOutcome,
  UndoRecord,
} from "../src/core/types.js";

const SETTINGS: Settings = {
  baseUrl: "",
  apiKey: "",
  model: "m",
  temperature: 0,
  frequencyPenalty: 0,
  maxTokens: 0,
  timeoutMs: 1000,
  responseFormat: "auto",
  triageFirst: false,
  maxBodyChars: 100,
  concurrency: 1,
  batchSize: 1,
  maxRetries: 3,
  retryBaseMs: 500,
};

const FOLDERS: FolderNode[] = [
  { id: "src", path: "Acc/Inbox", depth: 1, accountName: "Acc" },
  { id: "fA", path: "Acc/Archive", depth: 1, accountName: "Acc" },
  { id: "fB", path: "Acc/Finance", depth: 1, accountName: "Acc" },
];

function summary(id: number): MessageSummary {
  return {
    id,
    headerMessageId: `<msg-${id}@example.com>`,
    author: `a${id}`,
    recipients: [],
    ccList: [],
    subject: `s${id}`,
    date: "",
    headers: {},
    bodyExcerpt: "",
  };
}

const move = (folder: string): Decision => ({
  action: "move",
  folder,
  reason: "r",
  confidence: 1,
});
const keep: Decision = { action: "keep", folder: null, reason: "r", confidence: 0 };

// Default decisions: 1 -> Archive, 2 -> keep, 3 -> Finance.
function defaultDecision(s: MessageSummary): Decision {
  if (s.id === 1) return move("Acc/Archive");
  if (s.id === 3) return move("Acc/Finance");
  return keep;
}

interface Harness {
  runner: JobRunner;
  events: BgEvent[];
  /** Phase snapshotted at each emit time (events hold a live state reference). */
  phaseLog: string[];
  capturedCtx: ClassifierContext | null;
  /** Message ids actually sent to the (LLM) classifier, to prove cache skips. */
  classifyCalls: number[];
  moveMessages: ReturnType<typeof vi.fn>;
  copyMessages: ReturnType<typeof vi.fn>;
  resolveCurrentIds: ReturnType<typeof vi.fn>;
  undoMoves: ReturnType<typeof vi.fn>;
  saveUndo: ReturnType<typeof vi.fn>;
  clearUndo: ReturnType<typeof vi.fn>;
  saveCheckpoint: ReturnType<typeof vi.fn>;
  clearCheckpoint: ReturnType<typeof vi.fn>;
  saveReview: ReturnType<typeof vi.fn>;
  clearReview: ReturnType<typeof vi.fn>;
  setKeepalive: ReturnType<typeof vi.fn>;
}

function makeRunner(
  overrides: Partial<JobRunnerDeps> = {},
  options: { checkpointEvery?: number } = {},
): Harness {
  const events: BgEvent[] = [];
  const phaseLog: string[] = [];
  const harness: Harness = {
    runner: null as unknown as JobRunner,
    events,
    phaseLog,
    capturedCtx: null,
    classifyCalls: [],
    moveMessages: vi.fn(async (): Promise<MoveOutcome[]> => []),
    copyMessages: vi.fn(async (): Promise<MoveOutcome[]> => []),
    resolveCurrentIds: vi.fn(async () => new Map<string, number>()),
    undoMoves: vi.fn(
      async (): Promise<UndoOutcome> => ({ restored: 0, failures: [] }),
    ),
    saveUndo: vi.fn(async () => {}),
    clearUndo: vi.fn(async () => {}),
    saveCheckpoint: vi.fn(async () => {}),
    clearCheckpoint: vi.fn(async () => {}),
    saveReview: vi.fn(async () => {}),
    clearReview: vi.fn(async () => {}),
    setKeepalive: vi.fn(),
  };

  const ids = [1, 2, 3];
  const deps: JobRunnerDeps = {
    loadSettings: async () => SETTINGS,
    listFolders: async () => FOLDERS,
    toFolderIndex,
    summarise: async function* () {
      for (const id of ids) yield summary(id);
    },
    summariseHeaders: async function* () {
      for (const id of ids) yield summary(id);
    },
    countMessages: async () => ids.length,
    createClassifiers: (ctx): Classifiers => {
      harness.capturedCtx = ctx;
      return {
        classify: async (s) => {
          harness.classifyCalls.push(s.id);
          return defaultDecision(s);
        },
        classifyBatch: async (ss) => {
          for (const s of ss) harness.classifyCalls.push(s.id);
          return ss.map(defaultDecision);
        },
      };
    },
    moveMessages: harness.moveMessages,
    copyMessages: harness.copyMessages,
    resolveCurrentIds: harness.resolveCurrentIds,
    undoMoves: harness.undoMoves,
    loadUndo: async () => null,
    saveUndo: harness.saveUndo,
    clearUndo: harness.clearUndo,
    loadCheckpoint: async () => null,
    saveCheckpoint: harness.saveCheckpoint,
    clearCheckpoint: harness.clearCheckpoint,
    loadReview: async () => null,
    saveReview: harness.saveReview,
    clearReview: harness.clearReview,
    setKeepalive: harness.setKeepalive,
    emit: (e) => {
      events.push(e);
      if (e.type === "state") phaseLog.push(e.state.phase);
    },
    ...overrides,
  };

  harness.runner = new JobRunner(deps, { checkpointEvery: 1, ...options });
  return harness;
}

/** Spin the microtask queue until `pred` holds (no timers used in fakes). */
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error("waitFor: condition never met");
}

describe("JobRunner.start", () => {
  it("runs idle -> classifying -> review and records results in source order", async () => {
    const h = makeRunner();
    const result = h.runner.start("src", "sort it");
    expect(result).toEqual({ ok: true });
    // Phase flips synchronously so a racing request is rejected.
    expect(h.runner.getState().phase).toBe("classifying");

    await waitFor(() => h.runner.getState().phase === "review");
    const state = h.runner.getState();
    expect(state.results.map((r) => r.summary.id)).toEqual([1, 2, 3]);
    expect(state.results[0].decision.action).toBe("move");
    expect(state.results[1].decision.action).toBe("keep");
    expect(state.error).toBeNull();
    expect(state.stopped).toBe(false);
  });

  it("rejects a second start while a job is running", async () => {
    const h = makeRunner();
    h.runner.start("src", "first");
    const second = h.runner.start("src", "second");
    expect(second).toEqual({ ok: false, error: "a job is already running" });
    await waitFor(() => h.runner.getState().phase === "review");
  });

  it("streams full summaries when triageFirst is off", async () => {
    const fullSource = vi.fn(async function* () {
      for (const id of [1, 2, 3]) yield summary(id);
    });
    const headerSource = vi.fn(async function* () {
      /* should not be called */
    });
    const h = makeRunner({
      loadSettings: async () => ({ ...SETTINGS, triageFirst: false }),
      summarise: fullSource,
      summariseHeaders: headerSource,
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(fullSource).toHaveBeenCalledTimes(1);
    expect(headerSource).not.toHaveBeenCalled();
  });

  it("streams header-only summaries when triageFirst is on", async () => {
    const fullSource = vi.fn(async function* () {
      /* should not be called */
    });
    const headerSource = vi.fn(async function* () {
      for (const id of [1, 2, 3]) yield summary(id);
    });
    const h = makeRunner({
      loadSettings: async () => ({ ...SETTINGS, triageFirst: true }),
      summarise: fullSource,
      summariseHeaders: headerSource,
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(headerSource).toHaveBeenCalledWith("src");
    expect(fullSource).not.toHaveBeenCalled();
    expect(h.runner.getState().results.map((r) => r.summary.id)).toEqual([1, 2, 3]);
  });

  it("excludes the source folder from targets and allowed paths", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.capturedCtx?.targets.map((t) => t.id)).toEqual(["fA", "fB"]);
    expect(h.capturedCtx?.allowedPaths.has("Acc/Inbox")).toBe(false);
    expect(h.capturedCtx?.allowedPaths.has("Acc/Archive")).toBe(true);
  });

  it("limits targets to folders in the source folder's account", async () => {
    const crossAccount: FolderNode[] = [
      ...FOLDERS,
      { id: "other", path: "Other/Archive", depth: 1, accountName: "Other" },
    ];
    const h = makeRunner({ listFolders: async () => crossAccount });
    h.runner.start("src", "x"); // src is in account "Acc"
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.capturedCtx?.targets.map((t) => t.id)).toEqual(["fA", "fB"]);
    expect(h.capturedCtx?.allowedPaths.has("Other/Archive")).toBe(false);
  });

  it("includes other accounts when the run opts into cross-account", async () => {
    const crossAccount: FolderNode[] = [
      ...FOLDERS,
      { id: "other", path: "Other/Archive", depth: 1, accountName: "Other" },
    ];
    const h = makeRunner({ listFolders: async () => crossAccount });
    h.runner.start("src", "x", true); // per-run opt-in
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.capturedCtx?.targets.map((t) => t.id)).toEqual(["fA", "fB", "other"]);
    expect(h.capturedCtx?.allowedPaths.has("Other/Archive")).toBe(true);
  });

  it("records the cross-account choice in the checkpoint for resume", async () => {
    const h = makeRunner();
    h.runner.start("src", "x", true);
    await waitFor(() => h.runner.getState().phase === "review");
    const cp = h.saveCheckpoint.mock.calls.at(-1)![0] as JobCheckpoint;
    expect(cp.allowCrossAccount).toBe(true);
  });

  it("emits a state event for the classifying and review transitions", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    // Wait for the settled (emitted) review state, not the early phase flip:
    // the run finishes settling (checkpoint/review persistence, keepalive off)
    // in a `finally` that emits last.
    await waitFor(() => h.phaseLog.at(-1) === "review");
    expect(h.phaseLog[0]).toBe("classifying");
    expect(h.phaseLog.at(-1)).toBe("review");
    expect(h.events.some((e) => e.type === "progress")).toBe(true);
  });

  it("counts the folder up front and surfaces the total in progress", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.phaseLog.at(-1) === "review");
    const totals = h.events
      .filter(
        (e): e is Extract<BgEvent, { type: "progress" }> => e.type === "progress",
      )
      .map((e) => e.progress.total);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((t) => t === 3)).toBe(true);
  });

  it("runs without a total when the folder count fails", async () => {
    const h = makeRunner({
      countMessages: async () => {
        throw new Error("count boom");
      },
    });
    h.runner.start("src", "x");
    await waitFor(() => h.phaseLog.at(-1) === "review");
    // Classification still completes; progress just carries a null total.
    expect(h.runner.getState().results).toHaveLength(3);
    const totals = h.events
      .filter(
        (e): e is Extract<BgEvent, { type: "progress" }> => e.type === "progress",
      )
      .map((e) => e.progress.total);
    expect(totals.every((t) => t === null)).toBe(true);
  });

  it("captures a settings/folder load failure as an error and returns to idle", async () => {
    const h = makeRunner({
      listFolders: async () => {
        throw new Error("folders boom");
      },
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().error !== null);
    expect(h.runner.getState().phase).toBe("idle");
    expect(h.runner.getState().error).toBe("folders boom");
  });

  it("forwards a classifier retry notice as a notice event", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    h.capturedCtx?.onRetry({ kind: "retry", message: "retrying…" });
    expect(
      h.events.some((e) => e.type === "notice" && e.notice.message === "retrying…"),
    ).toBe(true);
  });

  it("marks the run stopped when aborted mid-classification", async () => {
    const h = makeRunner({
      createClassifiers: () => ({
        classify: async (s) => {
          if (s.id === 1) h.runner.abort();
          return defaultDecision(s);
        },
        classifyBatch: async (ss) => ss.map(defaultDecision),
      }),
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.runner.getState().stopped).toBe(true);
    expect(h.runner.getState().results.length).toBeLessThan(3);
  });
});

describe("JobRunner.apply", () => {
  async function toReview(overrides?: Partial<JobRunnerDeps>): Promise<Harness> {
    const h = makeRunner(overrides);
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    return h;
  }

  it("rejects apply unless in review", () => {
    const h = makeRunner();
    expect(h.runner.apply([1])).toEqual({ ok: false, error: "no results to apply" });
  });

  it("groups selected moves by destination folder id and ends in done", async () => {
    const h = await toReview();
    const res = h.runner.apply([1, 3]);
    expect(res).toEqual({ ok: true });
    await waitFor(() => h.runner.getState().phase === "done");

    expect(h.moveMessages).toHaveBeenCalledTimes(1);
    const byFolderId = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(byFolderId.get("fA")).toEqual([1]);
    expect(byFolderId.get("fB")).toEqual([3]);
    expect(h.runner.getState().error).toBeNull();
  });

  it("omits deselected and keep decisions from the move groups", async () => {
    const h = await toReview();
    h.runner.apply([1]); // 3 deselected, 2 is a keep
    await waitFor(() => h.runner.getState().phase === "done");
    const byFolderId = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(byFolderId.get("fA")).toEqual([1]);
    expect(byFolderId.has("fB")).toBe(false);
  });

  it("surfaces partial move failures but still reaches done", async () => {
    const h = await toReview({
      moveMessages: vi.fn(async () => [
        { folderId: "fA", moved: 1 },
        { folderId: "fB", moved: 0, error: "locked" },
      ]),
    });
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");
    expect(h.runner.getState().error).toContain("fB: locked");
  });

  it("returns to review when the move call throws", async () => {
    const h = await toReview({
      moveMessages: vi.fn(async () => {
        throw new Error("move boom");
      }),
    });
    h.runner.apply([1]);
    await waitFor(() => h.runner.getState().error !== null);
    expect(h.runner.getState().phase).toBe("review");
    expect(h.runner.getState().error).toBe("move boom");
  });

  it("records and persists an undo record for the moved messages", async () => {
    const h = await toReview();
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");

    expect(h.runner.getState().undo).toEqual({ count: 2, copied: 0 });
    expect(h.saveUndo).toHaveBeenCalledTimes(1);
    const record = h.saveUndo.mock.calls[0][0] as UndoRecord;
    expect(record.sourceFolderId).toBe("src");
    expect(record.items).toEqual([
      { headerMessageId: "<msg-1@example.com>", destFolderId: "fA", kind: "move" },
      { headerMessageId: "<msg-3@example.com>", destFolderId: "fB", kind: "move" },
    ]);
  });

  it("excludes messages in a failed destination from the undo record", async () => {
    const h = await toReview({
      moveMessages: vi.fn(async () => [
        { folderId: "fA", moved: 1 },
        { folderId: "fB", moved: 0, error: "locked" },
      ]),
    });
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");
    const record = h.saveUndo.mock.calls[0][0] as UndoRecord;
    expect(record.items).toEqual([
      { headerMessageId: "<msg-1@example.com>", destFolderId: "fA", kind: "move" },
    ]);
  });

  it("clears the undo record when nothing was moved", async () => {
    const h = await toReview();
    h.runner.apply([2]); // 2 is a keep -> no moves
    await waitFor(() => h.runner.getState().phase === "done");
    expect(h.runner.getState().undo).toBeNull();
    expect(h.clearUndo).toHaveBeenCalled();
    expect(h.saveUndo).not.toHaveBeenCalled();
  });

  // A folder set with a destination in a DIFFERENT account ("xArc"), plus a
  // classifier that decides id 1 -> that cross-account folder and id 3 -> same.
  const crossAccount = (): Partial<JobRunnerDeps> => ({
    listFolders: async () => [
      ...FOLDERS,
      { id: "xArc", path: "Other/Archive", depth: 1, accountName: "Other" },
    ],
    createClassifiers: (): Classifiers => {
      const decide = (s: MessageSummary): Decision =>
        s.id === 1 ? move("Other/Archive") : s.id === 3 ? move("Acc/Finance") : keep;
      return {
        classify: async (s) => decide(s),
        classifyBatch: async (ss) => ss.map(decide),
      };
    },
  });

  it("copies cross-account destinations and moves same-account ones by default", async () => {
    const h = await toReview(crossAccount());
    h.runner.apply([1, 3]); // keepOriginalCrossAccount defaults to true
    await waitFor(() => h.runner.getState().phase === "done");

    // Same-account (id 3 -> fB) moved; cross-account (id 1 -> xArc) copied.
    const moved = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(moved.get("fB")).toEqual([3]);
    expect(moved.has("xArc")).toBe(false);
    const copied = h.copyMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(copied.get("xArc")).toEqual([1]);
    expect(copied.has("fB")).toBe(false);

    // Undo record tags each item with how it was applied; state reports copies.
    expect(h.runner.getState().undo).toEqual({ count: 2, copied: 1 });
    const record = h.saveUndo.mock.calls[0][0] as UndoRecord;
    expect(record.items).toEqual([
      { headerMessageId: "<msg-1@example.com>", destFolderId: "xArc", kind: "copy" },
      { headerMessageId: "<msg-3@example.com>", destFolderId: "fB", kind: "move" },
    ]);
  });

  it("moves cross-account destinations when keep-original is off", async () => {
    const h = await toReview(crossAccount());
    h.runner.apply([1, 3], false);
    await waitFor(() => h.runner.getState().phase === "done");

    const moved = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(moved.get("xArc")).toEqual([1]);
    expect(moved.get("fB")).toEqual([3]);
    // Nothing copied; copyMessages is called with an empty group.
    const copied = h.copyMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(copied.size).toBe(0);
    expect(h.runner.getState().undo).toEqual({ count: 2, copied: 0 });
  });
});

describe("JobRunner.undo", () => {
  async function toDone(overrides?: Partial<JobRunnerDeps>): Promise<Harness> {
    const h = makeRunner(overrides);
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");
    return h;
  }

  it("rejects undo when there is nothing to undo", () => {
    const h = makeRunner();
    expect(h.runner.undo()).toEqual({ ok: false, error: "nothing to undo" });
  });

  it("reverses the last apply, clears the record, and returns to idle", async () => {
    const h = await toDone();
    h.undoMoves.mockResolvedValue({ restored: 2, failures: [] });
    const res = h.runner.undo();
    expect(res).toEqual({ ok: true });
    await waitFor(() => h.runner.getState().phase === "idle");

    expect(h.undoMoves).toHaveBeenCalledTimes(1);
    const record = h.undoMoves.mock.calls[0][0] as UndoRecord;
    expect(record.items).toHaveLength(2);
    expect(h.runner.getState().undo).toBeNull();
    expect(h.clearUndo).toHaveBeenCalled();
    expect(h.runner.getState().error).toBeNull();
  });

  it("reports partial undo failures", async () => {
    const h = await toDone();
    h.undoMoves.mockResolvedValue({
      restored: 1,
      failures: [{ headerMessageId: "<msg-3@example.com>", destFolderId: "fB", error: "gone" }],
    });
    h.runner.undo();
    await waitFor(() => h.runner.getState().phase === "idle");
    expect(h.runner.getState().error).toContain("restored 1");
    expect(h.runner.getState().undo).toBeNull();
  });

  it("loads a persisted undo record on init", async () => {
    const record: UndoRecord = {
      sourceFolderId: "src",
      items: [{ headerMessageId: "<m@x>", destFolderId: "fA" }],
    };
    const h = makeRunner({ loadUndo: async () => record });
    await h.runner.init();
    // A legacy record (items without `kind`) reports zero copies.
    expect(h.runner.getState().undo).toEqual({ count: 1, copied: 0 });
    // And it can be reversed after a restart, with no prior in-session apply.
    h.runner.undo();
    await waitFor(() => h.runner.getState().phase === "idle");
    expect(h.undoMoves).toHaveBeenCalledWith(record);
  });

  it("clears the undo record when a new job starts", async () => {
    const h = await toDone();
    expect(h.runner.getState().undo).not.toBeNull();
    h.runner.start("src", "again");
    expect(h.runner.getState().undo).toBeNull();
    expect(h.clearUndo).toHaveBeenCalled();
    await waitFor(() => h.runner.getState().phase === "review");
  });
});

describe("JobRunner checkpoint + resume", () => {
  it("toggles the keepalive around a run and persists a checkpoint", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    // Keepalive is turned off in the run's `finally`, which emits the review
    // state last — wait for that emit rather than the early phase flip.
    await waitFor(() => h.phaseLog.at(-1) === "review");

    expect(h.setKeepalive).toHaveBeenNthCalledWith(1, true);
    expect(h.setKeepalive).toHaveBeenLastCalledWith(false);
    // checkpointEvery:1 -> a write per decided message during the run.
    expect(h.saveCheckpoint).toHaveBeenCalled();
    const cp = h.saveCheckpoint.mock.calls.at(-1)![0] as JobCheckpoint;
    expect(cp.sourceFolderId).toBe("src");
    expect(cp.decisions.map((d) => d.headerMessageId)).toContain(
      "<msg-1@example.com>",
    );
  });

  it("clears the checkpoint once classification completes", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.clearCheckpoint).toHaveBeenCalled();
    expect(h.runner.getState().resumable).toBeNull();
  });

  it("does not checkpoint errored messages", async () => {
    const h = makeRunner({
      createClassifiers: (ctx) => {
        h.capturedCtx = ctx;
        return {
          classify: async (s) => {
            if (s.id === 1) throw new Error("boom");
            return defaultDecision(s);
          },
          classifyBatch: async (ss) => ss.map(defaultDecision),
        };
      },
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    const everyDecision = h.saveCheckpoint.mock.calls.flatMap(
      (c) => (c[0] as JobCheckpoint).decisions,
    );
    expect(everyDecision.some((d) => d.headerMessageId === "<msg-1@example.com>")).toBe(
      false,
    );
  });

  it("keeps a checkpoint and offers resume when a run is interrupted", async () => {
    // Source throws after yielding the first message: progress, then failure.
    const h = makeRunner({
      summarise: async function* () {
        yield summary(1);
        throw new Error("suspended");
      },
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "idle");
    expect(h.runner.getState().resumable).toMatchObject({ sourceFolderId: "src" });
    expect(h.saveCheckpoint).toHaveBeenCalled();
    // Only the start-time stale-clear; the interruption itself keeps the record.
    expect(h.clearCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("loads a checkpoint on init and exposes it as resumable", async () => {
    const checkpoint: JobCheckpoint = {
      sourceFolderId: "src",
      instruction: "sort it",
      decisions: [
        { headerMessageId: "<msg-1@example.com>", decision: move("Acc/Archive") },
      ],
    };
    const h = makeRunner({ loadCheckpoint: async () => checkpoint });
    await h.runner.init();
    expect(h.runner.getState().resumable).toEqual({
      sourceFolderId: "src",
      instruction: "sort it",
      count: 1,
    });
  });

  it("resume skips the LLM for already-decided messages", async () => {
    const checkpoint: JobCheckpoint = {
      sourceFolderId: "src",
      instruction: "sort it",
      decisions: [
        { headerMessageId: "<msg-1@example.com>", decision: move("Acc/Archive") },
      ],
    };
    const h = makeRunner({ loadCheckpoint: async () => checkpoint });
    await h.runner.init();
    expect(h.runner.resume()).toEqual({ ok: true });
    await waitFor(() => h.runner.getState().phase === "review");

    // msg 1 was cached -> not re-sent to the classifier; 2 and 3 were.
    expect(h.classifyCalls).not.toContain(1);
    expect(h.classifyCalls).toEqual(expect.arrayContaining([2, 3]));
    // The full result set still covers all three, in source order.
    expect(h.runner.getState().results.map((r) => r.summary.id)).toEqual([1, 2, 3]);
    expect(h.runner.getState().results[0].decision.action).toBe("move");
  });

  it("rejects resume when there is nothing to resume", () => {
    const h = makeRunner();
    expect(h.runner.resume()).toEqual({ ok: false, error: "nothing to resume" });
  });

  it("discards a resumable checkpoint", async () => {
    const checkpoint: JobCheckpoint = {
      sourceFolderId: "src",
      instruction: "sort it",
      decisions: [
        { headerMessageId: "<msg-1@example.com>", decision: move("Acc/Archive") },
      ],
    };
    const h = makeRunner({ loadCheckpoint: async () => checkpoint });
    await h.runner.init();
    expect(h.runner.discardResume()).toEqual({ ok: true });
    expect(h.runner.getState().resumable).toBeNull();
    expect(h.clearCheckpoint).toHaveBeenCalled();
  });

  it("clears any stale checkpoint when a fresh job starts", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.clearCheckpoint).toHaveBeenCalled();
  });
});

describe("JobRunner review snapshot", () => {
  it("persists a review snapshot when classification completes", async () => {
    const h = makeRunner();
    h.runner.start("src", "sort it");
    await waitFor(() => h.saveReview.mock.calls.length > 0);

    expect(h.saveReview).toHaveBeenCalled();
    const snap = h.saveReview.mock.calls.at(-1)![0] as ReviewSnapshot;
    expect(snap.sourceFolderId).toBe("src");
    expect(snap.instruction).toBe("sort it");
    expect(snap.stopped).toBe(false);
    expect(snap.results.map((r) => r.summary.id)).toEqual([1, 2, 3]);
  });

  it("restores the review phase from a snapshot on init", async () => {
    const snapshot: ReviewSnapshot = {
      sourceFolderId: "src",
      instruction: "sort it",
      stopped: false,
      results: [{ summary: summary(1), decision: move("Acc/Archive") }],
    };
    const h = makeRunner({ loadReview: async () => snapshot });
    await h.runner.init();
    const state = h.runner.getState();
    expect(state.phase).toBe("review");
    expect(state.instruction).toBe("sort it");
    expect(state.results.map((r) => r.summary.id)).toEqual([1]);
    expect(state.resumable).toBeNull();
  });

  it("prefers a review snapshot over a resume checkpoint on init", async () => {
    const snapshot: ReviewSnapshot = {
      sourceFolderId: "src",
      instruction: "review me",
      stopped: false,
      results: [{ summary: summary(1), decision: move("Acc/Archive") }],
    };
    const checkpoint: JobCheckpoint = {
      sourceFolderId: "src",
      instruction: "resume me",
      decisions: [
        { headerMessageId: "<msg-1@example.com>", decision: move("Acc/Archive") },
      ],
    };
    const h = makeRunner({
      loadReview: async () => snapshot,
      loadCheckpoint: async () => checkpoint,
    });
    await h.runner.init();
    expect(h.runner.getState().phase).toBe("review");
    expect(h.runner.getState().resumable).toBeNull();
  });

  it("clears the review snapshot once an apply completes", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");
    expect(h.clearReview).toHaveBeenCalled();
  });

  it("keeps the review snapshot when an apply fails back to review", async () => {
    const h = makeRunner({
      moveMessages: vi.fn(async () => {
        throw new Error("move boom");
      }),
    });
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    h.clearReview.mockClear();
    h.runner.apply([1]);
    await waitFor(() => h.runner.getState().error !== null);
    expect(h.runner.getState().phase).toBe("review");
    expect(h.clearReview).not.toHaveBeenCalled();
  });

  it("clears the review snapshot when a fresh job starts", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    expect(h.clearReview).toHaveBeenCalled();
    await waitFor(() => h.runner.getState().phase === "review");
  });
});

describe("JobRunner apply after restart", () => {
  function restoredReview(): Harness {
    const snapshot: ReviewSnapshot = {
      sourceFolderId: "src",
      instruction: "x",
      stopped: false,
      results: [
        { summary: summary(1), decision: move("Acc/Archive") },
        { summary: summary(3), decision: move("Acc/Finance") },
      ],
    };
    return makeRunner({ loadReview: async () => snapshot });
  }

  it("does not re-resolve ids for a live (same-session) review", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");

    expect(h.resolveCurrentIds).not.toHaveBeenCalled();
    const byFolderId = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(byFolderId.get("fA")).toEqual([1]); // stored id used as-is
    expect(byFolderId.get("fB")).toEqual([3]);
  });

  it("re-resolves stale ids by Message-ID when applying a restored review", async () => {
    const h = restoredReview();
    h.resolveCurrentIds.mockResolvedValue(
      new Map([
        ["<msg-1@example.com>", 101],
        ["<msg-3@example.com>", 103],
      ]),
    );
    await h.runner.init();
    expect(h.runner.getState().phase).toBe("review");

    h.runner.apply([1, 3]); // UI selects the snapshot's (stale) stored ids
    await waitFor(() => h.runner.getState().phase === "done");

    // The source folder was scanned for exactly the selected messages' Msg-IDs.
    expect(h.resolveCurrentIds).toHaveBeenCalledWith("src", [
      "<msg-1@example.com>",
      "<msg-3@example.com>",
    ]);
    // The move used the freshly-resolved ids, not the stale stored ones.
    const byFolderId = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(byFolderId.get("fA")).toEqual([101]);
    expect(byFolderId.get("fB")).toEqual([103]);
    // Undo still keys off the move-stable Message-ID.
    const record = h.saveUndo.mock.calls[0][0] as UndoRecord;
    expect(record.items.map((i) => i.headerMessageId)).toEqual([
      "<msg-1@example.com>",
      "<msg-3@example.com>",
    ]);
  });

  it("skips messages that no longer resolve and reports them", async () => {
    const h = restoredReview();
    // Only msg-1 still exists; msg-3 was moved/deleted since the restart.
    h.resolveCurrentIds.mockResolvedValue(new Map([["<msg-1@example.com>", 101]]));
    await h.runner.init();
    h.runner.apply([1, 3]);
    await waitFor(() => h.runner.getState().phase === "done");

    const byFolderId = h.moveMessages.mock.calls[0][0] as Map<string, number[]>;
    expect(byFolderId.get("fA")).toEqual([101]);
    expect(byFolderId.has("fB")).toBe(false); // msg-3 skipped
    expect(h.runner.getState().error).toContain("1 message(s) were not found");
    // The skipped message is not in the undo record.
    const record = h.saveUndo.mock.calls[0][0] as UndoRecord;
    expect(record.items.map((i) => i.headerMessageId)).toEqual([
      "<msg-1@example.com>",
    ]);
  });
});

describe("trimResultsForReview", () => {
  it("drops body/headers/recipients but keeps the review-facing fields", () => {
    const fat: ClassifiedMessage[] = [
      {
        summary: {
          ...summary(1),
          recipients: ["r@x"],
          ccList: ["c@x"],
          headers: { "X-Spam": "no" },
          bodyExcerpt: "a very long body".repeat(500),
        },
        decision: move("Acc/Archive"),
      },
    ];
    const trimmed = trimResultsForReview(fat);
    expect(trimmed[0].summary.bodyExcerpt).toBe("");
    expect(trimmed[0].summary.headers).toEqual({});
    expect(trimmed[0].summary.recipients).toEqual([]);
    expect(trimmed[0].summary.ccList).toEqual([]);
    // Fields the review UI, apply, and report still read are preserved.
    expect(trimmed[0].summary.id).toBe(1);
    expect(trimmed[0].summary.subject).toBe("s1");
    expect(trimmed[0].summary.author).toBe("a1");
    expect(trimmed[0].summary.headerMessageId).toBe("<msg-1@example.com>");
    expect(trimmed[0].decision.action).toBe("move");
    // Pure: the input is not mutated.
    expect(fat[0].summary.bodyExcerpt.length).toBeGreaterThan(0);
  });
});
