# Pippin — Agent Guide

Pippin is a CLI tool that runs shell commands inside isolated, on-demand Docker sandboxes. It is written in TypeScript and runs on the Bun runtime.

## Repository layout

```
src/cli/        # Host-side CLI — entrypoint, sandbox lifecycle, tool recipes, commands
src/server/     # In-container server — HTTP/WebSocket server, PTY executor, idle timeout
src/shared/     # Shared types used by both sides (WebSocket protocol, config shapes)
scripts/        # Build, deploy, and install scripts
```

The codebase has a hard split: `src/cli/` runs on the host machine, `src/server/` runs inside the Docker container. They communicate over a local WebSocket connection.

## Commands

```sh
bun install          # install dependencies
bun run typecheck    # type-check with tsc --noEmit
bun run test         # run tests once with Vitest (no watch mode)
bun run build        # compile all platform binaries to dist/
bun run deploy:cli   # build + install to ~/.local/bin/pippin
```

Always run `bun run typecheck` and `bun run test` before considering a task done.

## Conventions

- **Conventional Commits** — commit messages must follow the Conventional Commits spec (`feat:`, `fix:`, `chore:`, etc.) because semantic-release uses them to determine version bumps and generate the changelog.
- **TypeScript strict mode** — `strict: true` is enforced. No `any` escapes unless genuinely unavoidable.
- **No linter/formatter config** — the type checker is the primary static analysis gate. Keep code consistent with the surrounding style.
- **Tests live next to source** — test files are `*.test.ts` siblings of the files they test.

## Key files to know

| File | What it does |
|---|---|
| `src/cli/sandbox.ts` | Core sandbox lifecycle: start, stop, restart, config fingerprinting |
| `src/cli/tools.ts` | `RECIPES` map — declarative tool configs (git, gh, aws, codex, copilot, …) |
| `src/cli/config.ts` | Reads `~/.config/pippin/config.json` and resolves named sandbox config |
| `src/server/executor.ts` | PTY process spawning and I/O streaming inside the container |
| `src/shared/types.ts` | All shared types — WebSocket protocol, config shapes, state |

## Adding a new tool recipe

Tool recipes live in `src/cli/tools.ts` in the `RECIPES` map. Each entry declares dotfiles to mount, env vars to forward, dynamic resolvers, and whether SSH/GPG agent forwarding is needed. That is the primary extension point — no other files need changing for a new tool.

## Architecture notes

- **Config fingerprinting** — `sandbox.ts` hashes the full resolved config on every command. If it differs from the running sandbox's stored hash, the sandbox is transparently restarted.
- **Named sandboxes** — sandboxes are configured globally under `sandboxes` in `~/.config/pippin/config.json`. The sandbox named `default` is used when `--sandbox` is omitted.
- **Server binary embedding** — the server binary is bundled into the CLI binary and copied into the container at startup.
