// Owns the job lifecycle: the classify -> review -> apply state machine, abort,
// and progress/state emission. Decoupled from `messenger.*` and the LLM by
// injected dependencies (mirroring how `classifier.ts` takes an injected
// `classify` + source), which makes every phase transition unit-testable.

import { runClassification } from "./classifier.js";
import type { BgEvent, JobState } from "./protocol.js";
import type {
  Decision,
  FolderNode,
  FolderRef,
  MessageSummary,
  Settings,
} from "./types.js";

/** Outcome of moving one destination group; mirrors `moveBatched`. */
export interface MoveOutcome {
  folderId: string;
  moved: number;
  error?: string;
}

/** The two classify styles handed to `runClassification` for a single run. */
export interface Classifiers {
  classify: (summary: MessageSummary) => Promise<Decision>;
  classifyBatch: (summaries: MessageSummary[]) => Promise<Decision[]>;
}

/** Everything needed to build the per-run classify functions. */
export interface ClassifierContext {
  instruction: string;
  settings: Settings;
  /** Allowed move targets (source folder already removed). */
  targets: FolderRef[];
  /** Allowed target paths (source folder path already removed). */
  allowedPaths: Set<string>;
  signal: AbortSignal;
}

/** Injected side-effecting collaborators. Pure helpers are imported directly. */
export interface JobRunnerDeps {
  loadSettings: () => Promise<Settings>;
  listFolders: () => Promise<FolderNode[]>;
  /** Pure index builder; injected so `core/` need not import `platform/`. */
  toFolderIndex: (nodes: FolderNode[]) => {
    allowedPaths: Set<string>;
    byPath: Map<string, FolderNode>;
  };
  /** Stream of model-ready summaries for a folder. */
  summarise: (folderId: string, maxBodyChars: number) => AsyncIterable<MessageSummary>;
  /** Build the LLM-backed classify functions for this run. */
  createClassifiers: (ctx: ClassifierContext) => Classifiers;
  /** Apply moves grouped by destination folder id. */
  moveMessages: (byFolderId: Map<string, number[]>) => Promise<MoveOutcome[]>;
  /** Sink for state/progress events (wired to port broadcast in production). */
  emit: (event: BgEvent) => void;
}

/** Result of a request that may be rejected by a phase guard. */
export type JobActionResult = { ok: true } | { ok: false; error: string };

function initialState(): JobState {
  return {
    phase: "idle",
    sourceFolderId: null,
    instruction: "",
    progress: null,
    results: [],
    error: null,
    stopped: false,
  };
}

/**
 * The job state machine. `start`/`apply` return synchronously after performing
 * their phase guard and kicking off async work, so a second request can't slip
 * in before the phase flips (matching the single-threaded event-page contract).
 */
export class JobRunner {
  private state: JobState = initialState();
  private abortController: AbortController | null = null;

  constructor(private readonly deps: JobRunnerDeps) {}

  /** Current snapshot, e.g. to seed a newly connected UI port. */
  getState(): JobState {
    return this.state;
  }

  /** Begin classifying `sourceFolderId`. Rejected if a job is already running. */
  start(sourceFolderId: string, instruction: string): JobActionResult {
    if (this.state.phase === "classifying" || this.state.phase === "applying") {
      return { ok: false, error: "a job is already running" };
    }
    this.state.phase = "classifying";
    this.state.sourceFolderId = sourceFolderId;
    this.state.instruction = instruction;
    this.state.results = [];
    this.state.error = null;
    this.state.stopped = false;
    this.state.progress = { processed: 0, total: null };
    this.emitState();

    this.abortController = new AbortController();
    void this.runJob(sourceFolderId, instruction, this.abortController.signal);
    return { ok: true };
  }

  /** Cooperatively cancel an in-flight classification run. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Apply the selected move decisions. Rejected unless we're in review. */
  apply(messageIds: number[]): JobActionResult {
    if (this.state.phase !== "review") {
      return { ok: false, error: "no results to apply" };
    }
    this.state.phase = "applying";
    this.state.error = null;
    this.emitState();

    void this.runApply(messageIds);
    return { ok: true };
  }

  private emitState(): void {
    this.deps.emit({ type: "state", state: this.state });
  }

  private async runJob(
    sourceFolderId: string,
    instruction: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const settings = await this.deps.loadSettings();
      const nodes = await this.deps.listFolders();
      const { allowedPaths } = this.deps.toFolderIndex(nodes);

      // The source folder itself is not a useful move target; remove it.
      const sourcePath = nodes.find((n) => n.id === sourceFolderId)?.path;
      const targets: FolderRef[] = nodes
        .filter((n) => n.id !== sourceFolderId)
        .map((n) => ({ id: n.id, path: n.path }));
      if (sourcePath) allowedPaths.delete(sourcePath);

      const { classify, classifyBatch } = this.deps.createClassifiers({
        instruction,
        settings,
        targets,
        allowedPaths,
        signal,
      });

      const results = await runClassification({
        source: this.deps.summarise(sourceFolderId, settings.maxBodyChars),
        classify,
        classifyBatch,
        concurrency: settings.concurrency,
        batchSize: settings.batchSize,
        signal,
        onProgress: (progress) => {
          this.state.progress = progress;
          this.deps.emit({ type: "progress", progress });
        },
      });
      this.state.results = results;
      this.state.stopped = signal.aborted;
      this.state.phase = "review";
    } catch (err) {
      this.state.error = (err as Error).message;
      this.state.phase = "idle";
    } finally {
      this.abortController = null;
      this.emitState();
    }
  }

  private async runApply(messageIds: number[]): Promise<void> {
    try {
      const nodes = await this.deps.listFolders();
      const { byPath } = this.deps.toFolderIndex(nodes);
      const selected = new Set(messageIds);

      // Group the still-selected move decisions by destination folder id.
      const byFolderId = new Map<string, number[]>();
      for (const item of this.state.results) {
        if (item.decision.action !== "move" || !item.decision.folder) continue;
        if (!selected.has(item.summary.id)) continue;
        const node = byPath.get(item.decision.folder);
        if (!node) continue;
        const list = byFolderId.get(node.id) ?? [];
        list.push(item.summary.id);
        byFolderId.set(node.id, list);
      }

      const outcomes = await this.deps.moveMessages(byFolderId);
      const failed = outcomes.filter((o) => o.error);
      if (failed.length) {
        this.state.error = `Some moves failed: ${failed
          .map((f) => `${f.folderId}: ${f.error}`)
          .join("; ")}`;
      }
      this.state.phase = "done";
    } catch (err) {
      this.state.error = (err as Error).message;
      this.state.phase = "review";
    } finally {
      this.emitState();
    }
  }
}
