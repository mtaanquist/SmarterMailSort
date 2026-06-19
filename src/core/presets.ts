// Pure helpers for the saved-instruction preset list. Kept free of `messenger.*`
// (persistence lives in platform/presetStore) so the list logic is unit-testable.

import type { Preset } from "./types.js";

/**
 * Starter presets seeded on first run (and restorable on demand). Each describes
 * *what* to find and suggests a destination by common name rather than hard-
 * coding one, so it works regardless of the user's folder layout — the model
 * still picks from the folders it's actually allowed to target.
 */
export const DEFAULT_PRESETS: Preset[] = [
  {
    name: "Newsletters & promotions",
    instruction:
      "Find newsletters, marketing emails, and promotional announcements (sales, product launches, \"check out our new feature\"). Leave personal messages, receipts, and security/account notifications alone. Move matches to a Newsletters, Promotions, or Archive folder.",
  },
  {
    name: "Receipts & orders",
    instruction:
      "Find purchase receipts, order and shipping confirmations, and invoices. Move them to a Receipts, Orders, or Archive folder. Keep marketing and anything needing a reply.",
  },
  {
    name: "Travel & bookings",
    instruction:
      "Find flight, train, hotel, and other travel or booking confirmations and itineraries. Move them to a Travel folder. Keep general marketing from travel companies.",
  },
  {
    name: "Notifications & alerts",
    instruction:
      "Find automated notifications: app/service alerts, sign-in and security notices, and \"no-reply\" system messages. Move them to a Notifications folder. Keep messages from real people.",
  },
  {
    name: "Social media",
    instruction:
      "Find notifications from social networks (likes, comments, mentions, connection requests, digests). Move them to a Social folder. Keep direct personal correspondence.",
  },
  {
    name: "Expired & time-sensitive",
    instruction:
      "Find mail whose moment has clearly passed: expired offers, invitations for past dates, and \"your document is ready, click to view\" links that have likely expired. Move them to Archive or Trash. Keep anything still actionable.",
  },
];

/** Case-insensitive, whitespace-trimmed name match. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Add every default whose name isn't already present (case-insensitive) to the
 * existing list, never overwriting a user's own preset of the same name. Used
 * both for the first-run seed and the "Restore defaults" action. Sorted by name
 * for a stable dropdown; the input is not mutated.
 */
export function mergePresets(existing: Preset[], defaults: Preset[]): Preset[] {
  const next = [...existing];
  for (const d of defaults) {
    if (!next.some((p) => sameName(p.name, d.name))) next.push({ ...d });
  }
  return next.sort((a, b) => a.name.localeCompare(b.name));
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
