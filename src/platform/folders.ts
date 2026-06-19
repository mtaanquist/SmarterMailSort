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
 * `folders.getSubFolders(...)`. Several argument shapes are tried for
 * resilience across Thunderbird versions, and we degrade to whatever the
 * account object already carried (and finally to the root folder itself) so
 * the picker is never silently empty.
 */
type GetSubFoldersArg = Parameters<typeof messenger.folders.getSubFolders>[0];

async function fetchTopFolders(account: MailAccount): Promise<MailFolder[]> {
  const root = account.rootFolder;
  // Try the documented argument shapes in order; the account object and its
  // root folder are both accepted by getSubFolders depending on version.
  const candidates: GetSubFoldersArg[] = [
    account as unknown as GetSubFoldersArg,
    ...(root ? [root as unknown as GetSubFoldersArg] : []),
  ];
  for (const arg of candidates) {
    try {
      const result = (await messenger.folders.getSubFolders(
        arg,
        true,
      )) as unknown as MailFolder[];
      if (Array.isArray(result) && result.length) return result;
    } catch (err) {
      console.warn("SmarterMailSort: getSubFolders failed", err);
    }
  }
  // Degrade to inline folders, or finally the root itself, so the account is
  // still selectable rather than showing an empty picker.
  const inline = root?.subFolders ?? account.folders ?? [];
  if (inline.length) return inline;
  return root ? [root] : [];
}

export async function listFolderTree(): Promise<FolderNode[]> {
  const accounts = (await messenger.accounts.list()) as unknown as MailAccount[];
  const out: FolderNode[] = [];
  for (const account of accounts) {
    const tops = await fetchTopFolders(account);
    for (const top of tops) {
      walk(top, account.name, account.id, account.name, 0, out);
    }
  }
  if (!out.length) {
    console.warn("SmarterMailSort: no folders found across", accounts.length, "account(s)");
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
