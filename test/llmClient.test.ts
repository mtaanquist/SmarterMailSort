import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, LlmError, testConnection } from "../src/core/llmClient.js";
import type { LlmConfig } from "../src/core/types.js";

const config: LlmConfig = {
  baseUrl: "http://localhost:11434/",
  apiKey: "secret",
  model: "llama3.1",
  temperature: 0,
  timeoutMs: 5000,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** An error Response with optional headers (e.g. Retry-After). */
function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: false,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => "err",
  } as unknown as Response;
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
