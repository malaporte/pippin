import path from 'node:path'
import { expandHome } from './config'
import type { SandboxConfig, MountEntry } from '../shared/types'

export const DEFAULT_SANDBOX_NAME = 'default'

export interface ResolvedSandbox {
  /** The sandbox name (e.g. "default") */
  name: string
  /** The parsed sandbox configuration */
  config: SandboxConfig
}

/**
 * Resolve the sandbox to use. Returns the named sandbox config, or null if
 * the name is not found in the sandboxes map.
 *
 * When no name is given, defaults to "default".
 */
export function resolveSandbox(
  name: string = DEFAULT_SANDBOX_NAME,
  sandboxes: Record<string, SandboxConfig>,
): ResolvedSandbox | null {
  const config = sandboxes[name]
  if (!config) return null
  return { name, config }
}

/**
 * Validate that a CWD is reachable from within the sandbox.
 * The CWD must be under the sandbox root or one of the extra mounts.
 * Returns the resolved absolute CWD, or null if not reachable.
 */
export function validateCwd(
  cwd: string,
  sandboxConfig: SandboxConfig,
): string | null {
  const resolvedCwd = path.resolve(cwd)
  const root = path.resolve(expandHome(sandboxConfig.root))

  // Check primary mount (sandbox root)
  if (isUnderPath(resolvedCwd, root)) {
    return resolvedCwd
  }

  // Check extra mounts
  for (const mount of sandboxConfig.mounts ?? []) {
    const mountPath = path.resolve(expandHome(mount.path))
    if (isUnderPath(resolvedCwd, mountPath)) {
      return resolvedCwd
    }
  }

  return null
}

/**
 * Get the expanded extra mounts for a sandbox config (~ expanded to absolute paths).
 */
export function resolvedMounts(sandboxConfig: SandboxConfig): MountEntry[] {
  return (sandboxConfig.mounts ?? []).map((m) => ({
    ...m,
    path: expandHome(m.path),
  }))
}

function isUnderPath(child: string, parent: string): boolean {
  const normalizedParent = parent.replace(/\/+$/, '') || '/'
  const normalizedChild = child.replace(/\/+$/, '') || '/'

  if (normalizedChild === normalizedParent) return true
  return normalizedChild.startsWith(normalizedParent + path.sep)
}
