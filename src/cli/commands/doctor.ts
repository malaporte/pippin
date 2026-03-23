import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import kleur from 'kleur'
import { readGlobalConfig, expandHome } from '../config'
import { findWorkspace } from '../workspace'
import { resolveServerBinary } from '../sandbox'
import { resolvePolicy } from '../policy'
import { RECIPES, KNOWN_TOOLS, resolveToolRequirements } from '../tools'
import { findLeash, getLeashVersion } from '../leash'

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
  const leashPath = findLeash()
  if (!leashPath) {
    return fail('leash', 'not found — will be auto-installed on first sandbox start, or install manually: npm install -g @strongdm/leash')
  }

  const version = getLeashVersion(leashPath)
  const detail = version
    ? `${version} (${leashPath})`
    : leashPath

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

  // Check SSH agent socket if enabled (either explicitly or via tool recipes)
  const explicitSshAgent = config.sandbox?.ssh_agent ?? globalConfig.sshAgent
  const workspaceTools = config.sandbox?.tools ?? []
  const allTools = [...new Set([...globalConfig.tools, ...workspaceTools])]
  const toolReqs = resolveToolRequirements(allTools)
  const sshAgent = explicitSshAgent || toolReqs.sshAgent

  if (sshAgent) {
    if (os.platform() !== 'darwin') {
      results.push(fail('SSH agent', 'sshAgent is enabled but only works on macOS with Docker Desktop'))
    } else {
      // Check if the agent actually has keys loaded
      const listResult = spawnSync('ssh-add', ['-l'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (listResult.status === 0 && listResult.stdout?.trim()) {
        const keyCount = listResult.stdout.trim().split('\n').length
        results.push(pass('SSH agent', `enabled, ${keyCount} key${keyCount !== 1 ? 's' : ''} loaded`))
      } else {
        results.push(fail('SSH agent', 'enabled but no keys loaded — pippin will auto-add keys at sandbox start, or run `ssh-add` manually'))
      }
    }
  }

  return results
}

function checkSandboxImageSelection(): CheckResult {
  const globalConfig = readGlobalConfig()
  const workspace = findWorkspace(process.cwd())
  const sandbox = workspace?.config.sandbox

  if (sandbox?.image) {
    return pass('Sandbox image', `workspace image ${sandbox.image}`)
  }

  if (sandbox?.dockerfile) {
    const resolved = path.resolve(workspace!.root, expandHome(sandbox.dockerfile))
    return pass('Sandbox image', `workspace dockerfile ${resolved}`)
  }

  if (globalConfig.image) {
    return pass('Sandbox image', `global image ${globalConfig.image}`)
  }

  if (globalConfig.dockerfile) {
    const resolved = path.resolve(expandHome(globalConfig.dockerfile))
    return pass('Sandbox image', `global dockerfile ${resolved}`)
  }

  return pass('Sandbox image', 'using bundled default sandbox image')
}

function checkTools(): CheckResult[] {
  const results: CheckResult[] = []
  const globalConfig = readGlobalConfig()
  const cwd = process.cwd()
  const workspace = findWorkspace(cwd)
  const workspaceTools = workspace?.config.sandbox?.tools ?? []

  // Merge tools from both configs
  const tools = [...new Set([...globalConfig.tools, ...workspaceTools])]
  if (tools.length === 0) return results

  // Validate each tool name and check its credentials
  for (const tool of tools) {
    const name = tool.toLowerCase()
    const recipe = RECIPES[name]

    if (!recipe) {
      results.push(fail('Tool', `"${tool}" — unknown tool (available: ${KNOWN_TOOLS.join(', ')})`))
      continue
    }

    // Check that credential files / directories exist on the host
    const details: string[] = []
    let hasCredentials = true

    if (recipe.dotfiles) {
      for (const df of recipe.dotfiles) {
        const expanded = expandHome(df.path)
        if (fs.existsSync(expanded)) {
          details.push(df.path)
        } else {
          hasCredentials = false
        }
      }
    }

    // Check if any env vars are available
    const shellEnv = process.env
    const availableEnvVars: string[] = []
    if (recipe.environment) {
      for (const env of recipe.environment) {
        if (shellEnv[env]) {
          availableEnvVars.push(env)
        }
      }
      if (availableEnvVars.length > 0) {
        details.push(availableEnvVars.join(', '))
      }
    }

    if (recipe.sshAgent) {
      details.push('SSH agent')
    }

    // Warn if no credentials are available at all
    const hasEnvCreds = availableEnvVars.length > 0
    const hasDotfiles = recipe.dotfiles ? recipe.dotfiles.some((df) => fs.existsSync(expandHome(df.path))) : false

    if (!hasDotfiles && !hasEnvCreds && (recipe.dotfiles?.length || recipe.environment?.length)) {
      const missing: string[] = []
      if (recipe.dotfiles) missing.push(...recipe.dotfiles.map((df) => df.path))
      if (recipe.environment) missing.push(...recipe.environment.map((e) => `$${e}`))
      results.push(fail(`Tool: ${recipe.name}`, `no credentials found (checked: ${missing.join(', ')})`))
    } else {
      results.push(pass(`Tool: ${recipe.name}`, details.join(', ') || 'configured'))
    }

    // Warn if tool is also in hostCommands (informational)
    const hostCommands = new Set([
      ...globalConfig.hostCommands,
      ...(workspace?.config.sandbox?.host_commands ?? []),
    ])
    if (hostCommands.has(name)) {
      results.push(pass(`Tool: ${recipe.name}`, `also in host_commands (host_commands takes precedence at exec time)`))
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
  results.push(checkSandboxImageSelection())

  // Tool recipe validation
  results.push(...checkTools())

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

export const __test__ = {
  checkSandboxImageSelection,
}
