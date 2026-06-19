import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFolderTree, toFolderIndex } from "../src/platform/folders.js";
import { clearMockMessenger, installMockMessenger, type MockMessenger } from "./mocks/messenger.js";

let mock: MockMessenger;

beforeEach(() => {
  mock = installMockMessenger();
});
afterEach(() => clearMockMessenger());

describe("listFolderTree", () => {
  it("flattens the account folder tree with paths and depth", async () => {
    mock.accounts.list.mockResolvedValue([
      {
        id: "acc1",
        name: "Local Folders",
        rootFolder: {
          name: "",
          subFolders: [
            { id: "f-inbox", name: "Inbox" },
            {
              id: "f-archive",
              name: "archive",
              subFolders: [{ id: "f-2025", name: "2025" }],
            },
          ],
        },
      },
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
