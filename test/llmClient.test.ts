import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletion,
  clearResponseFormatCache,
  LlmError,
  resolveMaxTokens,
  testConnection,
} from "../src/core/llmClient.js";
import type { LlmConfig } from "../src/core/types.js";

const config: LlmConfig = {
  baseUrl: "http://localhost:11434/",
  apiKey: "secret",
  model: "llama3.1",
  temperature: 0,
  frequencyPenalty: 0,
  maxTokens: 0,
  timeoutMs: 5000,
  responseFormat: "auto",
};

// The format-negotiation cache is module-scoped; isolate it per test.
afterEach(() => clearResponseFormatCache());

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** An error Response with optional headers (e.g. Retry-After) and body text. */
function errorResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "err",
): Response {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: false,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

const SCHEMA = { name: "decision", schema: { type: "object" } };
const formatError = '{"error":"\'response_format.type\' must be \'json_schema\' or \'text\'"}';

/** Read the parsed request body from a fetch mock call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
}

const user = [{ role: "user" as const, content: "hi" }];
const okBody = { choices: [{ message: { content: "ok" } }] };

describe("chatCompletion", () => {
  it("posts to /v1/chat/completions and returns the content", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "hello" } }] }),
    );
    const out = await chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
      jsonMode: true,
    });
    expect(out).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("llama3.1");
  });

  it("throws LlmError on non-2xx", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad" }, false, 500));
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("throws when content is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock),
    ).rejects.toThrow(/missing/);
  });

  it("omits Authorization when no api key", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await chatCompletion({ ...config, apiKey: "" }, [{ role: "user", content: "hi" }], fetchMock);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("chatCompletion (retries)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries a 429 then succeeds, honoring Retry-After", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return call === 1 ? errorResponse(429, { "Retry-After": "2" }) : jsonResponse(okBody);
    });
    const delays: number[] = [];
    const out = await chatCompletion(config, user, fetchMock, {
      sleep: async (ms) => void delays.push(ms),
    });
    expect(out).toBe("ok");
    expect(call).toBe(2);
    expect(delays).toEqual([2000]); // Retry-After 2s wins over backoff
  });

  it("backs off exponentially and gives up after maxRetries on 5xx", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // zero jitter -> exact delays
    const fetchMock = vi.fn(async () => errorResponse(503));
    const onRetry = vi.fn();
    const delays: number[] = [];
    await expect(
      chatCompletion(config, user, fetchMock, {
        maxRetries: 2,
        retryBaseMs: 100,
        sleep: async (ms) => void delays.push(ms),
        onRetry,
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100, 200]); // base·2^0, base·2^1
  });

  it("does not retry a non-retryable 4xx", async () => {
    const fetchMock = vi.fn(async () => errorResponse(400));
    const onRetry = vi.fn();
    await expect(
      chatCompletion(config, user, fetchMock, { onRetry }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a transient network error", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("ECONNRESET");
      return jsonResponse(okBody);
    });
    const out = await chatCompletion(config, user, fetchMock, {
      sleep: async () => {},
    });
    expect(out).toBe("ok");
    expect(call).toBe(2);
  });

  it("does not retry once the external signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => errorResponse(429));
    const onRetry = vi.fn();
    await expect(
      chatCompletion(config, user, fetchMock, { signal: controller.signal, onRetry }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("chatCompletion (response_format negotiation)", () => {
  it("auto falls back from json_object to json_schema and remembers it", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      // First attempt (json_object) is rejected; json_schema is accepted.
      return call === 1 ? errorResponse(400, {}, formatError) : jsonResponse(okBody);
    });
    const out = await chatCompletion(config, user, fetchMock, {
      jsonMode: true,
      jsonSchema: SCHEMA,
    });
    expect(out).toBe("ok");
    expect(bodyOf(fetchMock, 0).response_format).toEqual({ type: "json_object" });
    expect(bodyOf(fetchMock, 1).response_format).toMatchObject({ type: "json_schema" });

    // A subsequent call should start straight at the remembered json_schema.
    const out2 = await chatCompletion(config, user, fetchMock, {
      jsonMode: true,
      jsonSchema: SCHEMA,
    });
    expect(out2).toBe("ok");
    expect(bodyOf(fetchMock, 2).response_format).toMatchObject({ type: "json_schema" });
  });

  it("auto falls back to plain text (no response_format) when schemas are rejected too", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { response_format?: unknown };
      return body.response_format ? errorResponse(400, {}, formatError) : jsonResponse(okBody);
    });
    const out = await chatCompletion(config, user, fetchMock, {
      jsonMode: true,
      jsonSchema: SCHEMA,
    });
    expect(out).toBe("ok");
    // Last attempt carried no response_format at all.
    expect(bodyOf(fetchMock, fetchMock.mock.calls.length - 1).response_format).toBeUndefined();
  });

  it("does not fall back on a 400 unrelated to response_format", async () => {
    const fetchMock = vi.fn(async () => errorResponse(400, {}, "bad request: model not found"));
    await expect(
      chatCompletion(config, user, fetchMock, { jsonMode: true, jsonSchema: SCHEMA }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit json_schema setting sends the schema and does not negotiate", async () => {
    const fetchMock = vi.fn(async () => errorResponse(400, {}, formatError));
    await expect(
      chatCompletion({ ...config, responseFormat: "json_schema" }, user, fetchMock, {
        jsonMode: true,
        jsonSchema: SCHEMA,
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no fallback for an explicit mode
    expect(bodyOf(fetchMock, 0).response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "decision", strict: true },
    });
  });

  it("an explicit text setting sends no response_format", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okBody));
    await chatCompletion({ ...config, responseFormat: "text" }, user, fetchMock, {
      jsonMode: true,
      jsonSchema: SCHEMA,
    });
    expect(bodyOf(fetchMock, 0).response_format).toBeUndefined();
  });
});

describe("resolveMaxTokens", () => {
  it("uses an explicit positive setting verbatim", () => {
    expect(resolveMaxTokens(1500, 20)).toBe(1500);
    expect(resolveMaxTokens(800, 1)).toBe(800);
  });

  it("scales automatically with batch size when the setting is 0", () => {
    // overhead 200 + 200/email
    expect(resolveMaxTokens(0, 1)).toBe(400);
    expect(resolveMaxTokens(0, 20)).toBe(4200);
  });

  it("treats a non-positive or non-finite setting as automatic", () => {
    expect(resolveMaxTokens(-5, 1)).toBe(400);
    expect(resolveMaxTokens(NaN, 2)).toBe(600);
  });

  it("floors a fractional batch size to at least one email", () => {
    expect(resolveMaxTokens(0, 0)).toBe(400);
  });
});

describe("chatCompletion (sampling knobs)", () => {
  it("sends max_tokens when a positive cap is given, omits it otherwise", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    );
    await chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
      maxTokens: 512,
    });
    expect(bodyOf(fetchMock, 0).max_tokens).toBe(512);

    const fetchMock2 = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    );
    await chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock2, {
      maxTokens: 0,
    });
    expect(bodyOf(fetchMock2, 0).max_tokens).toBeUndefined();
  });

  it("sends frequency_penalty only when non-zero", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    );
    await chatCompletion(
      { ...config, frequencyPenalty: 0.3 },
      [{ role: "user", content: "hi" }],
      fetchMock,
    );
    expect(bodyOf(fetchMock, 0).frequency_penalty).toBe(0.3);

    const fetchMock2 = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    );
    await chatCompletion(
      { ...config, frequencyPenalty: 0 },
      [{ role: "user", content: "hi" }],
      fetchMock2,
    );
    expect(bodyOf(fetchMock2, 0).frequency_penalty).toBeUndefined();
  });
});

describe("testConnection", () => {
  it("returns model ids on success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: "llama3.1" }, { id: "qwen" }] }),
    );
    const result = await testConnection(config, fetchMock);
    expect(result).toEqual({ ok: true, models: ["llama3.1", "qwen"] });
  });

  it("returns an error string on failure status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 404));
    const result = await testConnection(config, fetchMock);
    expect(result.ok).toBe(false);
  });
});
