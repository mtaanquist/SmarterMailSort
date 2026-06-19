import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFolderTree, toFolderIndex } from "../src/platform/folders.js";
import { clearMockMessenger, installMockMessenger, type MockMessenger } from "./mocks/messenger.js";

let mock: MockMessenger;

beforeEach(() => {
  mock = installMockMessenger();
});
afterEach(() => clearMockMessenger());

describe("listFolderTree", () => {
  it("flattens the account folder tree fetched via getSubFolders, with paths and depth", async () => {
    mock.accounts.list.mockResolvedValue([
      { id: "acc1", name: "Local Folders", rootFolder: { id: "root1", name: "" } },
    ]);
    // accounts.list returns the root without subfolders; the tree comes from
    // getSubFolders(root, true).
    mock.folders.getSubFolders.mockResolvedValue([
      { id: "f-inbox", name: "Inbox" },
      {
        id: "f-archive",
        name: "archive",
        subFolders: [{ id: "f-2025", name: "2025" }],
      },
    ]);

    const nodes = await listFolderTree();
    expect(mock.folders.getSubFolders).toHaveBeenCalled();
    expect(nodes.map((n) => n.path)).toEqual([
      "Local Folders/Inbox",
      "Local Folders/archive",
      "Local Folders/archive/2025",
    ]);
    expect(nodes.find((n) => n.path === "Local Folders/archive/2025")?.depth).toBe(1);
    expect(nodes.find((n) => n.path === "Local Folders/Inbox")?.id).toBe("f-inbox");
  });

  it("falls back to the account's carried folders if getSubFolders fails", async () => {
    mock.accounts.list.mockResolvedValue([
      {
        id: "acc1",
        name: "Local Folders",
        rootFolder: { id: "root1", name: "", subFolders: [{ id: "f-inbox", name: "Inbox" }] },
      },
    ]);
    mock.folders.getSubFolders.mockRejectedValue(new Error("nope"));

    const nodes = await listFolderTree();
    expect(nodes.map((n) => n.path)).toEqual(["Local Folders/Inbox"]);
  });

  it("exposes the root folder as a last resort so the picker is never empty", async () => {
    mock.accounts.list.mockResolvedValue([
      { id: "acc1", name: "Local Folders", rootFolder: { id: "root1", name: "Inbox" } },
    ]);
    // getSubFolders returns nothing and there are no inline subfolders.
    mock.folders.getSubFolders.mockResolvedValue([]);

    const nodes = await listFolderTree();
    expect(nodes.map((n) => n.path)).toEqual(["Local Folders/Inbox"]);
  });
});

describe("toFolderIndex", () => {
  it("builds an allowed-path set and a path lookup", () => {
    const { allowedPaths, byPath } = toFolderIndex([
      { id: "a", path: "X/y", depth: 0, accountName: "X" },
    ]);
    expect(allowedPaths.has("X/y")).toBe(true);
    expect(byPath.get("X/y")?.id).toBe("a");
  });
});
