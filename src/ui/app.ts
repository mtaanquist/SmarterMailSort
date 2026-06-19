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
import type { ClassifiedMessage, FolderNode } from "../core/types.js";

const el = {
  folder: document.getElementById("folder") as HTMLSelectElement,
  instruction: document.getElementById("instruction") as HTMLTextAreaElement,
  start: document.getElementById("start") as HTMLButtonElement,
  abort: document.getElementById("abort") as HTMLButtonElement,
  settingsLink: document.getElementById("settings-link") as HTMLAnchorElement,
  progressPanel: document.getElementById("progress-panel") as HTMLElement,
  progress: document.getElementById("progress") as HTMLProgressElement,
  progressText: document.getElementById("progress-text") as HTMLElement,
  reviewPanel: document.getElementById("review-panel") as HTMLElement,
  reviewSummary: document.getElementById("review-summary") as HTMLElement,
  reviewControls: document.getElementById("review-controls") as HTMLElement,
  selectAll: document.getElementById("select-all") as HTMLButtonElement,
  selectNone: document.getElementById("select-none") as HTMLButtonElement,
  confidenceThreshold: document.getElementById("confidence-threshold") as HTMLInputElement,
  confidenceValue: document.getElementById("confidence-value") as HTMLElement,
  selectedCount: document.getElementById("selected-count") as HTMLElement,
  review: document.getElementById("review") as HTMLElement,
  apply: document.getElementById("apply") as HTMLButtonElement,
  download: document.getElementById("download") as HTMLButtonElement,
  dryRun: document.getElementById("dry-run") as HTMLInputElement,
  error: document.getElementById("error") as HTMLElement,
};

let folders: FolderNode[] = [];
let lastState: JobState | null = null;

function send(request: UiRequest): Promise<UiResponse> {
  return messenger.runtime.sendMessage(request) as Promise<UiResponse>;
}

function setError(message: string | null): void {
  el.error.hidden = !message;
  el.error.textContent = message ?? "";
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
  // Bulk-selection controls are only meaningful when there are moves to triage.
  el.reviewControls.hidden = moveCount === 0;
  // Initialise selection state, honouring the current confidence threshold.
  applyThreshold();
}

/** Recompute the global + per-group "selected" counts and the Apply button. */
function updateSelectionUI(): void {
  const all = el.review.querySelectorAll<HTMLInputElement>(".move-checkbox");
  const checked = el.review.querySelectorAll<HTMLInputElement>(".move-checkbox:checked");
  el.selectedCount.textContent = `${checked.length} of ${all.length} selected`;

  for (const group of el.review.querySelectorAll<HTMLElement>(".folder-group")) {
    const boxes = group.querySelectorAll<HTMLInputElement>(".move-checkbox");
    const sel = group.querySelectorAll<HTMLInputElement>(".move-checkbox:checked");
    const groupBox = group.querySelector<HTMLInputElement>(".group-checkbox");
    if (groupBox) {
      groupBox.checked = boxes.length > 0 && sel.length === boxes.length;
      groupBox.indeterminate = sel.length > 0 && sel.length < boxes.length;
    }
    const count = group.querySelector<HTMLElement>(".group-count");
    if (count) count.textContent = ` (${sel.length}/${boxes.length})`;
  }

  el.apply.disabled = !lastState || lastState.phase !== "review" || checked.length === 0;
}

/** Check exactly the moves whose confidence meets the threshold slider. */
function applyThreshold(): void {
  const threshold = Number(el.confidenceThreshold.value);
  el.confidenceValue.textContent = threshold.toFixed(2);
  for (const box of el.review.querySelectorAll<HTMLInputElement>(".move-checkbox")) {
    box.checked = Number(box.dataset.confidence) >= threshold;
  }
  updateSelectionUI();
}

function setAllSelected(checked: boolean): void {
  for (const box of el.review.querySelectorAll<HTMLInputElement>(".move-checkbox")) {
    box.checked = checked;
  }
  updateSelectionUI();
}

function renderFolderGroup(
  folder: string,
  items: ClassifiedMessage[],
): HTMLElement {
  const details = document.createElement("details");
  details.className = "folder-group";
  details.open = true;

  const summary = document.createElement("summary");
  const groupBox = document.createElement("input");
  groupBox.type = "checkbox";
  groupBox.className = "group-checkbox";
  groupBox.checked = true;
  // Toggling the group checkbox shouldn't also open/close the <details>.
  groupBox.addEventListener("click", (event) => event.stopPropagation());
  const title = document.createElement("span");
  title.className = "group-title";
  title.textContent = `→ ${folder}`;
  const count = document.createElement("span");
  count.className = "group-count reason";
  summary.append(groupBox, title, count);
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

function render(state: JobState): void {
  lastState = state;
  setError(state.error);
  renderProgress(state);
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

  el.selectAll.addEventListener("click", () => setAllSelected(true));
  el.selectNone.addEventListener("click", () => setAllSelected(false));
  el.confidenceThreshold.addEventListener("input", applyThreshold);
  // Delegated: a group checkbox toggles its whole group; any change recounts.
  el.review.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("group-checkbox")) {
      const checked = (target as HTMLInputElement).checked;
      target
        .closest(".folder-group")
        ?.querySelectorAll<HTMLInputElement>(".move-checkbox")
        .forEach((box) => {
          box.checked = checked;
        });
    }
    updateSelectionUI();
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
    renderProgress(lastState);
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
  await loadFolders();
  ensurePort();

  const res = await send({ type: "getState" });
  if (res.ok && "state" in res) applyStateEvent(res.state);
}

void init();
