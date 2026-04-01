<img src="docs/pippin.avif" alt="Pippin" width="100%" />

# Pippin - your agents are up to no good

Run shell commands inside isolated, on-demand Docker sandboxes — transparently, from your terminal.

```sh
pippin run npm test
pippin run cargo build
pippin run python main.py
```

## What it does

Pippin automatically launches a Docker container for your project the first time you run a command, streams I/O back to your terminal in real-time, and shuts the container down after it sits idle. Full PTY support means interactive apps like `vim`, `htop`, and `bash` work exactly as they do on the host. No Dockerfile needed. No manual `docker run`. It just works.

## Why

AI coding agents — Claude Code, Codex, OpenCode — can run arbitrary shell commands on your machine with your full user permissions. That means package installs with postinstall scripts, builds that execute arbitrary code, file modifications outside the project directory, and network requests to unknown endpoints — all without any isolation. These agents are also vulnerable to prompt injection: malicious instructions hidden in code comments, README files, or web content can trick an agent into running commands it shouldn't. Pippin gives you three ways to contain the blast radius:

1. **Use a dedicated agent command.** `pippin codex` and `pippin copilot` run the respective CLI agents fully inside the sandbox with credentials automatically wired up — everything the agent does stays inside the container, no patching required.

2. **Run arbitrary commands in a sandbox.** `pippin run <cmd>` executes any command inside the container — build scripts, package installs, test suites, or even agents themselves. Anything that can run in a shell can run through `pippin run`.

3. **Route agent commands through the sandbox** *(experimental)*. For a better user experience, keep the agent on the host but configure it to prefix shell commands with `pippin run`. The agent can still read your code, but execution happens in an isolated container. This currently requires a patched agent — see [nopecode](https://github.com/malaporte/nopecode), a prototype fork of OpenCode with Pippin integration. Codex is also open-source and patchable in the same way.

Either way, you get [Cedar](https://docs.cedarpolicy.com) policy enforcement, filesystem isolation, and network controls — without changing how the agent works.

Pippin is also useful as a general-purpose sandboxing tool — run any project's commands in an isolated container without worrying about what they do to your host machine.

## How it works

1. `pippin run <command>` finds your workspace root: the first matching entry in the `workspaces` map in `~/.config/pippin/config.json`, then the nearest `.git` root, then the current directory.
2. If no sandbox is running, Pippin starts a container with your workspace mounted.
3. A lightweight server inside the container receives the command over WebSocket and executes it.
4. stdout/stderr stream back to your terminal live. A full PTY is allocated, so stdin, signals, and terminal resize events are all forwarded — interactive TUI apps work seamlessly.
5. You can also run `pippin shell` to drop into an interactive shell inside the sandbox.
6. The container exits automatically after an idle timeout (default: 15 minutes) — the timer only starts when no commands are running.
7. `pippin codex [args]` runs the OpenAI Codex CLI directly inside the sandbox — credentials and `OPENAI_API_KEY` are auto-configured via the `codex` tool recipe.
8. `pippin copilot [args]` runs the GitHub Copilot CLI directly inside the sandbox — `~/.copilot/config.json` is mounted and a GitHub token is resolved automatically via `gh auth token`.

## Requirements

- **Docker** — any recent version of Docker Desktop or Docker Engine
- **[leash](https://github.com/strongdm/leash)** — the sandbox runtime that manages containers and enforces Cedar policies via eBPF. Installed automatically by `pippin` if not already present.
- **macOS or Linux** — x64 or arm64. Windows is not supported.

Run `pippin doctor` after installing to verify your setup.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/malaporte/pippin/main/scripts/install.sh | bash
```

This installs the latest release to `~/.local/bin/pippin`. The install script also downloads and installs the latest [leash](https://github.com/strongdm/leash) binary alongside it. You can override the destination with `PIPPIN_INSTALL_DIR=/usr/local/bin` or pin a version with `PIPPIN_VERSION=0.1.1`.

### Build from source

```sh
# Requires Bun
bun run deploy:cli
```

## Updating

```sh
pippin update
```

This downloads and installs the latest release, replacing the current binary. Leash is also updated to the latest version. To reinstall the current version (e.g. if the binary is corrupted), use `pippin update --force`.

## Getting started

Run any command inside a sandbox — no setup required:

```sh
cd my-project
pippin run hostname   # prints the container's hostname, not the host's
```

When no matching entry is found in the `workspaces` map, Pippin walks up the directory tree to find a `.git` entry and uses that directory as the workspace root — so running from any subdirectory of a Git repo does the right thing automatically, including Git worktrees. If no `.git` is found either, the current directory is used. Only the workspace root and its children are mounted into the sandbox.

To customize the sandbox (idle timeout, extra mounts, custom images, security policies), add a `workspaces` entry to `~/.config/pippin/config.json`:

```json
// ~/.config/pippin/config.json
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": {
        "init": "bun install"
      }
    }
  }
}
```

## Commands

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `pippin run <cmd>`         | Run a command inside the sandbox                 |
| `pippin shell`             | Open an interactive shell in the sandbox         |
| `pippin monitor`           | Open the leash Control UI in your browser        |
| `pippin policy`            | Show the active Cedar policy for this workspace  |
| `pippin policy --validate` | Basic structural validation of the policy file   |
| `pippin status`            | Show the status of the current workspace sandbox |
| `pippin status --all`      | Show all running sandboxes                       |
| `pippin stop`              | Stop the current workspace sandbox               |
| `pippin stop --all`        | Stop all running sandboxes                       |
| `pippin restart`           | Restart the sandbox (config changes auto-restart) |
| `pippin update [--force]`  | Update pippin to the latest version              |
| `pippin doctor`            | Check prerequisites and validate configuration   |

## Configuration

### Workspace config — optional

Workspace-specific sandbox settings live in `~/.config/pippin/config.json` under a `workspaces` map. Each key is a regex tested against the resolved current working directory — the first matching key wins.

```json
// ~/.config/pippin/config.json
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": {
        "idle_timeout": 900,
        "init": "bun install",
        "auto_install": false,
        "install_command": "pnpm install --frozen-lockfile",
        "shell": "zsh",
        "policy": "/path/to/sandbox.cedar",
        "image": "my-registry/my-image:latest",
        "dockerfile": "~/.config/pippin/Dockerfile.myproject",
        "tools": ["git", "gh"],
        "host_commands": ["git", "ssh"],
        "ssh_agent": true,
        "mounts": [
          { "path": "/shared/libs", "readonly": true }
        ]
      }
    }
  }
}
```

Plain absolute paths (e.g. `"/path/to/my-project"`) also work as keys — they match as substrings. For strict prefix semantics use `^/path/to/my-project(/|$)`. Multiple workspaces can be configured; the first matching key is used.

If no entry matches, Pippin walks up the directory tree to find a `.git` entry and uses that as the implicit workspace root (falling back to the current directory if none is found).

### Global config (`~/.config/pippin/config.json`)

```json
{
  "idleTimeout": 900,
  "portRangeStart": 9111,
  "shell": "bash",
  "dotfiles": [
    { "path": "/Users/you/.zshrc" },
    { "path": "/Users/you/.gitconfig", "readonly": true }
  ],
  "environment": ["NPM_TOKEN", "AWS_PROFILE"],
  "image": "my-registry/my-image:latest",
  "policy": "/path/to/global-policy.cedar",
  "hostCommands": ["git", "ssh"],
  "sshAgent": true,
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": {
        "init": "bun install"
      }
    }
  }
}
```

Dotfiles are mounted into every sandbox so your shell environment and git config are available. Each entry is an object with a `path` and an optional `readonly` flag (defaults to `false`).

### Custom Docker image

By default, sandboxes build and use Pippin's bundled sandbox image. You can override this with a pre-built image or a local Dockerfile, at either the global or workspace level.

**Pre-built image** — set `image` to any Docker image reference:

```json
// ~/.config/pippin/config.json — workspace-level
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "image": "my-registry/custom-dev:latest" }
    }
  }
}
```

```json
// ~/.config/pippin/config.json — global
{ "image": "my-registry/custom-dev:latest" }
```

**Local Dockerfile** — set `dockerfile` to an absolute or `~/`-prefixed path:

```json
// ~/.config/pippin/config.json — workspace-level
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "dockerfile": "~/.config/pippin/Dockerfile.myproject" }
    }
  }
}
```

```json
// ~/.config/pippin/config.json — global
{ "dockerfile": "~/.config/pippin/Dockerfile" }
```

When a Dockerfile is used, Pippin builds the image locally and tags it by content hash (`pippin-custom:<sha256>`). The build is skipped on subsequent runs unless the Dockerfile changes.

**Priority**: workspace `image` > workspace `dockerfile` > global `image` > global `dockerfile` > bundled default Dockerfile.

### Tools

Instead of manually configuring dotfile mounts, environment variables, and SSH agent forwarding for each tool you use, you can declare the tools you need and Pippin handles the rest. Each built-in tool "recipe" knows what credentials to mount, what env vars to forward, and whether SSH agent access is required.

```json
// ~/.config/pippin/config.json — global
{ "tools": ["git", "gh", "aws", "npm", "ssh"] }
```

```json
// ~/.config/pippin/config.json — workspace-level
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "tools": ["git", "gh"] }
    }
  }
}
```

Tools from both configs are merged (union). The following tools have built-in recipes:

| Tool | What it does |
|------|-------------|
| `git` | Mounts `~/.gitconfig`, `~/.gitignore_global`, the GPG public keyring/trustdb (readonly), and forwards the host GPG agent socket. Enables SSH agent. |
| `gh` | Mounts `~/.config/gh/config.yml` (readonly). Resolves `GH_TOKEN` dynamically via `gh auth token` — works with keychain-based auth. |
| `aws` | Mounts `~/.aws/config` (readonly). Resolves temporary SSO credentials via `aws configure export-credentials` at sandbox start. |
| `snowflake` | Mounts `~/.snowflake/config.toml` (readonly). Extracts cached ID token from macOS keychain for `externalbrowser` auth. |
| `npm` | Mounts `~/.npmrc` (readonly). Forwards `NPM_TOKEN` and `NPM_CONFIG_REGISTRY`. |
| `bun` | Mounts `~/.npmrc` (readonly). Forwards `NPM_TOKEN`, `NPM_CONFIG_REGISTRY`, and `BUN_INSTALL`. |
| `pnpm` | Mounts `~/.npmrc` (readonly). Detects the host's pnpm content-addressable store via `pnpm store path` and mounts it into the container. Sets `PNPM_STORE_DIR` so pnpm uses the mounted store — `pnpm install` reuses cached packages instead of re-downloading. Forwards `NPM_TOKEN`, `NPM_CONFIG_REGISTRY`, and `PNPM_HOME`. |
| `ssh` | Mounts `~/.ssh/config` and `~/.ssh/known_hosts` (readonly). Enables SSH agent. Sanitizes macOS-specific options (`UseKeychain`, `AddKeysToAgent`) for Linux compatibility. |
| `codex` | Mounts `~/.codex/config.toml` and `~/.codex/auth.json` (readonly). Forwards `OPENAI_API_KEY`. |
| `copilot` | Mounts `~/.copilot/config.json` (readonly). Resolves `COPILOT_GITHUB_TOKEN` via `gh auth token`. Forwards `GH_TOKEN` and `GITHUB_TOKEN`. |

All credential files are mounted **read-only** — the sandbox never modifies your host credentials.

Tools that need dynamic credential resolution (gh, aws) run a host-side command when the sandbox starts and inject the result as environment variables. This means SSO sessions and keychain tokens work transparently — no need to export tokens into your shell environment.

Unknown tool names produce a warning but don't prevent the sandbox from starting. Run `pippin doctor` to check that all configured tools have their credentials available.

### Automatic dependency installs

By default, Pippin auto-detects common Node.js package-manager setups at the workspace root and runs the matching install command inside each fresh sandbox. This helps Linux-native binaries get installed in the sandbox even when the host checkout already contains macOS-native dependencies.

- `package.json` with `packageManager = "bun@..."` or a `bun.lock` / `bun.lockb` file -> `bun install`
- `package.json` with `packageManager = "pnpm@..."` or a `pnpm-lock.yaml` file -> `pnpm install`
- `package.json` with `packageManager = "npm@..."` or a `package-lock.json` file -> `npm install`

Detection prefers the `packageManager` field when present. If Pippin sees conflicting lockfiles and no supported `packageManager` field, it skips auto-install rather than guessing.

Use `sandbox.auto_install = false` to disable this behavior, `sandbox.install_command` to override the inferred install command, or `sandbox.init` when you need a fully custom startup script.

**Tools vs. host commands:** Tools run *inside* the container with auto-configured credentials. Host commands run *outside* the container on the host. Prefer tools when possible — they maintain sandbox isolation and Cedar policy enforcement.

### Host commands

Some commands need access to host-level credentials that are difficult to configure inside a sandbox — SSH keys for `git`, authentication tokens, and so on. Instead of mounting secrets into the container, you can configure specific commands to run directly on the host.

When `pippin run` encounters a command whose first word matches the `hostCommands` list, it spawns the process natively on the host instead of routing it through the sandbox.

```json
// ~/.config/pippin/config.json — global
{ "hostCommands": ["git", "ssh"] }
```

```json
// ~/.config/pippin/config.json — workspace-level
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "host_commands": ["git", "ssh"] }
    }
  }
}
```

The merged set from both configs is used (union). Matching is by the first token of the command, so `"git"` matches `git pull`, `git push`, etc.

**Note:** Host commands bypass sandbox isolation and Cedar policy enforcement entirely. Only add commands you trust to run outside the sandbox.

### SSH agent forwarding

Instead of using `hostCommands` to run `git` on the host, you can forward your SSH agent into the sandbox so git and ssh work natively inside the container. This uses Docker Desktop for Mac's built-in agent proxy socket.

```json
// ~/.config/pippin/config.json
{
  "idleTimeout": 900,
  "portRangeStart": 9111,
  "shell": "bash",
  "tools": ["git", "gh", "aws", "npm", "ssh"],
  "dotfiles": [
    { "path": "/Users/you/.zshrc" },
    { "path": "/Users/you/.gitconfig", "readonly": true }
  ],
  "environment": ["NPM_TOKEN", "AWS_PROFILE"],
  "image": "my-registry/my-image:latest",
  "policy": "/path/to/global-policy.cedar",
  "hostCommands": ["git", "ssh"],
  "sshAgent": true
}
```

```json
// ~/.config/pippin/config.json — workspace-level
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "ssh_agent": true }
    }
  }
}
```

When enabled, Pippin mounts Docker Desktop's SSH agent socket (`/run/host-services/ssh-auth.sock`) into the container and sets `SSH_AUTH_SOCK`. If `~/.ssh/known_hosts` exists on the host, it is also mounted read-only so SSH doesn't prompt for host key verification.

**Requirements:**
- Docker Desktop for Mac (provides the agent proxy socket)
- Your SSH key must be loaded in the host agent (`ssh-add -l` to check, `ssh-add --apple-use-keychain ~/.ssh/id_rsa` to add)

To have your key load automatically on login, add this to `~/.ssh/config`:

```
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_rsa
```

**Limitations:**
- Only works with Docker Desktop for Mac — not with Colima, OrbStack, or remote Docker hosts
- Does not work with non-default SSH agents (1Password, gpg-agent, Secretive) since Docker Desktop proxies the macOS default launchd agent
- Some Docker Desktop versions have intermittent bugs with the agent socket; restarting Docker Desktop usually resolves this

### Git worktree support

When your workspace is a [Git worktree](https://git-scm.com/docs/git-worktree), Pippin automatically detects it and mounts the main repository into the sandbox alongside the worktree directory. This is necessary because Git worktrees share the object store and refs with the main repository — without the main repo mounted, Git commands inside the sandbox would fail.

Detection works by checking whether `.git` is a file (containing a `gitdir:` pointer) rather than a directory. Pippin walks up from the workspace root, so it works even when the workspace root is a subdirectory inside a worktree. No configuration is needed — it just works.

### Environment variable forwarding

You can forward specific host environment variables into every sandbox. This is useful for tokens, credentials, or configuration that your build tools need.

```json
// ~/.config/pippin/config.json
{ "environment": ["NPM_TOKEN", "AWS_PROFILE", "GITHUB_TOKEN"] }
```

Pippin resolves the values from your login shell environment when the sandbox starts. Only the variable names are stored in the config — the actual values are read at runtime. Changes to the `environment` list trigger an automatic sandbox restart.

This is a global-config-only setting (not available in workspace entries). For most use cases, the `tools` feature handles environment forwarding automatically — use `environment` for custom variables that aren't covered by a built-in tool recipe.

### Cedar security policies

Pippin supports [Cedar](https://docs.cedarpolicy.com) policy files to restrict what sandboxes can do. Policies control command execution, file access, and network connections, enforced at the kernel level by leash via eBPF.

**Quick start:**

Create a Cedar policy file, then point your workspace config at it using an absolute or `~/`-prefixed path:

```json
// ~/.config/pippin/config.json
{
  "workspaces": {
    "^/path/to/my-project(/|$)": {
      "sandbox": { "policy": "/path/to/my-project/sandbox.cedar" }
    }
  }
}
```

```sh
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

Pippin tracks a fingerprint of the active sandbox configuration — covering the Docker image, Cedar policy (including file contents), dotfile mounts, workspace mounts, forwarded environment variables, tools, SSH agent forwarding, and Git worktree detection. When you change any of these settings and run your next command, Pippin detects the drift and automatically restarts the sandbox with the new configuration:

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
