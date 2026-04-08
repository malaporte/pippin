<img src="docs/pippin.avif" alt="Pippin" width="100%" />

# Pippin - your agents are up to no good!

Run shell commands inside isolated, on-demand Docker sandboxes — transparently, from your terminal.

```sh
pippin -c "npm test"
pippin -c "cargo build"
pippin -c "python main.py"
```

## What it does

Pippin launches a Docker container the first time you run a command, streams I/O back to your terminal in real time, and shuts the container down after it sits idle. Full PTY support means interactive apps like `vim`, `htop`, and `bash` work exactly as they do on the host. No manual `docker run`.

## Why

AI coding agents can run arbitrary shell commands on your machine with your full user permissions. That means package installs with postinstall scripts, builds that execute arbitrary code, file modifications outside your project, and network requests to unknown endpoints. Pippin contains that blast radius.

You can use it three ways:

1. `pippin codex` and `pippin copilot` run those CLIs fully inside the sandbox.
2. `pippin -c "<cmd>"` runs any command inside the sandbox.
3. You can point another tool at `pippin` as its shell so its command execution is sandboxed.

Either way, you get Cedar policy enforcement, filesystem isolation, and network controls without changing how the agent behaves.

## How it works

1. `pippin` selects a named sandbox from `~/.config/pippin/config.json`.
2. If no sandbox name is provided, it uses the sandbox named `default`.
3. If the sandbox is not running, Pippin starts a container with that sandbox's configured `root` mounted.
4. A lightweight server inside the container receives the command over WebSocket and executes it.
5. stdout/stderr stream back to your terminal live. PTY mode forwards stdin, signals, and resize events.
6. The container exits automatically after an idle timeout.

## Requirements

- Docker
- [leash](https://github.com/strongdm/leash) — installed automatically by `pippin` if missing
- macOS or Linux — x64 or arm64

Run `pippin doctor` after installing to verify your setup.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/malaporte/pippin/main/scripts/install.sh | bash
```

## Getting started

Run `pippin init` to create a default sandbox config if you do not already have one:

```sh
pippin init
```

By default this uses `~/Developer` when that directory exists, otherwise it uses your current working directory.

You can also create the config manually. Configure at least one named sandbox, and make sure one is called `default`:

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer"
    }
  }
}
```

Then run commands normally from anywhere under that root:

```sh
cd ~/Developer/my-project
pippin -c hostname
pippin shell
```

To target a non-default sandbox:

```sh
pippin --sandbox work -c "npm test"
pippin --sandbox work shell
```

Pippin validates that your current working directory is accessible inside the selected sandbox. If your `cwd` is outside the sandbox's `root` and extra `mounts`, it errors out.

## Commands

| Command | Description |
| --- | --- |
| `pippin -c "<cmd>"` | Run a command inside the default sandbox |
| `pippin init` | Configure a default sandbox if one is missing |
| `pippin --sandbox <name> -c "<cmd>"` | Run a command inside a named sandbox |
| `pippin shell` | Open an interactive shell in the default sandbox |
| `pippin --sandbox <name> shell` | Open a shell in a named sandbox |
| `pippin status` | Show status for the default sandbox |
| `pippin status --sandbox <name>` | Show status for a named sandbox |
| `pippin status --all` | Show all running sandboxes |
| `pippin stop` | Stop the default sandbox |
| `pippin stop --sandbox <name>` | Stop a named sandbox |
| `pippin stop --all` | Stop all running sandboxes |
| `pippin restart [--sandbox <name>]` | Restart a sandbox |
| `pippin monitor [--sandbox <name>]` | Open the leash Control UI |
| `pippin policy [--validate] [--sandbox <name>]` | Show or validate the active Cedar policy |
| `pippin doctor [--sandbox <name>]` | Check prerequisites and validate configuration |
| `pippin update [--force]` | Update pippin |

## Configuration

Pippin uses a single global config file at `~/.config/pippin/config.json`.

### Named sandboxes

Each sandbox is configured under the top-level `sandboxes` map.

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "idle_timeout": 900,
      "init_timeout": 60,
      "init": "echo ready",
      "shell": "zsh",
      "policy": "~/.config/pippin/policies/default.cedar",
      "image": "my-registry/dev:latest",
      "dockerfile": "~/.config/pippin/Dockerfile.dev",
      "tools": ["git", "gh"],
      "host_commands": ["git", "ssh"],
      "ssh_agent": true,
      "mounts": [
        { "path": "~/shared", "readonly": true }
      ]
    },
    "work": {
      "root": "~/Work"
    }
  }
}
```

Notes:

- `sandboxes.default` is required unless you always pass `--sandbox`.
- `root` is required for every sandbox.
- `root` and `mounts` define which host paths are reachable inside the container.
- `init` is optional and runs when a fresh sandbox starts.
- There is no workspace auto-detection and no package-manager auto-install behavior.

### Global config

The only global setting is `portRangeStart`.

```json
{
  "portRangeStart": 9111,
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "tools": ["git", "gh", "aws"]
    }
  }
}
```

### Custom Docker images

You can override the bundled sandbox image with either:

- a pre-built image via `image`
- a local Dockerfile via `dockerfile`

Priority is:

1. sandbox `image`
2. sandbox `dockerfile`
3. bundled default Dockerfile

When a Dockerfile is used, Pippin builds it locally and tags it by content hash.

The bundled default sandbox image includes a local Redis server and starts it automatically on fresh sandbox startup.

### Tools

Instead of manually wiring dotfiles, environment variables, and SSH/GPG forwarding, declare the tools you use and Pippin handles the rest.

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "tools": ["git", "gh", "aws", "npm", "ssh", "codex", "copilot"]
    }
  }
}
```

Built-in recipes:

| Tool | What it does |
| --- | --- |
| `git` | Mounts Git config and forwards the host GPG agent. Enables SSH agent. |
| `gh` | Mounts `~/.config/gh/config.yml` and resolves `GH_TOKEN`. |
| `aws` | Mounts `~/.aws/config` and resolves temporary credentials. |
| `snowflake` | Mounts Snowflake config and extracts cached auth. |
| `npm` | Mounts `~/.npmrc` and forwards npm env. |
| `bun` | Mounts `~/.npmrc` and forwards bun/npm env. |
| `pnpm` | Mounts `~/.npmrc`, mounts the pnpm store, and sets `PNPM_STORE_DIR`. |
| `ssh` | Mounts SSH config and known_hosts. Enables SSH agent. |
| `codex` | Mounts Codex config and forwards `OPENAI_API_KEY`. |
| `copilot` | Mounts Copilot config and resolves GitHub auth. |

### Host commands

Some commands can be configured to run on the host instead of inside the sandbox:

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "host_commands": ["git", "ssh", "docker"]
    }
  }
}
```

Matching is by the first token of the command.

Host commands bypass sandbox isolation entirely.

### SSH agent forwarding

Enable SSH agent forwarding per sandbox:

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "ssh_agent": true
    }
  }
}
```

When enabled, Pippin mounts Docker Desktop's SSH agent socket and sets `SSH_AUTH_SOCK` inside the container.

### Environment variable forwarding

Forward specific environment variables into a sandbox:

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "environment": ["NPM_TOKEN", "AWS_PROFILE", "GITHUB_TOKEN"]
    }
  }
}
```

Values are resolved from your login shell environment when the sandbox starts.

### Cedar policies

You can apply Cedar policies per sandbox.

```json
{
  "sandboxes": {
    "default": {
      "root": "~/Developer",
      "policy": "~/.config/pippin/policies/default.cedar"
    }
  }
}
```

Use:

```sh
pippin policy
pippin policy --validate
pippin --sandbox work policy
```

### Automatic restart on config changes

Pippin fingerprints the active sandbox configuration, including image, policy, mounts, environment forwarding, tools, and agent forwarding. If the config changes, the sandbox is restarted automatically before the next command runs.

## Architecture

```
Host machine                     Container (leash / Docker)
─────────────────                ────────────────────────────
pippin CLI
  │
  ├─ selects named sandbox
  ├─ starts container via leash ──▶ pippin-server (HTTP + WebSocket)
  ├─ polls /health                       │
  └─ WebSocket /exec?cmd=... ◀──────────▶ spawns process, streams I/O
```

The server binary is bundled with the CLI and copied into the container at startup.

## Development

```sh
bun run test
bun run typecheck
bun run build
```

## License

MIT
