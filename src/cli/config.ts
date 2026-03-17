import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_IDLE_TIMEOUT, DEFAULT_PORT } from '../shared/types'
import type { GlobalConfig, DotfileEntry } from '../shared/types'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'pippin')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/** Read the global pippin config, returning defaults for missing values */
export function readGlobalConfig(): Required<GlobalConfig> {
  const defaults: Required<GlobalConfig> = {
    idleTimeout: DEFAULT_IDLE_TIMEOUT,
    portRangeStart: DEFAULT_PORT,
    dotfiles: [],
  }

  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(text) as GlobalConfig
    return {
      idleTimeout: typeof parsed.idleTimeout === 'number' && parsed.idleTimeout > 0
        ? parsed.idleTimeout
        : defaults.idleTimeout,
      portRangeStart: typeof parsed.portRangeStart === 'number' && parsed.portRangeStart > 0
        ? parsed.portRangeStart
        : defaults.portRangeStart,
      dotfiles: Array.isArray(parsed.dotfiles)
        ? parsed.dotfiles.filter(isValidDotfileEntry)
        : defaults.dotfiles,
    }
  } catch {
    return defaults
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
