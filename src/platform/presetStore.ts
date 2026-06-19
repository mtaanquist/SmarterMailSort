// Persistence for saved instruction presets and the last-used instruction, via
// storage.local. Thin wrappers (the list logic lives in core/presets); kept
// separate from settings so each clears independently.

import type { Preset } from "../core/types.js";

const PRESETS_KEY = "instructionPresets";
const LAST_KEY = "lastInstruction";

export async function loadPresets(): Promise<Preset[]> {
  const stored = await messenger.storage.local.get(PRESETS_KEY);
  const list = stored[PRESETS_KEY] as Preset[] | undefined;
  return Array.isArray(list) ? list : [];
}

export async function savePresets(presets: Preset[]): Promise<void> {
  await messenger.storage.local.set({ [PRESETS_KEY]: presets });
}

export async function loadLastInstruction(): Promise<string> {
  const stored = await messenger.storage.local.get(LAST_KEY);
  const value = stored[LAST_KEY];
  return typeof value === "string" ? value : "";
}

export async function saveLastInstruction(instruction: string): Promise<void> {
  await messenger.storage.local.set({ [LAST_KEY]: instruction });
}
