<img src="docs/pippin.avif" alt="Pippin" width="100%" />

# Pippin - your agents are up to no good

Run shell commands inside isolated, on-demand Docker sandboxes — transparently, from your terminal.

```sh
pippin run npm test
pippin run cargo build
pippin run python main.py
```

## What it does

Pippin automatically launches a Docker container for your project the first time you run a command, streams I/O back to your terminal in real-time, and shuts the container down after it sits idle. No Dockerfile needed. No manual `docker run`. It just works.

## How it works

1. `pippin run <command>` finds your workspace root (a `.pippin.toml` file).
2. If no sandbox is running, Pippin starts a container with your workspace mounted.
3. A lightweight server inside the container receives the command over WebSocket and executes it.
4. stdout/stderr stream back to your terminal live. stdin, signals, and terminal resize events are all forwarded.
5. The container exits automatically after an idle timeout (default: 15 minutes).

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/malaporte/pippin/main/scripts/install.sh | bash
```

This installs the latest release to `~/.local/bin/pippin`. You can override the destination with `PIPPIN_INSTALL_DIR=/usr/local/bin` or pin a version with `PIPPIN_VERSION=0.1.1`.

Requires [leash](https://github.com/strongdm/leash) (`public.ecr.aws/s5i7k8t3/strongdm/leash`) and Docker.

### Build from source

```sh
# Requires Bun
bun run deploy:cli
```

## Getting started

Initialize a workspace config in your project root:

```sh
cd my-project
pippin init
```

This creates a `.pippin.toml` file. Then run any command:

```sh
pippin run bash
```

## Commands

| Command               | Description                                      |
| --------------------- | ------------------------------------------------ |
| `pippin run <cmd>`    | Run a command inside the sandbox                 |
| `pippin init`         | Create a `.pippin.toml` in the current directory |
| `pippin status`       | Show the status of the current workspace sandbox |
| `pippin status --all` | Show all running sandboxes                       |
| `pippin stop`         | Stop the current workspace sandbox               |
| `pippin stop --all`   | Stop all running sandboxes                       |

## Configuration

### Workspace config (`.pippin.toml`)

```toml
[sandbox]
# Override the global idle timeout (seconds)
idle_timeout = 900

# Extra paths to mount into the sandbox
[[sandbox.mounts]]
path = "/shared/libs"
readonly = true
```

### Global config (`~/.config/pippin/config.json`)

```json
{
  "idleTimeout": 900,
  "portRangeStart": 9111,
  "dotfiles": ["/Users/you/.zshrc", "/Users/you/.gitconfig"]
}
```

Dotfiles are mounted into every sandbox so your shell environment and git config are available.

## Architecture

```
Host machine                     Container (leash / Docker)
─────────────────                ────────────────────────────
pippin CLI
  │
  ├─ finds workspace root
  ├─ starts container via leash ──▶ pippin-server (HTTP + WebSocket)
  ├─ polls /health                       │
  └─ WebSocket /exec?cmd=... ◀──────────▶ spawns process, streams I/O
```

The CLI and server communicate over a local WebSocket connection. The server binary is bundled with the CLI and automatically copied into the container at startup — no setup required inside the image.

## Development

```sh
bun test          # run tests
bun run typecheck # type-check without building
bun run build     # build all binaries to dist/
```

## License

MIT
