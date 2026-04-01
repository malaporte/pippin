import { spawn } from 'node:child_process'
import { resolveWorkspace } from '../workspace'
import { readGlobalConfig } from '../config'
import { readState, isProcessAlive, isServerHealthy } from '../state'

/** Open the leash Control UI for the current workspace sandbox in the default browser */
export async function monitorCommand(): Promise<void> {
  const cwd = process.cwd()
  const globalConfig = readGlobalConfig()
  const workspace = resolveWorkspace(cwd, globalConfig.workspaces)

  const state = readState(workspace.root)
  if (!state) {
    process.stderr.write(`pippin: sandbox is not running\n`)
    process.exit(1)
  }

  const alive = isProcessAlive(state.leashPid)
  const healthy = alive ? await isServerHealthy(state.port) : false

  if (!alive || !healthy) {
    process.stderr.write(`pippin: sandbox is not running\n`)
    process.exit(1)
  }

  if (!state.controlPort) {
    process.stderr.write(
      `pippin: this sandbox was started before monitor support was added\n` +
      `restart it with: pippin stop && pippin run <command>\n`,
    )
    process.exit(1)
  }

  const url = `http://127.0.0.1:${state.controlPort}`
  process.stdout.write(`opening leash Control UI: ${url}\n`)

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
}
