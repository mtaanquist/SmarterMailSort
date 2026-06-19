// Thin wrapper over the accounts/folders WebExtension APIs. Isolated here so
// the rest of the code depends on plain FolderRef objects and this module can
// be exercised against a mocked `messenger` global in tests.

import type { FolderNode } from "../core/types.js";

export type { FolderNode } from "../core/types.js";

type MailFolder = {
  id?: string;
  name?: string;
  path?: string;
  subFolders?: MailFolder[];
};

type MailAccount = {
  id: string;
  name: string;
  rootFolder?: MailFolder;
  folders?: MailFolder[];
};

function folderId(folder: MailFolder, accountId: string): string {
  // Prefer the stable MV3 folder id; fall back to account+path composite.
  return folder.id ?? `${accountId}:${folder.path ?? ""}`;
}

function walk(
  folder: MailFolder,
  accountName: string,
  accountId: string,
  prefix: string,
  depth: number,
  out: FolderNode[],
): void {
  const name = folder.name ?? folder.path ?? "";
  const path = prefix ? `${prefix}/${name}` : `${accountName}/${name}`;
  // Skip the synthetic root folder (no name) but still descend into it.
  if (name) {
    out.push({ id: folderId(folder, accountId), path, depth, accountName });
  }
  const children = folder.subFolders ?? [];
  for (const child of children) {
    walk(child, accountName, accountId, name ? path : `${accountName}`, name ? depth + 1 : depth, out);
  }
}

/** Enumerate every folder across all accounts as a flat, depth-tagged list. */
export async function listFolderTree(): Promise<FolderNode[]> {
  const accounts = (await messenger.accounts.list()) as unknown as MailAccount[];
  const out: FolderNode[] = [];
  for (const account of accounts) {
    const roots = account.rootFolder
      ? [account.rootFolder]
      : (account.folders ?? []);
    for (const root of roots) {
      walk(root, account.name, account.id, "", 0, out);
    }
  }
  return out;
}

/** Build the allowed-target set and an id lookup the apply step needs. */
export function toFolderIndex(nodes: FolderNode[]): {
  allowedPaths: Set<string>;
  byPath: Map<string, FolderNode>;
} {
  const allowedPaths = new Set<string>();
  const byPath = new Map<string, FolderNode>();
  for (const node of nodes) {
    allowedPaths.add(node.path);
    byPath.set(node.path, node);
  }
  return { allowedPaths, byPath };
}
