// Settings persistence via storage.local. The API key lives here too; it never
// leaves the local profile except in the Authorization header to the user's own
// configured endpoint.

import { DEFAULT_SETTINGS, type Settings } from "../core/types.js";

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await messenger.storage.local.get(KEY);
  const partial = (stored[KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...partial };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await messenger.storage.local.set({ [KEY]: settings });
}
