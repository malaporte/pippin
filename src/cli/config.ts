import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_IDLE_TIMEOUT, DEFAULT_INIT_TIMEOUT, DEFAULT_PORT } from '../shared/types'
import type { GlobalConfig, DotfileEntry } from '../shared/types'
import { KNOWN_TOOLS } from './tools'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'pippin')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/** Resolved global config: fields with defaults are always present, optional overrides may be undefined */
export type ResolvedGlobalConfig = Required<Pick<GlobalConfig, 'idleTimeout' | 'portRangeStart' | 'dotfiles' | 'environment' | 'shell' | 'hostCommands' | 'sshAgent' | 'tools'>> & Pick<GlobalConfig, 'initTimeout' | 'image' | 'dockerfile' | 'policy'>

/** Read the global pippin config, returning defaults for missing values */
export function readGlobalConfig(): ResolvedGlobalConfig {
  const defaults: ResolvedGlobalConfig = {
    idleTimeout: DEFAULT_IDLE_TIMEOUT,
    portRangeStart: DEFAULT_PORT,
    dotfiles: [],
    environment: [],
    hostCommands: [],
    sshAgent: false,
    tools: [...KNOWN_TOOLS],
    shell: 'bash',
    image: undefined,
    dockerfile: undefined,
    policy: undefined,
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
    idleTimeout: typeof parsed.idleTimeout === 'number' && parsed.idleTimeout > 0
      ? parsed.idleTimeout
      : defaults.idleTimeout,
    initTimeout: typeof parsed.initTimeout === 'number' && parsed.initTimeout > 0
      ? parsed.initTimeout
      : undefined,
    portRangeStart: typeof parsed.portRangeStart === 'number' && parsed.portRangeStart > 0
      ? parsed.portRangeStart
      : defaults.portRangeStart,
    dotfiles: Array.isArray(parsed.dotfiles)
      ? parsed.dotfiles.filter(isValidDotfileEntry)
      : defaults.dotfiles,
    environment: Array.isArray(parsed.environment)
      ? parsed.environment.filter(isValidEnvName)
      : defaults.environment,
    hostCommands: Array.isArray(parsed.hostCommands)
      ? parsed.hostCommands.filter(isValidEnvName)
      : defaults.hostCommands,
    sshAgent: typeof parsed.sshAgent === 'boolean'
      ? parsed.sshAgent
      : defaults.sshAgent,
    tools: Array.isArray(parsed.tools)
      ? parsed.tools.filter(isValidEnvName)
      : defaults.tools,
    shell: typeof parsed.shell === 'string' && parsed.shell.length > 0
      ? parsed.shell
      : defaults.shell,
    image: typeof parsed.image === 'string' && parsed.image.length > 0
      ? parsed.image
      : defaults.image,
    dockerfile: typeof parsed.dockerfile === 'string' && parsed.dockerfile.length > 0
      ? parsed.dockerfile
      : defaults.dockerfile,
    policy: typeof parsed.policy === 'string' && parsed.policy.length > 0
      ? parsed.policy
      : defaults.policy,
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

function isValidDotfileEntry(entry: unknown): entry is DotfileEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const obj = entry as Record<string, unknown>
  return typeof obj.path === 'string' && obj.path.length > 0
}

function isValidEnvName(entry: unknown): entry is string {
  return typeof entry === 'string' && entry.length > 0
}
