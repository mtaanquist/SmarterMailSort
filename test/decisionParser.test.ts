import { describe, expect, it } from "vitest";
import {
  extractJsonArray,
  extractJsonObject,
  parseDecision,
  parseDecisions,
  parseTriageDecision,
  parseTriageDecisions,
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

describe("parseTriageDecision", () => {
  it("escalates on an explicit unsure action", () => {
    const raw = '{"action":"unsure","folder":null,"reason":"need body","confidence":0.2}';
    expect(parseTriageDecision(raw, allowed)).toEqual({ kind: "escalate" });
  });

  it("returns a decided move when the model commits", () => {
    const raw = '{"action":"move","folder":"Local Folders/archive","reason":"old","confidence":0.9}';
    expect(parseTriageDecision(raw, allowed)).toEqual({
      kind: "decided",
      decision: {
        action: "move",
        folder: "Local Folders/archive",
        reason: "old",
        confidence: 0.9,
      },
    });
  });

  it("returns a decided keep for a keep action", () => {
    const raw = '{"action":"keep","folder":null,"reason":"personal","confidence":0.8}';
    const t = parseTriageDecision(raw, allowed);
    expect(t).toEqual({
      kind: "decided",
      decision: { action: "keep", folder: null, reason: "personal", confidence: 0.8 },
    });
  });

  it("escalates rather than keeping when the reply can't be parsed", () => {
    expect(parseTriageDecision("not json", allowed)).toEqual({ kind: "escalate" });
    expect(parseTriageDecision("", allowed)).toEqual({ kind: "escalate" });
  });
});

describe("parseTriageDecisions", () => {
  const ids = [1, 2, 3];

  it("maps unsure to escalate and decisions to decided, keyed by id", () => {
    const raw = JSON.stringify({
      results: [
        { id: 1, action: "move", folder: "Local Folders/archive", reason: "x", confidence: 1 },
        { id: 2, action: "unsure", folder: null, reason: "?", confidence: 0 },
        { id: 3, action: "keep", folder: null, reason: "y", confidence: 0.5 },
      ],
    });
    const out = parseTriageDecisions(raw, allowed, ids);
    expect(out.get(1)).toEqual({
      kind: "decided",
      decision: { action: "move", folder: "Local Folders/archive", reason: "x", confidence: 1 },
    });
    expect(out.get(2)).toEqual({ kind: "escalate" });
    expect(out.get(3)?.kind).toBe("decided");
  });

  it("omits ids the model never returned (callers default them to escalate)", () => {
    const raw = JSON.stringify({
      results: [{ id: 1, action: "keep", folder: null, reason: "x", confidence: 0 }],
    });
    const out = parseTriageDecisions(raw, allowed, ids);
    expect(out.has(1)).toBe(true);
    expect(out.has(2)).toBe(false);
    expect(out.has(3)).toBe(false);
  });
});
