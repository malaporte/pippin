import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE = `# Pippin sandbox configuration
# See https://github.com/example/pippin for documentation

[sandbox]
# idle_timeout = 900  # seconds before the sandbox auto-shuts down

# Mount additional paths into the sandbox:
# [[sandbox.mounts]]
# path = "~/Developer/shared-libs"
#
# [[sandbox.mounts]]
# path = "~/Developer/other-project"
# readonly = true
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
