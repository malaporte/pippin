import path from 'node:path'
import fs from 'node:fs'
import { expandHome } from './config'
import type { ResolvedGlobalConfig } from './config'
import type { WorkspaceConfig } from '../shared/types'

/**
 * Resolve the Cedar policy file path for a sandbox.
 *
 * Priority (first match wins):
 *   1. workspace sandbox.policy  (must be absolute or ~-prefixed)
 *   2. global policy             (absolute or ~ path)
 *   3. undefined → leash uses its default permissive policy
 *
 * Returns the absolute path to the .cedar file, or undefined if no policy
 * is configured. Exits with an error if a configured path does not exist or
 * is a bare relative path.
 */
export function resolvePolicy(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): string | undefined {
  // Workspace-level policy takes top priority
  if (workspaceConfig.sandbox?.policy) {
    const raw = workspaceConfig.sandbox.policy
    if (!path.isAbsolute(raw) && !raw.startsWith('~/')) {
      process.stderr.write(`pippin: workspace policy path must be absolute or start with ~/ — got: "${raw}"\n`)
      process.stderr.write(`pippin: set sandbox.policy in the workspaces entry in ~/.config/pippin/config.json\n`)
      process.exit(1)
    }
    const resolved = path.resolve(expandHome(raw))
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`pippin: workspace policy file not found: ${resolved}\n`)
      process.stderr.write(`pippin: configured in ~/.config/pippin/config.json workspaces["${workspaceRoot}"].sandbox.policy\n`)
      process.exit(1)
    }
    return resolved
  }

  // Global-level policy
  if (globalConfig.policy) {
    const resolved = path.resolve(expandHome(globalConfig.policy))
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`pippin: global policy file not found: ${resolved}\n`)
      process.stderr.write(`pippin: configured in ~/.config/pippin/config.json as "policy"\n`)
      process.exit(1)
    }
    return resolved
  }

  return undefined
}

/**
 * Read and return the contents of a Cedar policy file.
 * Returns null if the path is undefined.
 */
export function readPolicyFile(policyPath: string | undefined): string | null {
  if (!policyPath) return null

  try {
    return fs.readFileSync(policyPath, 'utf-8')
  } catch {
    process.stderr.write(`pippin: failed to read policy file: ${policyPath}\n`)
    process.exit(1)
  }
}

/**
 * Describe the source of the active policy for display purposes.
 */
export function describePolicySource(
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): string {
  if (workspaceConfig.sandbox?.policy) {
    return `workspace (config.json workspaces sandbox.policy = "${workspaceConfig.sandbox.policy}")`
  }
  if (globalConfig.policy) {
    return `global (~/.config/pippin/config.json "policy": "${globalConfig.policy}")`
  }
  return 'default (leash permissive policy — no restrictions)'
}
