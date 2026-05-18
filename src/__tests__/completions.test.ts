import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { getDirectoryCompletions } from "../completions.js";

// ---------------------------------------------------------------------------
// Mock setup — hoisted so they're available when node:fs is imported by the
// module under test.
// ---------------------------------------------------------------------------
const { statSync, readdirSync } = vi.hoisted(() => ({
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  statSync,
  readdirSync,
}));

// ---------------------------------------------------------------------------
// Helper — describe a virtual filesystem as a map of absolute directory path
// → array of child entries.  Keys are implicitly directories.
// ---------------------------------------------------------------------------
function mockFilesystem(entries: Record<string, Array<{ name: string; isDir: boolean }>>) {
  statSync.mockImplementation((p: string) => {
    // The path itself is a known directory (top-level key)
    if (p in entries) return { isDirectory: () => true };

    // Look for the path as a child of some known directory
    for (const [dir, children] of Object.entries(entries)) {
      for (const child of children) {
        if (join(dir, child.name) === p) {
          return { isDirectory: () => child.isDir };
        }
      }
    }
    const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });

  readdirSync.mockImplementation((p: string) => {
    if (p in entries) return entries[p].map((e) => e.name);
    const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("getDirectoryCompletions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.HOME;
  });

  // 1. Empty prefix — lists directories in baseCwd
  it("returns directories in baseCwd when prefix is empty", () => {
    mockFilesystem({
      "/project": [
        { name: "src", isDir: true },
        { name: "lib", isDir: true },
        { name: "file.txt", isDir: false },
      ],
    });

    const result = getDirectoryCompletions("", "/project");
    expect(result).toEqual([
      { label: "src", value: "src" },
      { label: "lib", value: "lib" },
    ]);
  });

  // 2. Prefix "sub" — filters to dirs starting with "sub" (case-insensitive)
  it("filters entries by case-insensitive prefix match", () => {
    mockFilesystem({
      "/project": [
        { name: "subdir", isDir: true },
        { name: "SubModule", isDir: true },
        { name: "sublime", isDir: true },
        { name: "other", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("sub", "/project");
    expect(result).toEqual([
      { label: "subdir", value: "subdir" },
      { label: "SubModule", value: "SubModule" },
      { label: "sublime", value: "sublime" },
    ]);
  });

  // 3. Prefix ending with "/" — lists contents of that subdirectory
  it("lists contents of the trailing-slash directory", () => {
    mockFilesystem({
      "/project/src": [
        { name: "components", isDir: true },
        { name: "utils", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("src/", "/project");
    expect(result).toEqual([
      { label: "components", value: "src/components" },
      { label: "utils", value: "src/utils" },
    ]);
  });

  // 4. Absolute path prefix — returns absolute paths
  it("returns absolute paths for an absolute path prefix", () => {
    mockFilesystem({
      "/tmp": [
        { name: "subdir", isDir: true },
        { name: "subfiles", isDir: true },
        { name: "other", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("/tmp/sub", "/project");
    expect(result).toEqual([
      { label: "subdir", value: "/tmp/subdir" },
      { label: "subfiles", value: "/tmp/subfiles" },
    ]);
  });

  // 5. Tilde prefix with HOME set — preserves tilde in completion values
  it("resolves tilde prefix using HOME and preserves tilde in completion values", () => {
    vi.stubEnv("HOME", "/home/user");
    mockFilesystem({
      "/home/user": [
        { name: "Documents", isDir: true },
        { name: "Downloads", isDir: true },
        { name: "Pictures", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("~/Documents", "/project");
    // expandTilde expands ~ to /home/user for path resolution,
    // but the completion value preserves the original tilde prefix
    expect(result).toEqual([{ label: "Documents", value: "~/Documents" }]);
  });

  // 6. Non-existent searchDir — statSync throws → returns null
  it("returns null when the resolved search directory does not exist", () => {
    mockFilesystem({}); // empty filesystem

    const result = getDirectoryCompletions("nonexistent/sub", "/project");
    expect(result).toBeNull();
  });

  // 7. searchDir is a file, not a directory
  it("returns null when the resolved search directory is actually a file", () => {
    mockFilesystem({
      "/project": [{ name: "regular.txt", isDir: false }],
    });
    // statSync for "/project/regular.txt" returns isDirectory: false
    // Prefix "regular.txt/sub" resolves searchDir to /project/regular.txt
    const result = getDirectoryCompletions("regular.txt/sub", "/project");
    expect(result).toBeNull();
  });

  // 8. readdirSync throws → returns null
  it("returns null when readdirSync throws", () => {
    statSync.mockReturnValue({ isDirectory: () => true });
    readdirSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = getDirectoryCompletions("", "/project");
    expect(result).toBeNull();
  });

  // 9. Only directories returned — files are filtered out via statSync
  it("filters out non-directory entries, returning only directories", () => {
    mockFilesystem({
      "/project": [
        { name: "src", isDir: true },
        { name: "file.txt", isDir: false },
        { name: "readme.md", isDir: false },
        { name: "lib", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("", "/project");
    expect(result).toEqual([
      { label: "src", value: "src" },
      { label: "lib", value: "lib" },
    ]);
  });

  // 10. No matching directories → returns null
  it("returns null when no entries match the partial name", () => {
    mockFilesystem({
      "/project": [
        { name: "abc", isDir: true },
        { name: "xyz", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("zzz", "/project");
    expect(result).toBeNull();
  });

  // 11. Multiple matches — returns all as AutocompleteItem[] with label and value
  it("returns all matching directories as AutocompleteItem objects", () => {
    mockFilesystem({
      "/project": [
        { name: "alpha", isDir: true },
        { name: "beta", isDir: true },
        { name: "gamma", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("", "/project");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result).toEqual([
      { label: "alpha", value: "alpha" },
      { label: "beta", value: "beta" },
      { label: "gamma", value: "gamma" },
    ]);
    // Each item has label and value
    for (const item of result!) {
      expect(item).toHaveProperty("label");
      expect(item).toHaveProperty("value");
      expect(typeof item.label).toBe("string");
      expect(typeof item.value).toBe("string");
    }
  });

  // 12. Relative path prefix preserves the user's typed prefix structure
  it("preserves relative path structure in completion values", () => {
    mockFilesystem({
      "/project/deep/nested": [
        { name: "matchdir", isDir: true },
        { name: "other", isDir: true },
      ],
    });

    const result = getDirectoryCompletions("deep/nested/m", "/project");
    // partialName = "m", so both "matchdir" and "other" are checked
    // but only "matchdir" starts with "m"
    // value should preserve "deep/nested/" prefix
    expect(result).toEqual([{ label: "matchdir", value: "deep/nested/matchdir" }]);
  });

  // 13. statSync throws for individual entries — those entries are skipped
  it("skips entries where statSync throws", () => {
    const searchDir = "/project";
    // Set up readdirSync to return both entries
    readdirSync.mockReturnValue(["dir1", "dir2"]);

    // Set up statSync to throw for dir1 but succeed for dir2
    statSync.mockImplementation((p: string) => {
      if (p === join(searchDir, "dir1")) {
        const err = new Error(`EACCES: permission denied, stat '${p}'`);
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      if (p === join(searchDir, "dir2")) {
        return { isDirectory: () => true };
      }
      // Default case - treat the search directory itself as a valid directory
      if (p === searchDir) {
        return { isDirectory: () => true };
      }
      // Any other path - throw ENOENT
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const result = getDirectoryCompletions("", "/project");
    // Should only return dir2 (dir1 was skipped due to statSync error)
    expect(result).toEqual([{ label: "dir2", value: "dir2" }]);
  });
});
