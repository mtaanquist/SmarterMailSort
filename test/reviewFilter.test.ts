import { describe, expect, it } from "vitest";
import { matchesKeywords, parseKeywords } from "../src/core/reviewFilter.js";

describe("parseKeywords", () => {
  it("splits on commas, trims, lowercases, and drops empties", () => {
    expect(parseKeywords("  Newsletter , INVOICE ,, black friday ")).toEqual([
      "newsletter",
      "invoice",
      "black friday",
    ]);
  });

  it("returns an empty list for a blank query", () => {
    expect(parseKeywords("   ")).toEqual([]);
    expect(parseKeywords(",, ,")).toEqual([]);
  });
});

describe("matchesKeywords", () => {
  const keywords = parseKeywords("newsletter, invoice");

  it("matches a case-insensitive substring of any term", () => {
    expect(matchesKeywords("Weekly Newsletter — issue 12", keywords)).toBe(true);
    expect(matchesKeywords("Your INVOICE is ready", keywords)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesKeywords("Lunch tomorrow?", keywords)).toBe(false);
  });

  it("matches multi-word terms verbatim", () => {
    const black = parseKeywords("black friday");
    expect(matchesKeywords("Black Friday doorbusters", black)).toBe(true);
    expect(matchesKeywords("friday black", black)).toBe(false);
  });

  it("treats an empty keyword list as matching nothing", () => {
    expect(matchesKeywords("anything at all", [])).toBe(false);
  });
});
