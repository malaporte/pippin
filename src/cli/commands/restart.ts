import { resolveWorkspace } from '../workspace'
import { readGlobalConfig } from '../config'
import { stopSandbox, ensureSandbox } from '../sandbox'

/** Stop and restart the sandbox for the current workspace */
export async function restartCommand(): Promise<void> {
  const cwd = process.cwd()
  const globalConfig = readGlobalConfig()
  const workspace = resolveWorkspace(cwd, globalConfig.workspaces)

  await stopSandbox(workspace.root)
  await ensureSandbox(workspace.root, workspace.config)

  process.stderr.write(`sandbox restarted for ${workspace.root}\n`)
}
