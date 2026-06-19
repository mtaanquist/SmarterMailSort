// Owns the job lifecycle: the classify -> review -> apply state machine, abort,
// and progress/state emission. Decoupled from `messenger.*` and the LLM by
// injected dependencies (mirroring how `classifier.ts` takes an injected
// `classify` + source), which makes every phase transition unit-testable.

import { runClassification } from "./classifier.js";
import type {
  BgEvent,
  JobNotice,
  JobState,
  ResumableSummary,
} from "./protocol.js";
import type {
  ClassifiedMessage,
  Decision,
  FolderNode,
  FolderRef,
  JobCheckpoint,
  MessageSummary,
  ReviewSnapshot,
  Settings,
  UndoItem,
  UndoOutcome,
  UndoRecord,
} from "./types.js";

/** A "keep" used when a batch result is missing an entry; mirrors classifier. */
const OMITTED_DECISION: Decision = {
  action: "keep",
  folder: null,
  reason: "model omitted a decision for this email",
  confidence: 0,
};

/** How many newly-decided messages to accumulate between checkpoint writes. */
const DEFAULT_CHECKPOINT_EVERY = 25;

/**
 * Strip a results list down to the fields the review UI, apply, undo, and report
 * actually read (subject/author/date/ids + the decision). Dropping `bodyExcerpt`
 * and `headers` keeps a large folder's persisted review snapshot small — full
 * bodies for tens of thousands of messages would otherwise blow the
 * storage.local quota. Pure, so the trimming is unit-testable.
 */
export function trimResultsForReview(
  results: ClassifiedMessage[],
): ClassifiedMessage[] {
  return results.map((r) => ({
    ...r,
    summary: { ...r.summary, recipients: [], ccList: [], headers: {}, bodyExcerpt: "" },
  }));
}

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
  /** Surface a transient notice (e.g. "retrying…") to the UI. */
  onRetry: (notice: JobNotice) => void;
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
  /** Reverse a previously-applied batch (move each message back to source). */
  undoMoves: (record: UndoRecord) => Promise<UndoOutcome>;
  /** Load any persisted undo record (e.g. after an event-page restart). */
  loadUndo: () => Promise<UndoRecord | null>;
  /** Persist the undo record for the batch just applied. */
  saveUndo: (record: UndoRecord) => Promise<void>;
  /** Forget the persisted undo record. */
  clearUndo: () => Promise<void>;
  /** Load any persisted checkpoint of an interrupted classification run. */
  loadCheckpoint: () => Promise<JobCheckpoint | null>;
  /** Persist the current classification checkpoint. */
  saveCheckpoint: (checkpoint: JobCheckpoint) => Promise<void>;
  /** Forget the persisted checkpoint. */
  clearCheckpoint: () => Promise<void>;
  /** Load any persisted review snapshot of a completed-but-unapplied run. */
  loadReview: () => Promise<ReviewSnapshot | null>;
  /** Persist the proposed moves awaiting review so they survive suspension. */
  saveReview: (snapshot: ReviewSnapshot) => Promise<void>;
  /** Forget the persisted review snapshot. */
  clearReview: () => Promise<void>;
  /** Toggle a keepalive (e.g. an alarm) that resists event-page suspension. */
  setKeepalive: (active: boolean) => void;
  /** Sink for state/progress events (wired to port broadcast in production). */
  emit: (event: BgEvent) => void;
}

/** Tunables, primarily so tests can observe checkpointing at small sizes. */
export interface JobRunnerOptions {
  /** Newly-decided messages between checkpoint writes. */
  checkpointEvery?: number;
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
    undo: null,
    resumable: null,
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
  /** Full record backing `state.undo`; kept in memory and persisted via deps. */
  private undoRecord: UndoRecord | null = null;
  /**
   * Decisions made so far this run, keyed by RFC Message-ID. Seeded from a
   * checkpoint on resume (to skip the LLM for already-decided messages) and
   * grown as new results arrive (to persist progress).
   */
  private decided = new Map<string, Decision>();
  /** Newly-decided messages since the last checkpoint write. */
  private dirty = 0;
  /** True while a run should keep persisting its checkpoint. */
  private checkpointing = false;
  /** The interrupted checkpoint loaded at startup, available to resume. */
  private loadedCheckpoint: JobCheckpoint | null = null;
  /** Whether the active run may move messages into other accounts. */
  private allowCrossAccount = false;
  private readonly checkpointEvery: number;

  constructor(
    private readonly deps: JobRunnerDeps,
    options: JobRunnerOptions = {},
  ) {
    this.checkpointEvery = Math.max(1, options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY);
  }

  /**
   * Restore persisted state the event page may have lost to suspension/restart:
   * the undo record and any interrupted-run checkpoint. Safe to call once at
   * startup; emits state if anything loads.
   */
  async init(): Promise<void> {
    const [undoRecord, checkpoint, review] = await Promise.all([
      this.deps.loadUndo(),
      this.deps.loadCheckpoint(),
      this.deps.loadReview(),
    ]);
    let changed = false;
    if (undoRecord && undoRecord.items.length) {
      this.setUndo(undoRecord);
      changed = true;
    }
    // A review snapshot means classification finished but the moves weren't
    // applied before the page went down: restore straight back into review so
    // "Apply" works. It supersedes a stale resume checkpoint (cleared when the
    // run reached review), so we never offer "resume" over a ready review.
    if (review && review.results.length) {
      this.state.phase = "review";
      this.state.sourceFolderId = review.sourceFolderId;
      this.state.instruction = review.instruction;
      this.state.results = review.results;
      this.state.stopped = review.stopped;
      changed = true;
    } else if (checkpoint && checkpoint.decisions.length) {
      this.loadedCheckpoint = checkpoint;
      this.setResumable({
        sourceFolderId: checkpoint.sourceFolderId,
        instruction: checkpoint.instruction,
        count: checkpoint.decisions.length,
      });
      changed = true;
    }
    if (changed) this.emitState();
  }

  /** Current snapshot, e.g. to seed a newly connected UI port. */
  getState(): JobState {
    return this.state;
  }

  /** Begin classifying `sourceFolderId`. Rejected if a job is already running. */
  start(
    sourceFolderId: string,
    instruction: string,
    allowCrossAccount = false,
  ): JobActionResult {
    if (this.isBusy()) return { ok: false, error: "a job is already running" };
    // A fresh run starts with no cached decisions and drops any stale checkpoint.
    this.decided = new Map();
    this.loadedCheckpoint = null;
    this.allowCrossAccount = allowCrossAccount;
    void this.deps.clearCheckpoint();
    // A new run replaces any moves that were sitting in review.
    void this.deps.clearReview();
    this.beginRun(sourceFolderId, instruction);
    return { ok: true };
  }

  /** Resume an interrupted run loaded at startup, skipping decided messages. */
  resume(): JobActionResult {
    if (this.isBusy()) return { ok: false, error: "a job is already running" };
    const checkpoint = this.loadedCheckpoint;
    if (!checkpoint) return { ok: false, error: "nothing to resume" };
    // Seed the cache so already-decided messages skip the LLM on this pass.
    this.decided = new Map(
      checkpoint.decisions.map((d) => [d.headerMessageId, d.decision]),
    );
    this.allowCrossAccount = checkpoint.allowCrossAccount ?? false;
    void this.deps.clearReview();
    this.beginRun(checkpoint.sourceFolderId, checkpoint.instruction);
    return { ok: true };
  }

  /** Forget an interrupted run without resuming it. */
  discardResume(): JobActionResult {
    if (this.isBusy()) return { ok: false, error: "a job is already running" };
    this.decided = new Map();
    this.loadedCheckpoint = null;
    this.checkpointing = false;
    this.setResumable(null);
    void this.deps.clearCheckpoint();
    this.emitState();
    return { ok: true };
  }

  private isBusy(): boolean {
    return this.state.phase === "classifying" || this.state.phase === "applying";
  }

  /** Shared setup for start/resume: reset run state and kick off classification. */
  private beginRun(sourceFolderId: string, instruction: string): void {
    this.state.phase = "classifying";
    this.state.sourceFolderId = sourceFolderId;
    this.state.instruction = instruction;
    this.state.results = [];
    this.state.error = null;
    this.state.stopped = false;
    this.state.progress = { processed: 0, total: null };
    // Starting/resuming clears the "resume?" prompt and any previous undo.
    this.setResumable(null);
    this.setUndo(null);
    void this.deps.clearUndo();
    this.checkpointing = true;
    this.dirty = 0;
    this.emitState();

    this.abortController = new AbortController();
    void this.runJob(sourceFolderId, instruction, this.abortController.signal);
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

  /** Move the most recently applied batch back to its source folder. */
  undo(): JobActionResult {
    if (this.state.phase === "classifying" || this.state.phase === "applying") {
      return { ok: false, error: "a job is already running" };
    }
    if (!this.undoRecord) {
      return { ok: false, error: "nothing to undo" };
    }
    const record = this.undoRecord;
    this.state.phase = "applying";
    this.state.error = null;
    this.emitState();

    void this.runUndo(record);
    return { ok: true };
  }

  private emitState(): void {
    this.deps.emit({ type: "state", state: this.state });
  }

  /** Update both the in-memory undo record and the UI-facing summary. */
  private setUndo(record: UndoRecord | null): void {
    this.undoRecord = record;
    this.state.undo = record ? { count: record.items.length } : null;
  }

  private setResumable(summary: ResumableSummary | null): void {
    this.state.resumable = summary;
  }

  /** Snapshot the decisions made so far as a persistable checkpoint. */
  private buildCheckpoint(): JobCheckpoint | null {
    if (!this.state.sourceFolderId) return null;
    return {
      sourceFolderId: this.state.sourceFolderId,
      instruction: this.state.instruction,
      allowCrossAccount: this.allowCrossAccount,
      decisions: [...this.decided].map(([headerMessageId, decision]) => ({
        headerMessageId,
        decision,
      })),
    };
  }

  /** Write the current checkpoint, unless this run has stopped checkpointing. */
  private async flushCheckpoint(): Promise<void> {
    if (!this.checkpointing) return;
    const checkpoint = this.buildCheckpoint();
    if (checkpoint) await this.deps.saveCheckpoint(checkpoint);
  }

  /** Persist (or, if there's nothing to review, clear) the review snapshot. */
  private async persistReview(): Promise<void> {
    if (!this.state.sourceFolderId || !this.state.results.length) {
      await this.deps.clearReview();
      return;
    }
    await this.deps.saveReview({
      sourceFolderId: this.state.sourceFolderId,
      instruction: this.state.instruction,
      stopped: this.state.stopped,
      results: trimResultsForReview(this.state.results),
    });
  }

  private async runJob(
    sourceFolderId: string,
    instruction: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.deps.setKeepalive(true);
    try {
      const settings = await this.deps.loadSettings();
      const nodes = await this.deps.listFolders();

      // By default, targets are limited to the source folder's OWN account
      // (minus itself): moving mail across accounts is rarely intended and just
      // gives the model irrelevant, confusing options. Users can opt into
      // cross-account moves via settings. allowedPaths mirrors the targets so a
      // decision can never name an out-of-scope or non-existent folder.
      const sourceAccount = nodes.find((n) => n.id === sourceFolderId)?.accountName;
      const sameAccount = (n: FolderNode): boolean =>
        this.allowCrossAccount ||
        sourceAccount === undefined ||
        n.accountName === sourceAccount;
      const targets: FolderRef[] = nodes
        .filter((n) => n.id !== sourceFolderId && sameAccount(n))
        .map((n) => ({ id: n.id, path: n.path }));
      const allowedPaths = new Set(targets.map((t) => t.path));

      const raw = this.deps.createClassifiers({
        instruction,
        settings,
        targets,
        allowedPaths,
        signal,
        onRetry: (notice) => this.deps.emit({ type: "notice", notice }),
      });

      const results = await runClassification({
        source: this.deps.summarise(sourceFolderId, settings.maxBodyChars),
        // Skip the LLM for messages already decided in a prior (resumed) pass.
        classify: (summary) => this.cachedOrClassify(summary, raw),
        classifyBatch: (summaries) => this.cachedOrClassifyBatch(summaries, raw),
        concurrency: settings.concurrency,
        batchSize: settings.batchSize,
        signal,
        onProgress: (progress) => {
          this.state.progress = progress;
          this.recordDecision(progress.lastResult);
          this.deps.emit({ type: "progress", progress });
        },
      });
      this.state.results = results;
      this.state.stopped = signal.aborted;
      this.state.phase = "review";
      // Classification finished; the resume checkpoint has served its purpose.
      // Hand the baton to a durable review snapshot so the proposed moves
      // survive a suspension between here and "Apply" (otherwise they live only
      // in memory and vanish with the event page).
      this.checkpointing = false;
      this.decided = new Map();
      this.loadedCheckpoint = null;
      this.setResumable(null);
      await this.deps.clearCheckpoint();
      await this.persistReview();
    } catch (err) {
      this.state.error = (err as Error).message;
      this.state.phase = "idle";
      // Keep whatever progress we made so the run can be resumed later.
      this.checkpointing = false;
      const checkpoint = this.decided.size ? this.buildCheckpoint() : null;
      if (checkpoint) {
        await this.deps.saveCheckpoint(checkpoint);
        this.loadedCheckpoint = checkpoint;
        this.setResumable({
          sourceFolderId: checkpoint.sourceFolderId,
          instruction: checkpoint.instruction,
          count: checkpoint.decisions.length,
        });
      } else {
        await this.deps.clearCheckpoint();
      }
    } finally {
      this.deps.setKeepalive(false);
      this.abortController = null;
      this.emitState();
    }
  }

  /** Return a cached decision for `summary` if present, else run the LLM. */
  private cachedOrClassify(
    summary: MessageSummary,
    raw: Classifiers,
  ): Promise<Decision> {
    const hit = this.decided.get(summary.headerMessageId);
    return hit ? Promise.resolve(hit) : raw.classify(summary);
  }

  /** Batch variant: send only undecided messages to the LLM, merge the cache. */
  private async cachedOrClassifyBatch(
    summaries: MessageSummary[],
    raw: Classifiers,
  ): Promise<Decision[]> {
    const undecided = summaries.filter((s) => !this.decided.has(s.headerMessageId));
    const fresh = undecided.length ? await raw.classifyBatch(undecided) : [];
    const byId = new Map<number, Decision>();
    undecided.forEach((s, i) => byId.set(s.id, fresh[i]));
    return summaries.map(
      (s) => this.decided.get(s.headerMessageId) ?? byId.get(s.id) ?? OMITTED_DECISION,
    );
  }

  /** Fold a freshly resolved result into the checkpoint, flushing every N. */
  private recordDecision(result: ClassifiedMessage | undefined): void {
    if (!result || result.error || !result.summary.headerMessageId) return;
    this.decided.set(result.summary.headerMessageId, result.decision);
    if (++this.dirty >= this.checkpointEvery) {
      this.dirty = 0;
      void this.flushCheckpoint();
    }
  }

  private async runApply(messageIds: number[]): Promise<void> {
    try {
      const nodes = await this.deps.listFolders();
      const { byPath } = this.deps.toFolderIndex(nodes);
      const selected = new Set(messageIds);

      // Group the still-selected move decisions by destination folder id, and in
      // parallel capture move-stable header ids per destination for a later undo.
      const byFolderId = new Map<string, number[]>();
      const undoByFolderId = new Map<string, UndoItem[]>();
      for (const item of this.state.results) {
        if (item.decision.action !== "move" || !item.decision.folder) continue;
        if (!selected.has(item.summary.id)) continue;
        const node = byPath.get(item.decision.folder);
        if (!node) continue;
        const list = byFolderId.get(node.id) ?? [];
        list.push(item.summary.id);
        byFolderId.set(node.id, list);
        // Only messages with a Message-ID can be reliably located for undo.
        if (item.summary.headerMessageId) {
          const undoList = undoByFolderId.get(node.id) ?? [];
          undoList.push({
            headerMessageId: item.summary.headerMessageId,
            destFolderId: node.id,
          });
          undoByFolderId.set(node.id, undoList);
        }
      }

      const outcomes = await this.deps.moveMessages(byFolderId);
      const failed = outcomes.filter((o) => o.error);
      if (failed.length) {
        this.state.error = `Some moves failed: ${failed
          .map((f) => `${f.folderId}: ${f.error}`)
          .join("; ")}`;
      }

      // Build the undo record from the destinations that moved successfully.
      const failedFolders = new Set(failed.map((f) => f.folderId));
      const undoItems: UndoItem[] = [];
      for (const [destFolderId, items] of undoByFolderId) {
        if (!failedFolders.has(destFolderId)) undoItems.push(...items);
      }
      await this.recordUndo(undoItems);

      // The moves are applied; the review snapshot must not linger or a later
      // wake would restore "review" and offer to re-apply an already-done batch.
      await this.deps.clearReview();
      this.state.phase = "done";
    } catch (err) {
      // Stay in review (the snapshot is still valid) so the user can retry.
      this.state.error = (err as Error).message;
      this.state.phase = "review";
    } finally {
      this.emitState();
    }
  }

  /** Persist (or clear) the undo record for the batch that just applied. */
  private async recordUndo(items: UndoItem[]): Promise<void> {
    if (this.state.sourceFolderId && items.length) {
      const record: UndoRecord = {
        sourceFolderId: this.state.sourceFolderId,
        items,
      };
      this.setUndo(record);
      await this.deps.saveUndo(record);
    } else {
      this.setUndo(null);
      await this.deps.clearUndo();
    }
  }

  private async runUndo(record: UndoRecord): Promise<void> {
    try {
      const outcome = await this.deps.undoMoves(record);
      this.state.error = outcome.failures.length
        ? `Undo: restored ${outcome.restored}, ${outcome.failures.length} could not be moved back.`
        : null;
      // The batch is consumed whether or not every message came back; the ones
      // that failed are gone (moved/deleted) and retrying won't recover them.
      this.setUndo(null);
      await this.deps.clearUndo();
      this.state.phase = "idle";
    } catch (err) {
      // The reverse move itself failed wholesale; keep the record (and its
      // banner) so the user can retry, and settle back to idle.
      this.state.error = (err as Error).message;
      this.state.phase = "idle";
    } finally {
      this.emitState();
    }
  }
}
