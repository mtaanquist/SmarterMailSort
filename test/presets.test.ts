import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESETS,
  findPreset,
  mergePresets,
  removePreset,
  upsertPreset,
} from "../src/core/presets.js";
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

describe("mergePresets", () => {
  it("adds defaults that are missing and keeps the list sorted", () => {
    const defaults: Preset[] = [
      { name: "Archive", instruction: "a" },
      { name: "Finance", instruction: "default finance" },
    ];
    const next = mergePresets(base, defaults);
    expect(next.map((p) => p.name)).toEqual(["Archive", "Finance", "Newsletters"]);
  });

  it("never overwrites a user preset of the same name (case-insensitive)", () => {
    const defaults: Preset[] = [{ name: "finance", instruction: "default finance" }];
    const next = mergePresets(base, defaults);
    expect(findPreset(next, "Finance")?.instruction).toBe("receipts -> Finance");
    expect(next.filter((p) => p.name.toLowerCase() === "finance")).toHaveLength(1);
  });

  it("does not mutate either input", () => {
    const copy = [...base];
    mergePresets(base, DEFAULT_PRESETS);
    expect(base).toEqual(copy);
  });

  it("seeds the full default set into an empty list", () => {
    const next = mergePresets([], DEFAULT_PRESETS);
    expect(next).toHaveLength(DEFAULT_PRESETS.length);
  });
});

describe("DEFAULT_PRESETS", () => {
  it("has unique, non-empty names and instructions", () => {
    const names = DEFAULT_PRESETS.map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const p of DEFAULT_PRESETS) {
      expect(p.name.trim()).not.toBe("");
      expect(p.instruction.trim()).not.toBe("");
    }
  });
});
