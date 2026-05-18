import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expandTilde, escapeRegex, bashSingleQuote } from "../helpers.js";

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------
describe("expandTilde", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/home/user");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("expands ~/Documents with HOME set", () => {
    expect(expandTilde("~/Documents")).toBe("/home/user/Documents");
  });

  it("expands ~ alone to HOME value", () => {
    expect(expandTilde("~")).toBe("/home/user");
  });

  it("expands ~/ to $HOME/", () => {
    expect(expandTilde("~/")).toBe("/home/user/");
  });

  // NOTE: The current implementation expands ~otheruser/path even though
  // conventionally only bare ~ and ~/ should be expanded. If this is
  // unintentional, the function should check for /^~(\/|$)/ instead.
  it("expands ~otheruser/path (current behavior expands all ~-prefixed paths)", () => {
    expect(expandTilde("~otheruser/path")).toBe("/home/userotheruser/path");
  });

  it("returns /absolute/path as-is (no tilde)", () => {
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
  });

  it("returns relative/path as-is", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("returns empty string as-is", () => {
    expect(expandTilde("")).toBe("");
  });

  it("returns input as-is when HOME is empty", () => {
    vi.stubEnv("HOME", "");
    expect(expandTilde("~/something")).toBe("~/something");
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------
describe("escapeRegex", () => {
  it("escapes a dot", () => {
    expect(escapeRegex("hello.world")).toBe("hello\\.world");
  });

  it("leaves path/to/file untouched (no special chars)", () => {
    expect(escapeRegex("path/to/file")).toBe("path/to/file");
  });

  it("escapes $ in $pecial", () => {
    expect(escapeRegex("$pecial")).toBe("\\$pecial");
  });

  it("escapes parentheses in (group)", () => {
    expect(escapeRegex("(group)")).toBe("\\(group\\)");
  });

  it("escapes square brackets in [bracket]", () => {
    expect(escapeRegex("[bracket]")).toBe("\\[bracket\\]");
  });

  it("escapes +, *, and ? in a+b*c?d", () => {
    expect(escapeRegex("a+b*c?d")).toBe("a\\+b\\*c\\?d");
  });

  it("returns empty string for empty input", () => {
    expect(escapeRegex("")).toBe("");
  });

  it("leaves no-special untouched", () => {
    expect(escapeRegex("no-special")).toBe("no-special");
  });
});

// ---------------------------------------------------------------------------
// bashSingleQuote
// ---------------------------------------------------------------------------
describe("bashSingleQuote", () => {
  it("wraps a simple string in single quotes", () => {
    expect(bashSingleQuote("simple")).toBe("'simple'");
  });

  it("wraps an empty string in single quotes", () => {
    expect(bashSingleQuote("")).toBe("''");
  });

  it("handles a single embedded quote in it's", () => {
    expect(bashSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles a single embedded quote in don't stop", () => {
    expect(bashSingleQuote("don't stop")).toBe("'don'\\''t stop'");
  });

  it("handles multiple embedded quotes in a'b'c", () => {
    expect(bashSingleQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("handles a lone single quote", () => {
    expect(bashSingleQuote("'")).toBe("''\\'''");
  });

  it("preserves spaces without escaping", () => {
    expect(bashSingleQuote("path with spaces")).toBe("'path with spaces'");
  });

  it("prevents shell expansion of $(danger)", () => {
    expect(bashSingleQuote("$(danger)")).toBe("'$(danger)'");
  });

  it("preserves backslash literally in back\\tick", () => {
    expect(bashSingleQuote("back\\tick")).toBe("'back\\tick'");
  });
});
