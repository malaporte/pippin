import path from 'node:path'
import { findWorkspace } from '../workspace'
import { readState, listStates, isProcessAlive, isServerHealthy } from '../state'

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
  const workspace = findWorkspace(cwd) ?? { root: path.resolve(cwd), config: {} }

  const state = readState(workspace.root)
  if (!state) {
    process.stdout.write(`workspace: ${workspace.root}\n`)
    process.stdout.write(`status:    stopped\n`)
    return
  }

  const alive = isProcessAlive(state.leashPid)
  const healthy = alive ? await isServerHealthy(state.port) : false

  process.stdout.write(`workspace: ${workspace.root}\n`)
  process.stdout.write(`status:    ${healthy ? 'running' : alive ? 'unhealthy' : 'dead'}\n`)
  process.stdout.write(`port:      ${state.port}\n`)
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
      `${state.workspaceRoot}  ${status}  port=${state.port}${state.controlPort ? `  control=${state.controlPort}` : ''}  pid=${state.leashPid}  started=${state.startedAt}\n`,
    )
  }
}
