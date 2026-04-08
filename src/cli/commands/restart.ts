import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { stopSandbox, ensureSandbox } from '../sandbox'

export async function restartCommand(sandboxName?: string): Promise<void> {
  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(name, globalConfig.sandboxes)
  if (!sandbox) {
    process.stderr.write(`pippin: sandbox "${name}" is not configured\n`)
    process.exit(1)
  }

  await stopSandbox(name)
  await ensureSandbox(name, sandbox.config)
  process.stderr.write(`sandbox restarted for ${name}\n`)
}
