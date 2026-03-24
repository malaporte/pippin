import path from 'node:path'
import fs from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import type { WorkspaceConfig, MountEntry } from '../shared/types'

const WORKSPACE_CONFIG_FILE = '.pippin.toml'

interface ResolvedWorkspace {
  /** Absolute path to the directory containing .pippin.toml */
  root: string
  /** Parsed workspace configuration */
  config: WorkspaceConfig
}

/**
 * Walk from `startDir` upward to find a .pippin.toml file.
 * Returns the resolved workspace or null if not found.
 */
export function findWorkspace(startDir: string): ResolvedWorkspace | null {
  let dir = path.resolve(startDir)

  while (true) {
    const configPath = path.join(dir, WORKSPACE_CONFIG_FILE)
    try {
      const text = fs.readFileSync(configPath, 'utf-8')
      const parsed = parseToml(text) as unknown as WorkspaceConfig
      return {
        root: dir,
        config: validateWorkspaceConfig(parsed),
      }
    } catch {
      // File doesn't exist or is invalid — keep walking up
    }

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

/**
 * Walk from `startDir` upward to find a .git entry (file or directory).
 * Returns the directory containing .git, or null if not found.
 */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir)
  while (true) {
    try {
      fs.lstatSync(path.join(dir, '.git'))
      return dir
    } catch {
      // No .git here — keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Resolve the workspace for the current working directory.
 * If no .pippin.toml is found, walks up the directory tree to find a .git
 * entry and uses that directory as the implicit workspace root. If no .git
 * is found either, falls back silently to the current directory.
 */
export function resolveWorkspace(cwd: string): ResolvedWorkspace {
  const workspace = findWorkspace(cwd)
  if (!workspace) {
    const root = findGitRoot(cwd) ?? path.resolve(cwd)
    return { root, config: {} }
  }
  return workspace
}

/**
 * Validate that a CWD is reachable from within the sandbox.
 * The CWD must be under the workspace root or one of the extra mounts.
 */
export function validateCwd(
  cwd: string,
  workspaceRoot: string,
  extraMounts: MountEntry[],
): string | null {
  const resolvedCwd = path.resolve(cwd)

  // Check primary mount (workspace root)
  if (isUnderPath(resolvedCwd, workspaceRoot)) {
    return resolvedCwd
  }

  // Check extra mounts
  for (const mount of extraMounts) {
    const mountPath = path.resolve(mount.path)
    if (isUnderPath(resolvedCwd, mountPath)) {
      return resolvedCwd
    }
  }

  return null
}

function isUnderPath(child: string, parent: string): boolean {
  const normalizedParent = parent.replace(/\/+$/, '') || '/'
  const normalizedChild = child.replace(/\/+$/, '') || '/'

  if (normalizedChild === normalizedParent) return true
  return normalizedChild.startsWith(normalizedParent + path.sep)
}

function validateWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null) return {}

  const obj = raw as Record<string, unknown>
  const config: WorkspaceConfig = {}

  if (typeof obj.sandbox === 'object' && obj.sandbox !== null) {
    const sandbox = obj.sandbox as Record<string, unknown>
    config.sandbox = {}

    if (typeof sandbox.idle_timeout === 'number' && sandbox.idle_timeout > 0) {
      config.sandbox.idle_timeout = sandbox.idle_timeout
    }

    if (typeof sandbox.init === 'string' && sandbox.init.length > 0) {
      config.sandbox.init = sandbox.init
    }

    if (Array.isArray(sandbox.mounts)) {
      config.sandbox.mounts = sandbox.mounts
        .filter((m): m is MountEntry =>
          typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).path === 'string',
        )
    }

    if (typeof sandbox.image === 'string' && sandbox.image.length > 0) {
      config.sandbox.image = sandbox.image
    }

    if (typeof sandbox.dockerfile === 'string' && sandbox.dockerfile.length > 0) {
      config.sandbox.dockerfile = sandbox.dockerfile
    }

    if (typeof sandbox.policy === 'string' && sandbox.policy.length > 0) {
      config.sandbox.policy = sandbox.policy
    }

    if (typeof sandbox.shell === 'string' && sandbox.shell.length > 0) {
      config.sandbox.shell = sandbox.shell
    }

    if (Array.isArray(sandbox.host_commands)) {
      config.sandbox.host_commands = sandbox.host_commands
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
    }

    if (typeof sandbox.ssh_agent === 'boolean') {
      config.sandbox.ssh_agent = sandbox.ssh_agent
    }

    if (Array.isArray(sandbox.tools)) {
      config.sandbox.tools = sandbox.tools
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
    }
  }

  return config
}
