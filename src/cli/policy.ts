import path from 'node:path'
import fs from 'node:fs'
import { expandHome } from './config'
import type { ResolvedGlobalConfig } from './config'
import type { SandboxConfig } from '../shared/types'

export function resolvePolicy(
  sandboxName: string,
  sandboxConfig: SandboxConfig,
  _globalConfig: ResolvedGlobalConfig,
): string | undefined {
  if (sandboxConfig.policy) {
    const raw = sandboxConfig.policy
    if (!path.isAbsolute(raw) && !raw.startsWith('~/')) {
      process.stderr.write(`pippin: sandbox policy path must be absolute or start with ~/ - got: "${raw}"\n`)
      process.stderr.write(`pippin: set sandboxes["${sandboxName}"].policy in ~/.config/pippin/config.json\n`)
      process.exit(1)
    }
    const resolved = path.resolve(expandHome(raw))
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`pippin: sandbox policy file not found: ${resolved}\n`)
      process.stderr.write(`pippin: configured in ~/.config/pippin/config.json sandboxes["${sandboxName}"].policy\n`)
      process.exit(1)
    }
    return resolved
  }

  return undefined
}

export function readPolicyFile(policyPath: string | undefined): string | null {
  if (!policyPath) return null

  try {
    return fs.readFileSync(policyPath, 'utf-8')
  } catch {
    process.stderr.write(`pippin: failed to read policy file: ${policyPath}\n`)
    process.exit(1)
  }
}

export function describePolicySource(
  sandboxName: string,
  sandboxConfig: SandboxConfig,
  _globalConfig: ResolvedGlobalConfig,
): string {
  if (sandboxConfig.policy) {
    return `sandbox ${sandboxName} (config.json sandboxes.${sandboxName}.policy = "${sandboxConfig.policy}")`
  }
  return 'default (leash permissive policy - no restrictions)'
}
