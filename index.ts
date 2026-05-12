/**
 * pi-cwd Extension
 *
 * Provides a `/cwd <path>` command that changes the effective working directory
 * for all tool execution (bash, read, write, edit, grep, find, ls) without
 * restarting the pi-agent process.
 *
 * Usage:
 * /cwd — show current working directory
 * /cwd /tmp — change to absolute path
 * /cwd .. — change to relative path
 * /cwd ~/Documents — change with tilde expansion
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ============================================================================
// Module State
// ============================================================================
/** Original working directory at extension load — never changes. */
const originalCwd: string = process.cwd();

/** Effective working directory — changes via /cwd command. */
let effectiveCwd: string = originalCwd;

/** Cached local bash operations for user_bash handler. */
let localBashOps = createLocalBashOperations();

/** File tools that require a path argument. */
const FILE_TOOLS_REQUIRED_PATH = new Set(["read", "write", "edit"]);

/** File tools that can optionally use a path argument. */
const FILE_TOOLS_OPTIONAL_PATH = new Set(["grep", "find", "ls"]);

// ============================================================================
// Helper Functions
// ============================================================================
/** Expand leading ~ to $HOME. */
function expandTilde(input: string): string {
  if (input.startsWith("~")) {
    const home = process.env.HOME || "";
    if (home) {
      return home + input.slice(1);
    }
  }
  return input;
}

/** Escape a string for safe use in a RegExp pattern. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely quote a string for bash using single quotes.
 * Single quotes prevent ALL shell expansion ($, backticks, etc.).
 * Embedded single quotes are handled via: end-quote + escaped-quote + reopen-quote
 */
function bashSingleQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Update the footer status indicator. Clears when cwd matches original. */
function updateFooterStatus(ctx: ExtensionContext, cwd: string, original: string): void {
  if (!ctx.hasUI) return;
  if (cwd === original) {
    ctx.ui.setStatus("cwd", undefined);
    return;
  }
  const home = process.env.HOME || "";
  const displayPath = home ? cwd.replace(new RegExp(`^${escapeRegex(home)}`), "~") : cwd;
  ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `📂 ${displayPath}`));
}

/**
 * Scan the current session branch for "cwd-change" entries.
 * Returns the last recorded cwd, or the original if none found.
 */
function restoreCwdFromBranch(ctx: ExtensionContext, original: string): string {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!branch) return original;
    let lastCwd: string | undefined;
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        entry.customType === "cwd-change" &&
        entry.data?.cwd &&
        typeof entry.data.cwd === "string"
      ) {
        // Validate that the cwd exists and is a directory
        try {
          const stat = statSync(entry.data.cwd as string);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }
        lastCwd = entry.data.cwd;
      }
    }
    return lastCwd || original;
  } catch {
    return original;
  }
}

/** Provide directory tab-completion for the /cwd command. */
function getDirectoryCompletions(
  prefix: string,
  baseCwd: string,
): AutocompleteItem[] | null {
  try {
    const expanded = expandTilde(prefix || "");
    let searchDir: string;
    let partialName: string;
    if (expanded === "" || expanded === ".") {
      searchDir = baseCwd;
      partialName = "";
    } else if (isAbsolute(expanded)) {
      const s = statSync(expanded);
      if (s.isDirectory()) {
        searchDir = expanded;
        partialName = "";
      } else {
        searchDir = dirname(expanded);
        partialName = basename(expanded);
      }
    } else {
      const resolved = resolve(baseCwd, expanded);
      const s = statSync(resolved);
      if (s.isDirectory()) {
        searchDir = resolved;
        partialName = "";
      } else {
        searchDir = dirname(resolved);
        partialName = basename(resolved);
      }
    }
    if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) {
      return null;
    }
    const entries = readdirSync(searchDir, { withFileTypes: true });
    const results: AutocompleteItem[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!partialName || entry.name.toLowerCase().startsWith(partialName.toLowerCase())) {
          const fullPath = join(searchDir, entry.name);
          let value: string;
          if (isAbsolute(expanded) || expanded.startsWith("~")) {
            value = fullPath;
            if (expanded.startsWith("~") && process.env.HOME) {
              value = value.replace(
                new RegExp(`^${escapeRegex(process.env.HOME as string)}`),
                "~",
              );
            }
          } else {
            const dirPart = dirname(prefix || "");
            value = dirPart === "." ? entry.name : join(dirPart, entry.name);
          }
          results.push({ label: entry.name, value });
        }
      }
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI): void {
  // ── /cwd command ──────────────────────────────────────────────────
  pi.registerCommand("cwd", {
    description: "Change working directory for tool execution (/cwd <path> or /cwd to show current)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const rawInput = args.trim();
      if (!rawInput) {
        ctx.ui.notify(`Current working directory: ${effectiveCwd}`, "info");
        return;
      }
      const expanded = expandTilde(rawInput);
      const newCwd = resolve(effectiveCwd, expanded);
      if (!existsSync(newCwd)) {
        ctx.ui.notify(`Directory not found: ${newCwd}`, "error");
        return;
      }
      try {
        const stat = statSync(newCwd);
        if (!stat.isDirectory()) {
          ctx.ui.notify(`Not a directory: ${newCwd}`, "error");
          return;
        }
      } catch {
        ctx.ui.notify(`Cannot access: ${newCwd}`, "error");
        return;
      }
      const realCwd = realpathSync(newCwd);
      effectiveCwd = realCwd;
      pi.appendEntry("cwd-change", { cwd: effectiveCwd });
      updateFooterStatus(ctx, effectiveCwd, originalCwd);
      ctx.ui.notify(`Working directory: ${effectiveCwd}`, "info");
    },
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      return getDirectoryCompletions(argumentPrefix, effectiveCwd);
    },
  });

  // ── Tool call interception ────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (effectiveCwd === originalCwd) return undefined;

    if (event.toolName === "bash") {
      const input = event.input as { command: string; timeout?: number };
      input.command = `cd ${bashSingleQuote(effectiveCwd)} && ${input.command}`;
    } else if (FILE_TOOLS_REQUIRED_PATH.has(event.toolName)) {
      const input = event.input as { path: string };
      if (!isAbsolute(input.path)) {
        input.path = resolve(effectiveCwd, input.path);
      }
    } else if (FILE_TOOLS_OPTIONAL_PATH.has(event.toolName)) {
      const input = event.input as { path?: string };
      if (input.path === undefined || input.path === "") {
        input.path = effectiveCwd;
      } else if (!isAbsolute(input.path)) {
        input.path = resolve(effectiveCwd, input.path);
      }
    }

    return undefined;
  });

  // ── System prompt modification ────────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (effectiveCwd === originalCwd) return undefined;
    const modified = event.systemPrompt.replace(
      /Current working directory: .+/,
      `Current working directory: ${effectiveCwd}`,
    );
    return { systemPrompt: modified };
  });

  // ── User ! bash command support ───────────────────────────────────
  pi.on("user_bash", async (_event, _ctx) => {
    if (effectiveCwd === originalCwd) return undefined;
    const escapedCwd = bashSingleQuote(effectiveCwd);
    const originalOps = localBashOps;
    return {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: {
            onData?: (chunk: string) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: Record<string, string>;
          },
        ) => {
          return originalOps.exec(`cd ${escapedCwd} && ${command}`, cwd, options);
        },
      },
    };
  });

  // ── State restoration ─────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    effectiveCwd = restoreCwdFromBranch(ctx, originalCwd);
    localBashOps = createLocalBashOperations();
    updateFooterStatus(ctx, effectiveCwd, originalCwd);
  });

  pi.on("session_tree", async (_event, ctx) => {
    effectiveCwd = restoreCwdFromBranch(ctx, originalCwd);
    updateFooterStatus(ctx, effectiveCwd, originalCwd);
  });
}
