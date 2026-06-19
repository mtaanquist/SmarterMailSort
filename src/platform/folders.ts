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
  parentPath: string,
  depth: number,
  out: FolderNode[],
): void {
  const name = folder.name || folder.path || "(folder)";
  const path = parentPath ? `${parentPath}/${name}` : `${accountName}/${name}`;
  out.push({ id: folderId(folder, accountId), path, depth, accountName });
  for (const child of folder.subFolders ?? []) {
    walk(child, accountName, accountId, path, depth + 1, out);
  }
}

/**
 * Enumerate every folder across all accounts as a flat, depth-tagged list.
 *
 * `accounts.list()` returns each account's root folder but does NOT populate
 * the nested `subFolders` tree (in MV3 subfolders are only included when
 * explicitly requested), so we fetch the hierarchy with
 * `folders.getSubFolders(root, true)`.
 */
export async function listFolderTree(): Promise<FolderNode[]> {
  const accounts = (await messenger.accounts.list()) as unknown as MailAccount[];
  const out: FolderNode[] = [];
  for (const account of accounts) {
    const root = account.rootFolder ?? account;
    let tops: MailFolder[];
    try {
      tops = (await messenger.folders.getSubFolders(
        root as unknown as Parameters<typeof messenger.folders.getSubFolders>[0],
        true,
      )) as unknown as MailFolder[];
    } catch {
      // Fall back to whatever the account object already carried.
      tops = account.rootFolder?.subFolders ?? account.folders ?? [];
    }
    for (const top of tops) {
      walk(top, account.name, account.id, account.name, 0, out);
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
