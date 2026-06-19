// Thin wrapper over the accounts/folders WebExtension APIs. Isolated here so
// the rest of the code depends on plain FolderRef objects and this module can
// be exercised against a mocked `messenger` global in tests.

import type { FolderNode } from "../core/types.js";

export type { FolderNode } from "../core/types.js";

type MailFolder = {
  id?: string;
  name?: string;
  path?: string;
  accountId?: string;
  isRoot?: boolean;
  isVirtual?: boolean;
  isUnified?: boolean;
  isTag?: boolean;
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

/** Skip account roots and the special virtual/unified/tag folders. */
function isSelectable(folder: MailFolder): boolean {
  return !!folder.id && !folder.isRoot && !folder.isVirtual && !folder.isUnified && !folder.isTag;
}

/**
 * Enumerate every folder across all accounts as a flat, depth-tagged list.
 *
 * Primary path: `folders.query({})` (TB 121+) returns every folder in one flat
 * call. Fallback for older builds / failures: walk each account's root via
 * `getSubFolders(rootFolderId, true)` — note the API takes a MailFolderId
 * STRING, not a folder object. As a last resort the root folder is exposed so
 * the picker is never silently empty.
 */
async function listViaQuery(
  accountNames: Map<string, string>,
): Promise<FolderNode[]> {
  const all = (await messenger.folders.query({})) as unknown as MailFolder[];
  const out: FolderNode[] = [];
  for (const folder of all) {
    if (!isSelectable(folder)) continue;
    const accountName =
      (folder.accountId && accountNames.get(folder.accountId)) || folder.accountId || "";
    const rel = (folder.path ?? "").replace(/^\/+/, "");
    const depth = rel ? rel.split("/").length - 1 : 0;
    out.push({
      id: folder.id!,
      path: `${accountName}/${rel || (folder.name ?? "(folder)")}`,
      depth,
      accountName,
    });
  }
  return out;
}

async function listViaWalk(accounts: MailAccount[]): Promise<FolderNode[]> {
  const out: FolderNode[] = [];
  for (const account of accounts) {
    const root = account.rootFolder;
    let tops: MailFolder[] = [];
    if (root?.id) {
      try {
        // getSubFolders takes a MailFolderId string, not a folder object.
        tops = (await messenger.folders.getSubFolders(
          root.id,
          true,
        )) as unknown as MailFolder[];
      } catch (err) {
        console.warn("SmarterMailSort: getSubFolders failed", err);
      }
    }
    if (!tops.length) tops = root?.subFolders ?? account.folders ?? (root ? [root] : []);
    for (const top of tops) {
      walk(top, account.name, account.id, account.name, 0, out);
    }
  }
  return out;
}

export async function listFolderTree(): Promise<FolderNode[]> {
  const accounts = (await messenger.accounts.list()) as unknown as MailAccount[];
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));

  try {
    const viaQuery = await listViaQuery(accountNames);
    if (viaQuery.length) return viaQuery;
  } catch (err) {
    console.warn("SmarterMailSort: folders.query failed, falling back", err);
  }

  const out = await listViaWalk(accounts);
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
