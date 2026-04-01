import { resolveWorkspace } from '../workspace'
import { readGlobalConfig } from '../config'
import { stopSandbox, stopAllSandboxes } from '../sandbox'

/** Stop the sandbox for the current workspace, or all sandboxes */
export async function stopCommand(all: boolean): Promise<void> {
  if (all) {
    await stopAllSandboxes()
    process.stderr.write('all sandboxes stopped\n')
    return
  }

  const cwd = process.cwd()
  const globalConfig = readGlobalConfig()
  const workspace = resolveWorkspace(cwd, globalConfig.workspaces)

  await stopSandbox(workspace.root)
  process.stderr.write(`sandbox stopped for ${workspace.root}\n`)
}
