import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import kleur from 'kleur'
import { readGlobalConfig, expandHome } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { resolveGpgSocketInfo, resolveServerBinary } from '../sandbox'
import { RECIPES, KNOWN_TOOLS, resolveToolRequirements } from '../tools'

interface CheckResult { ok: boolean; label: string; detail: string }
const pass = (label: string, detail: string): CheckResult => ({ ok: true, label, detail })
const fail = (label: string, detail: string): CheckResult => ({ ok: false, label, detail })

function printResult(result: CheckResult): void {
  const icon = result.ok ? kleur.green('[✓]') : kleur.red('[✗]')
  process.stderr.write(`${icon} ${result.label}: ${result.detail}\n`)
}

function checkPlatform(): CheckResult {
  const platform = os.platform()
  const arch = os.arch()
  const supported = (platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')
  return supported ? pass('Platform', `${platform} ${arch}`) : fail('Platform', `${platform} ${arch} (unsupported - requires macOS or Linux, x64 or arm64)`)
}

function checkDocker(): CheckResult[] {
  const results: CheckResult[] = []
  const version = spawnSync('docker', ['--version'], { encoding: 'utf-8', timeout: 10_000 })
  if (version.status !== 0) return [fail('Docker', 'not found on PATH')]
  results.push(pass('Docker', (version.stdout || '').trim().replace(/^Docker version\s*/i, '')))
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 15_000 })
  results.push(info.status !== 0 ? fail('Docker daemon', 'not running (start Docker Desktop or dockerd)') : pass('Docker daemon', 'running'))
  return results
}

function checkServerBinary(): CheckResult {
  const binary = resolveServerBinary()
  if (!binary) {
    const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
    return fail('Server binary', `pippin-server-linux-${arch} not found (reinstall pippin)`)
  }
  return pass('Server binary', path.basename(binary))
}

function checkGlobalConfig(): CheckResult[] {
  const results: CheckResult[] = []
  const configPath = path.join(os.homedir(), '.config', 'pippin', 'config.json')
  if (!fs.existsSync(configPath)) return results

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [fail('Global config', `invalid JSON: ${msg}`)]
  }

  results.push(pass('Global config', configPath))

  return results
}

function checkSandboxes(): CheckResult[] {
  const results: CheckResult[] = []
  const globalConfig = readGlobalConfig()
  if (!globalConfig.sandboxes.default) {
    results.push(fail('Default sandbox', 'missing required sandboxes.default configuration'))
  }

  for (const [name, sandbox] of Object.entries(globalConfig.sandboxes)) {
    const root = path.resolve(expandHome(sandbox.root))
    results.push(fs.existsSync(root) ? pass(`Sandbox: ${name}`, root) : fail(`Sandbox: ${name}`, `${root} does not exist`))
    for (const dotfile of sandbox.dotfiles ?? []) {
      const resolved = path.resolve(expandHome(dotfile.path))
      if (!fs.existsSync(resolved)) results.push(fail(`Sandbox dotfile: ${name}`, `${resolved} does not exist`))
    }
    if (sandbox.dockerfile) {
      const resolved = path.resolve(expandHome(sandbox.dockerfile))
      if (!fs.existsSync(resolved)) results.push(fail(`Sandbox dockerfile: ${name}`, `${resolved} does not exist`))
    }
    for (const mount of sandbox.mounts ?? []) {
      const resolved = path.resolve(expandHome(mount.path))
      if (!fs.existsSync(resolved)) results.push(fail(`Sandbox mount: ${name}`, `${resolved} does not exist`))
    }
  }

  return results
}

function checkSelectedSandbox(sandboxName?: string): CheckResult[] {
  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(name, globalConfig.sandboxes)
  if (!sandbox) return [fail('Selected sandbox', `sandbox "${name}" is not configured`)]
  return [pass('Selected sandbox', `${name} -> ${path.resolve(expandHome(sandbox.config.root))}`)]
}

function checkGpgAgentForwarding(sandboxName?: string): CheckResult[] {
  const results: CheckResult[] = []
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(sandboxName ?? DEFAULT_SANDBOX_NAME, globalConfig.sandboxes)
  const tools = [...new Set(sandbox?.config.tools ?? [])]
  const toolReqs = resolveToolRequirements(tools)
  if (!toolReqs.gpgAgent) return results
  const socketInfo = resolveGpgSocketInfo('/root')
  if (!socketInfo) return [fail('GPG agent socket', 'enabled but no usable host socket found (checked agent-extra-socket, then agent-socket)')]
  results.push(pass('GPG agent socket', `${socketInfo.source} ${socketInfo.hostSocket} -> ${socketInfo.containerSocket}`))
  return results
}

function checkTools(sandboxName?: string): CheckResult[] {
  const results: CheckResult[] = []
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(sandboxName ?? DEFAULT_SANDBOX_NAME, globalConfig.sandboxes)
  const tools = [...new Set(sandbox?.config.tools ?? [])]

  for (const tool of tools) {
    const name = tool.toLowerCase()
    const recipe = RECIPES[name]
    if (!recipe) {
      results.push(fail('Tool', `"${tool}" - unknown tool (available: ${KNOWN_TOOLS.join(', ')})`))
      continue
    }

    const details: string[] = []
    if (recipe.dotfiles) {
      for (const df of recipe.dotfiles) {
        const expanded = expandHome(df.path)
        if (fs.existsSync(expanded)) details.push(df.path)
      }
    }
    const availableEnvVars: string[] = []
    if (recipe.environment) {
      for (const env of recipe.environment) {
        if (process.env[env]) availableEnvVars.push(env)
      }
      if (availableEnvVars.length > 0) details.push(availableEnvVars.join(', '))
    }
    results.push(pass(`Tool: ${recipe.name}`, details.join(', ') || 'configured'))
  }

  return results
}

export function doctorCommand(sandboxName?: string): void {
  process.stderr.write('\n')
  const results: CheckResult[] = []
  results.push(checkPlatform())
  results.push(...checkDocker())
  results.push(checkServerBinary())
  results.push(...checkGlobalConfig())
  results.push(...checkSandboxes())
  results.push(...checkSelectedSandbox(sandboxName))
  results.push(...checkGpgAgentForwarding(sandboxName))
  results.push(...checkTools(sandboxName))
  for (const result of results) printResult(result)
  const failures = results.filter((r) => !r.ok)
  process.stderr.write('\n')
  if (failures.length > 0) {
    process.stderr.write(kleur.red(`${failures.length} issue${failures.length === 1 ? '' : 's'} found\n`))
    process.exit(1)
  }
  process.stderr.write(kleur.green('all checks passed\n'))
}

export const __test__ = {
  checkSandboxes,
}
