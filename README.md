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

1. `pippin run <command>` finds your workspace root (the nearest `.pippin.toml`, or the current directory if none exists).
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

Run any command inside a sandbox — no setup required:

```sh
cd my-project
pippin run bash
```

When no `.pippin.toml` is found, Pippin uses the current directory as the workspace root. Only that directory and its children are mounted into the sandbox.

To customize the sandbox (idle timeout, extra mounts, custom images, security policies), create a config file:

```sh
pippin init
```

This creates a `.pippin.toml` file and an example `sandbox.cedar` policy.

## Commands

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `pippin run <cmd>`         | Run a command inside the sandbox                 |
| `pippin shell`             | Open an interactive shell in the sandbox         |
| `pippin init`              | Create a `.pippin.toml` in the current directory |
| `pippin monitor`           | Open the leash Control UI in your browser        |
| `pippin policy`            | Show the active Cedar policy for this workspace  |
| `pippin policy --validate` | Basic structural validation of the policy file   |
| `pippin status`            | Show the status of the current workspace sandbox |
| `pippin status --all`      | Show all running sandboxes                       |
| `pippin stop`              | Stop the current workspace sandbox               |
| `pippin stop --all`        | Stop all running sandboxes                       |
| `pippin restart`           | Restart the sandbox (config changes auto-restart) |
| `pippin update [--force]`  | Update pippin to the latest version              |

## Configuration

### Workspace config (`.pippin.toml`) — optional

A `.pippin.toml` file marks the workspace root and lets you customize the sandbox. If no config file is found, Pippin defaults to using the current directory as the workspace root with default settings.

```toml
[sandbox]
# Override the global idle timeout (seconds)
idle_timeout = 900

# Shell to use for `pippin shell` (default: "bash")
# shell = "zsh"

# Cedar policy file for sandbox enforcement (restricts commands, file access, network)
# policy = "sandbox.cedar"

# Use a custom Docker image for the sandbox
image = "my-registry/my-image:latest"

# Or build a local Dockerfile instead (relative to workspace root)
# dockerfile = "./Dockerfile.pippin"

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
  "shell": "bash",
  "dotfiles": ["/Users/you/.zshrc", "/Users/you/.gitconfig"],
  "image": "my-registry/my-image:latest",
  "policy": "/path/to/global-policy.cedar"
}
```

Dotfiles are mounted into every sandbox so your shell environment and git config are available.

### Custom Docker image

By default, sandboxes use the standard leash coder image. You can override this with a pre-built image or a local Dockerfile, at either the global or workspace level.

**Pre-built image** — set `image` to any Docker image reference:

```toml
# .pippin.toml
[sandbox]
image = "my-registry/custom-dev:latest"
```

```json
// ~/.config/pippin/config.json
{ "image": "my-registry/custom-dev:latest" }
```

**Local Dockerfile** — set `dockerfile` to a path (relative paths resolve from the workspace root in `.pippin.toml`, or as absolute/`~`-prefixed in the global config):

```toml
# .pippin.toml
[sandbox]
dockerfile = "./Dockerfile.pippin"
```

```json
// ~/.config/pippin/config.json
{ "dockerfile": "~/.config/pippin/Dockerfile" }
```

When a Dockerfile is used, Pippin builds the image locally and tags it by content hash (`pippin-custom:<sha256>`). The build is skipped on subsequent runs unless the Dockerfile changes.

**Priority**: workspace `image` > workspace `dockerfile` > global `image` > global `dockerfile`. If nothing is configured, leash uses its default image.

### Cedar security policies

Pippin supports [Cedar](https://docs.cedarpolicy.com) policy files to restrict what sandboxes can do. Policies control command execution, file access, and network connections, enforced at the kernel level by leash via eBPF.

**Quick start:**

```sh
pippin init          # creates .pippin.toml and an example sandbox.cedar
# edit sandbox.cedar to your needs, then uncomment sandbox.policy in .pippin.toml
pippin policy        # show the active policy
pippin policy --validate  # basic structural check
```

**Example policy** — allow all execution and file access, but restrict network to specific hosts:

```cedar
permit (principal, action == Action::"ProcessExec", resource)
when { resource in [Dir::"/"] };

permit (principal, action in [Action::"FileOpen", Action::"FileOpenReadOnly", Action::"FileOpenReadWrite"], resource)
when { resource in [Dir::"/"] };

permit (principal, action == Action::"NetworkConnect", resource)
when { resource in [Host::"github.com", Host::"*.npmjs.org", Host::"registry.npmjs.org"] };
```

**Available actions:** `ProcessExec`, `FileOpen`, `FileOpenReadOnly`, `FileOpenReadWrite`, `NetworkConnect`

**Resource types:** `File::"/path"` (exact file), `Dir::"/path/"` (directory tree), `Host::"hostname"` (supports wildcards like `*.example.com`)

**Priority:** workspace `policy` > global `policy`. If no policy is configured, the sandbox runs with no restrictions.

### Automatic restart on config changes

Pippin tracks a fingerprint of the active sandbox configuration — covering the Docker image, Cedar policy (including file contents), dotfile mounts, workspace mounts, and forwarded environment variables. When you change any of these settings and run your next command, Pippin detects the drift and automatically restarts the sandbox with the new configuration:

```
$ pippin shell
pippin: sandbox configuration changed, restarting…
```

This means you no longer need to manually run `pippin restart` after editing your config. The restart happens transparently before the command executes.

Sandboxes started before this feature was added (without a stored fingerprint) are not force-restarted; they pick up the new behavior on their next natural restart.

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
bun run test      # run tests with Vitest
bun run typecheck # type-check without building
bun run build     # build all binaries to dist/
```

## License

MIT
