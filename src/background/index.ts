// Background event page: thin wiring layer. It owns the entry points (toolbar
// button, folder menu, app tab) and the UI port plumbing, and delegates the job
// lifecycle to a JobRunner built from the platform + LLM dependencies.

import { parseDecision, parseDecisions } from "../core/decisionParser.js";
import { chatCompletion, type RetryInfo } from "../core/llmClient.js";
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
} from "../platform/messages.js";
import { loadSettings, saveSettings } from "../platform/settings.js";
import { clearUndo, loadUndo, saveUndo } from "../platform/undoStore.js";
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "../platform/checkpointStore.js";
import {
  loadLastInstruction,
  loadPresets,
  savePresets,
  saveLastInstruction,
} from "../platform/presetStore.js";

const ports = new Set<browser.runtime.Port>();
// Id of our dedicated app tab, tracked so we can refocus it without needing
// the broad "tabs" permission (querying tabs by URL requires it).
let appTabId: number | undefined;

function broadcast(event: BgEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

// A periodic alarm whose only job is to wake the event page often enough that an
// active classification run is less likely to be suspended mid-flight. The
// checkpoint is the real safety net; this just reduces interruptions.
const KEEPALIVE_ALARM = "smartermailsort-keepalive";

// The thunderbird-webext-browser types omit the alarms API (Thunderbird supports
// it at runtime with the "alarms" permission), so we reach it via a minimal shape.
interface AlarmsApi {
  create(name: string, info: { periodInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
  onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
}
const alarms = (messenger as unknown as { alarms: AlarmsApi }).alarms;

function setKeepalive(active: boolean): void {
  try {
    if (active) {
      alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    } else {
      void alarms.clear(KEEPALIVE_ALARM);
    }
  } catch (err) {
    console.warn("SmarterMailSort: keepalive alarm failed", err);
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

  // The keepalive alarm needs a listener so firing it wakes the event page.
  try {
    alarms.onAlarm.addListener(() => {
      /* wake-only: nothing to do, the wake itself is the point */
    });
  } catch (err) {
    console.error("SmarterMailSort: failed to register keepalive listener", err);
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
  undoMoves: moveBackByHeaderId,
  loadUndo,
  saveUndo,
  clearUndo,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  setKeepalive,
  emit: broadcast,
});

messenger.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.postMessage({ type: "state", state: runner.getState() } satisfies BgEvent);
  port.onDisconnect.addListener(() => ports.delete(port));
});

messenger.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as UiRequest;

  void (async (): Promise<UiResponse> => {
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
        return runner.start(request.sourceFolderId, request.instruction);
      case "abort":
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

// Register UI entry points last, so the message handler above is always live.
registerEntryPoints();

// Restore any persisted "undo last apply" so it survives event-page restarts.
void runner.init();
