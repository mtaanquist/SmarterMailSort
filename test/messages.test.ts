import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { iterateFolderHeaders, moveBatched } from "../src/platform/messages.js";
import { clearMockMessenger, installMockMessenger, type MockMessenger } from "./mocks/messenger.js";

let mock: MockMessenger;

beforeEach(() => {
  mock = installMockMessenger();
});
afterEach(() => clearMockMessenger());

describe("iterateFolderHeaders", () => {
  it("pages through list/continueList until exhausted", async () => {
    mock.messages.list.mockResolvedValue({
      id: "page2",
      messages: [{ id: 1 }, { id: 2 }],
    });
    mock.messages.continueList.mockResolvedValue({
      id: null,
      messages: [{ id: 3 }],
    });

    const ids: number[] = [];
    for await (const h of iterateFolderHeaders("folder-1")) ids.push(h.id);

    expect(ids).toEqual([1, 2, 3]);
    expect(mock.messages.continueList).toHaveBeenCalledWith("page2");
  });

  it("stops after a single page when id is null", async () => {
    mock.messages.list.mockResolvedValue({ id: null, messages: [{ id: 9 }] });
    const ids: number[] = [];
    for await (const h of iterateFolderHeaders("folder-1")) ids.push(h.id);
    expect(ids).toEqual([9]);
    expect(mock.messages.continueList).not.toHaveBeenCalled();
  });
});

describe("moveBatched", () => {
  it("moves each group and reports counts", async () => {
    const results = await moveBatched(
      new Map([
        ["folderA", [1, 2]],
        ["folderB", [3]],
      ]),
    );
    expect(mock.messages.move).toHaveBeenCalledWith([1, 2], "folderA");
    expect(mock.messages.move).toHaveBeenCalledWith([3], "folderB");
    expect(results).toEqual([
      { folderId: "folderA", moved: 2 },
      { folderId: "folderB", moved: 1 },
    ]);
  });

  it("captures errors per folder", async () => {
    mock.messages.move.mockRejectedValueOnce(new Error("locked"));
    const results = await moveBatched(new Map([["folderA", [1]]]));
    expect(results[0].error).toBe("locked");
    expect(results[0].moved).toBe(0);
  });

  it("skips empty groups", async () => {
    const results = await moveBatched(new Map([["folderA", []]]));
    expect(results).toEqual([]);
    expect(mock.messages.move).not.toHaveBeenCalled();
  });
});
