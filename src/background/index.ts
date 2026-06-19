// Background event page: owns the job state machine, runs classification, and
// brokers requests/progress between the UI tab and the platform + LLM layers.

import { runClassification } from "../core/classifier.js";
import { parseDecision } from "../core/decisionParser.js";
import { chatCompletion } from "../core/llmClient.js";
import { buildClassificationMessages } from "../core/promptBuilder.js";
import {
  PORT_NAME,
  type BgEvent,
  type JobState,
  type UiRequest,
  type UiResponse,
} from "../core/protocol.js";
import { testConnection } from "../core/llmClient.js";
import type { Decision, FolderNode, MessageSummary } from "../core/types.js";
import { listFolderTree, toFolderIndex } from "../platform/folders.js";
import { getSummary, iterateFolderHeaders, moveBatched } from "../platform/messages.js";
import { loadSettings, saveSettings } from "../platform/settings.js";

const state: JobState = {
  phase: "idle",
  sourceFolderId: null,
  instruction: "",
  progress: null,
  results: [],
  error: null,
};

let abortController: AbortController | null = null;
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

function pushState(): void {
  broadcast({ type: "state", state });
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
  if (appTabId !== undefined) {
    try {
      await messenger.tabs.get(appTabId);
      await messenger.tabs.update(appTabId, { active: true, url });
      return;
    } catch {
      appTabId = undefined; // the tab was closed since we last saw it
    }
  }

  const tab = await messenger.tabs.create({ url });
  appTabId = tab.id ?? undefined;
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

  try {
    messenger.menus.onClicked.addListener((info) => {
      if (info.menuItemId === FOLDER_MENU_ID && info.selectedFolder?.id) {
        void openApp(info.selectedFolder.id);
      }
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

async function runJob(sourceFolderId: string, instruction: string): Promise<void> {
  state.phase = "classifying";
  state.sourceFolderId = sourceFolderId;
  state.instruction = instruction;
  state.results = [];
  state.error = null;
  state.progress = { processed: 0, total: null };
  pushState();

  abortController = new AbortController();
  const settings = await loadSettings();
  const nodes = await listFolderTree();
  const { allowedPaths } = toFolderIndex(nodes);

  // The source folder itself is not a useful move target; remove it.
  const sourcePath = nodes.find((n) => n.id === sourceFolderId)?.path;
  const targets = nodes.filter((n) => n.id !== sourceFolderId);
  if (sourcePath) allowedPaths.delete(sourcePath);

  const folderRefs = targets.map((n) => ({ id: n.id, path: n.path }));

  const classify = async (summary: MessageSummary): Promise<Decision> => {
    const messages = buildClassificationMessages(instruction, folderRefs, summary);
    const raw = await chatCompletion(settings, messages, fetch, {
      jsonMode: true,
      signal: abortController?.signal,
    });
    return parseDecision(raw, allowedPaths);
  };

  try {
    const results = await runClassification({
      source: summarise(sourceFolderId, settings.maxBodyChars),
      classify,
      concurrency: settings.concurrency,
      signal: abortController.signal,
      onProgress: (progress) => {
        state.progress = progress;
        broadcast({ type: "progress", progress });
      },
    });
    state.results = results;
    state.phase = "review";
  } catch (err) {
    state.error = (err as Error).message;
    state.phase = "idle";
  } finally {
    abortController = null;
    pushState();
  }
}

async function applyMoves(messageIds: number[]): Promise<void> {
  state.phase = "applying";
  state.error = null;
  pushState();

  const nodes = await listFolderTree();
  const { byPath } = toFolderIndex(nodes);
  const selected = new Set(messageIds);

  // Group the still-selected move decisions by destination folder id.
  const byFolderId = new Map<string, number[]>();
  for (const item of state.results) {
    if (item.decision.action !== "move" || !item.decision.folder) continue;
    if (!selected.has(item.summary.id)) continue;
    const node: FolderNode | undefined = byPath.get(item.decision.folder);
    if (!node) continue;
    const list = byFolderId.get(node.id) ?? [];
    list.push(item.summary.id);
    byFolderId.set(node.id, list);
  }

  try {
    const outcomes = await moveBatched(byFolderId);
    const failed = outcomes.filter((o) => o.error);
    if (failed.length) {
      state.error = `Some moves failed: ${failed
        .map((f) => `${f.folderId}: ${f.error}`)
        .join("; ")}`;
    }
    state.phase = "done";
  } catch (err) {
    state.error = (err as Error).message;
    state.phase = "review";
  } finally {
    pushState();
  }
}

messenger.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.postMessage({ type: "state", state } satisfies BgEvent);
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
        return { ok: true, state };
      case "startClassify":
        if (state.phase === "classifying" || state.phase === "applying") {
          return { ok: false, error: "a job is already running" };
        }
        void runJob(request.sourceFolderId, request.instruction);
        return { ok: true };
      case "abort":
        abortController?.abort();
        return { ok: true };
      case "applyMoves":
        if (state.phase !== "review") {
          return { ok: false, error: "no results to apply" };
        }
        void applyMoves(request.messageIds);
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
