import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import kleur from 'kleur'
import { readGlobalConfig, expandHome } from '../config'
import { findWorkspace } from '../workspace'
import { resolveServerBinary } from '../sandbox'
import { resolvePolicy } from '../policy'

interface CheckResult {
  ok: boolean
  label: string
  detail: string
}

function pass(label: string, detail: string): CheckResult {
  return { ok: true, label, detail }
}

function fail(label: string, detail: string): CheckResult {
  return { ok: false, label, detail }
}

function printResult(result: CheckResult): void {
  const icon = result.ok ? kleur.green('[✓]') : kleur.red('[✗]')
  process.stderr.write(`${icon} ${result.label}: ${result.detail}\n`)
}

// --- Individual checks ---

function checkPlatform(): CheckResult {
  const platform = os.platform()
  const arch = os.arch()
  const supported = (platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')
  const desc = `${platform} ${arch}`

  if (supported) {
    return pass('Platform', desc)
  }
  return fail('Platform', `${desc} (unsupported — requires macOS or Linux, x64 or arm64)`)
}

function checkDocker(): CheckResult[] {
  const results: CheckResult[] = []

  // Check docker is installed
  const version = spawnSync('docker', ['--version'], { encoding: 'utf-8', timeout: 10_000 })
  if (version.status !== 0) {
    results.push(fail('Docker', 'not found on PATH'))
    return results
  }

  const versionStr = (version.stdout || '').trim().replace(/^Docker version\s*/i, '')
  results.push(pass('Docker', versionStr))

  // Check docker daemon is running
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 15_000 })
  if (info.status !== 0) {
    results.push(fail('Docker daemon', 'not running (start Docker Desktop or dockerd)'))
  } else {
    results.push(pass('Docker daemon', 'running'))
  }

  return results
}

function checkLeash(): CheckResult {
  const result = spawnSync('leash', ['--version'], { encoding: 'utf-8', timeout: 10_000 })
  if (result.status !== 0 && result.error) {
    return fail('leash', 'not found on PATH — see https://github.com/strongdm/leash')
  }

  const versionStr = (result.stdout || '').trim().split('\n')[0]
  // Find the leash binary location
  const which = spawnSync('which', ['leash'], { encoding: 'utf-8', timeout: 5_000 })
  const location = (which.stdout || '').trim()

  const detail = versionStr
    ? `${versionStr}${location ? ` (${location})` : ''}`
    : location || 'found'

  return pass('leash', detail)
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

  if (!fs.existsSync(configPath)) {
    // No global config is fine — it's optional
    return results
  }

  let text: string
  try {
    text = fs.readFileSync(configPath, 'utf-8')
  } catch {
    results.push(fail('Global config', `cannot read ${configPath}`))
    return results
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.push(fail('Global config', `invalid JSON: ${msg}`))
    return results
  }

  results.push(pass('Global config', configPath))

  // Validate dotfiles exist
  if (Array.isArray(parsed.dotfiles)) {
    for (const entry of parsed.dotfiles) {
      if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string') {
        const expanded = expandHome((entry as Record<string, unknown>).path as string)
        if (!fs.existsSync(expanded)) {
          results.push(fail('Dotfile', `${expanded} does not exist`))
        }
      } else if (typeof entry === 'string') {
        results.push(fail('Dotfile', `"${entry}" — must be an object with a "path" field, e.g. { "path": "${entry}" }`))
      }
    }
  }

  // Validate policy file exists
  if (typeof parsed.policy === 'string' && parsed.policy.length > 0) {
    const expanded = path.resolve(expandHome(parsed.policy))
    if (!fs.existsSync(expanded)) {
      results.push(fail('Global policy', `${expanded} does not exist`))
    }
  }

  // Validate dockerfile exists
  if (typeof parsed.dockerfile === 'string' && parsed.dockerfile.length > 0) {
    const expanded = path.resolve(expandHome(parsed.dockerfile))
    if (!fs.existsSync(expanded)) {
      results.push(fail('Global Dockerfile', `${expanded} does not exist`))
    }
  }

  return results
}

function checkWorkspace(): CheckResult[] {
  const results: CheckResult[] = []
  const cwd = process.cwd()
  const workspace = findWorkspace(cwd)

  if (!workspace) {
    // No workspace config is fine — pippin works without one
    return results
  }

  results.push(pass('Workspace config', path.join(workspace.root, '.pippin.toml')))
  const globalConfig = readGlobalConfig()
  const config = workspace.config

  // Validate policy file
  if (config.sandbox?.policy) {
    const resolved = path.resolve(workspace.root, expandHome(config.sandbox.policy))
    if (!fs.existsSync(resolved)) {
      results.push(fail('Workspace policy', `${resolved} does not exist`))
    } else {
      results.push(pass('Workspace policy', resolved))
    }
  }

  // Validate dockerfile
  if (config.sandbox?.dockerfile) {
    const resolved = path.resolve(workspace.root, config.sandbox.dockerfile)
    if (!fs.existsSync(resolved)) {
      results.push(fail('Workspace Dockerfile', `${resolved} does not exist`))
    }
  }

  // Validate mounts
  if (config.sandbox?.mounts) {
    for (const mount of config.sandbox.mounts) {
      const expanded = expandHome(mount.path)
      const resolved = path.resolve(expanded)
      if (!fs.existsSync(resolved)) {
        results.push(fail('Mount', `${resolved} does not exist`))
      }
    }
  }

  // Check SSH agent socket if enabled
  const sshAgent = config.sandbox?.ssh_agent ?? globalConfig.sshAgent
  if (sshAgent) {
    if (os.platform() !== 'darwin') {
      results.push(fail('SSH agent', 'sshAgent is enabled but only works on macOS with Docker Desktop'))
    } else {
      // We can't check the socket directly since it lives inside the Docker Desktop VM,
      // but we can check if Docker Desktop is the runtime
      results.push(pass('SSH agent', 'enabled'))
    }
  }

  return results
}

// --- Main command ---

export function doctorCommand(): void {
  process.stderr.write('\n')

  const results: CheckResult[] = []

  // Core prerequisites
  results.push(checkPlatform())
  results.push(...checkDocker())
  results.push(checkLeash())
  results.push(checkServerBinary())

  // Config validation
  results.push(...checkGlobalConfig())
  results.push(...checkWorkspace())

  // Print all results
  for (const result of results) {
    printResult(result)
  }

  const failures = results.filter((r) => !r.ok)
  process.stderr.write('\n')

  if (failures.length > 0) {
    process.stderr.write(kleur.red(`${failures.length} issue${failures.length === 1 ? '' : 's'} found\n`))
    process.exit(1)
  } else {
    process.stderr.write(kleur.green('all checks passed\n'))
  }
}
