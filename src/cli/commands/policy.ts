import { resolveWorkspace } from '../workspace'
import { readGlobalConfig } from '../config'
import { resolvePolicy, readPolicyFile, describePolicySource } from '../policy'

/** Show the active Cedar policy for the current workspace */
export function policyCommand(validate: boolean): void {
  const cwd = process.cwd()
  const workspace = resolveWorkspace(cwd)
  const globalConfig = readGlobalConfig()

  const policyPath = resolvePolicy(workspace.root, workspace.config, globalConfig)
  const source = describePolicySource(workspace.config, globalConfig)

  process.stdout.write(`workspace: ${workspace.root}\n`)
  process.stdout.write(`source:    ${source}\n`)

  if (!policyPath) {
    process.stdout.write(`\nno policy configured — sandbox runs with no restrictions\n`)
    process.stdout.write(`\nto add a policy, set sandbox.policy in .pippin.toml or "policy" in ~/.config/pippin/config.json\n`)
    return
  }

  process.stdout.write(`file:      ${policyPath}\n`)

  const content = readPolicyFile(policyPath)
  if (!content) return

  if (validate) {
    validatePolicyContent(content, policyPath)
  } else {
    process.stdout.write(`\n${content}`)
    if (!content.endsWith('\n')) {
      process.stdout.write('\n')
    }
  }
}

/**
 * Basic validation of Cedar policy content.
 * Checks for structural issues that are common mistakes.
 * Full validation happens inside leash via the Cedar transpiler.
 */
function validatePolicyContent(content: string, policyPath: string): void {
  const lines = content.split('\n')
  const errors: string[] = []

  // Check for at least one permit or forbid statement
  const hasPolicy = lines.some((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith('permit') || trimmed.startsWith('forbid')
  })

  if (!hasPolicy) {
    errors.push('no permit or forbid statements found')
  }

  // Check for balanced parentheses
  let parenDepth = 0
  for (const line of lines) {
    // Skip comments
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) continue

    for (const ch of line) {
      if (ch === '(') parenDepth++
      if (ch === ')') parenDepth--
    }
  }
  if (parenDepth !== 0) {
    errors.push(`unbalanced parentheses (depth ${parenDepth})`)
  }

  // Check for balanced braces
  let braceDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) continue

    for (const ch of line) {
      if (ch === '{') braceDepth++
      if (ch === '}') braceDepth--
    }
  }
  if (braceDepth !== 0) {
    errors.push(`unbalanced braces (depth ${braceDepth})`)
  }

  // Check that policies end with semicolons
  // Look for closing ) or } that should be followed by ;
  const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()
  const policyBlocks = stripped.split(';').filter((s) => s.trim().length > 0)
  for (const block of policyBlocks) {
    const trimmed = block.trim()
    if (trimmed.length > 0 && !trimmed.startsWith('@') && !trimmed.startsWith('permit') && !trimmed.startsWith('forbid')) {
      errors.push(`unexpected content outside policy block: "${trimmed.slice(0, 40)}..."`)
    }
  }

  if (errors.length > 0) {
    process.stdout.write(`\nvalidation issues in ${policyPath}:\n`)
    for (const err of errors) {
      process.stdout.write(`  - ${err}\n`)
    }
    process.stdout.write(`\nnote: full Cedar validation happens at sandbox startup via leash\n`)
    process.exit(1)
  }

  process.stdout.write(`\npolicy is structurally valid\n`)
  process.stdout.write(`note: full Cedar validation happens at sandbox startup via leash\n`)
}
