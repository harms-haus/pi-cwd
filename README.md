# pi-cwd

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that lets you change the effective working directory without restarting the agent.

## Features

- `/cwd` — show current working directory
- `/cwd <path>` — change working directory (absolute, relative, or `~` expansion)
- Tab-completion for directory paths
- All tool execution (bash, read, write, edit, grep, find, ls) follows the new cwd
- User `!` bash commands also use the new cwd
- Footer indicator shows active directory when it differs from the original
- Session persistence — cwd changes survive `/reload` and session resume

## Install

### From GitHub

```bash
pi install git:github.com/harms-haus/pi-cwd
```

Then start pi — the extension will be auto-discovered. Or reload an existing session with `/reload`.

### From source

```bash
git clone https://github.com/harms-haus/pi-cwd.git
pi -e ./pi-cwd/src/index.ts
```

### Manual

Copy `src/index.ts` to `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).

## Usage

```
/cwd                    # show current directory
/cwd /tmp               # absolute path
/cwd ../other-project   # relative path
/cwd ~/Documents        # tilde expansion
```

## How it works

The extension intercepts the `tool_call` event and mutates tool arguments in-place:

- **bash** — prepends `cd '<cwd>' &&` to the command (single-quoted for shell safety)
- **read / write / edit** — resolves relative paths against the effective cwd
- **grep / find / ls** — defaults to the effective cwd when no path is specified

The system prompt is updated via `before_agent_start` so the LLM is aware of the active directory.

## Limitations

- `ctx.cwd` (the built-in getter) remains the original cwd — this is a read-only property on the ExtensionRunner
- Other extension tools that read `ctx.cwd` directly will see the original value
- Resource discovery (AGENTS.md, project-local extensions/skills) stays bound to the original cwd
- Session files are saved under the original cwd's session directory

## Development

```bash
npm install          # install dependencies
npm test             # run tests
npm run test:coverage # run tests with coverage report
npm run typecheck    # type-check with TypeScript
npm run lint         # lint with ESLint
npm run format       # format with Prettier
npm run format:check # check formatting
```

## License

MIT
