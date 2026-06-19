// Dedicated-tab UI: pick a folder + instruction, watch live progress, review
// the model's proposed moves, then apply the selected ones. State is driven by
// the background event page over a runtime Port.

import { groupMovesByFolder } from "../core/classifier.js";
import { log } from "../core/log.js";
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
  crossAccount: document.getElementById("cross-account") as HTMLInputElement,
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
  reviewControls: document.getElementById("review-controls") as HTMLElement,
  selectAll: document.getElementById("select-all") as HTMLInputElement,
  selectedCount: document.getElementById("selected-count") as HTMLElement,
  confidenceThreshold: document.getElementById("confidence-threshold") as HTMLInputElement,
  confidenceValue: document.getElementById("confidence-value") as HTMLElement,
  review: document.getElementById("review") as HTMLElement,
  apply: document.getElementById("apply") as HTMLButtonElement,
  download: document.getElementById("download") as HTMLButtonElement,
  dryRun: document.getElementById("dry-run") as HTMLInputElement,
  error: document.getElementById("error") as HTMLElement,
};

let folders: FolderNode[] = [];
let presets: Preset[] = [];
let lastState: JobState | null = null;
/** Min confidence below which a proposed move is auto-deselected (0 = none). */
let confidenceThreshold = 0;

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
    // folder-pane context menu on a fresh tab).
    const requested = new URLSearchParams(location.search).get("folder");
    if (requested) preselectFolder(requested);
  }
}

/** Select `folderId` in the source dropdown if it's a folder we know about. */
function preselectFolder(folderId: string): void {
  if (folders.some((f) => f.id === folderId)) {
    el.folder.value = folderId;
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

  // Bulk-selection controls only make sense while reviewing actual moves.
  el.reviewControls.hidden = state.phase !== "review" || moveCount === 0;
  el.confidenceThreshold.value = String(confidenceThreshold);
  el.confidenceValue.textContent = confidenceThreshold.toFixed(2);
  applyThreshold();
  updateSelectionUi();
}

/** Deselect proposed moves whose confidence is below the chosen threshold. */
function applyThreshold(): void {
  for (const cb of el.review.querySelectorAll<HTMLInputElement>(".move-checkbox")) {
    cb.checked = Number(cb.dataset.confidence) >= confidenceThreshold;
  }
}

/** Refresh counts, the global/per-folder tri-state boxes, and the apply button. */
function updateSelectionUi(): void {
  const all = [...el.review.querySelectorAll<HTMLInputElement>(".move-checkbox")];
  const checked = all.filter((c) => c.checked).length;
  el.selectedCount.textContent = `${checked} of ${all.length} selected`;
  el.selectAll.checked = all.length > 0 && checked === all.length;
  el.selectAll.indeterminate = checked > 0 && checked < all.length;

  for (const group of el.review.querySelectorAll<HTMLElement>(".folder-group")) {
    const boxes = [...group.querySelectorAll<HTMLInputElement>(".move-checkbox")];
    const sel = boxes.filter((b) => b.checked).length;
    const folderBox = group.querySelector<HTMLInputElement>(".folder-select");
    if (folderBox) {
      folderBox.checked = boxes.length > 0 && sel === boxes.length;
      folderBox.indeterminate = sel > 0 && sel < boxes.length;
    }
    const count = group.querySelector<HTMLElement>(".folder-count");
    if (count) count.textContent = `(${sel}/${boxes.length})`;
  }

  el.apply.disabled = lastState?.phase !== "review" || checked === 0;
}

function renderFolderGroup(
  folder: string,
  items: ClassifiedMessage[],
): HTMLElement {
  const details = document.createElement("details");
  details.className = "folder-group";
  details.open = true;

  const summary = document.createElement("summary");
  const folderBox = document.createElement("input");
  folderBox.type = "checkbox";
  folderBox.checked = true;
  folderBox.className = "folder-select";
  folderBox.setAttribute("aria-label", `Select all in ${folder}`);
  // A click inside <summary> would otherwise toggle the disclosure open/closed.
  folderBox.addEventListener("click", (e) => e.stopPropagation());
  const label = document.createElement("span");
  label.textContent = `→ ${folder} `;
  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = `(${items.length}/${items.length})`;
  summary.append(folderBox, label, count);
  details.appendChild(summary);

  const table = document.createElement("table");
  for (const item of items) {
    const tr = document.createElement("tr");

    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.messageId = String(item.summary.id);
    checkbox.dataset.confidence = String(item.decision.confidence);
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
      allowCrossAccount: el.crossAccount.checked,
    });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.abort.addEventListener("click", () => {
    // Reconnect first: if the background suspended mid-run the port is dead, and
    // we want the resulting state (idle + resume) to stream back rather than the
    // click being a silent no-op against a respawned, job-less page.
    ensurePort();
    void send({ type: "abort" });
    void refreshState();
  });

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

  el.selectAll.addEventListener("change", () => {
    for (const cb of el.review.querySelectorAll<HTMLInputElement>(".move-checkbox")) {
      cb.checked = el.selectAll.checked;
    }
    updateSelectionUi();
  });

  el.confidenceThreshold.addEventListener("input", () => {
    confidenceThreshold = Number(el.confidenceThreshold.value);
    el.confidenceValue.textContent = confidenceThreshold.toFixed(2);
    applyThreshold();
    updateSelectionUi();
  });

  // Delegated: per-folder select-all toggles its group; any box change updates counts.
  el.review.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("folder-select")) {
      const group = target.closest(".folder-group");
      const checked = (target as HTMLInputElement).checked;
      group
        ?.querySelectorAll<HTMLInputElement>(".move-checkbox")
        .forEach((cb) => (cb.checked = checked));
    }
    updateSelectionUi();
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
/** Guards against scheduling more than one recovery reconnect at a time. */
let recovering = false;

/** Pull the authoritative job state from the background and render it. */
async function refreshState(): Promise<void> {
  const res = await send({ type: "getState" });
  if (res.ok && "state" in res) applyStateEvent(res.state);
}

/**
 * The port dropped. If we were mid-job, this is very likely the event page
 * suspending and taking the run down with it (the in-memory job is gone, but its
 * checkpoint survives). Do ONE delayed reconnect + state pull: the getState wakes
 * a fresh page, which — after its init loads the checkpoint — reports idle with a
 * resumable run, so the UI drops the forever-spinner and shows "Resume" instead
 * of leaving the user staring at a dead progress bar. A single shot (not a timer
 * loop) avoids the "closed conduit" storm a naive auto-reconnect would cause.
 */
function recoverFromDisconnect(): void {
  const busy = lastState?.phase === "classifying" || lastState?.phase === "applying";
  if (!busy || recovering) return;
  recovering = true;
  setTimeout(() => {
    recovering = false;
    log("UI: recovering after mid-job port loss");
    ensurePort();
    void refreshState();
  }, 800);
}

function handlePortMessage(message: unknown): void {
  const event = message as BgEvent;
  if (event.type === "state") {
    log("UI: state ←", event.state.phase);
    applyStateEvent(event.state);
  }
  else if (event.type === "progress" && lastState) {
    lastState.progress = event.progress;
    // A resolved message clears any retry note shown while it was in flight.
    setNote(null);
    renderProgress(lastState);
  } else if (event.type === "notice") {
    setNote(event.notice.message);
  } else if (event.type === "preselectFolder") {
    // Sent when launched from the folder menu onto an already-open tab.
    preselectFolder(event.folderId);
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
  log("UI: opening port");
  const p = messenger.runtime.connect({ name: PORT_NAME });
  p.onMessage.addListener(handlePortMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    log("UI: port disconnected", { phase: lastState?.phase ?? null });
    recoverFromDisconnect();
  });
  port = p;
}

async function init(): Promise<void> {
  log("UI: app loaded");
  wireEvents();
  await Promise.all([loadFolders(), loadPresets()]);
  ensurePort();
  await refreshState();
}

void init();
