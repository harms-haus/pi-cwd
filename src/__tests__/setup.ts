import { vi } from "vitest";

// Mock createLocalBashOperations so tests don't need the real pi-agent runtime
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createLocalBashOperations: vi.fn(() => ({
    exec: vi.fn(),
  })),
}));
