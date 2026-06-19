// Thin OpenAI-compatible chat client. Works against OpenAI, OpenWebUI and
// Ollama (which exposes /v1/chat/completions). Pure with respect to the
// extension APIs: it only needs a `fetch` implementation, which is injected so
// tests can run without network access.

import type { LlmConfig } from "./types.js";
import type { ChatMessage } from "./promptBuilder.js";

export type FetchLike = typeof fetch;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export interface ChatOptions {
  /** Ask the endpoint for a JSON object response when supported. */
  jsonMode?: boolean;
  /** Optional external abort signal, merged with the per-request timeout. */
  signal?: AbortSignal;
}

/**
 * Send a chat completion request and return the assistant's text content.
 * Throws {@link LlmError} on non-2xx responses, timeouts or malformed payloads.
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  options: ChatOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort());
  }

  const body: Record<string, unknown> = {
    model: config.model,
    temperature: config.temperature,
    messages,
    stream: false,
  };
  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(config.apiKey),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LlmError(`request timed out after ${config.timeoutMs}ms`);
    }
    throw new LlmError(`network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new LlmError(
      `endpoint returned ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
  };
  try {
    payload = await response.json();
  } catch {
    throw new LlmError("endpoint returned non-JSON body");
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("endpoint response missing choices[0].message.content");
  }
  return content;
}

/** Lightweight connectivity probe used by the options "Test connection" button. */
export async function testConnection(
  config: LlmConfig,
  fetchImpl: FetchLike,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(config.baseUrl, "/v1/models"), {
      method: "GET",
      headers: authHeaders(config.apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `endpoint returned ${response.status}` };
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return { ok: true, models };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `timed out after ${config.timeoutMs}ms` };
    }
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
