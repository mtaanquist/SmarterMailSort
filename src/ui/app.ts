// Dedicated-tab UI: pick a folder + instruction, watch live progress, review
// the model's proposed moves, then apply the selected ones. State is driven by
// the background event page over a runtime Port.

import { groupMovesByFolder } from "../core/classifier.js";
import {
  PORT_NAME,
  type BgEvent,
  type JobState,
  type UiRequest,
  type UiResponse,
} from "../core/protocol.js";
import { buildMarkdownReport } from "../core/report.js";
import { findPreset, removePreset, upsertPreset } from "../core/presets.js";
import type { ClassifiedMessage, FolderNode, Preset } from "../core/types.js";

const el = {
  folder: document.getElementById("folder") as HTMLSelectElement,
  instruction: document.getElementById("instruction") as HTMLTextAreaElement,
  presetSelect: document.getElementById("preset-select") as HTMLSelectElement,
  presetName: document.getElementById("preset-name") as HTMLInputElement,
  savePreset: document.getElementById("save-preset") as HTMLButtonElement,
  deletePreset: document.getElementById("delete-preset") as HTMLButtonElement,
  start: document.getElementById("start") as HTMLButtonElement,
  abort: document.getElementById("abort") as HTMLButtonElement,
  settingsLink: document.getElementById("settings-link") as HTMLAnchorElement,
  progressPanel: document.getElementById("progress-panel") as HTMLElement,
  progress: document.getElementById("progress") as HTMLProgressElement,
  progressText: document.getElementById("progress-text") as HTMLElement,
  progressNote: document.getElementById("progress-note") as HTMLElement,
  resumePanel: document.getElementById("resume-panel") as HTMLElement,
  resumeText: document.getElementById("resume-text") as HTMLElement,
  resume: document.getElementById("resume") as HTMLButtonElement,
  resumeDiscard: document.getElementById("resume-discard") as HTMLButtonElement,
  undoPanel: document.getElementById("undo-panel") as HTMLElement,
  undoText: document.getElementById("undo-text") as HTMLElement,
  undo: document.getElementById("undo") as HTMLButtonElement,
  reviewPanel: document.getElementById("review-panel") as HTMLElement,
  reviewSummary: document.getElementById("review-summary") as HTMLElement,
  review: document.getElementById("review") as HTMLElement,
  apply: document.getElementById("apply") as HTMLButtonElement,
  download: document.getElementById("download") as HTMLButtonElement,
  dryRun: document.getElementById("dry-run") as HTMLInputElement,
  error: document.getElementById("error") as HTMLElement,
};

let folders: FolderNode[] = [];
let presets: Preset[] = [];
let lastState: JobState | null = null;

function send(request: UiRequest): Promise<UiResponse> {
  return messenger.runtime.sendMessage(request) as Promise<UiResponse>;
}

function setError(message: string | null): void {
  el.error.hidden = !message;
  el.error.textContent = message ?? "";
}

/** Show (or clear) a transient note under the progress bar, e.g. "retrying…". */
function setNote(message: string | null): void {
  el.progressNote.hidden = !message;
  el.progressNote.textContent = message ?? "";
}

async function loadFolders(): Promise<void> {
  const res = await send({ type: "listFolders" });
  if (!res.ok) {
    setError(`Could not load folders: ${"error" in res ? res.error : "unknown error"}`);
    return;
  }
  if (res.ok && "folders" in res) {
    folders = res.folders;
    el.folder.innerHTML = "";
    for (const node of folders) {
      const option = document.createElement("option");
      option.value = node.id;
      option.textContent = `${" ".repeat(node.depth * 2)}${node.path}`;
      el.folder.appendChild(option);
    }
    // Preselect the folder passed via ?folder= (set when launched from the
    // folder-pane context menu).
    const requested = new URLSearchParams(location.search).get("folder");
    if (requested && folders.some((f) => f.id === requested)) {
      el.folder.value = requested;
    }
  }
}

function populatePresetSelect(): void {
  const selected = el.presetSelect.value;
  el.presetSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = presets.length ? "Presets…" : "No saved presets";
  el.presetSelect.appendChild(placeholder);
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.name;
    option.textContent = preset.name;
    el.presetSelect.appendChild(option);
  }
  // Keep the current selection if it still exists.
  if (findPreset(presets, selected)) el.presetSelect.value = selected;
  el.deletePreset.disabled = !el.presetSelect.value;
}

async function loadPresets(): Promise<void> {
  const res = await send({ type: "getPresets" });
  if (res.ok && "presets" in res) {
    presets = res.presets;
    populatePresetSelect();
    // Prefill the last-used instruction, but never clobber what the user typed.
    if (res.lastInstruction && !el.instruction.value.trim()) {
      el.instruction.value = res.lastInstruction;
    }
  }
}

async function persistPresets(): Promise<boolean> {
  const res = await send({ type: "savePresets", presets });
  if (!res.ok && "error" in res) {
    setError(`Could not save preset: ${res.error}`);
    return false;
  }
  return true;
}

function renderProgress(state: JobState): void {
  const running = state.phase === "classifying";
  el.progressPanel.hidden = !running && state.phase !== "applying";
  el.start.disabled = running || state.phase === "applying";
  el.abort.disabled = !running;

  const p = state.progress;
  if (p) {
    if (p.total) {
      el.progress.removeAttribute("indeterminate");
      el.progress.max = p.total;
      el.progress.value = p.processed;
      el.progressText.textContent = `${p.processed} / ${p.total} classified`;
    } else {
      el.progress.removeAttribute("value");
      el.progressText.textContent = `${p.processed} classified…`;
    }
  }
  if (state.phase === "applying") {
    el.progressText.textContent = "Applying moves…";
  }
  // Retry notices only make sense mid-classification; clear them otherwise.
  if (!running) setNote(null);
}

function renderReview(state: JobState): void {
  const show = state.phase === "review" || state.phase === "done";
  el.reviewPanel.hidden = !show;
  if (!show) return;

  const moves = groupMovesByFolder(state.results);
  const moveCount = [...moves.values()].reduce((n, list) => n + list.length, 0);
  const errors = state.results.filter((r) => r.error).length;
  const stoppedNote = state.stopped ? "Stopped early — " : "";
  const totalNote =
    state.stopped && state.progress?.total
      ? ` of ~${state.progress.total}`
      : "";
  el.reviewSummary.textContent =
    state.phase === "done"
      ? `Done. ${moveCount} move(s) were processed.`
      : `${stoppedNote}${state.results.length}${totalNote} classified · ${moveCount} proposed move(s) · ${errors} error(s).`;

  el.review.innerHTML = "";
  for (const [folder, items] of moves) {
    el.review.appendChild(renderFolderGroup(folder, items));
  }
  el.apply.disabled = state.phase !== "review" || moveCount === 0;
}

function renderFolderGroup(
  folder: string,
  items: ClassifiedMessage[],
): HTMLElement {
  const details = document.createElement("details");
  details.className = "folder-group";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `→ ${folder} (${items.length})`;
  details.appendChild(summary);

  const table = document.createElement("table");
  for (const item of items) {
    const tr = document.createElement("tr");

    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.messageId = String(item.summary.id);
    checkbox.className = "move-checkbox";
    checkCell.appendChild(checkbox);

    const infoCell = document.createElement("td");
    const subject = document.createElement("div");
    subject.textContent = item.summary.subject || "(no subject)";
    const meta = document.createElement("div");
    meta.className = "reason";
    meta.textContent = `${item.summary.author} — ${item.decision.reason} (${item.decision.confidence.toFixed(2)})`;
    infoCell.append(subject, meta);

    tr.append(checkCell, infoCell);
    table.appendChild(tr);
  }
  details.appendChild(table);
  return details;
}

function renderResume(state: JobState): void {
  const busy = state.phase === "classifying" || state.phase === "applying";
  el.resumePanel.hidden = !state.resumable;
  if (state.resumable) {
    const folder =
      folders.find((f) => f.id === state.resumable!.sourceFolderId)?.path ??
      "a folder";
    el.resumeText.textContent = `An interrupted run on ${folder} classified ${state.resumable.count} message(s). Resume to finish it (already-done messages are skipped) or discard it.`;
  }
  el.resume.disabled = busy;
  el.resumeDiscard.disabled = busy;
}

function renderUndo(state: JobState): void {
  const busy = state.phase === "classifying" || state.phase === "applying";
  el.undoPanel.hidden = !state.undo;
  if (state.undo) {
    el.undoText.textContent = `Last apply moved ${state.undo.count} message(s). You can move them back.`;
  }
  el.undo.disabled = busy;
}

function render(state: JobState): void {
  lastState = state;
  setError(state.error);
  renderProgress(state);
  renderResume(state);
  renderUndo(state);
  renderReview(state);
}

function selectedMessageIds(): number[] {
  const boxes = el.review.querySelectorAll<HTMLInputElement>(".move-checkbox:checked");
  return [...boxes].map((b) => Number(b.dataset.messageId));
}

function downloadReport(): void {
  if (!lastState) return;
  const sourcePath =
    folders.find((f) => f.id === lastState!.sourceFolderId)?.path ?? "(unknown)";
  const markdown = buildMarkdownReport(lastState.results, {
    sourceFolder: sourcePath,
    instruction: lastState.instruction,
    dryRun: el.dryRun.checked || lastState.phase !== "done",
    stopped: lastState.stopped,
    generatedAt: new Date().toISOString(),
  });
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "smartermailsort-report.md";
  a.click();
  URL.revokeObjectURL(url);
}

function wireEvents(): void {
  el.start.addEventListener("click", async () => {
    setError(null);
    const instruction = el.instruction.value.trim();
    if (!instruction) {
      setError("Enter an instruction first.");
      return;
    }
    ensurePort(); // make sure progress updates stream for this run
    const res = await send({
      type: "startClassify",
      sourceFolderId: el.folder.value,
      instruction,
    });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.abort.addEventListener("click", () => void send({ type: "abort" }));

  // Picking a preset fills the instruction and targets it for save/delete.
  el.presetSelect.addEventListener("change", () => {
    const preset = findPreset(presets, el.presetSelect.value);
    if (preset) {
      el.instruction.value = preset.instruction;
      el.presetName.value = preset.name;
    }
    el.deletePreset.disabled = !el.presetSelect.value;
  });

  el.savePreset.addEventListener("click", async () => {
    setError(null);
    const name = el.presetName.value.trim();
    const instruction = el.instruction.value.trim();
    if (!name) {
      setError("Enter a preset name to save.");
      return;
    }
    if (!instruction) {
      setError("Enter an instruction to save as a preset.");
      return;
    }
    presets = upsertPreset(presets, name, instruction);
    if (!(await persistPresets())) return;
    populatePresetSelect();
    el.presetSelect.value = name;
    el.deletePreset.disabled = false;
  });

  el.deletePreset.addEventListener("click", async () => {
    setError(null);
    const name = el.presetSelect.value;
    if (!name) return;
    presets = removePreset(presets, name);
    if (!(await persistPresets())) return;
    el.presetName.value = "";
    populatePresetSelect();
  });

  el.apply.addEventListener("click", async () => {
    if (el.dryRun.checked) {
      downloadReport();
      return;
    }
    const ids = selectedMessageIds();
    if (!ids.length) {
      setError("No messages selected.");
      return;
    }
    ensurePort(); // receive the applying/done state transitions
    const res = await send({ type: "applyMoves", messageIds: ids });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.resume.addEventListener("click", async () => {
    setError(null);
    ensurePort(); // stream progress for the resumed run
    const res = await send({ type: "resume" });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.resumeDiscard.addEventListener("click", async () => {
    const res = await send({ type: "discardResume" });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.undo.addEventListener("click", async () => {
    setError(null);
    ensurePort(); // receive the applying/idle transitions
    const res = await send({ type: "undo" });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.download.addEventListener("click", downloadReport);

  el.settingsLink.addEventListener("click", (event) => {
    event.preventDefault();
    void messenger.runtime.openOptionsPage();
  });
}

/**
 * Render an incoming background state, but ignore one that would erase results
 * we are already showing — e.g. the background event page suspended while idle
 * and respawned empty while the user sits in the review phase.
 */
function applyStateEvent(incoming: JobState): void {
  if (
    lastState &&
    lastState.results.length > 0 &&
    incoming.phase === "idle" &&
    incoming.results.length === 0
  ) {
    return;
  }
  render(incoming);
}

let port: browser.runtime.Port | null = null;

function handlePortMessage(message: unknown): void {
  const event = message as BgEvent;
  if (event.type === "state") applyStateEvent(event.state);
  else if (event.type === "progress" && lastState) {
    lastState.progress = event.progress;
    // A resolved message clears any retry note shown while it was in flight.
    setNote(null);
    renderProgress(lastState);
  } else if (event.type === "notice") {
    setNote(event.notice.message);
  }
}

/**
 * Open the background port if one isn't already open. Deliberately does NOT
 * auto-reconnect on disconnect — the MV3 event page suspends while idle, and a
 * timer-based reconnect produces a "closed conduit" storm. Instead we reconnect
 * lazily: `ensurePort()` is called before each user action, and a live job
 * keeps the background (and the port) alive for the duration.
 */
function ensurePort(): void {
  if (port) return;
  const p = messenger.runtime.connect({ name: PORT_NAME });
  p.onMessage.addListener(handlePortMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
  });
  port = p;
}

async function init(): Promise<void> {
  wireEvents();
  await Promise.all([loadFolders(), loadPresets()]);
  ensurePort();

  const res = await send({ type: "getState" });
  if (res.ok && "state" in res) applyStateEvent(res.state);
}

void init();
