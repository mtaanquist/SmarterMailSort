// Thin OpenAI-compatible chat client. Works against OpenAI, OpenWebUI and
// Ollama (which exposes /v1/chat/completions). Pure with respect to the
// extension APIs: it only needs a `fetch` implementation, which is injected so
// tests can run without network access.

import type { LlmConfig, ResponseFormat } from "./types.js";
import type { ChatMessage, NamedSchema } from "./promptBuilder.js";

export type FetchLike = typeof fetch;

/** A concrete response_format the wire request can carry (never "auto"). */
type FormatMode = "json_object" | "json_schema" | "text";

/** Order "auto" tries formats in. `text` (no enforcement) always works last. */
const AUTO_ORDER: FormatMode[] = ["json_object", "json_schema", "text"];

/**
 * Remembers, per endpoint, which response_format the server accepted, so once
 * "auto" has negotiated a working mode we don't re-pay the rejected attempt on
 * every subsequent message. Session-scoped; cleared by tests.
 */
const formatMemo = new Map<string, FormatMode>();

/** Clear the negotiated-format cache (used by tests). */
export function clearResponseFormatCache(): void {
  formatMemo.clear();
}

export class LlmError extends Error {
  readonly status?: number;
  /** Whether the failure is worth retrying (network/timeout/5xx/429). */
  readonly retryable: boolean;
  /** Server-requested wait (from a Retry-After header) in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Details handed to the onRetry callback before each backoff wait. */
export interface RetryInfo {
  /** 1-based index of the upcoming retry. */
  attempt: number;
  /** How long we're about to wait before retrying, in milliseconds. */
  delayMs: number;
  error: LlmError;
}

/** Default retry budget; tunable per-call via {@link ChatOptions}. */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
/** Cap a single backoff wait so a large Retry-After can't stall a run forever. */
const MAX_BACKOFF_MS = 30_000;

/** Automatic per-email and fixed-overhead token budgets (see resolveMaxTokens). */
const AUTO_TOKENS_PER_EMAIL = 200;
const AUTO_TOKENS_OVERHEAD = 200;

/**
 * Resolve the `max_tokens` cap for a request. An explicit positive `setting` is
 * used verbatim (the user's override). `setting <= 0` means "automatic": a budget
 * that scales with `batchSize`, so a single decision is tightly bounded while a
 * large batch still has room for one object per email. Bounding the response is
 * what stops a model that degenerates into a repetition loop from generating
 * until the request times out.
 */
export function resolveMaxTokens(setting: number, batchSize: number): number {
  if (Number.isFinite(setting) && setting > 0) return Math.floor(setting);
  const n = Math.max(1, Math.floor(batchSize || 1));
  return AUTO_TOKENS_OVERHEAD + n * AUTO_TOKENS_PER_EMAIL;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter: base·2^attempt + [0, base). */
function backoffDelay(attempt: number, baseMs: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt);
  return exp + Math.floor(Math.random() * baseMs);
}

/** Resolve after `ms`, or early if `signal` aborts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ChatOptions {
  /** Ask the endpoint for a JSON object response when supported. */
  jsonMode?: boolean;
  /** Optional external abort signal, merged with the per-request timeout. */
  signal?: AbortSignal;
  /** Max retries for transient failures. Defaults to 3; 0 disables retrying. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 500. */
  retryBaseMs?: number;
  /** Called before each backoff wait, e.g. to surface "retrying…" in the UI. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable sleep, primarily so tests can run without real delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Schema for the `json_schema` response_format (required to use that mode). */
  jsonSchema?: NamedSchema;
  /** Resolved `max_tokens` cap for this request; omitted from the body when <= 0. */
  maxTokens?: number;
}

/** Resolve the ordered list of response_format modes to try for a request. */
function candidateModes(
  responseFormat: ResponseFormat,
  options: ChatOptions,
  memoKey: string,
): FormatMode[] {
  if (!options.jsonMode) return ["text"]; // caller didn't ask for JSON enforcement
  // json_schema is only usable when the caller supplied a schema.
  const usable = (m: FormatMode): boolean => m !== "json_schema" || !!options.jsonSchema;
  if (responseFormat !== "auto") {
    return usable(responseFormat) ? [responseFormat] : ["text"];
  }
  const remembered = formatMemo.get(memoKey);
  const order = remembered
    ? [remembered, ...AUTO_ORDER.filter((m) => m !== remembered)]
    : AUTO_ORDER;
  return order.filter(usable);
}

/** Build the `response_format` body field for a given mode (undefined = omit). */
function buildResponseFormat(
  mode: FormatMode,
  schema: NamedSchema | undefined,
): Record<string, unknown> | undefined {
  if (mode === "json_object") return { type: "json_object" };
  if (mode === "json_schema" && schema) {
    return {
      type: "json_schema",
      json_schema: { name: schema.name, schema: schema.schema, strict: true },
    };
  }
  return undefined; // "text": rely on the prompt's JSON instructions
}

/** A 400 specifically complaining about response_format — worth trying another mode. */
function isUnsupportedFormat(err: unknown): boolean {
  return (
    err instanceof LlmError &&
    err.status === 400 &&
    /response_format/i.test(err.message)
  );
}

/**
 * Retry `fn` while it throws a retryable {@link LlmError}, backing off between
 * attempts. Honors a server Retry-After over the computed backoff, and stops
 * immediately on a non-retryable error, an exhausted budget, or an abort.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Required<Pick<ChatOptions, "maxRetries" | "retryBaseMs">> &
    Pick<ChatOptions, "signal" | "onRetry" | "sleep">,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries));
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const error =
        err instanceof LlmError ? err : new LlmError((err as Error).message);
      if (!error.retryable || attempt >= maxRetries || opts.signal?.aborted) {
        throw err;
      }
      const delayMs = error.retryAfterMs ?? backoffDelay(attempt, opts.retryBaseMs);
      attempt++;
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
      if (opts.signal?.aborted) throw err;
    }
  }
}

/** A single, un-retried chat completion attempt using a specific format mode. */
async function chatCompletionOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  options: ChatOptions,
  mode: FormatMode,
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
  // Standard OpenAI sampling knobs. Both are omitted at their no-op default so
  // quirky endpoints never see a field they don't need; both are portable across
  // OpenAI-compatible servers (unlike top_k/repeat_penalty, which are not).
  if (Number.isFinite(config.frequencyPenalty) && config.frequencyPenalty !== 0) {
    body.frequency_penalty = config.frequencyPenalty;
  }
  if (options.maxTokens && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }
  const responseFormat = buildResponseFormat(mode, options.jsonSchema);
  if (responseFormat) body.response_format = responseFormat;

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
    // An external abort is the user cancelling: surface it, don't retry it.
    if (options.signal?.aborted) {
      throw new LlmError("request aborted");
    }
    // Our own timeout, or a genuine network blip — both worth retrying.
    if (controller.signal.aborted) {
      throw new LlmError(`request timed out after ${config.timeoutMs}ms`, {
        retryable: true,
      });
    }
    throw new LlmError(`network error: ${(err as Error).message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new LlmError(`endpoint returned ${response.status}: ${text.slice(0, 300)}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: parseRetryAfter(response.headers?.get?.("Retry-After")),
    });
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
 *
 * Two layers of resilience: transient failures (network, timeout, 5xx, 429) are
 * retried with exponential backoff; and when the endpoint rejects the JSON
 * `response_format` with a 400 (e.g. LM Studio refusing `json_object`), "auto"
 * mode steps to the next supported format (json_object → json_schema → text) and
 * remembers what worked for the endpoint. Throws {@link LlmError} once options
 * are exhausted, on any other non-retryable error, or on a malformed payload.
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  options: ChatOptions = {},
): Promise<string> {
  const memoKey = config.baseUrl;
  const modes = candidateModes(config.responseFormat, options, memoKey);
  const negotiating = config.responseFormat === "auto";

  let lastError: unknown;
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    try {
      const result = await withRetry(
        () => chatCompletionOnce(config, messages, fetchImpl, options, mode),
        {
          maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
          retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
          signal: options.signal,
          onRetry: options.onRetry,
          sleep: options.sleep,
        },
      );
      if (negotiating) formatMemo.set(memoKey, mode);
      return result;
    } catch (err) {
      lastError = err;
      // Only "auto" negotiates; only an unsupported-format 400 falls through.
      if (negotiating && isUnsupportedFormat(err) && i < modes.length - 1) continue;
      throw err;
    }
  }
  throw lastError;
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
