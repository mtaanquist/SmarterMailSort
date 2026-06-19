// Background event page: thin wiring layer. It owns the entry points (toolbar
// button, folder menu, app tab) and the UI port plumbing, and delegates the job
// lifecycle to a JobRunner built from the platform + LLM dependencies.

import { parseDecision, parseDecisions } from "../core/decisionParser.js";
import { chatCompletion, resolveMaxTokens, type RetryInfo } from "../core/llmClient.js";
import { log, logError, warn } from "../core/log.js";
import { JobRunner } from "../core/jobRunner.js";
import type { ClassifierContext, Classifiers } from "../core/jobRunner.js";
import {
  BATCH_DECISION_SCHEMA,
  DECISION_SCHEMA,
  buildBatchClassificationMessages,
  buildClassificationMessages,
} from "../core/promptBuilder.js";
import { PORT_NAME, type BgEvent, type UiRequest, type UiResponse } from "../core/protocol.js";
import { testConnection } from "../core/llmClient.js";
import type { Decision, MessageSummary } from "../core/types.js";
import { listFolderTree, toFolderIndex } from "../platform/folders.js";
import {
  getSummary,
  iterateFolderHeaders,
  moveBackByHeaderId,
  moveBatched,
  resolveCurrentIds,
} from "../platform/messages.js";
import { loadSettings, saveSettings } from "../platform/settings.js";
import { clearUndo, loadUndo, saveUndo } from "../platform/undoStore.js";
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "../platform/checkpointStore.js";
import { clearReview, loadReview, saveReview } from "../platform/reviewStore.js";
import {
  loadLastInstruction,
  loadPresets,
  savePresets,
  saveLastInstruction,
  seedDefaultPresetsOnce,
} from "../platform/presetStore.js";

const ports = new Set<browser.runtime.Port>();
// Id of our dedicated app tab, tracked so we can refocus it without needing
// the broad "tabs" permission (querying tabs by URL requires it).
let appTabId: number | undefined;

function broadcast(event: BgEvent): void {
  // Phase transitions are the spine of the job lifecycle; log them (but not the
  // per-message "progress" firehose) so a stalled run is easy to place.
  if (event.type === "state") {
    log("state →", event.state.phase, {
      results: event.state.results.length,
      resumable: event.state.resumable?.count ?? null,
      stopped: event.state.stopped,
      error: event.state.error,
    });
  }
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

// Keeping the event page alive during a long run is two mechanisms working
// together. (1) A self-rescheduling timer makes a cheap WebExtension API call
// every KEEPALIVE_MS, which resets the page's idle-suspension timer — this is
// what actually holds the page up while a job runs (a bare `await fetch` chain
// does not reliably count as activity). (2) A periodic alarm is the backstop:
// it survives a suspension and wakes the page so a checkpoint-backed resume can
// be offered. The checkpoint remains the real safety net for the data; these
// just keep the run from being interrupted in the first place, and let the UI
// recover when it is.
const KEEPALIVE_ALARM = "smartermailsort-keepalive";
// Comfortably under the ~30s event-page idle timeout so a tick always lands
// before suspension can.
const KEEPALIVE_MS = 20_000;

// The thunderbird-webext-browser types omit the alarms API (Thunderbird supports
// it at runtime with the "alarms" permission), so we reach it via a minimal shape.
interface AlarmsApi {
  create(name: string, info: { periodInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
  onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
}
const alarms = (messenger as unknown as { alarms: AlarmsApi }).alarms;

let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;

/** One heartbeat: a trivial API call resets the idle timer, then reschedule. */
function keepaliveTick(): void {
  void messenger.runtime.getPlatformInfo().then(
    () => log("keepalive ♥"),
    () => {},
  );
  keepaliveTimer = setTimeout(keepaliveTick, KEEPALIVE_MS);
}

function setKeepalive(active: boolean): void {
  try {
    if (active) {
      alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      if (keepaliveTimer === undefined) keepaliveTick();
      log("keepalive on");
    } else {
      void alarms.clear(KEEPALIVE_ALARM);
      if (keepaliveTimer !== undefined) {
        clearTimeout(keepaliveTimer);
        keepaliveTimer = undefined;
      }
      log("keepalive off");
    }
  } catch (err) {
    warn("keepalive failed", err);
  }
}

/**
 * Open (or focus) the dedicated SmarterMailSort tab. When `folderId` is given,
 * it is passed as a query param so the UI can preselect that source folder.
 */
async function openApp(folderId?: string): Promise<void> {
  const base = messenger.runtime.getURL("ui/app.html");
  const url = folderId ? `${base}?folder=${encodeURIComponent(folderId)}` : base;

  // Reuse the existing app tab if we still have one. tabs.get/update/create do
  // not require the "tabs" permission (filtering by URL would).
  let reused = false;
  if (appTabId !== undefined) {
    try {
      await messenger.tabs.get(appTabId);
      await messenger.tabs.update(appTabId, { active: true, url });
      reused = true;
    } catch {
      appTabId = undefined; // the tab was closed since we last saw it
    }
  }

  if (!reused) {
    const tab = await messenger.tabs.create({ url });
    appTabId = tab.id ?? undefined;
  }

  // A fresh tab reads the folder from `?folder=` on load. A reused tab won't
  // reliably reload on a query-only URL change, so push the preselection over
  // the live port instead (no-op if no UI is connected yet).
  if (folderId) broadcast({ type: "preselectFolder", folderId });
}

const FOLDER_MENU_ID = "smartermailsort-sort-folder";

// Register the toolbar button and folder context menu. These are wrapped in
// try/catch and run AFTER the runtime.onMessage handler is installed (see
// bottom of file) so that an API quirk here can never take down the message
// handler that powers the settings page and UI.
function registerEntryPoints(): void {
  try {
    // MV3 toolbar button is the `action` API; `browser_action` is MV2-only and
    // is ignored by Thunderbird MV3 (leaving messenger.browserAction undefined).
    messenger.action.onClicked.addListener(() => void openApp());
  } catch (err) {
    console.error("SmarterMailSort: failed to register toolbar button", err);
  }

  // Forget the tracked tab once it closes, so the next open creates a fresh one.
  messenger.tabs.onRemoved.addListener((tabId) => {
    if (tabId === appTabId) appTabId = undefined;
  });

  // The keepalive alarm needs a listener so firing it wakes the event page. The
  // wake itself is the point; if it fired after a suspension killed a run, the
  // page is now back up to serve a getState (and thus offer a resume).
  try {
    alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) log("keepalive alarm woke the page");
    });
  } catch (err) {
    logError("failed to register keepalive listener", err);
  }

  try {
    messenger.menus.onClicked.addListener((info) => {
      if (info.menuItemId !== FOLDER_MENU_ID) return;
      // Prefer the right-clicked folder; fall back to the displayed folder.
      // Always open the tab even if no folder id is available, so the click is
      // never a silent no-op (it just opens without a preselection).
      const folderId = info.selectedFolder?.id ?? info.displayedFolder?.id;
      if (!folderId) {
        console.warn(
          "SmarterMailSort: folder menu click had no folder id; info keys:",
          Object.keys(info),
        );
      }
      void openApp(folderId);
    });
    // removeAll() first keeps creation idempotent across event-page restarts.
    void messenger.menus
      .removeAll()
      .then(() =>
        messenger.menus.create({
          id: FOLDER_MENU_ID,
          title: "Sort with SmarterMailSort…",
          contexts: ["folder_pane"],
        }),
      )
      .catch((err) =>
        console.error("SmarterMailSort: failed to create folder menu", err),
      );
  } catch (err) {
    console.error("SmarterMailSort: failed to register folder menu", err);
  }
}

/** Stream every message in the folder as a model-ready summary. */
async function* summarise(
  folderId: string,
  maxBodyChars: number,
): AsyncGenerator<MessageSummary> {
  for await (const header of iterateFolderHeaders(folderId)) {
    yield await getSummary(header, maxBodyChars);
  }
}

/**
 * Build the LLM-backed classify functions for a run. This is the one piece of
 * job orchestration that genuinely needs the LLM client + prompt builders, so
 * it stays here and is handed to the JobRunner as an injected dependency.
 */
function createClassifiers(ctx: ClassifierContext): Classifiers {
  const { instruction, settings, targets, allowedPaths, signal, onRetry } = ctx;

  // Shared LLM request options for this run: JSON mode, the run's abort signal,
  // the configured retry budget, and a retry hook that surfaces "retrying…".
  const chatOptions = {
    jsonMode: true,
    signal,
    maxRetries: settings.maxRetries,
    retryBaseMs: settings.retryBaseMs,
    onRetry: (info: RetryInfo) => {
      const what = info.error.status ? `HTTP ${info.error.status}` : "request failed";
      onRetry({
        kind: "retry",
        message: `${what} — retrying (${info.attempt}/${settings.maxRetries}) in ${(info.delayMs / 1000).toFixed(1)}s…`,
      });
    },
  };

  const classify = async (summary: MessageSummary): Promise<Decision> => {
    const messages = buildClassificationMessages(instruction, targets, summary);
    const raw = await chatCompletion(settings, messages, fetch, {
      ...chatOptions,
      jsonSchema: DECISION_SCHEMA,
      maxTokens: resolveMaxTokens(settings.maxTokens, 1),
    });
    return parseDecision(raw, allowedPaths);
  };

  // Batched path: classify several emails per LLM request, then map the keyed
  // results back to the input order (any omitted email defaults to "keep").
  const classifyBatch = async (
    summaries: MessageSummary[],
  ): Promise<Decision[]> => {
    const messages = buildBatchClassificationMessages(
      instruction,
      targets,
      summaries,
    );
    const raw = await chatCompletion(settings, messages, fetch, {
      ...chatOptions,
      jsonSchema: BATCH_DECISION_SCHEMA,
      maxTokens: resolveMaxTokens(settings.maxTokens, summaries.length),
    });
    const byId = parseDecisions(
      raw,
      allowedPaths,
      summaries.map((s) => s.id),
    );
    return summaries.map(
      (s) =>
        byId.get(s.id) ?? {
          action: "keep",
          folder: null,
          reason: "model omitted a decision for this email",
          confidence: 0,
        },
    );
  };

  return { classify, classifyBatch };
}

const runner = new JobRunner({
  loadSettings,
  listFolders: listFolderTree,
  toFolderIndex,
  summarise,
  createClassifiers,
  moveMessages: moveBatched,
  resolveCurrentIds,
  undoMoves: moveBackByHeaderId,
  loadUndo,
  saveUndo,
  clearUndo,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  loadReview,
  saveReview,
  clearReview,
  setKeepalive,
  emit: broadcast,
});

messenger.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  log("port connected", { ports: ports.size });
  port.postMessage({ type: "state", state: runner.getState() } satisfies BgEvent);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    log("port disconnected", { ports: ports.size });
  });
});

// Assigned at the bottom from runner.init(); requests that read job state await
// it first so a freshly-woken page has loaded its checkpoint before it answers
// (otherwise a recovery getState can race init and report "idle, nothing to
// resume" for a run that is in fact resumable).
let initReady: Promise<void> | null = null;

/** Requests whose answer depends on restored job state must wait for init. */
const STATE_DEPENDENT = new Set<UiRequest["type"]>([
  "getState",
  "resume",
  "discardResume",
  "abort",
  "applyMoves",
  "undo",
]);

messenger.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as UiRequest;
  log("request:", request.type);

  void (async (): Promise<UiResponse> => {
    if (initReady && STATE_DEPENDENT.has(request.type)) await initReady;
    switch (request.type) {
      case "getSettings":
        return { ok: true, settings: await loadSettings() };
      case "saveSettings":
        await saveSettings(request.settings);
        return { ok: true };
      case "testConnection": {
        const result = await testConnection(request.settings, fetch);
        return result.ok
          ? { ok: true, models: result.models }
          : { ok: false, error: result.error };
      }
      case "listFolders":
        return { ok: true, folders: await listFolderTree() };
      case "getState":
        return { ok: true, state: runner.getState() };
      case "startClassify":
        // Remember the instruction so the UI can prefill it next time.
        void saveLastInstruction(request.instruction);
        log("startClassify", {
          folder: request.sourceFolderId,
          allowCrossAccount: request.allowCrossAccount,
        });
        return runner.start(
          request.sourceFolderId,
          request.instruction,
          request.allowCrossAccount,
        );
      case "abort":
        log("abort requested");
        runner.abort();
        return { ok: true };
      case "applyMoves":
        return runner.apply(request.messageIds);
      case "undo":
        return runner.undo();
      case "resume":
        return runner.resume();
      case "discardResume":
        return runner.discardResume();
      case "getPresets":
        // Seed first (idempotent) so the first read already includes the
        // starter set, with no race against a separate startup seed.
        await seedDefaultPresetsOnce();
        return {
          ok: true,
          presets: await loadPresets(),
          lastInstruction: await loadLastInstruction(),
        };
      case "savePresets":
        await savePresets(request.presets);
        return { ok: true };
      default:
        return { ok: false, error: "unknown request" };
    }
  })().then(sendResponse, (err: Error) =>
    sendResponse({ ok: false, error: err.message } satisfies UiResponse),
  );

  // Keep the message channel open for the async response.
  return true;
});

// Every time the event page (re)loads — first run, manual wake, or respawn after
// an idle suspension — this whole module re-executes. The breadcrumb makes those
// respawns visible: a fresh "background loaded" line in the middle of a run is
// the signature of a suspension.
log("background event page loaded");

// A run that died to suspension can leave its keepalive alarm armed (the cleanup
// in runJob's finally never ran). Clear any orphan now; a genuine resume re-arms
// it. This avoids a respawned-but-idle page being woken forever.
void alarms.clear(KEEPALIVE_ALARM);

// Register UI entry points last, so the message handler above is always live.
registerEntryPoints();

// Restore persisted state the event page may have lost to suspension/restart:
// the "undo last apply" record, any interrupted-run checkpoint, and a completed
// run's review snapshot (so proposed moves are still appliable). State-reading
// requests await this (see initReady) so recovery never races the load.
initReady = runner.init();
void initReady.then(() => log("init complete", runner.getState().phase));

// Seed the starter presets on first run (idempotent; getPresets also ensures it).
void seedDefaultPresetsOnce();
