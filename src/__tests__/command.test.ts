import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

// ── Mock node:fs before importing anything that uses it ──────────────
vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  realpathSync: vi.fn(),
}));

// ── Mock completions so we don't need a real filesystem ──────────────
vi.mock("../completions.js", () => ({
  getDirectoryCompletions: vi.fn(() => [{ label: "test", value: "/test" }]),
}));

// ── Imports (after mocks are registered) ─────────────────────────────
import { statSync, realpathSync } from "node:fs";
import extension from "../index.js";
import { setEffectiveCwd, getEffectiveCwd, getOriginalCwd } from "../state.js";
import { createMockAPI, createMockContext, captureCommand } from "./helpers/mocks.js";
import { getDirectoryCompletions } from "../completions.js";

// ============================================================================
// Helpers
// ============================================================================
function makeDirStat() {
  return { isDirectory: () => true } as unknown as ReturnType<typeof statSync>;
}

function makeFileStat() {
  return { isDirectory: () => false } as unknown as ReturnType<typeof statSync>;
}

// ============================================================================
// Setup / Teardown
// ============================================================================
beforeEach(() => {
  setEffectiveCwd(getOriginalCwd());
  vi.mocked(statSync).mockReset();
  vi.mocked(realpathSync).mockReset();
  vi.mocked(getDirectoryCompletions).mockReset();
  vi.mocked(getDirectoryCompletions).mockReturnValue([{ label: "test", value: "/test" }]);
});

afterEach(() => {
  setEffectiveCwd(getOriginalCwd());
  vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================
describe("/cwd command handler", () => {
  /** Helper: register extension and return the captured command handler + completions getter */
  function setup() {
    const { api, registerCommand, appendEntry } = createMockAPI();
    extension(api);
    const { name, options } = captureCommand(registerCommand);
    return {
      name,
      handler: options.handler as (
        args: string,
        ctx: ReturnType<typeof createMockContext>,
      ) => Promise<void>,
      getArgumentCompletions: options.getArgumentCompletions as (prefix: string) => unknown,
      appendEntry,
      api,
    };
  }

  // ── Registration ───────────────────────────────────────────────────
  it("registers a command named 'cwd'", () => {
    const { name } = setup();
    expect(name).toBe("cwd");
  });

  // ── No args (empty string) ────────────────────────────────────────
  it("empty args → notify with current working directory", async () => {
    const { handler } = setup();
    const ctx = createMockContext();
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `Current working directory: ${getEffectiveCwd()}`,
      "info",
    );
  });

  // ── Whitespace args ───────────────────────────────────────────────
  it("whitespace args → notify with current working directory", async () => {
    const { handler } = setup();
    const ctx = createMockContext();
    await handler("   ", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `Current working directory: ${getEffectiveCwd()}`,
      "info",
    );
  });

  // ── Valid directory ───────────────────────────────────────────────
  it("valid directory → sets effectiveCwd, appends entry, updates footer, notifies", async () => {
    const { handler, appendEntry } = setup();
    const ctx = createMockContext();
    const targetPath = "/tmp/some/dir";

    vi.mocked(statSync).mockReturnValue(makeDirStat());
    vi.mocked(realpathSync).mockReturnValue(targetPath);

    await handler(targetPath, ctx);

    // State updated
    expect(getEffectiveCwd()).toBe(targetPath);

    // Entry appended
    expect(appendEntry).toHaveBeenCalledWith("cwd-change", { cwd: targetPath });

    // Footer updated (setStatus called)
    expect(ctx.ui.setStatus).toHaveBeenCalled();

    // Success notification
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `Changed working directory to ${targetPath}`,
      "info",
    );
  });

  // ── Relative path ".." ────────────────────────────────────────────
  it("relative path '..' → resolves relative to current effectiveCwd", async () => {
    const { handler } = setup();
    const ctx = createMockContext();

    // Set a known effectiveCwd so we can predict resolve()
    const base = "/home/user/projects";
    setEffectiveCwd(base);

    const expected = resolve(base, ".."); // /home/user

    vi.mocked(statSync).mockReturnValue(makeDirStat());
    vi.mocked(realpathSync).mockReturnValue(expected);

    await handler("..", ctx);

    expect(statSync).toHaveBeenCalledWith(expected);
    expect(getEffectiveCwd()).toBe(expected);
  });

  // ── Tilde path ────────────────────────────────────────────────────
  it("tilde path ~/something → expands via expandTilde", async () => {
    const { handler } = setup();
    const ctx = createMockContext();

    const home = process.env.HOME || "";
    if (!home) return; // skip if HOME not set

    const expanded = `${home}/Documents`;
    const expectedResolved = resolve(getEffectiveCwd(), expanded);

    vi.mocked(statSync).mockReturnValue(makeDirStat());
    vi.mocked(realpathSync).mockReturnValue(expectedResolved);

    await handler("~/Documents", ctx);

    expect(statSync).toHaveBeenCalledWith(expectedResolved);
    expect(getEffectiveCwd()).toBe(expectedResolved);
  });

  // ── statSync throws ───────────────────────────────────────────────
  it("statSync throws → notify 'Cannot access:' error", async () => {
    const { handler } = setup();
    const ctx = createMockContext();

    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    await handler("/nonexistent", ctx);

    const resolved = resolve(getEffectiveCwd(), "/nonexistent");
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Cannot access directory: ${resolved}`, "error");
    // State should NOT change
    expect(getEffectiveCwd()).toBe(getOriginalCwd());
  });

  // ── statSync returns non-directory ────────────────────────────────
  it("statSync returns non-directory → notify 'Not a directory:' error", async () => {
    const { handler } = setup();
    const ctx = createMockContext();

    vi.mocked(statSync).mockReturnValue(makeFileStat());

    await handler("/some/file.txt", ctx);

    const resolved = resolve(getEffectiveCwd(), "/some/file.txt");
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Not a directory: ${resolved}`, "error");
    // State should NOT change
    expect(getEffectiveCwd()).toBe(getOriginalCwd());
  });

  // ── realpathSync resolves symlink ─────────────────────────────────
  it("realpathSync resolves symlink → effectiveCwd is the real path", async () => {
    const { handler } = setup();
    const ctx = createMockContext();

    const originalCwd = getOriginalCwd();
    const linkPath = "/tmp/symlink";
    const resolvedPath = resolve(originalCwd, linkPath);
    const realPath = "/tmp/real/target";

    vi.mocked(statSync).mockReturnValue(makeDirStat());
    vi.mocked(realpathSync).mockReturnValue(realPath);

    await handler(linkPath, ctx);

    expect(realpathSync).toHaveBeenCalledWith(resolvedPath);
    expect(getEffectiveCwd()).toBe(realPath);
  });

  // ── getArgumentCompletions ─────────────────────────────────────────
  it("getArgumentCompletions delegates to getDirectoryCompletions with prefix and effectiveCwd", () => {
    const { getArgumentCompletions } = setup();

    const currentCwd = getEffectiveCwd();
    const result = getArgumentCompletions("test");

    expect(getDirectoryCompletions).toHaveBeenCalledWith("test", currentCwd);
    expect(result).toEqual([{ label: "test", value: "/test" }]);
  });
});
