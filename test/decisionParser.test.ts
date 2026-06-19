import { describe, expect, it } from "vitest";
import { extractJsonObject, parseDecision } from "../src/core/decisionParser.js";

const allowed = new Set(["Local Folders/to_be_deleted", "Local Folders/archive"]);

describe("extractJsonObject", () => {
  it("extracts a balanced object from surrounding prose and fences", () => {
    const text = 'Sure!\n```json\n{"action":"keep","reason":"x"}\n```';
    expect(extractJsonObject(text)).toBe('{"action":"keep","reason":"x"}');
  });

  it("handles braces inside strings", () => {
    const text = '{"reason":"has } brace","action":"keep"}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("returns null when no object present", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("parseDecision", () => {
  it("parses a valid move into an allowed folder", () => {
    const raw = '{"action":"move","folder":"Local Folders/archive","reason":"old","confidence":0.9}';
    expect(parseDecision(raw, allowed)).toEqual({
      action: "move",
      folder: "Local Folders/archive",
      reason: "old",
      confidence: 0.9,
    });
  });

  it("keeps when the model targets an unknown folder", () => {
    const raw = '{"action":"move","folder":"Nope/x","reason":"r"}';
    const decision = parseDecision(raw, allowed);
    expect(decision.action).toBe("keep");
    expect(decision.folder).toBeNull();
  });

  it("forces folder null on keep", () => {
    const raw = '{"action":"keep","folder":"Local Folders/archive"}';
    expect(parseDecision(raw, allowed).folder).toBeNull();
  });

  it("clamps confidence into 0..1", () => {
    const raw = '{"action":"keep","reason":"r","confidence":5}';
    expect(parseDecision(raw, allowed).confidence).toBe(1);
  });

  it("defaults to keep on unparseable input", () => {
    expect(parseDecision("garbage", allowed).action).toBe("keep");
    expect(parseDecision("", allowed).action).toBe("keep");
  });
});
