// Minimal mock of the `messenger` global for exercising the platform wrappers.
// Only the surface the wrappers touch is implemented.

import { vi } from "vitest";

export interface MockMessenger {
  accounts: { list: ReturnType<typeof vi.fn> };
  folders: { getSubFolders: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  messages: {
    list: ReturnType<typeof vi.fn>;
    continueList: ReturnType<typeof vi.fn>;
    getFull: ReturnType<typeof vi.fn>;
    move: ReturnType<typeof vi.fn>;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
}

export function installMockMessenger(): MockMessenger {
  const mock: MockMessenger = {
    accounts: { list: vi.fn() },
    folders: { getSubFolders: vi.fn(), query: vi.fn() },
    messages: {
      list: vi.fn(),
      continueList: vi.fn(),
      getFull: vi.fn(),
      move: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  (globalThis as unknown as { messenger: MockMessenger }).messenger = mock;
  return mock;
}

export function clearMockMessenger(): void {
  delete (globalThis as unknown as { messenger?: MockMessenger }).messenger;
}
