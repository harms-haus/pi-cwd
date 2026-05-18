import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statSync } from "node:fs";

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
}));

import {
  FILE_TOOLS_REQUIRED_PATH,
  FILE_TOOLS_OPTIONAL_PATH,
  CWD_CHANGE_TYPE,
  STATUS_KEY,
  getOriginalCwd,
  getEffectiveCwd,
  setEffectiveCwd,
  getLocalBashOps,
  resetBashOps,
  updateFooterStatus,
  restoreCwdFromBranch,
} from "../state.js";
import { createMockContext } from "./helpers/mocks.js";

// ============================================================================
// Helpers
// ============================================================================
function makeCwdEntry(cwd: string) {
  return { type: "custom", customType: "cwd-change", data: { cwd } };
}

// ============================================================================
// Reset module-level mutable state between tests
// ============================================================================
beforeEach(() => {
  setEffectiveCwd(getOriginalCwd());
});

afterEach(() => {
  setEffectiveCwd(getOriginalCwd());
  vi.restoreAllMocks();
});

// ============================================================================
// Constants
// ============================================================================
describe("constants", () => {
  it("CWD_CHANGE_TYPE is 'cwd-change'", () => {
    expect(CWD_CHANGE_TYPE).toBe("cwd-change");
  });

  it("STATUS_KEY is 'cwd'", () => {
    expect(STATUS_KEY).toBe("cwd");
  });

  it("FILE_TOOLS_REQUIRED_PATH contains read, write, edit", () => {
    expect(FILE_TOOLS_REQUIRED_PATH).toBeInstanceOf(Set);
    expect(FILE_TOOLS_REQUIRED_PATH.has("read")).toBe(true);
    expect(FILE_TOOLS_REQUIRED_PATH.has("write")).toBe(true);
    expect(FILE_TOOLS_REQUIRED_PATH.has("edit")).toBe(true);
  });

  it("FILE_TOOLS_OPTIONAL_PATH contains grep, find, ls", () => {
    expect(FILE_TOOLS_OPTIONAL_PATH).toBeInstanceOf(Set);
    expect(FILE_TOOLS_OPTIONAL_PATH.has("grep")).toBe(true);
    expect(FILE_TOOLS_OPTIONAL_PATH.has("find")).toBe(true);
    expect(FILE_TOOLS_OPTIONAL_PATH.has("ls")).toBe(true);
  });
});

// ============================================================================
// Getters / Setters
// ============================================================================
describe("getters and setters", () => {
  it("getOriginalCwd() returns process.cwd() at load time", () => {
    expect(getOriginalCwd()).toBe(process.cwd());
  });

  it("getEffectiveCwd() initially returns same as getOriginalCwd()", () => {
    expect(getEffectiveCwd()).toBe(getOriginalCwd());
  });

  it("setEffectiveCwd('/tmp') → getEffectiveCwd() returns '/tmp'", () => {
    setEffectiveCwd("/tmp");
    expect(getEffectiveCwd()).toBe("/tmp");
  });

  it("resetBashOps() replaces cached bash ops with a new object", () => {
    const before = getLocalBashOps();
    resetBashOps();
    const after = getLocalBashOps();
    expect(after).not.toBe(before);
  });
});

// ============================================================================
// updateFooterStatus
// ============================================================================
describe("updateFooterStatus", () => {
  it("cwd === original → setStatus called with (STATUS_KEY, undefined)", () => {
    const ctx = createMockContext();
    const cwd = "/some/path";
    updateFooterStatus(ctx, cwd, cwd);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("cwd !== original and hasUI true → setStatus called with (STATUS_KEY, theme.fg result)", () => {
    const ctx = createMockContext();
    const original = "/home/user";
    const cwd = "/home/user/projects";
    updateFooterStatus(ctx, cwd, original);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.any(String));
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith("accent", expect.stringContaining("projects"));
  });

  it("hasUI is false → no setStatus call at all", () => {
    const ctx = createMockContext({ hasUI: false });
    const original = "/home/user";
    const cwd = "/home/user/projects";
    updateFooterStatus(ctx, cwd, original);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("cwd starts with HOME → display path replaces HOME with ~", () => {
    const ctx = createMockContext();
    const home = process.env.HOME;
    if (!home) return; // skip if HOME not set
    const cwd = `${home}/projects/foo`;
    const original = "/original";
    updateFooterStatus(ctx, cwd, original);
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
      "accent",
      expect.stringContaining("~/projects/foo"),
    );
    expect(ctx.ui.theme.fg).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(home),
    );
  });

  it("cwd does not start with HOME → full path shown", () => {
    const ctx = createMockContext();
    const cwd = "/tmp/some/dir";
    const original = "/original";
    updateFooterStatus(ctx, cwd, original);
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
      "accent",
      expect.stringContaining("/tmp/some/dir"),
    );
  });

  it("displays raw path when HOME is empty", () => {
    vi.stubEnv("HOME", "");
    const ctx = createMockContext();
    updateFooterStatus(ctx, "/tmp/some/dir", "/original");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      ctx.ui.theme.fg("accent", "📂 /tmp/some/dir"),
    );
    vi.unstubAllEnvs();
  });
});

// ============================================================================
// restoreCwdFromBranch
// ============================================================================
describe("restoreCwdFromBranch", () => {
  const original = "/original/cwd";

  it("empty branch [] → returns original", () => {
    const ctx = createMockContext();
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("branch with valid cwd-change entry → returns that cwd", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [makeCwdEntry("/valid/dir")]),
      },
    });
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    expect(restoreCwdFromBranch(ctx, original)).toBe("/valid/dir");
  });

  it("branch with cwd-change entry where statSync throws → skips, returns original", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [makeCwdEntry("/missing/dir")]),
      },
    });
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("branch with cwd-change entry where statSync returns isDirectory false → skips", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [makeCwdEntry("/a/file")]),
      },
    });
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as unknown as ReturnType<
      typeof statSync
    >);
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("multiple valid cwd-change entries → returns the LAST one", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [
          makeCwdEntry("/first/dir"),
          makeCwdEntry("/second/dir"),
          makeCwdEntry("/third/dir"),
        ]),
      },
    });
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    expect(restoreCwdFromBranch(ctx, original)).toBe("/third/dir");
  });

  it("entry with missing data.cwd → skips", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [{ type: "custom", customType: "cwd-change", data: {} }]),
      },
    });
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("entry with non-string data.cwd → skips", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [{ type: "custom", customType: "cwd-change", data: { cwd: 42 } }]),
      },
    });
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("entry with wrong customType → skips", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [
          { type: "custom", customType: "other-type", data: { cwd: "/some/dir" } },
        ]),
      },
    });
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("getBranch() throws → returns original", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => {
          throw new Error("branch error");
        }),
      },
    });
    expect(restoreCwdFromBranch(ctx, original)).toBe(original);
  });

  it("mix of valid and invalid entries → returns last valid one", () => {
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn(() => [
          makeCwdEntry("/valid1"),
          { type: "custom", customType: "other", data: { cwd: "/wrong" } },
          makeCwdEntry("/valid2"),
          { type: "custom", customType: "cwd-change", data: {} },
          makeCwdEntry("/valid3"),
        ]),
      },
    });
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    expect(restoreCwdFromBranch(ctx, original)).toBe("/valid3");
  });
});
