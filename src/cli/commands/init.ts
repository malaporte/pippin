import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE = `# Pippin sandbox configuration
# See https://github.com/example/pippin for documentation

[sandbox]
# idle_timeout = 900  # seconds before the sandbox auto-shuts down

# Cedar policy file for sandbox enforcement (restricts commands, file access, network):
# policy = "sandbox.cedar"

# Use a custom Docker image for the sandbox:
# image = "my-registry/my-image:latest"

# Or build a local Dockerfile for the sandbox:
# dockerfile = "./Dockerfile.pippin"

# Mount additional paths into the sandbox:
# [[sandbox.mounts]]
# path = "~/Developer/shared-libs"
#
# [[sandbox.mounts]]
# path = "~/Developer/other-project"
# readonly = true
`

const POLICY_TEMPLATE = `// Pippin Sandbox Policy
// This file uses the Cedar policy language to control what is allowed
// inside the sandbox. Leash enforces these rules via eBPF (kernel-level).
//
// Cedar docs: https://docs.cedarpolicy.com
//
// Available actions:
//   Action::"ProcessExec"       — execute a process
//   Action::"FileOpen"          — open a file (any mode)
//   Action::"FileOpenReadOnly"  — open a file read-only
//   Action::"FileOpenReadWrite" — open a file read-write
//   Action::"NetworkConnect"    — outbound network connection
//
// Resource types:
//   File::"/path/to/file"       — exact file path
//   Dir::"/path/to/dir/"        — directory (and everything under it)
//   Host::"hostname"            — network host (supports wildcards like "*.example.com")

// Allow all process execution
permit (principal, action == Action::"ProcessExec", resource)
when { resource in [Dir::"/"] };

// Allow all file access
permit (
  principal,
  action in [Action::"FileOpen", Action::"FileOpenReadOnly", Action::"FileOpenReadWrite"],
  resource
)
when { resource in [Dir::"/"] };

// Allow all network connections
permit (principal, action == Action::"NetworkConnect", resource)
when { resource in [Host::"*"] };

// --- Examples of restrictions you can add: ---

// Block deleting files outside the workspace:
// forbid (principal, action == Action::"FileOpenReadWrite", resource)
// when { resource in [Dir::"/etc/"] };

// Block network access to specific hosts:
// forbid (principal, action == Action::"NetworkConnect", resource)
// when { resource in [Host::"*.evil.com"] };

// Only allow specific executables:
// forbid (principal, action == Action::"ProcessExec", resource)
// unless { resource in [Dir::"/usr/bin/", Dir::"/usr/local/bin/", Dir::"/bin/"] };
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

  // Also create an example Cedar policy file
  const policyPath = path.join(cwd, 'sandbox.cedar')
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(policyPath, POLICY_TEMPLATE)
    process.stderr.write(`created ${policyPath}\n`)
    process.stderr.write(`\nto enable the policy, uncomment sandbox.policy in .pippin.toml\n`)
  }
}
