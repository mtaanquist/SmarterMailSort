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
    /** Whether retrying the request might succeed (transient failure). */
    readonly retryable: boolean = false,
    /** Server-requested delay before retrying, in ms (from Retry-After). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Default base backoff in ms when the caller doesn't override it. */
const DEFAULT_RETRY_BASE_MS = 500;
/** Upper bound on a single backoff wait, so a huge Retry-After can't hang a run. */
const MAX_BACKOFF_MS = 30_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/** Exponential backoff with a little jitter, clamped to MAX_BACKOFF_MS. */
function backoffDelay(baseMs: number, attempt: number): number {
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return Math.min(MAX_BACKOFF_MS, Math.round(exp + jitter));
}

/** Resolve after `ms`, or reject early if the abort signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError("request aborted during backoff"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError("request aborted during backoff"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export interface RetryInfo {
  /** 1-based attempt number that is about to be retried. */
  attempt: number;
  /** How long we will wait before the retry, in ms. */
  delayMs: number;
  /** Human-readable reason for the retry. */
  reason: string;
  /** HTTP status that triggered the retry, when applicable. */
  status?: number;
}

export interface ChatOptions {
  /** Ask the endpoint for a JSON object response when supported. */
  jsonMode?: boolean;
  /** Optional external abort signal, merged with the per-request timeout. */
  signal?: AbortSignal;
  /** Max retries on transient failures (429, 5xx, network, timeout). 0 = none. */
  maxRetries?: number;
  /** Base backoff in ms (doubled each attempt). Defaults to 500. */
  retryBaseMs?: number;
  /** Notified just before each retry wait (e.g. to log "retrying…"). */
  onRetry?: (info: RetryInfo) => void;
}

/** Run a single chat-completion attempt; throws a classified {@link LlmError}. */
async function attemptChat(
  config: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  options: ChatOptions,
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
    // An external abort (user stop) is terminal; our own timeout is transient.
    if (options.signal?.aborted) {
      throw new LlmError("request aborted", undefined, false);
    }
    if (controller.signal.aborted) {
      throw new LlmError(`request timed out after ${config.timeoutMs}ms`, undefined, true);
    }
    throw new LlmError(`network error: ${(err as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryAfter =
      response.status === 429 || response.status === 503
        ? (parseRetryAfter(response.headers?.get?.("retry-after") ?? null) ?? undefined)
        : undefined;
    throw new LlmError(
      `endpoint returned ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      isRetryableStatus(response.status),
      retryAfter,
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

/**
 * Send a chat completion request and return the assistant's text content.
 * Retries transient failures (429, 5xx, network errors, timeouts) with
 * exponential backoff, honouring a Retry-After header when present.
 * Throws {@link LlmError} on terminal errors or once retries are exhausted.
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  options: ChatOptions = {},
): Promise<string> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
  const baseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) {
      throw new LlmError("request aborted", undefined, false);
    }
    try {
      return await attemptChat(config, messages, fetchImpl, options);
    } catch (err) {
      const retryable =
        err instanceof LlmError &&
        err.retryable &&
        attempt < maxRetries &&
        !options.signal?.aborted;
      if (!retryable) throw err;

      const e = err as LlmError;
      const delayMs = e.retryAfterMs ?? backoffDelay(baseMs, attempt);
      options.onRetry?.({
        attempt: attempt + 1,
        delayMs,
        reason: e.message,
        status: e.status,
      });
      await delay(delayMs, options.signal);
    }
  }
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
