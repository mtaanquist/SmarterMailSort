import { describe, expect, it } from "vitest";
import {
  extractJsonArray,
  extractJsonObject,
  parseDecision,
  parseDecisions,
} from "../src/core/decisionParser.js";

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

describe("extractJsonArray", () => {
  it("extracts a balanced array from prose and fences", () => {
    const text = 'Here:\n```json\n[{"id":1},{"id":2}]\n```';
    expect(extractJsonArray(text)).toBe('[{"id":1},{"id":2}]');
  });

  it("ignores brackets inside strings", () => {
    const text = '[{"reason":"a ] bracket"}]';
    expect(extractJsonArray(text)).toBe(text);
  });
});

describe("parseDecisions", () => {
  const ids = [1, 2, 3];

  it("parses an object with a results array, keyed by id", () => {
    const raw = JSON.stringify({
      results: [
        { id: 1, action: "move", folder: "Local Folders/archive", reason: "old", confidence: 0.8 },
        { id: 2, action: "keep", reason: "inbox" },
      ],
    });
    const map = parseDecisions(raw, allowed, ids);
    expect(map.get(1)).toEqual({
      action: "move",
      folder: "Local Folders/archive",
      reason: "old",
      confidence: 0.8,
    });
    expect(map.get(2)?.action).toBe("keep");
    // Id 3 was omitted by the model — caller defaults it to keep.
    expect(map.has(3)).toBe(false);
  });

  it("parses a bare top-level array", () => {
    const raw = '[{"id":2,"action":"move","folder":"Local Folders/to_be_deleted","reason":"r"}]';
    const map = parseDecisions(raw, allowed, ids);
    expect(map.get(2)?.folder).toBe("Local Folders/to_be_deleted");
  });

  it("keeps when a batched entry targets an unknown folder", () => {
    const raw = '{"results":[{"id":1,"action":"move","folder":"Nope/x","reason":"r"}]}';
    expect(parseDecisions(raw, allowed, ids).get(1)?.action).toBe("keep");
  });

  it("drops entries with ids that were not in the batch", () => {
    const raw = '{"results":[{"id":99,"action":"keep"},{"id":1,"action":"keep"}]}';
    const map = parseDecisions(raw, allowed, ids);
    expect(map.has(99)).toBe(false);
    expect(map.has(1)).toBe(true);
  });

  it("ignores duplicate ids, keeping the first", () => {
    const raw = '{"results":[{"id":1,"action":"keep","reason":"first"},{"id":1,"action":"move","folder":"Local Folders/archive"}]}';
    const map = parseDecisions(raw, allowed, ids);
    expect(map.get(1)?.action).toBe("keep");
    expect(map.get(1)?.reason).toBe("first");
  });

  it("returns an empty map on unparseable input", () => {
    expect(parseDecisions("garbage", allowed, ids).size).toBe(0);
    expect(parseDecisions("", allowed, ids).size).toBe(0);
  });
});
