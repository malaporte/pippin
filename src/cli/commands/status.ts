import path from 'node:path'
import { expandHome, readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { readState, listStates, isProcessAlive, isServerHealthy } from '../state'
import type { SandboxConfig } from '../../shared/types'

function describeSandboxImageSource(sandboxConfig: SandboxConfig): string {
  if (sandboxConfig.image) return `sandbox image ${sandboxConfig.image}`
  if (sandboxConfig.dockerfile) return `sandbox dockerfile ${path.resolve(expandHome(sandboxConfig.root), expandHome(sandboxConfig.dockerfile))}`
  return 'bundled default sandbox image'
}

export async function statusCommand(showAll: boolean, sandboxName?: string): Promise<void> {
  if (showAll) {
    await showAllStatus()
  } else {
    await showSandboxStatus(sandboxName)
  }
}

async function showSandboxStatus(sandboxName?: string): Promise<void> {
  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(name, globalConfig.sandboxes)
  if (!sandbox) {
    process.stderr.write(`pippin: sandbox "${name}" is not configured\n`)
    process.exit(1)
  }

  const configuredImage = describeSandboxImageSource(sandbox.config)
  const state = readState(name)
  if (!state) {
    process.stdout.write(`sandbox:   ${name}\n`)
    process.stdout.write(`root:      ${path.resolve(expandHome(sandbox.config.root))}\n`)
    process.stdout.write('status:    stopped\n')
    process.stdout.write(`image:     ${configuredImage}\n`)
    return
  }

  const alive = isProcessAlive(state.leashPid)
  const healthy = alive ? await isServerHealthy(state.port) : false
  process.stdout.write(`sandbox:   ${name}\n`)
  process.stdout.write(`root:      ${state.workspaceRoot}\n`)
  process.stdout.write(`status:    ${healthy ? 'running' : alive ? 'unhealthy' : 'dead'}\n`)
  process.stdout.write(`port:      ${state.port}\n`)
  process.stdout.write(`image:     ${state.image ?? configuredImage}\n`)
  if (state.controlPort) process.stdout.write(`control:   ${state.controlPort}\n`)
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
      `${state.sandboxName}  root=${state.workspaceRoot}  ${status}  port=${state.port}${state.controlPort ? `  control=${state.controlPort}` : ''}  image=${state.image ?? 'bundled-default'}  pid=${state.leashPid}  started=${state.startedAt}\n`,
    )
  }
}

export const __test__ = {
  describeSandboxImageSource,
}
