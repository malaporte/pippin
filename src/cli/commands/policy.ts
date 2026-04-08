import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox } from '../sandbox-config'
import { resolvePolicy, readPolicyFile, describePolicySource } from '../policy'

export function policyCommand(validate: boolean, sandboxName?: string): void {
  const name = sandboxName ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(name, globalConfig.sandboxes)
  if (!sandbox) {
    process.stderr.write(`pippin: sandbox "${name}" is not configured\n`)
    process.exit(1)
  }

  const policyPath = resolvePolicy(name, sandbox.config, globalConfig)
  const source = describePolicySource(name, sandbox.config, globalConfig)

  process.stdout.write(`sandbox:   ${name}\n`)
  process.stdout.write(`source:    ${source}\n`)

  if (!policyPath) {
    process.stdout.write('\nno policy configured - sandbox runs with no restrictions\n')
    process.stdout.write('\nto add a policy, set sandboxes.<name>.policy in ~/.config/pippin/config.json or set "policy" globally\n')
    return
  }

  process.stdout.write(`file:      ${policyPath}\n`)
  const content = readPolicyFile(policyPath)
  if (!content) return

  if (validate) {
    validatePolicyContent(content, policyPath)
  } else {
    process.stdout.write(`\n${content}`)
    if (!content.endsWith('\n')) process.stdout.write('\n')
  }
}

function validatePolicyContent(content: string, policyPath: string): void {
  const lines = content.split('\n')
  const errors: string[] = []
  const hasPolicy = lines.some((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith('permit') || trimmed.startsWith('forbid')
  })
  if (!hasPolicy) errors.push('no permit or forbid statements found')

  let parenDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) continue
    for (const ch of line) {
      if (ch === '(') parenDepth++
      if (ch === ')') parenDepth--
    }
  }
  if (parenDepth !== 0) errors.push(`unbalanced parentheses (depth ${parenDepth})`)

  let braceDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) continue
    for (const ch of line) {
      if (ch === '{') braceDepth++
      if (ch === '}') braceDepth--
    }
  }
  if (braceDepth !== 0) errors.push(`unbalanced braces (depth ${braceDepth})`)

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
    for (const err of errors) process.stdout.write(`  - ${err}\n`)
    process.stdout.write('\nnote: full Cedar validation happens at sandbox startup via leash\n')
    process.exit(1)
  }

  process.stdout.write('\npolicy is structurally valid\n')
  process.stdout.write('note: full Cedar validation happens at sandbox startup via leash\n')
}
