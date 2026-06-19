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
