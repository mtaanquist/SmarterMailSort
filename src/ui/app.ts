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
  if (res.ok && "folders" in res) {
    folders = res.folders;
    el.folder.innerHTML = "";
    for (const node of folders) {
      const option = document.createElement("option");
      option.value = node.id;
      option.textContent = `${" ".repeat(node.depth * 2)}${node.path}`;
      el.folder.appendChild(option);
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
  el.reviewSummary.textContent =
    state.phase === "done"
      ? `Done. ${moveCount} move(s) were processed.`
      : `${state.results.length} classified · ${moveCount} proposed move(s) · ${errors} error(s).`;

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
    const res = await send({
      type: "startClassify",
      sourceFolderId: el.folder.value,
      instruction,
    });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.abort.addEventListener("click", () => void send({ type: "abort" }));

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
    const res = await send({ type: "applyMoves", messageIds: ids });
    if (!res.ok && "error" in res) setError(res.error);
  });

  el.download.addEventListener("click", downloadReport);

  el.settingsLink.addEventListener("click", (event) => {
    event.preventDefault();
    void messenger.runtime.openOptionsPage();
  });
}

async function init(): Promise<void> {
  wireEvents();
  await loadFolders();

  const port = messenger.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((message) => {
    const event = message as BgEvent;
    if (event.type === "state") render(event.state);
    else if (event.type === "progress" && lastState) {
      lastState.progress = event.progress;
      renderProgress(lastState);
    }
  });

  const res = await send({ type: "getState" });
  if (res.ok && "state" in res) render(res.state);
}

void init();
