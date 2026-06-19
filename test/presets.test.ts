import { describe, expect, it } from "vitest";
import { findPreset, removePreset, upsertPreset } from "../src/core/presets.js";
import type { Preset } from "../src/core/types.js";

const base: Preset[] = [
  { name: "Finance", instruction: "receipts -> Finance" },
  { name: "Newsletters", instruction: "newsletters -> to_be_deleted" },
];

describe("upsertPreset", () => {
  it("adds a new preset and keeps the list sorted by name", () => {
    const next = upsertPreset(base, "Archive", "old mail -> Archive");
    expect(next.map((p) => p.name)).toEqual(["Archive", "Finance", "Newsletters"]);
  });

  it("overwrites an existing preset's instruction (case-insensitive name)", () => {
    const next = upsertPreset(base, "finance", "invoices -> Finance");
    expect(next.filter((p) => p.name.toLowerCase() === "finance")).toHaveLength(1);
    expect(findPreset(next, "Finance")?.instruction).toBe("invoices -> Finance");
  });

  it("trims the name and rejects an empty one", () => {
    expect(upsertPreset(base, "  Spam  ", "x").some((p) => p.name === "Spam")).toBe(true);
    expect(() => upsertPreset(base, "   ", "x")).toThrow(/required/);
  });

  it("does not mutate the input", () => {
    const copy = [...base];
    upsertPreset(base, "Archive", "x");
    expect(base).toEqual(copy);
  });
});

describe("removePreset", () => {
  it("removes by name (case-insensitive) and leaves others", () => {
    const next = removePreset(base, "newsletters");
    expect(next.map((p) => p.name)).toEqual(["Finance"]);
  });

  it("is a no-op for an unknown name", () => {
    expect(removePreset(base, "Nope")).toHaveLength(2);
  });
});

describe("findPreset", () => {
  it("matches trimmed, case-insensitive", () => {
    expect(findPreset(base, "  finance ")?.instruction).toBe("receipts -> Finance");
    expect(findPreset(base, "missing")).toBeUndefined();
  });
});
