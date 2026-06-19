import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFolderTree, toFolderIndex } from "../src/platform/folders.js";
import { clearMockMessenger, installMockMessenger, type MockMessenger } from "./mocks/messenger.js";

let mock: MockMessenger;

beforeEach(() => {
  mock = installMockMessenger();
});
afterEach(() => clearMockMessenger());

describe("listFolderTree", () => {
  it("flattens all folders from folders.query, deriving path and depth, skipping roots/virtual", async () => {
    mock.accounts.list.mockResolvedValue([{ id: "acc1", name: "Local Folders" }]);
    mock.folders.query.mockResolvedValue([
      { id: "root1", accountId: "acc1", path: "/", isRoot: true },
      { id: "f-inbox", accountId: "acc1", path: "/Inbox", name: "Inbox" },
      { id: "f-archive", accountId: "acc1", path: "/archive", name: "archive" },
      { id: "f-2025", accountId: "acc1", path: "/archive/2025", name: "2025" },
      { id: "v1", accountId: "acc1", path: "/saved", name: "saved", isVirtual: true },
    ]);

    const nodes = await listFolderTree();
    expect(nodes.map((n) => n.path)).toEqual([
      "Local Folders/Inbox",
      "Local Folders/archive",
      "Local Folders/archive/2025",
    ]);
    expect(nodes.find((n) => n.path === "Local Folders/archive/2025")?.depth).toBe(1);
    expect(nodes.find((n) => n.path === "Local Folders/Inbox")?.id).toBe("f-inbox");
  });

  it("falls back to getSubFolders(rootId, true) when query yields nothing", async () => {
    mock.accounts.list.mockResolvedValue([
      { id: "acc1", name: "Local Folders", rootFolder: { id: "root1", name: "" } },
    ]);
    mock.folders.query.mockResolvedValue([]);
    mock.folders.getSubFolders.mockResolvedValue([
      { id: "f-inbox", name: "Inbox", subFolders: [{ id: "f-sub", name: "sub" }] },
    ]);

    const nodes = await listFolderTree();
    // Passed the root folder id STRING, not an object.
    expect(mock.folders.getSubFolders).toHaveBeenCalledWith("root1", true);
    expect(nodes.map((n) => n.path)).toEqual([
      "Local Folders/Inbox",
      "Local Folders/Inbox/sub",
    ]);
  });

  it("exposes the root folder as a last resort so the picker is never empty", async () => {
    mock.accounts.list.mockResolvedValue([
      { id: "acc1", name: "Local Folders", rootFolder: { id: "root1", name: "Inbox" } },
    ]);
    mock.folders.query.mockRejectedValue(new Error("no query"));
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
