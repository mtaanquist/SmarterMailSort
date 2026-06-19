// Options page logic: load/save settings, test the endpoint, and request the
// cross-origin host permission for the configured endpoint (must run from this
// user-gesture context, not the background page).

import type { UiRequest, UiResponse } from "../core/protocol.js";
import type { Settings } from "../core/types.js";

function $(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as HTMLInputElement;
}

const status = document.getElementById("status") as HTMLParagraphElement;

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function send(request: UiRequest): Promise<UiResponse> {
  return messenger.runtime.sendMessage(request) as Promise<UiResponse>;
}

function readForm(): Settings {
  return {
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value,
    model: $("model").value.trim(),
    temperature: Number($("temperature").value),
    timeoutMs: Number($("timeoutMs").value),
    maxBodyChars: Number($("maxBodyChars").value),
    concurrency: Number($("concurrency").value),
  };
}

function writeForm(s: Settings): void {
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("temperature").value = String(s.temperature);
  $("timeoutMs").value = String(s.timeoutMs);
  $("maxBodyChars").value = String(s.maxBodyChars);
  $("concurrency").value = String(s.concurrency);
}

/** Request privileged cross-origin access to the endpoint host. */
async function requestEndpointPermission(baseUrl: string): Promise<boolean> {
  let origin: string;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    setStatus("Invalid base URL.", "err");
    return false;
  }
  const granted = await messenger.permissions.request({ origins: [origin] });
  if (!granted) {
    setStatus(
      `Permission for ${origin} was not granted; requests may be blocked.`,
      "err",
    );
  }
  return granted;
}

async function init(): Promise<void> {
  const res = await send({ type: "getSettings" });
  if (res.ok && "settings" in res) writeForm(res.settings);

  const form = document.getElementById("settings-form") as HTMLFormElement;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const settings = readForm();
    await requestEndpointPermission(settings.baseUrl);
    const saved = await send({ type: "saveSettings", settings });
    setStatus(saved.ok ? "Saved." : `Save failed: ${errorOf(saved)}`, saved.ok ? "ok" : "err");
  });

  document.getElementById("test")!.addEventListener("click", async () => {
    const settings = readForm();
    await requestEndpointPermission(settings.baseUrl);
    setStatus("Testing…");
    const result = await send({ type: "testConnection", settings });
    if (result.ok && "models" in result) {
      const list = result.models.length
        ? ` Models: ${result.models.slice(0, 10).join(", ")}`
        : "";
      setStatus(`Connection OK.${list}`, "ok");
    } else {
      setStatus(`Connection failed: ${errorOf(result)}`, "err");
    }
  });
}

function errorOf(res: UiResponse): string {
  return "error" in res ? res.error : "unknown error";
}

void init();
