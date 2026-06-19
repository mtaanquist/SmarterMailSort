import { describe, expect, it, vi } from "vitest";
import {
  JobRunner,
  type ClassifierContext,
  type Classifiers,
  type JobRunnerDeps,
  type MoveOutcome,
} from "../src/core/jobRunner.js";
import { toFolderIndex } from "../src/platform/folders.js";
import type { BgEvent } from "../src/core/protocol.js";
import type {
  Decision,
  FolderNode,
  MessageSummary,
  Settings,
} from "../src/core/types.js";

const SETTINGS: Settings = {
  baseUrl: "",
  apiKey: "",
  model: "m",
  temperature: 0,
  timeoutMs: 1000,
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
  moveMessages: ReturnType<typeof vi.fn>;
}

function makeRunner(overrides: Partial<JobRunnerDeps> = {}): Harness {
  const events: BgEvent[] = [];
  const phaseLog: string[] = [];
  const harness: Harness = {
    runner: null as unknown as JobRunner,
    events,
    phaseLog,
    capturedCtx: null,
    moveMessages: vi.fn(async (): Promise<MoveOutcome[]> => []),
  };

  const ids = [1, 2, 3];
  const deps: JobRunnerDeps = {
    loadSettings: async () => SETTINGS,
    listFolders: async () => FOLDERS,
    toFolderIndex,
    summarise: async function* () {
      for (const id of ids) yield summary(id);
    },
    createClassifiers: (ctx): Classifiers => {
      harness.capturedCtx = ctx;
      return {
        classify: async (s) => defaultDecision(s),
        classifyBatch: async (ss) => ss.map(defaultDecision),
      };
    },
    moveMessages: harness.moveMessages,
    emit: (e) => {
      events.push(e);
      if (e.type === "state") phaseLog.push(e.state.phase);
    },
    ...overrides,
  };

  harness.runner = new JobRunner(deps);
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

  it("excludes the source folder from targets and allowed paths", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.capturedCtx?.targets.map((t) => t.id)).toEqual(["fA", "fB"]);
    expect(h.capturedCtx?.allowedPaths.has("Acc/Inbox")).toBe(false);
    expect(h.capturedCtx?.allowedPaths.has("Acc/Archive")).toBe(true);
  });

  it("emits a state event for the classifying and review transitions", async () => {
    const h = makeRunner();
    h.runner.start("src", "x");
    await waitFor(() => h.runner.getState().phase === "review");
    expect(h.phaseLog[0]).toBe("classifying");
    expect(h.phaseLog.at(-1)).toBe("review");
    expect(h.events.some((e) => e.type === "progress")).toBe(true);
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
});
