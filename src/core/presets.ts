// Pure helpers for the saved-instruction preset list. Kept free of `messenger.*`
// (persistence lives in platform/presetStore) so the list logic is unit-testable.

import type { Preset } from "./types.js";

/** Case-insensitive, whitespace-trimmed name match. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Find a preset by name (trimmed, case-insensitive). */
export function findPreset(presets: Preset[], name: string): Preset | undefined {
  return presets.find((p) => sameName(p.name, name));
}

/**
 * Add a preset, or overwrite the instruction of an existing one with the same
 * name. The returned list is sorted by name so the dropdown is stable; the
 * input is never mutated. Throws on an empty name.
 */
export function upsertPreset(
  presets: Preset[],
  name: string,
  instruction: string,
): Preset[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("preset name is required");
  const next = presets.filter((p) => !sameName(p.name, trimmed));
  next.push({ name: trimmed, instruction });
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a preset by name (trimmed, case-insensitive). Input is not mutated. */
export function removePreset(presets: Preset[], name: string): Preset[] {
  return presets.filter((p) => !sameName(p.name, name));
}
