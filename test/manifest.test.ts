import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression guard for MV3 manifest invariants. This caught (would have caught)
// the v0.2.0 bug where the MV2-only `browser_action` key left the toolbar API
// undefined and crashed the background script on load.
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/manifest.json", import.meta.url)), "utf8"),
) as {
  manifest_version: number;
  permissions?: string[];
  action?: unknown;
  browser_action?: unknown;
  background?: { scripts?: string[] };
};

describe("manifest invariants", () => {
  it("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("uses the MV3 `action` key, not the MV2 `browser_action` key", () => {
    expect(manifest.action).toBeDefined();
    expect(manifest.browser_action).toBeUndefined();
  });

  it("declares the permissions the extension relies on", () => {
    for (const perm of ["accountsRead", "messagesRead", "messagesMove", "menus", "storage", "alarms"]) {
      expect(manifest.permissions).toContain(perm);
    }
  });

  it("registers an event-page background script (not a service worker)", () => {
    expect(manifest.background?.scripts).toContain("background/index.js");
  });
});
