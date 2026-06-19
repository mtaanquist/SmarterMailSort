// Options page logic: load/save settings, test the endpoint, and request the
// cross-origin host permission for the configured endpoint (must run from this
// user-gesture context, not the background page).

import { originMatchPattern } from "../core/endpoint.js";
import type { UiRequest, UiResponse } from "../core/protocol.js";
import type { ResponseFormat, Settings } from "../core/types.js";

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
    responseFormat: $("responseFormat").value as ResponseFormat,
    maxBodyChars: Number($("maxBodyChars").value),
    concurrency: Number($("concurrency").value),
    batchSize: Number($("batchSize").value),
    maxRetries: Number($("maxRetries").value),
    retryBaseMs: Number($("retryBaseMs").value),
    allowCrossAccount: $("allowCrossAccount").checked,
  };
}

function writeForm(s: Settings): void {
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("temperature").value = String(s.temperature);
  $("timeoutMs").value = String(s.timeoutMs);
  $("responseFormat").value = s.responseFormat;
  $("maxBodyChars").value = String(s.maxBodyChars);
  $("concurrency").value = String(s.concurrency);
  $("batchSize").value = String(s.batchSize);
  $("maxRetries").value = String(s.maxRetries);
  $("retryBaseMs").value = String(s.retryBaseMs);
  $("allowCrossAccount").checked = s.allowCrossAccount;
}

/**
 * Request privileged cross-origin access to the endpoint host. Never throws —
 * a bad URL or denied/failed request resolves to `false` so it can't abort the
 * surrounding save. Must be invoked from a user gesture (the click handler).
 */
async function requestEndpointPermission(baseUrl: string): Promise<boolean> {
  const origin = originMatchPattern(baseUrl);
  if (!origin) {
    setStatus("Invalid endpoint URL (must be http(s)).", "err");
    return false;
  }
  try {
    return await messenger.permissions.request({ origins: [origin] });
  } catch (err) {
    setStatus(`Could not request host permission: ${(err as Error).message}`, "err");
    return false;
  }
}

async function init(): Promise<void> {
  const res = await send({ type: "getSettings" });
  if (res.ok && "settings" in res) writeForm(res.settings);

  const form = document.getElementById("settings-form") as HTMLFormElement;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const settings = readForm();
    // Start the permission request inside the user gesture, but don't let its
    // outcome block or abort persisting the settings.
    const permissionPromise = requestEndpointPermission(settings.baseUrl);
    const saved = await send({ type: "saveSettings", settings });
    const granted = await permissionPromise;
    if (!saved.ok) {
      setStatus(`Save failed: ${errorOf(saved)}`, "err");
    } else if (!granted) {
      setStatus("Saved, but host permission was not granted — requests may be blocked.", "ok");
    } else {
      setStatus("Saved.", "ok");
    }
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
