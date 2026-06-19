import { describe, expect, it } from "vitest";
import { originMatchPattern } from "../src/core/endpoint.js";

describe("originMatchPattern", () => {
  it("strips the port so the pattern is a valid match pattern", () => {
    // Ports are illegal in match patterns; the host-only pattern covers any port.
    expect(originMatchPattern("http://localhost:11434")).toBe("http://localhost/*");
    expect(originMatchPattern("http://localhost:11434/v1")).toBe("http://localhost/*");
  });

  it("keeps the scheme and host for standard URLs", () => {
    expect(originMatchPattern("https://api.openai.com")).toBe("https://api.openai.com/*");
    expect(originMatchPattern("https://openwebui.example.com/")).toBe(
      "https://openwebui.example.com/*",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(originMatchPattern("  http://localhost:8080  ")).toBe("http://localhost/*");
  });

  it("returns null for invalid or non-http(s) URLs", () => {
    expect(originMatchPattern("not a url")).toBeNull();
    expect(originMatchPattern("")).toBeNull();
    expect(originMatchPattern("ftp://example.com")).toBeNull();
    expect(originMatchPattern("file:///etc/passwd")).toBeNull();
  });
});
