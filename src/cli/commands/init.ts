import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE = `# Pippin sandbox configuration
# See https://github.com/example/pippin for documentation

[sandbox]
# idle_timeout = 900  # seconds before the sandbox auto-shuts down

# Run a shell command inside the container after each fresh sandbox start.
# Useful for installing arch-specific dependencies in the sandbox.
# init = "bun install"

# Cedar policy file for sandbox enforcement (restricts commands, file access, network):
# policy = "sandbox.cedar"

# Use a custom Docker image for the sandbox instead of Pippin's bundled default:
# image = "my-registry/my-image:latest"

# Or build a local Dockerfile for the sandbox instead of the bundled default:
# dockerfile = "./Dockerfile.pippin"

# Mount additional paths into the sandbox:
# [[sandbox.mounts]]
# path = "~/Developer/shared-libs"
#
# [[sandbox.mounts]]
# path = "~/Developer/other-project"
# readonly = true

# Commands that bypass the sandbox and run directly on the host.
# Useful for commands that need host-level credentials (SSH keys, tokens).
# Matched by the first word of the command (e.g. "git" matches "git pull").
# NOTE: host commands are NOT subject to Cedar policy enforcement.
# host_commands = ["git", "ssh"]

# Forward the host SSH agent into the sandbox (Docker Desktop for Mac only).
# Enables git clone/pull/push over SSH without mounting private keys.
# ssh_agent = true

# Tools to auto-configure in the sandbox. Pippin mounts credentials,
# forwards env vars, and enables SSH agent as needed for each tool.
# Supported: git, gh, aws, snowflake, npm, ssh, codex, copilot
# tools = ["git"]
`

/** Create a .pippin.toml file in the current directory */
export function initCommand(): void {
  const cwd = process.cwd()
  const configPath = path.join(cwd, '.pippin.toml')

  if (fs.existsSync(configPath)) {
    process.stderr.write(`pippin: .pippin.toml already exists in ${cwd}\n`)
    process.exit(1)
  }

  fs.writeFileSync(configPath, TEMPLATE)
  process.stderr.write(`created ${configPath}\n`)
}
