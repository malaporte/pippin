import { spawn } from 'node:child_process'
import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { readState, isProcessAlive, isServerHealthy } from '../state'

export async function monitorCommand(sandboxName?: string): Promise<void> {
  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  if (!resolveSandbox(name, globalConfig.sandboxes)) {
    process.stderr.write(`pippin: sandbox "${name}" is not configured\n`)
    process.exit(1)
  }

  const state = readState(name)
  if (!state) {
    process.stderr.write('pippin: sandbox is not running\n')
    process.exit(1)
  }

  const alive = isProcessAlive(state.leashPid)
  const healthy = alive ? await isServerHealthy(state.port) : false
  if (!alive || !healthy) {
    process.stderr.write('pippin: sandbox is not running\n')
    process.exit(1)
  }

  if (!state.controlPort) {
    process.stderr.write('pippin: this sandbox was started before monitor support was added\n')
    process.stderr.write(`restart it with: pippin restart --sandbox ${name}\n`)
    process.exit(1)
  }

  const url = `http://127.0.0.1:${state.controlPort}`
  process.stdout.write(`opening leash Control UI: ${url}\n`)
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
}
