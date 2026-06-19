import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  iterateFolderHeaders,
  moveBackByHeaderId,
  moveBatched,
} from "../src/platform/messages.js";
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

describe("moveBackByHeaderId", () => {
  it("re-locates messages by header id and moves them back to the source", async () => {
    // dest "fA" holds m1 (now id 11) and m2 (now id 12); dest "fB" holds m3 (id 13).
    const found: Record<string, number> = {
      "<m1>": 11,
      "<m2>": 12,
      "<m3>": 13,
    };
    mock.messages.query.mockImplementation(async (q: { headerMessageId: string }) => ({
      id: null,
      messages: [{ id: found[q.headerMessageId] }],
    }));

    const outcome = await moveBackByHeaderId({
      sourceFolderId: "src",
      items: [
        { headerMessageId: "<m1>", destFolderId: "fA" },
        { headerMessageId: "<m2>", destFolderId: "fA" },
        { headerMessageId: "<m3>", destFolderId: "fB" },
      ],
    });

    expect(outcome).toEqual({ restored: 3, failures: [] });
    expect(mock.messages.move).toHaveBeenCalledWith([11, 12], "src");
    expect(mock.messages.move).toHaveBeenCalledWith([13], "src");
  });

  it("records a failure when a message can no longer be found", async () => {
    mock.messages.query.mockResolvedValue({ id: null, messages: [] });
    const outcome = await moveBackByHeaderId({
      sourceFolderId: "src",
      items: [{ headerMessageId: "<gone>", destFolderId: "fA" }],
    });
    expect(outcome.restored).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ headerMessageId: "<gone>" });
    expect(mock.messages.move).not.toHaveBeenCalled();
  });

  it("records a failure when the move back throws", async () => {
    mock.messages.query.mockResolvedValue({ id: null, messages: [{ id: 99 }] });
    mock.messages.move.mockRejectedValueOnce(new Error("locked"));
    const outcome = await moveBackByHeaderId({
      sourceFolderId: "src",
      items: [{ headerMessageId: "<m1>", destFolderId: "fA" }],
    });
    expect(outcome.restored).toBe(0);
    expect(outcome.failures[0].error).toBe("locked");
  });
});
