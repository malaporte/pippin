import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_PORT } from '../shared/types'
import type { GlobalConfig, DotfileEntry, SandboxConfig } from '../shared/types'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'pippin')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/** Resolved global config: fields with defaults are always present, optional overrides may be undefined */
export type ResolvedGlobalConfig = Required<Pick<GlobalConfig, 'portRangeStart' | 'sandboxes'>>

/** Read the global pippin config, returning defaults for missing values */
export function readGlobalConfig(): ResolvedGlobalConfig {
  const defaults: ResolvedGlobalConfig = {
    portRangeStart: DEFAULT_PORT,
    sandboxes: {},
  }

  let text: string
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    // Config file doesn't exist — use defaults silently
    return defaults
  }

  let parsed: GlobalConfig
  try {
    parsed = JSON.parse(text) as GlobalConfig
  } catch (err) {
    // Config file exists but contains invalid JSON — warn the user
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`pippin: warning: failed to parse ${CONFIG_PATH}: ${message}\n`)
    process.stderr.write(`pippin: using default configuration\n`)
    return defaults
  }

  return {
    portRangeStart: typeof parsed.portRangeStart === 'number' && parsed.portRangeStart > 0
      ? parsed.portRangeStart
      : defaults.portRangeStart,
    sandboxes: parseSandboxes(parsed.sandboxes),
  }
}

/** Write the global config file, creating the directory if needed */
export function writeGlobalConfig(config: GlobalConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/** Resolve a path that may start with ~ to an absolute path */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

function parseSandboxes(raw: unknown): Record<string, SandboxConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: Record<string, SandboxConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue
    const parsed = validateSandboxConfig(value)
    if (parsed) {
      result[key] = parsed
    } else {
      process.stderr.write(`pippin: warning: sandbox "${key}" has no valid "root" field — skipping\n`)
    }
  }
  return result
}

export function validateSandboxConfig(raw: unknown): SandboxConfig | null {
  if (typeof raw !== 'object' || raw === null) return null

  const obj = raw as Record<string, unknown>

  // root is required
  if (typeof obj.root !== 'string' || obj.root.length === 0) return null

  const config: SandboxConfig = { root: obj.root }

  if (Array.isArray(obj.dotfiles)) {
    config.dotfiles = obj.dotfiles.filter(isValidDotfileEntry)
  }

  if (Array.isArray(obj.environment)) {
    config.environment = obj.environment.filter(isValidEnvName)
  }

  if (typeof obj.idle_timeout === 'number' && obj.idle_timeout > 0) {
    config.idle_timeout = obj.idle_timeout
  }

  if (typeof obj.init_timeout === 'number' && obj.init_timeout > 0) {
    config.init_timeout = obj.init_timeout
  }

  if (typeof obj.init === 'string' && obj.init.length > 0) {
    config.init = obj.init
  }

  if (Array.isArray(obj.mounts)) {
    config.mounts = obj.mounts.filter(
      (m): m is { path: string; readonly?: boolean } =>
        typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).path === 'string',
    )
  }

  if (typeof obj.image === 'string' && obj.image.length > 0) {
    config.image = obj.image
  }

  if (typeof obj.dockerfile === 'string' && obj.dockerfile.length > 0) {
    config.dockerfile = obj.dockerfile
  }

  if (typeof obj.policy === 'string' && obj.policy.length > 0) {
    config.policy = obj.policy
  }

  if (typeof obj.shell === 'string' && obj.shell.length > 0) {
    config.shell = obj.shell
  }

  if (Array.isArray(obj.host_commands)) {
    config.host_commands = obj.host_commands.filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    )
  }

  if (typeof obj.ssh_agent === 'boolean') {
    config.ssh_agent = obj.ssh_agent
  }

  if (Array.isArray(obj.tools)) {
    config.tools = obj.tools.filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    )
  }

  return config
}

function isValidDotfileEntry(entry: unknown): entry is DotfileEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const obj = entry as Record<string, unknown>
  return typeof obj.path === 'string' && obj.path.length > 0
}

function isValidEnvName(entry: unknown): entry is string {
  return typeof entry === 'string' && entry.length > 0
}
