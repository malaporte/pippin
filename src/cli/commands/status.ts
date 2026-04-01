import path from 'node:path'
import { readGlobalConfig, expandHome } from '../config'
import { resolveWorkspace } from '../workspace'
import { readState, listStates, isProcessAlive, isServerHealthy } from '../state'

function describeSandboxImageSource(workspaceRoot: string, workspaceConfig: { sandbox?: { image?: string; dockerfile?: string } }): string {
  const globalConfig = readGlobalConfig()
  const sandbox = workspaceConfig.sandbox

  if (sandbox?.image) return `workspace image ${sandbox.image}`
  if (sandbox?.dockerfile) return `workspace dockerfile ${path.resolve(workspaceRoot, expandHome(sandbox.dockerfile))}`
  if (globalConfig.image) return `global image ${globalConfig.image}`
  if (globalConfig.dockerfile) return `global dockerfile ${path.resolve(expandHome(globalConfig.dockerfile))}`
  return 'bundled default sandbox image'
}

/** Show sandbox status for the current workspace or all workspaces */
export async function statusCommand(showAll: boolean): Promise<void> {
  if (showAll) {
    await showAllStatus()
  } else {
    await showWorkspaceStatus()
  }
}

async function showWorkspaceStatus(): Promise<void> {
  const cwd = process.cwd()
  const globalConfig = readGlobalConfig()
  const workspace = resolveWorkspace(cwd, globalConfig.workspaces)
  const configuredImage = describeSandboxImageSource(workspace.root, workspace.config)

  const state = readState(workspace.root)
  if (!state) {
    process.stdout.write(`workspace: ${workspace.root}\n`)
    process.stdout.write(`status:    stopped\n`)
    process.stdout.write(`image:     ${configuredImage}\n`)
    return
  }

  const alive = isProcessAlive(state.leashPid)
  const healthy = alive ? await isServerHealthy(state.port) : false

  process.stdout.write(`workspace: ${workspace.root}\n`)
  process.stdout.write(`status:    ${healthy ? 'running' : alive ? 'unhealthy' : 'dead'}\n`)
  process.stdout.write(`port:      ${state.port}\n`)
  process.stdout.write(`image:     ${state.image ?? configuredImage}\n`)
  if (state.controlPort) {
    process.stdout.write(`control:   ${state.controlPort}\n`)
  }
  process.stdout.write(`pid:       ${state.leashPid}\n`)
  process.stdout.write(`started:   ${state.startedAt}\n`)
}

async function showAllStatus(): Promise<void> {
  const states = listStates()

  if (states.length === 0) {
    process.stdout.write('no active sandboxes\n')
    return
  }

  for (const state of states) {
    const alive = isProcessAlive(state.leashPid)
    const healthy = alive ? await isServerHealthy(state.port) : false
    const status = healthy ? 'running' : alive ? 'unhealthy' : 'dead'

    process.stdout.write(
      `${state.workspaceRoot}  ${status}  port=${state.port}${state.controlPort ? `  control=${state.controlPort}` : ''}  image=${state.image ?? 'bundled-default'}  pid=${state.leashPid}  started=${state.startedAt}\n`,
    )
  }
}

export const __test__ = {
  describeSandboxImageSource,
}
