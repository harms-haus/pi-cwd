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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { bashSingleQuote, expandTilde } from "./helpers.js";
import { getDirectoryCompletions } from "./completions.js";
import {
  getEffectiveCwd,
  setEffectiveCwd,
  getOriginalCwd,
  getLocalBashOps,
  resetBashOps,
  FILE_TOOLS_REQUIRED_PATH,
  FILE_TOOLS_OPTIONAL_PATH,
  restoreCwdFromBranch,
  updateFooterStatus,
  CWD_CHANGE_TYPE,
} from "./state.js";

// Regex to find the cwd line in the system prompt
const CWD_PROMPT_REGEX = /Current working directory: .+/;

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI): void {
  // ── /cwd command ──────────────────────────────────────────────────
  pi.registerCommand("cwd", {
    description:
      "Change working directory for tool execution (/cwd <path> or /cwd to show current)",
    // eslint-disable-next-line @typescript-eslint/require-await
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const rawInput = args.trim();
      if (!rawInput) {
        ctx.ui.notify(`Current working directory: ${getEffectiveCwd()}`, "info");
        return;
      }
      const expanded = expandTilde(rawInput);
      const newCwd = resolve(getEffectiveCwd(), expanded);
      try {
        const stat = statSync(newCwd);
        if (!stat.isDirectory()) {
          ctx.ui.notify(`Not a directory: ${newCwd}`, "error");
          return;
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          ctx.ui.notify(`Directory does not exist: ${newCwd}`, "error");
        } else if (code === "EACCES") {
          ctx.ui.notify(`Permission denied: ${newCwd}`, "error");
        } else {
          ctx.ui.notify(`Cannot access directory: ${newCwd}`, "error");
        }
        return;
      }
      const realCwd = realpathSync(newCwd);
      setEffectiveCwd(realCwd);
      pi.appendEntry(CWD_CHANGE_TYPE, { cwd: getEffectiveCwd() });
      updateFooterStatus(ctx, getEffectiveCwd(), getOriginalCwd());
      ctx.ui.notify(`Changed working directory to ${getEffectiveCwd()}`, "info");
    },
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      return getDirectoryCompletions(argumentPrefix, getEffectiveCwd());
    },
  });

  // ── Tool call interception ────────────────────────────────────────
  pi.on("tool_call", (event, _ctx) => {
    if (getEffectiveCwd() === getOriginalCwd()) return undefined;

    if (event.toolName === "bash") {
      // Bash tool input — only `command` is relevant for cwd prefixing
      const input = event.input as { command: string };
      input.command = `cd ${bashSingleQuote(getEffectiveCwd())} && ${input.command}`;
    } else if (FILE_TOOLS_REQUIRED_PATH.has(event.toolName)) {
      const input = event.input as { path: string };
      if (!isAbsolute(input.path)) {
        input.path = resolve(getEffectiveCwd(), input.path);
      }
    } else if (FILE_TOOLS_OPTIONAL_PATH.has(event.toolName)) {
      const input = event.input as { path?: string };
      if (input.path === undefined || input.path === "") {
        input.path = getEffectiveCwd();
      } else if (!isAbsolute(input.path)) {
        input.path = resolve(getEffectiveCwd(), input.path);
      }
    }

    return undefined;
  });

  // ── System prompt modification ────────────────────────────────────
  pi.on("before_agent_start", (event, _ctx) => {
    if (getEffectiveCwd() === getOriginalCwd()) return undefined;
    const modified = event.systemPrompt.replace(
      CWD_PROMPT_REGEX,
      `Current working directory: ${getEffectiveCwd()}`,
    );
    return { systemPrompt: modified };
  });

  // ── User ! bash command support ───────────────────────────────────
  pi.on("user_bash", (_event, _ctx) => {
    if (getEffectiveCwd() === getOriginalCwd()) return undefined;
    const escapedCwd = bashSingleQuote(getEffectiveCwd());
    const originalOps = getLocalBashOps();
    return {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: {
            onData: (data: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: NodeJS.ProcessEnv;
          },
        ) => {
          return originalOps.exec(`cd ${escapedCwd} && ${command}`, cwd, options);
        },
      },
    };
  });

  // ── State restoration ─────────────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    setEffectiveCwd(restoreCwdFromBranch(ctx, getOriginalCwd()));
    resetBashOps();
    updateFooterStatus(ctx, getEffectiveCwd(), getOriginalCwd());
  });

  pi.on("session_tree", (_event, ctx) => {
    setEffectiveCwd(restoreCwdFromBranch(ctx, getOriginalCwd()));
    updateFooterStatus(ctx, getEffectiveCwd(), getOriginalCwd());
  });
}
