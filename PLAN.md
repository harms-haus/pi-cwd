# Implementation Plan: `/cwd` Extension for pi-coding-agent

## Scope & Boundaries

### Files to Create

| File | Purpose |
|------|---------|
| `/home/blake/Documents/software/pi-extensions/pi-cwd/package.json` | Extension metadata and pi entry point declaration |
| `/home/blake/Documents/software/pi-extensions/pi-cwd/index.ts` | Complete extension implementation (single file) |

### Files OUT OF SCOPE (will not be modified)
- All files in other pi-extension projects (`pi-till-done`, `pi-rpir-workflow`, etc.)
- Any `node_modules` or `@earendil-works/pi-coding-agent` source code
- Any configuration files outside `pi-cwd/`

### Known Limitations (documented, not fixed)
- `ctx.cwd` remains the original cwd — it is a read-only getter on `ExtensionRunner`
- Extension tools registered by other extensions (e.g., `lint-files`, `lsp-*`) read `ctx.cwd` and will see the original cwd
- Session files continue to be saved under the original cwd's directory
- Resource discovery (AGENTS.md, project extensions, skills) stays bound to the original cwd

---

## Data Model & State Changes

### Module-Level State

```typescript
let effectiveCwd: string;   // The effective working directory; initialized to process.cwd()
const originalCwd: string;  // The original cwd at extension load time; never changes
```

### Persisted State (via `pi.appendEntry`)

Custom entry type: `"cwd-change"`

```typescript
// Written via:
pi.appendEntry("cwd-change", { cwd: effectiveCwd });

// Shape of entry.data:
interface CwdChangeData {
    cwd: string;  // absolute path
}
```

### State Restoration (from session branch)

On `session_start` and `session_tree`, scan `ctx.sessionManager.getBranch()` forwards (oldest-to-newest) for all `"cwd-change"` entries. The **last** one wins. If no entries exist, reset `effectiveCwd` to `originalCwd`.

```typescript
interface SessionEntry {
    type: string;          // look for "custom"
    customType?: string;   // look for "cwd-change"
    data?: { cwd?: string };
}
```

---

## Algorithm & Logic

### 1. `/cwd` Command Handler

**Input:** `args: string` (raw string from the user, after the command name)
**Context:** `ExtensionCommandContext`

```
FUNCTION handleCwdCommand(args, ctx):
    rawInput = args.trim()

    // Case 1: No arguments — show current cwd
    IF rawInput is empty:
        ctx.ui.notify(`Current working directory: ${effectiveCwd}`, "info")
        RETURN

    // Case 2: Expand tilde
    IF rawInput starts with "~":
        rawInput = rawInput.replace(/^~/, process.env.HOME || "~")

    // Case 3: Resolve to absolute path
    targetPath = resolve(effectiveCwd, rawInput)

    // Case 4: Validate target exists and is a directory
    IF NOT existsSync(targetPath):
        ctx.ui.notify(`Directory not found: ${targetPath}`, "error")
        RETURN
    IF NOT statSync(targetPath).isDirectory():
        ctx.ui.notify(`Not a directory: ${targetPath}`, "error")
        RETURN

    // Case 5: Update state
    effectiveCwd = targetPath

    // Case 6: Persist to session
    pi.appendEntry("cwd-change", { cwd: effectiveCwd })

    // Case 7: Update footer status
    updateFooterStatus(ctx)

    // Case 8: Notify user
    ctx.ui.notify(`Working directory: ${effectiveCwd}`, "info")
```

### 2. Tool Call Interception (`tool_call` event)

**Early exit:** If `effectiveCwd === originalCwd`, return `undefined` (no interception needed).

**Tool-specific logic:**

#### `bash` tool
```
IF event.toolName === "bash":
    event.input.command = `cd ${JSON.stringify(effectiveCwd)} && ${event.input.command}`
    RETURN undefined
```

- `JSON.stringify` handles paths with spaces and special characters.
- `cd` is a shell builtin that doesn't spawn a process; the `&&` ensures the original command only runs if `cd` succeeds.

#### File tools with required `path`: `read`, `write`, `edit`
```
IF event.toolName is "read" | "write" | "edit":
    IF event.input.path exists AND NOT isAbsolute(event.input.path):
        event.input.path = resolve(effectiveCwd, event.input.path)
    RETURN undefined
```

- These tools have a required `path: string` field.
- Only relative paths are rewritten; absolute paths pass through unchanged.

#### File tools with optional `path`: `grep`, `find`, `ls`
```
IF event.toolName is "grep" | "find" | "ls":
    pathValue = event.input.path
    IF pathValue is undefined OR pathValue is "":
        // Tool defaults to original cwd — override to effectiveCwd
        event.input.path = effectiveCwd
    ELSE IF NOT isAbsolute(pathValue):
        event.input.path = resolve(effectiveCwd, pathValue)
    RETURN undefined
```

- These tools have optional `path` fields. When omitted, the tool uses its built-in cwd (the original). We must explicitly set it to `effectiveCwd` when it's missing.

### 3. System Prompt Modification (`before_agent_start` event)

```
FUNCTION handleBeforeAgentStart(event):
    IF effectiveCwd === originalCwd:
        RETURN undefined  // No modification needed

    modifiedPrompt = event.systemPrompt.replace(
        /Current working directory: .+/,
        `Current working directory: ${effectiveCwd}`
    )
    RETURN { systemPrompt: modifiedPrompt }
```

- The regex matches the exact line format in the built-in system prompt.
- Only replaces the first occurrence (which is the correct one).
- This ensures the LLM knows the effective working directory.

### 4. Footer Status Indicator

```
FUNCTION updateFooterStatus(ctx):
    IF effectiveCwd === originalCwd:
        ctx.ui.setStatus("cwd", undefined)  // Clear status
    ELSE:
        // Shorten display: show ~ for home, show relative if under home
        displayPath = effectiveCwd.replace(
            new RegExp(`^${escapeRegex(process.env.HOME || "")}`), "~"
        )
        ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `📂 ${displayPath}`))
```

- `setStatus("cwd", text)` adds a keyed entry to the footer status bar.
- Setting to `undefined` clears the entry.
- The key `"cwd"` avoids collisions with other extensions.

### 5. State Persistence (`pi.appendEntry`)

Called after every successful `/cwd` invocation:
```
pi.appendEntry("cwd-change", { cwd: effectiveCwd })
```

### 6. State Restoration (`session_start` and `session_tree` events)

#### `session_start` handler
```
FUNCTION handleSessionStart(event, ctx):
    effectiveCwd = originalCwd  // Reset to default first
    branch = ctx.sessionManager.getBranch()
    FOR entry IN branch:  // Iterate forwards; last cwd-change wins
        IF entry.type === "custom" AND entry.customType === "cwd-change":
            IF entry.data?.cwd AND typeof entry.data.cwd === "string":
                effectiveCwd = entry.data.cwd
    updateFooterStatus(ctx)
```

#### `session_tree` handler
```
FUNCTION handleSessionTree(event, ctx):
    // Same logic as session_start — re-derive from the branch we navigated to
    effectiveCwd = originalCwd
    branch = ctx.sessionManager.getBranch()
    FOR entry IN branch:
        IF entry.type === "custom" AND entry.customType === "cwd-change":
            IF entry.data?.cwd AND typeof entry.data.cwd === "string":
                effectiveCwd = entry.data.cwd
    updateFooterStatus(ctx)
```

### 7. User `!` Bash Commands (`user_bash` event)

```
FUNCTION handleUserBash(event, ctx):
    IF effectiveCwd === originalCwd:
        RETURN undefined  // Default handling

    // Provide custom BashOperations that prepend cd to effectiveCwd
    IF NOT localOps:
        localOps = createLocalBashOperations()
    RETURN { operations: localOps }
```

Wait — the `user_bash` event's `operations` override replaces the operations entirely, but the operations themselves receive `cwd` as a parameter from the caller. The caller passes `sessionManager.getCwd()` (the original). The `BashOperations.exec(command, cwd, options)` receives `cwd` from the caller.

We cannot change the `cwd` parameter through `operations` because it's passed by the caller. Instead, we need to modify the command itself. But `UserBashEvent.command` is not mutable per the research.

**Revised approach:** Return a custom `BashOperations` wrapper that prepends `cd` to the command:

```
FUNCTION handleUserBash(event, ctx):
    IF effectiveCwd === originalCwd:
        RETURN undefined

    RETURN {
        operations: {
            exec: (command, cwd, options) => {
                const modifiedCommand = `cd ${JSON.stringify(effectiveCwd)} && ${command}`
                // Use original operations to execute
                return originalOps.exec(modifiedCommand, cwd, options)
            }
        }
    }
```

This wraps the command with `cd <effectiveCwd> &&` before the original operations execute it. The `cwd` parameter passed to `exec` doesn't matter because we're explicitly `cd`-ing first.

### 8. Argument Completion (`getArgumentCompletions`)

```
FUNCTION getArgumentCompletions(prefix):
    // Resolve the prefix against effectiveCwd
    resolvedPrefix = prefix.startsWith("~")
        ? prefix.replace(/^~/, process.env.HOME || "~")
        : prefix

    baseDir = isAbsolute(resolvedPrefix)
        ? dirname(resolvedPrefix)
        : resolve(effectiveCwd, dirname(resolvedPrefix) || effectiveCwd)

    partial = basename(resolvedPrefix) || ""

    IF NOT existsSync(baseDir) OR NOT statSync(baseDir).isDirectory():
        RETURN null

    TRY:
        entries = readdirSync(baseDir)
        dirs = entries.filter(e => {
            fullPath = join(baseDir, e)
            return statSync(fullPath).isDirectory()
        })

        filtered = dirs.filter(d =>
            d.toLowerCase().startsWith(partial.toLowerCase())
        )

        IF filtered.length === 0:
            RETURN null

        RETURN filtered.map(d => ({
            label: d,
            // Completion text: the part after the prefix's dirname
            value: isAbsolute(resolvedPrefix)
                ? join(baseDir, d)
                : join(dirname(prefix) || "", d)
        }))
    CATCH:
        RETURN null
```

Returns `AutocompleteItem[] | null`. Returns `null` if no matches or directory doesn't exist.

### 9. Edge Cases

| Edge Case | Handling |
|-----------|----------|
| `/cwd /nonexistent` | `existsSync` check → `ctx.ui.notify("Directory not found: ...", "error")` |
| `/cwd /some/file.txt` | `statSync.isDirectory()` check → `ctx.ui.notify("Not a directory: ...", "error")` |
| `/cwd ..` | `resolve(effectiveCwd, "..")` works correctly → parent directory |
| `/cwd .` | `resolve(effectiveCwd, ".")` → same directory (no-op, but still validates and persists) |
| `/cwd ~/Documents` | Tilde expansion via `replace(/^~/, process.env.HOME)` |
| `/cwd` (no args) | Shows current `effectiveCwd` via `ctx.ui.notify` |
| Tool call with absolute path | `isAbsolute` check → path passes through unchanged |
| Tool call with relative path | `resolve(effectiveCwd, path)` → rewritten to absolute under effectiveCwd |
| `grep`/`find`/`ls` with no `path` | Explicitly set `event.input.path = effectiveCwd` |
| `bash` command with special chars | `JSON.stringify(effectiveCwd)` properly quotes the path for shell |
| `effectiveCwd === originalCwd` | All interception handlers return early (no-op) |
| Session branch with no cwd-change entries | `effectiveCwd` stays at `originalCwd` |
| Multiple cwd-change entries in branch | Last entry wins (forward iteration, later assignment overwrites) |

---

## Integration & Contracts

### Extension Entry Point

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void { ... }
```

### Registered Command

```typescript
pi.registerCommand("cwd", {
    description: "Change working directory for tool execution",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => { ... },
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => { ... },
});
```

### Event Handler Signatures

```typescript
// Tool call interception
pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => { ... });

// System prompt modification
pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> => { ... });

// User bash command support
pi.on("user_bash", async (event: UserBashEvent, ctx: ExtensionContext): Promise<UserBashEventResult | undefined> => { ... });

// State restoration
pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => { ... });
pi.on("session_tree", async (event: SessionTreeEvent, ctx: ExtensionContext): Promise<void> => { ... });
```

### Helper Function Signatures

```typescript
function updateFooterStatus(ctx: ExtensionContext): void
function resolvePath(path: string | undefined, cwd: string): string | undefined
function expandTilde(input: string): string
```

### package.json

```json
{
  "name": "pi-cwd",
  "version": "1.0.0",
  "description": "pi-coding-agent extension: change working directory with /cwd <path>",
  "keywords": ["pi-package"],
  "main": "index.ts",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "license": "MIT"
}
```

---

## Implementation Steps (Atomic, Ordered)

### Step 1: Create `package.json`
Create `/home/blake/Documents/software/pi-extensions/pi-cwd/package.json` with the content above.

### Step 2: Create `index.ts` — Imports and Module State
Create `/home/blake/Documents/software/pi-extensions/pi-cwd/index.ts` with:
- File header comment block (matching convention from other extensions)
- All imports
- Module-level state variables (`effectiveCwd`, `originalCwd`)

```typescript
/**
 * pi-cwd — Change working directory for tool execution
 *
 * Provides /cwd <path> command to change the effective working directory
 * without restarting the agent. Intercepts tool calls to redirect
 * file operations and bash commands to the new directory.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionCommandContext,
    ToolCallEvent,
    BeforeAgentStartEvent,
    UserBashEvent,
    SessionStartEvent,
    SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve, isAbsolute, dirname, basename, join } from "node:path";
```

### Step 3: Add Helper Functions
Add these private helper functions before the main export:

```typescript
/** Expand ~ to HOME directory */
function expandTilde(input: string): string {
    if (input.startsWith("~")) {
        return input.replace(/^~/, process.env.HOME || "~");
    }
    return input;
}

/** Escape string for use in RegExp */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve a path against a base directory. Returns absolute path or undefined if input is undefined/empty. */
function resolvePath(pathInput: string | undefined, base: string): string | undefined {
    if (pathInput === undefined || pathInput === "") return undefined;
    if (isAbsolute(pathInput)) return pathInput;
    return resolve(base, pathInput);
}

/** Update the footer status indicator */
function updateFooterStatus(ctx: ExtensionContext, effectiveCwd: string, originalCwd: string): void {
    if (!ctx.hasUI) return;
    if (effectiveCwd === originalCwd) {
        ctx.ui.setStatus("cwd", undefined);
        return;
    }
    const home = process.env.HOME || "";
    const displayPath = home ? effectiveCwd.replace(new RegExp(`^${escapeRegex(home)}`), "~") : effectiveCwd;
    ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `📂 ${displayPath}`));
}
```

### Step 4: Add State Restoration Function
```typescript
/** Re-derive effectiveCwd from session branch. Returns the last cwd-change value, or originalCwd. */
function restoreCwdFromBranch(
    ctx: ExtensionContext,
    originalCwd: string,
): string {
    const branch = ctx.sessionManager.getBranch();
    let restored = originalCwd;
    for (const entry of branch) {
        if (
            entry.type === "custom" &&
            entry.customType === "cwd-change" &&
            entry.data?.cwd &&
            typeof entry.data.cwd === "string"
        ) {
            restored = entry.data.cwd;
        }
    }
    return restored;
}
```

### Step 5: Add Argument Completion Function
```typescript
/** Directory tab-completion for /cwd command */
function getDirectoryCompletions(
    prefix: string,
    effectiveCwd: string,
): Array<{ label: string; value: string }> | null {
    const expanded = expandTilde(prefix);
    const hasDirPart = expanded.includes("/") || (expanded.length > 0 && !isAbsolute(expanded));

    let baseDir: string;
    let partial: string;

    if (expanded === "" || expanded === ".") {
        baseDir = effectiveCwd;
        partial = "";
    } else if (isAbsolute(expanded)) {
        baseDir = dirname(expanded);
        partial = basename(expanded);
    } else {
        baseDir = resolve(effectiveCwd, dirname(expanded) === "." ? effectiveCwd : dirname(expanded));
        partial = basename(expanded);
    }

    if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) return null;

    try {
        const entries = readdirSync(baseDir);
        const dirs = entries.filter((e) => {
            try {
                return statSync(join(baseDir, e)).isDirectory();
            } catch {
                return false;
            }
        });

        const filtered = partial
            ? dirs.filter((d) => d.toLowerCase().startsWith(partial.toLowerCase()))
            : dirs;

        if (filtered.length === 0) return null;

        return filtered.map((d) => {
            let value: string;
            if (isAbsolute(expanded) || expanded.startsWith("~")) {
                value = join(baseDir, d);
                if (expanded.startsWith("~") && process.env.HOME) {
                    value = value.replace(new RegExp(`^${escapeRegex(process.env.HOME)}`), "~");
                }
            } else {
                const dirPart = dirname(prefix);
                value = dirPart === "." ? d : join(dirPart, d);
            }
            return { label: d, value };
        });
    } catch {
        return null;
    }
}
```

### Step 6: Implement Main Export — State Initialization and Command Registration
```typescript
export default function (pi: ExtensionAPI): void {
    const originalCwd = process.cwd();
    let effectiveCwd = originalCwd;
    let localBashOps = createLocalBashOperations();

    // ── /cwd command ──

    pi.registerCommand("cwd", {
        description: "Change working directory for tool execution (/cwd <path> or /cwd to show current)",
        handler: async (args, ctx) => {
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

            effectiveCwd = newCwd;
            pi.appendEntry("cwd-change", { cwd: effectiveCwd });
            updateFooterStatus(ctx, effectiveCwd, originalCwd);
            ctx.ui.notify(`Working directory: ${effectiveCwd}`, "info");
        },
        getArgumentCompletions: (argumentPrefix) => {
            return getDirectoryCompletions(argumentPrefix, effectiveCwd);
        },
    });
```

### Step 7: Implement `tool_call` Event Handler
```typescript
    // ── Tool call interception ──

    pi.on("tool_call", async (event, _ctx) => {
        // Early exit if cwd hasn't changed
        if (effectiveCwd === originalCwd) return undefined;

        const FILE_TOOLS_REQUIRED_PATH = new Set(["read", "write", "edit"]);
        const FILE_TOOLS_OPTIONAL_PATH = new Set(["grep", "find", "ls"]);

        if (event.toolName === "bash") {
            const input = event.input as { command: string; timeout?: number };
            input.command = `cd ${JSON.stringify(effectiveCwd)} && ${input.command}`;
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
```

### Step 8: Implement `before_agent_start` Event Handler
```typescript
    // ── System prompt modification ──

    pi.on("before_agent_start", async (event, _ctx) => {
        if (effectiveCwd === originalCwd) return undefined;

        const modified = event.systemPrompt.replace(
            /Current working directory: .+/,
            `Current working directory: ${effectiveCwd}`,
        );
        return { systemPrompt: modified };
    });
```

### Step 9: Implement `user_bash` Event Handler
```typescript
    // ── User ! bash command support ──

    pi.on("user_bash", async (event, _ctx) => {
        if (effectiveCwd === originalCwd) return undefined;

        return {
            operations: {
                exec: (command, cwd, options) => {
                    const modifiedCommand = `cd ${JSON.stringify(effectiveCwd)} && ${command}`;
                    return localBashOps.exec(modifiedCommand, cwd, options);
                },
            },
        };
    });
```

### Step 10: Implement `session_start` and `session_tree` Event Handlers
```typescript
    // ── State restoration ──

    pi.on("session_start", async (_event, ctx) => {
        effectiveCwd = restoreCwdFromBranch(ctx, originalCwd);
        updateFooterStatus(ctx, effectiveCwd, originalCwd);
    });

    pi.on("session_tree", async (_event, ctx) => {
        effectiveCwd = restoreCwdFromBranch(ctx, originalCwd);
        updateFooterStatus(ctx, effectiveCwd, originalCwd);
    });
```

This completes the export function body. Close it with `}`.

---

## Testing Strategy

### Manual Testing Checklist

These tests are performed interactively in the pi TUI:

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 1 | Show current cwd | Type `/cwd` | Shows `Current working directory: <original>` |
| 2 | Change to absolute path | `/cwd /tmp` | Shows `Working directory: /tmp` |
| 3 | Change to relative path | `/cwd ..` | Shows parent directory |
| 4 | Change with tilde | `/cwd ~/Documents` | Shows expanded home path |
| 5 | Nonexistent path | `/cwd /nonexistent` | Error: "Directory not found: /nonexistent" |
| 6 | Not a directory | `/cwd /etc/passwd` | Error: "Not a directory: ..." |
| 7 | Bash tool uses new cwd | `/cwd /tmp`, then ask agent to run `pwd` | Agent's bash shows `/tmp` |
| 8 | Read tool uses new cwd | `/cwd /tmp`, then ask agent to read a relative file in /tmp | File resolved correctly |
| 9 | Write tool uses new cwd | `/cwd /tmp`, ask agent to write to a relative path | File written to /tmp/<path> |
| 10 | Edit tool uses new cwd | `/cwd /tmp`, ask agent to edit a relative file | File resolved correctly |
| 11 | Grep with no path uses new cwd | `/cwd /tmp`, ask agent to grep without specifying path | Searches in /tmp |
| 12 | Find with no path uses new cwd | `/cwd /tmp`, ask agent to find without specifying path | Searches in /tmp |
| 13 | Ls with no path uses new cwd | `/cwd /tmp`, ask agent to ls without specifying path | Lists /tmp contents |
| 14 | Footer status indicator | `/cwd /tmp` | Footer shows `📂 /tmp` |
| 15 | Footer clears on reset | `/cwd /tmp`, then `/cwd <original>` | Footer clears |
| 16 | System prompt updated | `/cwd /tmp`, then ask agent "what is my cwd?" | Agent responds with /tmp |
| 17 | User ! bash command | `/cwd /tmp`, then type `!pwd` | Shows `/tmp` |
| 18 | State persists across reload | `/cwd /tmp`, then `/reload` | After reload, cwd is still /tmp |
| 19 | State persists across restart | `/cwd /tmp`, restart pi, `/resume` | After resume, cwd is /tmp |
| 20 | Branch navigation restores cwd | `/cwd /tmp`, do some work, navigate back before cwd change | effectiveCwd reverts to original |
| 21 | Tab completion works | Type `/cwd /tm` then Tab | Completes to `/tmp` |
| 22 | Absolute paths not rewritten | Ask agent to read `/etc/passwd` after `/cwd /tmp` | Reads `/etc/passwd` (not `/tmp/etc/passwd`) |
| 23 | Multiple cwd changes | `/cwd /tmp`, `/cwd /var`, `/cwd /home` | Each change updates correctly |
| 24 | No-op when cwd unchanged | `/cwd <original>` | No interception happens (early exit) |

### Existing Tests That Must Pass
- No existing tests are affected; this is a new extension in a new directory.
