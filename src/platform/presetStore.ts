// Persistence for saved instruction presets and the last-used instruction, via
// storage.local. Thin wrappers (the list logic lives in core/presets); kept
// separate from settings so each clears independently.

import { DEFAULT_PRESETS, mergePresets } from "../core/presets.js";
import type { Preset } from "../core/types.js";

const PRESETS_KEY = "instructionPresets";
const LAST_KEY = "lastInstruction";
/** Set once the starter presets have been seeded, so we never re-seed. */
const SEEDED_KEY = "presetsSeeded";

export async function loadPresets(): Promise<Preset[]> {
  const stored = await messenger.storage.local.get(PRESETS_KEY);
  const list = stored[PRESETS_KEY] as Preset[] | undefined;
  return Array.isArray(list) ? list : [];
}

export async function savePresets(presets: Preset[]): Promise<void> {
  await messenger.storage.local.set({ [PRESETS_KEY]: presets });
}

/**
 * Seed the starter presets exactly once. Merges (never clobbers) so a user who
 * already has presets keeps them; idempotent via a stored flag, so deleting a
 * seeded preset makes it stay gone rather than reappearing on the next launch.
 */
export async function seedDefaultPresetsOnce(): Promise<void> {
  const stored = await messenger.storage.local.get(SEEDED_KEY);
  if (stored[SEEDED_KEY]) return;
  const existing = await loadPresets();
  await savePresets(mergePresets(existing, DEFAULT_PRESETS));
  await messenger.storage.local.set({ [SEEDED_KEY]: true });
}

export async function loadLastInstruction(): Promise<string> {
  const stored = await messenger.storage.local.get(LAST_KEY);
  const value = stored[LAST_KEY];
  return typeof value === "string" ? value : "";
}

export async function saveLastInstruction(instruction: string): Promise<void> {
  await messenger.storage.local.set({ [LAST_KEY]: instruction });
}
