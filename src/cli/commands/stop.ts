import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { stopSandbox, stopAllSandboxes } from '../sandbox'

export async function stopCommand(all: boolean, sandboxName?: string): Promise<void> {
  if (all) {
    await stopAllSandboxes()
    process.stderr.write('all sandboxes stopped\n')
    return
  }

  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  if (!resolveSandbox(name, globalConfig.sandboxes)) {
    process.stderr.write(`pippin: sandbox "${name}" is not configured\n`)
    process.exit(1)
  }

  await stopSandbox(name)
  process.stderr.write(`sandbox stopped for ${name}\n`)
}
