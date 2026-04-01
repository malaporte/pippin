import path from 'node:path'
import fs from 'node:fs'
import type { WorkspaceConfig, MountEntry } from '../shared/types'

interface ResolvedWorkspace {
  /** Absolute path to the workspace root (matched key or .git root) */
  root: string
  /** Parsed workspace configuration */
  config: WorkspaceConfig
}

/**
 * Find the workspace config for `cwd` by matching keys in the `workspaces`
 * map from the global config. Each key is treated as a regex tested against
 * the resolved cwd. The first matching key wins.
 *
 * For plain absolute paths (e.g. "/foo/bar") the regex matches as a prefix
 * naturally when written as "/foo/bar" since it will match any cwd that
 * contains that string — users who want strict prefix semantics should write
 * "^/foo/bar(/|$)". Invalid regexes are skipped with a warning.
 *
 * Returns the matched config and the key, or null if no key matches.
 */
export function findWorkspaceConfig(
  cwd: string,
  workspaces: Record<string, WorkspaceConfig>,
): { root: string; config: WorkspaceConfig } | null {
  const resolvedCwd = path.resolve(cwd)

  for (const key of Object.keys(workspaces)) {
    let re: RegExp
    try {
      re = new RegExp(key)
    } catch {
      process.stderr.write(`pippin: warning: invalid workspace key regex "${key}" — skipping\n`)
      continue
    }
    if (re.test(resolvedCwd)) {
      return { root: key, config: workspaces[key] }
    }
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
 * Looks up `cwd` in the `workspaces` map (longest-prefix match).
 * If no entry matches, walks up the directory tree to find a .git entry and
 * uses that directory as the implicit workspace root with an empty config.
 * Falls back silently to `cwd` itself if no .git is found either.
 */
export function resolveWorkspace(
  cwd: string,
  workspaces: Record<string, WorkspaceConfig>,
): ResolvedWorkspace {
  const match = findWorkspaceConfig(cwd, workspaces)
  if (match) return match

  const root = findGitRoot(cwd) ?? path.resolve(cwd)
  return { root, config: {} }
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

export function validateWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null) return {}

  const obj = raw as Record<string, unknown>
  const config: WorkspaceConfig = {}

  if (typeof obj.sandbox === 'object' && obj.sandbox !== null) {
    const sandbox = obj.sandbox as Record<string, unknown>
    config.sandbox = {}

    if (typeof sandbox.idle_timeout === 'number' && sandbox.idle_timeout > 0) {
      config.sandbox.idle_timeout = sandbox.idle_timeout
    }

    if (typeof sandbox.init_timeout === 'number' && sandbox.init_timeout > 0) {
      config.sandbox.init_timeout = sandbox.init_timeout
    }

    if (typeof sandbox.init === 'string' && sandbox.init.length > 0) {
      config.sandbox.init = sandbox.init
    }

    if (typeof sandbox.auto_install === 'boolean') {
      config.sandbox.auto_install = sandbox.auto_install
    }

    if (typeof sandbox.install_command === 'string' && sandbox.install_command.length > 0) {
      config.sandbox.install_command = sandbox.install_command
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
