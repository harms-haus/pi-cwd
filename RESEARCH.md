# Research Report: `/cwd <directory>` Extension for pi-coding-agent

**Date:** 2026-05-12  
**pi version:** 0.74.0  
**Target:** Allow users to type `/cwd <directory>` to change the current working directory of the pi-agent without restarting.

---

## 1. CRITICAL FINDING: TWO VIABLE APPROACHES

There are **two fundamentally different approaches** to implementing `/cwd`:

| | **Approach 1: Session Replacement** | **Approach 2: Tool Call Interception** |
|---|---|---|
| Mechanism | `ctx.switchSession()` rebuilds entire runtime | `tool_call` event mutates `event.input` in-place |
| Cwd change scope | Full runtime rebuild — ALL code sees new cwd | Only affects tool execution — `ctx.cwd` stays the same |
| Conversation | Lost (or requires manual copy via `forkFrom`) | Preserved automatically |
| Extension state | Lost and rebuilt via `session_start` | Preserved automatically |
| Resource discovery | New AGENTS.md, extensions, skills loaded | Stays with original project resources |
| Complexity | Medium (session file management) | Medium (intercept 7+ tool types) |
| Robustness | ★★★★★ (official mechanism) | ★★★★☆ (mutation is documented but unconventional) |
| User experience | "New session" feel | "Same session, different dir" feel |

**Recommendation:** Approach 2 (Tool Call Interception) is preferred for the primary use case of "I want to work in a different directory for a bit" because it preserves the conversation. Approach 1 (Session Replacement) should be available as a `/cwd-full` or flag-based alternative for when the user wants full project context switch.

---

## 2. APPROACH 1: SESSION REPLACEMENT (Full Runtime Rebuild)

### How it works

The `ctx.switchSession()` method is the **only existing code path** that changes cwd. It:
1. Tears down the current extension runtime
2. Calls `createRuntime({ cwd: newCwd })` which rebuilds ALL services from scratch
3. Rebinds everything (tools, extensions, resource loader, footer, etc.)

### Implementation pattern

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cwd", {
    description: "Change working directory (starts a new session with full project context)",
    handler: async (args, ctx) => {
      const rawInput = args.trim();
      if (!rawInput) {
        ctx.ui.notify(`Current directory: ${ctx.cwd}`, "info");
        return;
      }

      const target = rawInput.startsWith("~")
        ? rawInput.replace("~", process.env.HOME || "~")
        : rawInput;
      const newCwd = resolve(ctx.cwd, target);

      if (!existsSync(newCwd)) {
        ctx.ui.notify(`Directory not found: ${newCwd}`, "error");
        return;
      }
      if (!statSync(newCwd).isDirectory()) {
        ctx.ui.notify(`Not a directory: ${newCwd}`, "error");
        return;
      }

      // Option A: Fresh session (lose conversation)
      const newSm = SessionManager.create(newCwd);
      
      // Option B: Preserve conversation via forkFrom
      // const currentSessionFile = ctx.sessionManager.getSessionFile()!;
      // const newSm = SessionManager.forkFrom(currentSessionFile, newCwd);

      await ctx.switchSession(newSm.getSessionFile()!, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Working directory: ${newCwd}`, "info");
        }
      });
    }
  });
}
```

### Key facts

- **`ctx.cwd`** is a read-only getter on `ExtensionRunner.cwd`, set once in constructor. It CANNOT be mutated.
- **`ctx.reload()`** does NOT change cwd — it reloads extensions but uses `this._cwd`.
- **`ctx.newSession()`** does NOT change cwd — it uses `this.cwd` from the runtime.
- **`ctx.switchSession()`** DOES change cwd — it rebuilds the runtime with the session's stored cwd.
- **`process.chdir()`** alone is INSUFFICIENT — tools capture cwd at creation time via closures.
- **`SessionManager`** is importable from `@earendil-works/pi-coding-agent`.
- **`SessionManager.forkFrom(sourcePath, targetCwd)`** creates a new session in `targetCwd` with all history from `sourcePath`.

### What gets rebuilt on switchSession

- Tools (bash, read, write, edit) — recreated with new cwd
- `ExtensionRunner.cwd` — updated
- `DefaultResourceLoader` — rediscovers AGENTS.md, .pi/extensions, .pi/skills
- `FooterDataProvider` — git branch watcher updated via `setCwd()`
- System prompt — regenerated with new cwd on next turn
- Terminal title — updated

### Downsides

- Conversation history is lost (unless using `forkFrom`)
- Extension state is lost and must be reconstructed via `session_start`
- Creates a new session file (old one remains for `/resume`)
- Heavy operation — full teardown and rebuild

---

## 3. APPROACH 2: TOOL CALL INTERCEPTION (Lightweight, Preserves Conversation)

### How it works

Use the `tool_call` event to mutate `event.input` before tool execution. The `event.input` object is the SAME reference as the actual tool arguments — mutations propagate directly to tool execution.

**Confirmed in source code** (`agent-session.js` line 177-178):
```javascript
return await runner.emitToolCall({
    type: "tool_call",
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    input: args,  // <-- SAME object reference as tool arguments
});
```

The `beforeToolCall` hook on the Agent receives `args`, and the extension runner's `emitToolCall` passes `args` directly as `event.input`. Handlers mutate this object in place, and the mutated `args` flows to actual tool execution.

### Implementation pattern

```typescript
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

export default function (pi: ExtensionAPI) {
  let effectiveCwd = process.cwd();
  const originalCwd = process.cwd();

  // --- Command ---
  pi.registerCommand("cwd", {
    description: "Change working directory for tool execution",
    getArgumentCompletions: (prefix) => {
      // TODO: implement directory completion
      return null;
    },
    handler: async (args, ctx) => {
      const rawInput = args.trim();
      if (!rawInput) {
        ctx.ui.notify(`Current directory: ${effectiveCwd}`, "info");
        return;
      }

      const target = rawInput.startsWith("~")
        ? rawInput.replace("~", process.env.HOME || "~")
        : rawInput;
      const newCwd = resolve(effectiveCwd, target);

      if (!existsSync(newCwd)) {
        ctx.ui.notify(`Directory not found: ${newCwd}`, "error");
        return;
      }
      if (!statSync(newCwd).isDirectory()) {
        ctx.ui.notify(`Not a directory: ${newCwd}`, "error");
        return;
      }

      effectiveCwd = newCwd;
      pi.appendEntry("cwd-change", { cwd: effectiveCwd });
      ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `cwd: ${effectiveCwd}`));
      ctx.ui.notify(`Working directory: ${effectiveCwd}`, "info");
    },
  });

  // --- Intercept tool calls ---
  pi.on("tool_call", async (event, _ctx) => {
    if (effectiveCwd === originalCwd) return undefined;

    switch (event.toolName) {
      case "bash":
        // Prepend cd to the effective cwd
        (event.input as { command: string }).command =
          `cd ${JSON.stringify(effectiveCwd)} && ${(event.input as { command: string }).command}`;
        break;
      case "read":
      case "write":
      case "edit":
      case "grep":
      case "find":
      case "ls":
        // Resolve relative paths to absolute against effectiveCwd
        if (event.input.path && !isAbsolute(event.input.path)) {
          event.input.path = resolve(effectiveCwd, event.input.path);
        }
        break;
    }
    return undefined;
  });

  // --- System prompt modification ---
  pi.on("before_agent_start", async (event) => {
    if (effectiveCwd === originalCwd) return undefined;
    const modified = event.systemPrompt.replace(
      /Current working directory: .+/,
      `Current working directory: ${effectiveCwd}`
    );
    return { systemPrompt: modified };
  });

  // --- User bash commands (! prefix) ---
  pi.on("user_bash", async (event, _ctx) => {
    if (effectiveCwd === originalCwd) return undefined;
    // Return custom operations that cd to effectiveCwd first
    // (The user_bash handler can return { operations } to override execution)
    return undefined; // Default handling is OK since we can't easily override cwd here
    // Alternative: prepend cd to event.command... but event.command is not mutable
  });

  // --- Restore state on session events ---
  pi.on("session_start", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "cwd-change") {
        const data = entry.data as { cwd: string } | undefined;
        if (data?.cwd) effectiveCwd = data.cwd;
      }
    }
    if (effectiveCwd !== originalCwd) {
      ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `cwd: ${effectiveCwd}`));
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Re-derive effectiveCwd from the branch we navigated to
    effectiveCwd = originalCwd;
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "cwd-change") {
        const data = entry.data as { cwd: string } | undefined;
        if (data?.cwd) effectiveCwd = data.cwd;
      }
    }
    if (effectiveCwd !== originalCwd) {
      ctx.ui.setStatus("cwd", ctx.ui.theme.fg("accent", `cwd: ${effectiveCwd}`));
    }
  });
}
```

### Key facts about this approach

- **`event.input` is mutable** — documented in extensions.md and confirmed in source
- **Mutations affect actual execution** — the same `args` object reference flows to tool `execute()`
- **No re-validation after mutation** — mutated values are used as-is
- **Later handlers see earlier mutations** — sequential handler execution
- **`appendEntry`** persists state to session for branch-aware restoration
- **`ctx.ui.setStatus(key, text)`** adds a status bar indicator

### What this approach handles

| Tool | How | Works? |
|------|-----|--------|
| bash | Prepend `cd <effectiveCwd> &&` | ✅ |
| read | Resolve `event.input.path` against effectiveCwd | ✅ |
| write | Resolve `event.input.path` against effectiveCwd | ✅ |
| edit | Resolve `event.input.path` against effectiveCwd | ✅ |
| grep | Resolve `event.input.path` against effectiveCwd | ✅ |
| find | Resolve `event.input.path` against effectiveCwd | ✅ |
| ls | Resolve `event.input.path` against effectiveCwd | ✅ |
| System prompt | Replace "Current working directory:" line | ✅ |
| User `!` commands | `user_bash` event (limited) | ⚠️ Partial |
| `ctx.cwd` | NOT updated (remains original) | ❌ Cosmetic only |
| Footer display | Via `ctx.ui.setStatus()` | ✅ |
| Extension renderers | Still show original cwd in `context.cwd` | ⚠️ Cosmetic |

### Limitations

1. **`ctx.cwd` stays the original** — extensions that read `ctx.cwd` get the original value
2. **Tool renderers show original cwd** — the `ToolRenderContext.cwd` comes from `runner.cwd`
3. **User `!` commands** — `executeBash()` uses `sessionManager.getCwd()` (original). The `user_bash` event doesn't let you modify the command, only provide custom `BashOperations` or a complete result
4. **Resource discovery** — AGENTS.md, project extensions, skills from original cwd still loaded
5. **Session directory** — sessions still saved under original cwd's directory

---

## 4. EXISTING EXAMPLE EXTENSIONS AS TEMPLATES

### 4a. SSH Extension (`ssh.ts`) — ★★★★★ MOST RELEVANT

**Pattern:** Overrides ALL built-in tools to redirect operations to a remote machine. Modifies system prompt to show effective cwd.

```typescript
// Creates local tools, then wraps their execute methods
const localBash = createBashTool(cwd);
pi.registerTool({
  ...localBash,  // Spreads name, label, description, parameters, renderers
  async execute(id, params, signal, onUpdate, _ctx) {
    if (ssh) {
      const tool = createBashTool(cwd, {
        operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localBash.execute(id, params, signal, onUpdate);
  },
});

// Modifies system prompt
pi.on("before_agent_start", async (event) => {
  const modified = event.systemPrompt.replace(
    `Current working directory: ${localCwd}`,
    `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
  );
  return { systemPrompt: modified };
});
```

### 4b. Bash Spawn Hook (`bash-spawn-hook.ts`) — ★★★★☆

**Pattern:** Uses `createBashTool(cwd, { spawnHook })` to adjust cwd per-command.

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,  // CAN MODIFY CWD!
    env: { ...env, PI_SPAWN_HOOK: "1" },
  }),
});
```

**Key:** The `spawnHook` can modify `cwd` for bash. But this only works for bash, and requires overriding the bash tool.

### 4c. Pirate Extension (`pirate.ts`) — ★★★★☆

**Pattern:** Mutable state + command toggle + `before_agent_start` system prompt modification.

```typescript
let pirateMode = false;
pi.registerCommand("pirate", { handler: async (_args, ctx) => { pirateMode = !pirateMode; } });
pi.on("before_agent_start", async (event) => {
  if (pirateMode) return { systemPrompt: event.systemPrompt + "..." };
});
```

### 4d. Permission Gate (`permission-gate.ts`) — ★★★☆☆

**Pattern:** `tool_call` event interception with blocking and mutation.

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command as string;
  // Can block: return { block: true, reason: "..." };
  // Can mutate: event.input.command = "modified";
});
```

### 4e. Tools Extension (`tools.ts`) — ★★★☆☆

**Pattern:** State persistence via `pi.appendEntry()` + restoration on `session_start`/`session_tree`.

```typescript
pi.appendEntry<ToolsState>("tools-config", { enabledTools: [...] });
// Restore by scanning ctx.sessionManager.getBranch() for custom entries
```

### 4f. Tool Override (`tool-override.ts`) — ★★★☆☆

**Pattern:** Override a built-in tool by registering a tool with the same name. Shows `resolve(ctx.cwd, path)` for path resolution.

### 4g. Input Transform (`input-transform.ts`) — ★★☆☆☆

**Pattern:** `input` event for intercepting/transforming/handling user input before agent processing.

### 4h. Event Bus (`event-bus.ts`) — ★★☆☆☆

**Pattern:** `pi.events` for inter-extension communication (emit/on).

### 4i. Inline Bash (`inline-bash.ts`) — ★★☆☆☆

**Pattern:** `input` event to expand `!{command}` patterns using `pi.exec()`.

### 4j. Handoff (`handoff.ts`) — ★★☆☆☆

**Pattern:** Complex command using `ctx.newSession()` with `withSession` callback, LLM call for prompt generation, `BorderedLoader` for progress UI.

### 4k. Session Name (`session-name.ts`) — ★☆☆☆☆

**Pattern:** Simple command using `pi.setSessionName()` / `pi.getSessionName()`.

---

## 5. EXTENSION API REFERENCE (Key Types)

### Tool Call Event
```typescript
interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls" | string;
  input: Record<string, unknown>; // MUTABLE - mutations propagate to execution
}

interface ToolCallEventResult {
  block?: boolean;   // Block tool execution
  reason?: string;   // Reason for blocking
}
```

### Before Agent Start Event
```typescript
interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;                    // Can be replaced
  systemPromptOptions: BuildSystemPromptOptions;
}

interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  systemPrompt?: string;  // Replace the system prompt for this turn
}
```

### Bash Tool Input (cwd is NOT in the schema)
```typescript
type BashToolInput = {
  command: string;
  timeout?: number;
}
// cwd is captured at tool CREATION time, not per-call
```

### Bash Spawn Hook
```typescript
type BashSpawnHook = (context: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => { command: string; cwd: string; env: NodeJS.ProcessEnv };
```

### User Bash Event
```typescript
interface UserBashEvent {
  type: "user_bash";
  command: string;
  excludeFromContext: boolean;
  cwd: string;  // Read-only from sessionManager.getCwd()
}

interface UserBashEventResult {
  operations?: BashOperations;  // Custom execution operations
  result?: BashResult;          // Full replacement result
}
```

### Tool Factories
```typescript
createBashTool(cwd: string, options?: BashToolOptions): AgentTool;
createReadTool(cwd: string, options?: ReadToolOptions): AgentTool;
createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool;
createEditTool(cwd: string, options?: EditToolOptions): AgentTool;
createFindTool(cwd: string, options?: FindToolOptions): AgentTool;
createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool;
createLsTool(cwd: string, options?: LsToolOptions): AgentTool;
```

---

## 6. HOW CWD FLOWS THROUGH THE SYSTEM

```
Startup:
  process.cwd()
    → SessionManager.create(cwd)         [stores cwd in session header]
    → AgentSessionRuntime({ cwd })       [stores as _cwd]
    → createRuntime({ cwd })
      → createAgentSessionServices({ cwd })
        → DefaultResourceLoader({ cwd }) [discovers .pi/*, AGENTS.md]
        → createCodingTools(cwd)         [bash/read/write/edit capture cwd in closures]
      → ExtensionRunner(extensions, runtime, cwd)
        → runner.cwd = cwd               [ctx.cwd getter returns this]
    → AgentSession({ _cwd })             [stores internally]

Tool execution:
  bash tool: resolveSpawnContext(command, cwd, spawnHook) → ops.exec(command, spawnContext.cwd)
  read tool: resolveReadPath(path, cwd) → ops.readFile(absolutePath)
  write tool: resolveToCwd(path, cwd) → ops.writeFile(absolutePath)
  edit tool: resolveToCwd(path, cwd) → ops.readFile/writeFile(absolutePath)

User ! command:
  executeBash(command) → executeBashWithOperations(command, sessionManager.getCwd(), ops)

System prompt:
  buildSystemPrompt({ cwd, ... }) → "Current working directory: <cwd>"
```

---

## 7. PROJECT CONVENTIONS

### Extension Structure
- **Single default export function:** `export default function(pi: ExtensionAPI) { ... }`
- **TypeScript** with `import type` for type-only imports
- **Imports from:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`, `node:*`

### Naming
- File names: `kebab-case.ts`
- Tool names: `snake_case`
- Command names: `kebab-case`
- Custom entry types: `kebab-case` (e.g., `"cwd-change"`, `"tools-config"`)

### Error Handling
- `ctx.ui.notify(message, "error" | "warning" | "info")` for user feedback
- Guard with `if (!ctx.hasUI)` for non-interactive modes
- Validate inputs before acting

### State Persistence
- `pi.appendEntry<CustomType>("custom-type-key", data)` for session-aware persistence
- Scan `ctx.sessionManager.getBranch()` for custom entries to restore state
- Restore on `session_start` and `session_tree` events

---

## 8. RECOMMENDED IMPLEMENTATION STRATEGY

### Phase 1: Core `/cwd` command (Approach 2 — tool_call interception)

Implement the lightweight approach that preserves conversation:

1. Register `/cwd` command with path argument, validation, and `~` expansion
2. Store `effectiveCwd` in module-level variable, defaulting to `process.cwd()`
3. Use `tool_call` event to mutate `event.input`:
   - `bash`: prepend `cd <effectiveCwd> &&`
   - `read`/`write`/`edit`/`grep`/`find`/`ls`: resolve `path` against `effectiveCwd`
4. Use `before_agent_start` to update system prompt cwd
5. Use `ctx.ui.setStatus()` for footer indicator
6. Persist via `pi.appendEntry("cwd-change", { cwd })` for session-aware state
7. Restore on `session_start` and `session_tree`

### Phase 2: User `!` command support

Handle the `user_bash` event to redirect user bash commands to the effective cwd. Options:
- Return custom `BashOperations` using `createLocalBashOperations()`
- Or just prepend `cd <effectiveCwd> &&` to the command in a wrapper

### Phase 3: Argument completion

Add `getArgumentCompletions` for directory path completion in the `/cwd` command.

### Phase 4 (Optional): Full session replacement mode

Add a `--full` flag to `/cwd` that uses Approach 1 (session replacement via `switchSession`) for when the user wants full project context including AGENTS.md, project extensions, etc.

---

## 9. KEY FILES TO REFERENCE

| File | Purpose |
|------|---------|
| `examples/extensions/ssh.ts` | Full tool override pattern with cwd substitution + system prompt |
| `examples/extensions/bash-spawn-hook.ts` | `spawnHook` pattern for bash cwd modification |
| `examples/extensions/pirate.ts` | State toggle + system prompt modification |
| `examples/extensions/tools.ts` | State persistence via `appendEntry` + session events |
| `examples/extensions/permission-gate.ts` | `tool_call` event interception |
| `examples/extensions/commands.ts` | Command registration with argument completions |
| `examples/extensions/tool-override.ts` | Tool override by same name |
| `dist/core/extensions/types.d.ts` | All type definitions |
| `dist/core/tools/bash.d.ts` | BashSpawnHook, BashOperations types |
| `dist/core/agent-session.js` (line 165-180) | `beforeToolCall` hook — confirms `args` is same reference |
| `dist/core/extensions/runner.js` (line 389-391) | `ctx.cwd` getter returns `runner.cwd` |
| `docs/extensions.md` | Full extension documentation |

---

## 10. IMPORT REQUIREMENTS

```typescript
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
```

No additional npm dependencies needed.
