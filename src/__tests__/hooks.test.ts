import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Hoisted mocks — these are hoisted to the top by vitest, so they must be
// defined with vi.hoisted() to be available in vi.mock() factories.
// ============================================================================
const {
  mockGetEffectiveCwd,
  mockGetOriginalCwd,
  mockSetEffectiveCwd,
  mockGetLocalBashOps,
  mockResetBashOps,
  mockRestoreCwdFromBranch,
  mockUpdateFooterStatus,
  mockBashSingleQuote,
} = vi.hoisted(() => ({
  mockGetEffectiveCwd: vi.fn(),
  mockGetOriginalCwd: vi.fn(),
  mockSetEffectiveCwd: vi.fn(),
  mockGetLocalBashOps: vi.fn(),
  mockResetBashOps: vi.fn(),
  mockRestoreCwdFromBranch: vi.fn(),
  mockUpdateFooterStatus: vi.fn(),
  mockBashSingleQuote: vi.fn((s: string) => `'${s}'`),
}));

vi.mock("../state.js", () => ({
  getEffectiveCwd: mockGetEffectiveCwd,
  getOriginalCwd: mockGetOriginalCwd,
  setEffectiveCwd: mockSetEffectiveCwd,
  getLocalBashOps: mockGetLocalBashOps,
  resetBashOps: mockResetBashOps,
  restoreCwdFromBranch: mockRestoreCwdFromBranch,
  updateFooterStatus: mockUpdateFooterStatus,
  FILE_TOOLS_REQUIRED_PATH: new Set(["read", "write", "edit"]),
  FILE_TOOLS_OPTIONAL_PATH: new Set(["grep", "find", "ls"]),
  CWD_CHANGE_TYPE: "cwd-change",
}));

vi.mock("../helpers.js", () => ({
  bashSingleQuote: mockBashSingleQuote,
  expandTilde: vi.fn((s: string) => s),
}));

vi.mock("../completions.js", () => ({
  getDirectoryCompletions: vi.fn(() => null),
}));

// Import after mocks are set up
import indexModule from "../index.js";
import { createMockAPI, createMockContext, captureHandlers } from "./helpers/mocks.js";

// ============================================================================
// Setup — run extension entry point to register handlers
// ============================================================================
let handlers: Record<string, (...args: unknown[]) => unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  const { api, on } = createMockAPI();
  indexModule(api);
  handlers = captureHandlers(on);
});

// ============================================================================
// Helpers
// ============================================================================

/** Configure the cwd mocks for the common case where effectiveCwd !== originalCwd */
function setupCwdDifferent(effectiveCwd = "/test/dir", originalCwd = "/original") {
  mockGetEffectiveCwd.mockReturnValue(effectiveCwd);
  mockGetOriginalCwd.mockReturnValue(originalCwd);
}

/** Configure the cwd mocks so effectiveCwd === originalCwd */
function setupCwdSame(cwd = "/original") {
  mockGetEffectiveCwd.mockReturnValue(cwd);
  mockGetOriginalCwd.mockReturnValue(cwd);
}

// ============================================================================
// tool_call handler
// ============================================================================
describe("tool_call handler", () => {
  it("returns undefined when effectiveCwd === originalCwd", () => {
    setupCwdSame();
    const input = { command: "ls" };
    const result = handlers["tool_call"]({ toolName: "bash", input }, {});
    expect(result).toBeUndefined();
    expect(input.command).toBe("ls");
  });

  describe("bash tool", () => {
    it("prepends cd command to bash input", () => {
      setupCwdDifferent("/test/dir");
      mockBashSingleQuote.mockReturnValue("'/test/dir'");
      const input = { command: "ls" };
      handlers["tool_call"]({ toolName: "bash", input }, {});
      expect(input.command).toBe("cd '/test/dir' && ls");
      expect(mockBashSingleQuote).toHaveBeenCalledWith("/test/dir");
    });
  });

  describe("required-path tools (read, write, edit)", () => {
    it("resolves relative path for 'read'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "relative/file.txt" };
      handlers["tool_call"]({ toolName: "read", input }, {});
      expect(input.path).toBe("/test/dir/relative/file.txt");
    });

    it("leaves absolute path unchanged for 'read'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/absolute/file.txt" };
      handlers["tool_call"]({ toolName: "read", input }, {});
      expect(input.path).toBe("/absolute/file.txt");
    });

    it("resolves relative path for 'write'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "output.txt" };
      handlers["tool_call"]({ toolName: "write", input }, {});
      expect(input.path).toBe("/test/dir/output.txt");
    });

    it("leaves absolute path unchanged for 'write'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/tmp/output.txt" };
      handlers["tool_call"]({ toolName: "write", input }, {});
      expect(input.path).toBe("/tmp/output.txt");
    });

    it("resolves relative path for 'edit'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "src/index.ts" };
      handlers["tool_call"]({ toolName: "edit", input }, {});
      expect(input.path).toBe("/test/dir/src/index.ts");
    });

    it("leaves absolute path unchanged for 'edit'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/home/user/src/index.ts" };
      handlers["tool_call"]({ toolName: "edit", input }, {});
      expect(input.path).toBe("/home/user/src/index.ts");
    });
  });

  describe("optional-path tools (grep, find, ls)", () => {
    it("sets path to effectiveCwd when undefined for 'grep'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: undefined };
      handlers["tool_call"]({ toolName: "grep", input }, {});
      expect(input.path).toBe("/test/dir");
    });

    it("sets path to effectiveCwd when empty string for 'grep'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "" };
      handlers["tool_call"]({ toolName: "grep", input }, {});
      expect(input.path).toBe("/test/dir");
    });

    it("resolves relative path for 'grep'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "src" };
      handlers["tool_call"]({ toolName: "grep", input }, {});
      expect(input.path).toBe("/test/dir/src");
    });

    it("leaves absolute path unchanged for 'grep'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/absolute/src" };
      handlers["tool_call"]({ toolName: "grep", input }, {});
      expect(input.path).toBe("/absolute/src");
    });

    it("sets path to effectiveCwd when undefined for 'find'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: undefined };
      handlers["tool_call"]({ toolName: "find", input }, {});
      expect(input.path).toBe("/test/dir");
    });

    it("resolves relative path for 'find'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "subdir" };
      handlers["tool_call"]({ toolName: "find", input }, {});
      expect(input.path).toBe("/test/dir/subdir");
    });

    it("leaves absolute path unchanged for 'find'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/absolute/subdir" };
      handlers["tool_call"]({ toolName: "find", input }, {});
      expect(input.path).toBe("/absolute/subdir");
    });

    it("sets path to effectiveCwd when undefined for 'ls'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: undefined };
      handlers["tool_call"]({ toolName: "ls", input }, {});
      expect(input.path).toBe("/test/dir");
    });

    it("resolves relative path for 'ls'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "subdir" };
      handlers["tool_call"]({ toolName: "ls", input }, {});
      expect(input.path).toBe("/test/dir/subdir");
    });

    it("leaves absolute path unchanged for 'ls'", () => {
      setupCwdDifferent("/test/dir");
      const input = { path: "/absolute/subdir" };
      handlers["tool_call"]({ toolName: "ls", input }, {});
      expect(input.path).toBe("/absolute/subdir");
    });
  });

  describe("unknown tool", () => {
    it("does not modify input for unrecognized toolName", () => {
      setupCwdDifferent("/test/dir");
      const input = { foo: "bar" };
      handlers["tool_call"]({ toolName: "unknown_tool", input }, {});
      expect(input).toEqual({ foo: "bar" });
    });
  });
});

// ============================================================================
// before_agent_start handler
// ============================================================================
describe("before_agent_start handler", () => {
  it("returns undefined when effectiveCwd === originalCwd", () => {
    setupCwdSame();
    const result = handlers["before_agent_start"](
      { systemPrompt: "Current working directory: /original" },
      {},
    );
    expect(result).toBeUndefined();
  });

  it("returns modified systemPrompt with new cwd when effectiveCwd !== originalCwd", () => {
    setupCwdDifferent("/new/cwd");
    const result = handlers["before_agent_start"](
      { systemPrompt: "Current working directory: /original" },
      {},
    );
    expect(result).toEqual({ systemPrompt: "Current working directory: /new/cwd" });
  });

  it("does not modify prompt when cwd line is absent", () => {
    setupCwdDifferent("/new/cwd");
    const result = handlers["before_agent_start"]({ systemPrompt: "Some other prompt text" }, {});
    // String.replace with a non-matching regex returns the original string
    expect(result).toEqual({ systemPrompt: "Some other prompt text" });
  });
});

// ============================================================================
// user_bash handler
// ============================================================================
describe("user_bash handler", () => {
  it("returns undefined when effectiveCwd === originalCwd", () => {
    setupCwdSame();
    const result = handlers["user_bash"]({}, {});
    expect(result).toBeUndefined();
  });

  it("returns operations.exec that prepends cd command", () => {
    setupCwdDifferent("/test/dir");
    mockBashSingleQuote.mockReturnValue("'/test/dir'");
    const mockExec = vi.fn();
    mockGetLocalBashOps.mockReturnValue({ exec: mockExec });

    const result = handlers["user_bash"]({}, {}) as {
      operations: { exec: (...args: unknown[]) => unknown };
    };

    expect(result).toHaveProperty("operations.exec");
    expect(typeof result.operations.exec).toBe("function");

    // Call exec
    const options = { onData: vi.fn(), signal: undefined, timeout: undefined, env: undefined };
    result.operations.exec("ls -la", "/some/cwd", options);

    expect(mockExec).toHaveBeenCalledWith("cd '/test/dir' && ls -la", "/some/cwd", options);
  });

  it("exec passes through all options (onData, signal, timeout, env)", () => {
    setupCwdDifferent("/test/dir");
    mockBashSingleQuote.mockReturnValue("'/test/dir'");
    const mockExec = vi.fn();
    mockGetLocalBashOps.mockReturnValue({ exec: mockExec });

    const result = handlers["user_bash"]({}, {}) as {
      operations: { exec: (...args: unknown[]) => unknown };
    };

    const onData = vi.fn();
    const signal = new AbortController().signal;
    const timeout = 30_000;
    const env = { PATH: "/usr/bin" };

    result.operations.exec("echo hi", "/cwd", { onData, signal, timeout, env });

    expect(mockExec).toHaveBeenCalledWith("cd '/test/dir' && echo hi", "/cwd", {
      onData,
      signal,
      timeout,
      env,
    });
  });
});

// ============================================================================
// session_start handler
// ============================================================================
describe("session_start handler", () => {
  it("calls restoreCwdFromBranch, setEffectiveCwd, resetBashOps, updateFooterStatus", () => {
    const ctx = createMockContext();
    mockRestoreCwdFromBranch.mockReturnValue("/restored/cwd");

    handlers["session_start"]({}, ctx);

    expect(mockRestoreCwdFromBranch).toHaveBeenCalledWith(ctx, mockGetOriginalCwd());
    expect(mockSetEffectiveCwd).toHaveBeenCalledWith("/restored/cwd");
    expect(mockResetBashOps).toHaveBeenCalled();
    expect(mockUpdateFooterStatus).toHaveBeenCalledWith(
      ctx,
      mockGetEffectiveCwd(),
      mockGetOriginalCwd(),
    );
  });

  it("calls functions in correct order", () => {
    const ctx = createMockContext();
    mockRestoreCwdFromBranch.mockReturnValue("/restored/cwd");
    const callOrder: string[] = [];
    mockRestoreCwdFromBranch.mockImplementation(() => {
      callOrder.push("restoreCwdFromBranch");
      return "/restored/cwd";
    });
    mockSetEffectiveCwd.mockImplementation(() => {
      callOrder.push("setEffectiveCwd");
    });
    mockResetBashOps.mockImplementation(() => {
      callOrder.push("resetBashOps");
    });
    mockUpdateFooterStatus.mockImplementation(() => {
      callOrder.push("updateFooterStatus");
    });

    handlers["session_start"]({}, ctx);

    expect(callOrder).toEqual([
      "restoreCwdFromBranch",
      "setEffectiveCwd",
      "resetBashOps",
      "updateFooterStatus",
    ]);
  });
});

// ============================================================================
// session_tree handler
// ============================================================================
describe("session_tree handler", () => {
  it("calls restoreCwdFromBranch, setEffectiveCwd, updateFooterStatus", () => {
    const ctx = createMockContext();
    mockRestoreCwdFromBranch.mockReturnValue("/restored/cwd");

    handlers["session_tree"]({}, ctx);

    expect(mockRestoreCwdFromBranch).toHaveBeenCalledWith(ctx, mockGetOriginalCwd());
    expect(mockSetEffectiveCwd).toHaveBeenCalledWith("/restored/cwd");
    expect(mockUpdateFooterStatus).toHaveBeenCalledWith(
      ctx,
      mockGetEffectiveCwd(),
      mockGetOriginalCwd(),
    );
  });

  it("does NOT call resetBashOps", () => {
    const ctx = createMockContext();
    mockRestoreCwdFromBranch.mockReturnValue("/restored/cwd");

    handlers["session_tree"]({}, ctx);

    expect(mockResetBashOps).not.toHaveBeenCalled();
  });

  it("calls functions in correct order", () => {
    const ctx = createMockContext();
    mockRestoreCwdFromBranch.mockReturnValue("/restored/cwd");
    const callOrder: string[] = [];
    mockRestoreCwdFromBranch.mockImplementation(() => {
      callOrder.push("restoreCwdFromBranch");
      return "/restored/cwd";
    });
    mockSetEffectiveCwd.mockImplementation(() => {
      callOrder.push("setEffectiveCwd");
    });
    mockUpdateFooterStatus.mockImplementation(() => {
      callOrder.push("updateFooterStatus");
    });

    handlers["session_tree"]({}, ctx);

    expect(callOrder).toEqual(["restoreCwdFromBranch", "setEffectiveCwd", "updateFooterStatus"]);
  });
});
