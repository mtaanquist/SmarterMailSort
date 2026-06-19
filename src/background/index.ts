// Background event page: thin wiring layer. It owns the entry points (toolbar
// button, folder menu, app tab) and the UI port plumbing, and delegates the job
// lifecycle to a JobRunner built from the platform + LLM dependencies.

import { parseDecision, parseDecisions } from "../core/decisionParser.js";
import { chatCompletion } from "../core/llmClient.js";
import { JobRunner } from "../core/jobRunner.js";
import type { ClassifierContext, Classifiers } from "../core/jobRunner.js";
import {
  buildBatchClassificationMessages,
  buildClassificationMessages,
} from "../core/promptBuilder.js";
import { PORT_NAME, type BgEvent, type UiRequest, type UiResponse } from "../core/protocol.js";
import { testConnection } from "../core/llmClient.js";
import type { Decision, MessageSummary } from "../core/types.js";
import { listFolderTree, toFolderIndex } from "../platform/folders.js";
import { getSummary, iterateFolderHeaders, moveBatched } from "../platform/messages.js";
import { loadSettings, saveSettings } from "../platform/settings.js";

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
  const { instruction, settings, targets, allowedPaths, signal } = ctx;

  const classify = async (summary: MessageSummary): Promise<Decision> => {
    const messages = buildClassificationMessages(instruction, targets, summary);
    const raw = await chatCompletion(settings, messages, fetch, {
      jsonMode: true,
      signal,
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
      jsonMode: true,
      signal,
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
        return runner.start(request.sourceFolderId, request.instruction);
      case "abort":
        runner.abort();
        return { ok: true };
      case "applyMoves":
        return runner.apply(request.messageIds);
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
