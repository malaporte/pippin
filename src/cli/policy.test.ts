import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolvePolicy, readPolicyFile, describePolicySource } from './policy'
import type { ResolvedGlobalConfig } from './config'
import type { WorkspaceConfig } from '../shared/types'

function makeGlobalConfig(overrides: Partial<ResolvedGlobalConfig> = {}): ResolvedGlobalConfig {
  return {
    idleTimeout: 900,
    portRangeStart: 9111,
    dotfiles: [],
    environment: [],
    hostCommands: [],
    sshAgent: false,
    tools: [],
    shell: 'bash',
    workspaces: {},
    image: undefined,
    dockerfile: undefined,
    policy: undefined,
    ...overrides,
  }
}

describe('resolvePolicy', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-policy-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined when no policy is configured', () => {
    const config: WorkspaceConfig = {}
    const global = makeGlobalConfig()
    const result = resolvePolicy(tmpDir, config, global)
    expect(result).toBeUndefined()
  })

  it('resolves workspace policy with absolute path', () => {
    const policyPath = path.join(tmpDir, 'sandbox.cedar')
    fs.writeFileSync(policyPath, 'permit (principal, action, resource);')

    const config: WorkspaceConfig = { sandbox: { policy: policyPath } }
    const global = makeGlobalConfig()
    const result = resolvePolicy(tmpDir, config, global)
    expect(result).toBe(policyPath)
  })

  it('resolves global policy with absolute path', () => {
    const policyPath = path.join(tmpDir, 'global.cedar')
    fs.writeFileSync(policyPath, 'permit (principal, action, resource);')

    const config: WorkspaceConfig = {}
    const global = makeGlobalConfig({ policy: policyPath })
    const result = resolvePolicy(tmpDir, config, global)
    expect(result).toBe(policyPath)
  })

  it('workspace policy overrides global policy', () => {
    const workspacePolicy = path.join(tmpDir, 'workspace.cedar')
    const globalPolicy = path.join(tmpDir, 'global.cedar')
    fs.writeFileSync(workspacePolicy, 'forbid (principal, action, resource);')
    fs.writeFileSync(globalPolicy, 'permit (principal, action, resource);')

    const config: WorkspaceConfig = { sandbox: { policy: workspacePolicy } }
    const global = makeGlobalConfig({ policy: globalPolicy })
    const result = resolvePolicy(tmpDir, config, global)
    expect(result).toBe(workspacePolicy)
  })

  it('exits with error when workspace policy file does not exist', () => {
    const config: WorkspaceConfig = { sandbox: { policy: '/nonexistent/sandbox.cedar' } }
    const global = makeGlobalConfig()

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const mockStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(() => resolvePolicy(tmpDir, config, global)).toThrow('exit')
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining('workspace policy file not found'))

    mockExit.mockRestore()
    mockStderr.mockRestore()
  })

  it('exits with error when global policy file does not exist', () => {
    const config: WorkspaceConfig = {}
    const global = makeGlobalConfig({ policy: '/nonexistent/path/global.cedar' })

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const mockStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(() => resolvePolicy(tmpDir, config, global)).toThrow('exit')
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining('global policy file not found'))

    mockExit.mockRestore()
    mockStderr.mockRestore()
  })

  it('resolves workspace policy in a subdirectory via absolute path', () => {
    const subdir = path.join(tmpDir, 'policies')
    fs.mkdirSync(subdir, { recursive: true })
    const policyPath = path.join(subdir, 'strict.cedar')
    fs.writeFileSync(policyPath, 'forbid (principal, action, resource);')

    const config: WorkspaceConfig = { sandbox: { policy: policyPath } }
    const global = makeGlobalConfig()
    const result = resolvePolicy(tmpDir, config, global)
    expect(result).toBe(policyPath)
  })

  it('exits with error when workspace policy is a bare relative path', () => {
    const config: WorkspaceConfig = { sandbox: { policy: 'relative/path.cedar' } }
    const global = makeGlobalConfig()

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const mockStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(() => resolvePolicy(tmpDir, config, global)).toThrow('exit')
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining('must be absolute or start with ~/'))

    mockExit.mockRestore()
    mockStderr.mockRestore()
  })
})

// Need to import vi for spyOn usage
import { vi } from 'vitest'

describe('readPolicyFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-policy-read-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null for undefined path', () => {
    expect(readPolicyFile(undefined)).toBeNull()
  })

  it('reads the contents of a Cedar policy file', () => {
    const policyPath = path.join(tmpDir, 'test.cedar')
    const content = 'permit (principal, action, resource);\n'
    fs.writeFileSync(policyPath, content)

    expect(readPolicyFile(policyPath)).toBe(content)
  })
})

describe('describePolicySource', () => {
  it('describes workspace source when workspace policy is set', () => {
    const config: WorkspaceConfig = { sandbox: { policy: 'sandbox.cedar' } }
    const global = makeGlobalConfig()
    const desc = describePolicySource(config, global)
    expect(desc).toContain('workspace')
    expect(desc).toContain('sandbox.cedar')
  })

  it('describes global source when only global policy is set', () => {
    const config: WorkspaceConfig = {}
    const global = makeGlobalConfig({ policy: '~/.config/pippin/policy.cedar' })
    const desc = describePolicySource(config, global)
    expect(desc).toContain('global')
    expect(desc).toContain('policy.cedar')
  })

  it('describes default when no policy is set', () => {
    const config: WorkspaceConfig = {}
    const global = makeGlobalConfig()
    const desc = describePolicySource(config, global)
    expect(desc).toContain('default')
    expect(desc).toContain('no restrictions')
  })
})
