import { describe, expect, it, vi } from "vitest";
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
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock),
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

const ok = () => jsonResponse({ choices: [{ message: { content: "ok" } }] });

describe("chatCompletion retries", () => {
  it("retries a 5xx and succeeds, calling onRetry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 503))
      .mockResolvedValueOnce(ok());
    const onRetry = vi.fn();
    const out = await chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
      maxRetries: 2,
      retryBaseMs: 0,
      onRetry,
    });
    expect(out).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, status: 503 });
  });

  it("retries network errors up to maxRetries then throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
        maxRetries: 2,
        retryBaseMs: 0,
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry a 4xx client error", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "nope" }, false, 400));
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
        maxRetries: 3,
        retryBaseMs: 0,
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours a Retry-After header on 429", async () => {
    const headers = { get: (k: string) => (k.toLowerCase() === "retry-after" ? "0" : null) };
    const resp429 = {
      ok: false,
      status: 429,
      headers,
      json: async () => ({}),
      text: async () => "rate limited",
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(resp429).mockResolvedValueOnce(ok());
    const onRetry = vi.fn();
    const out = await chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
      maxRetries: 1,
      retryBaseMs: 5000,
      onRetry,
    });
    expect(out).toBe("ok");
    // Retry-After of 0s overrides the 5s base backoff.
    expect(onRetry.mock.calls[0][0].delayMs).toBe(0);
  });

  it("does not retry by default (maxRetries unset)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, false, 500));
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the abort signal fires", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new Error("network");
    });
    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], fetchMock, {
        maxRetries: 5,
        retryBaseMs: 0,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
