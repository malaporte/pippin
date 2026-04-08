import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxConfig } from '../shared/types'
import type { ResolvedGlobalConfig } from './config'

describe('policy helpers', () => {
  let globalConfig: ResolvedGlobalConfig

  beforeEach(() => {
    globalConfig = {
      portRangeStart: 9111,
      sandboxes: {},
    }
  })

  it('describes sandbox policy source', async () => {
    const { describePolicySource } = await import('./policy')
    const config: SandboxConfig = { root: '/workspace/project', policy: '/tmp/policy.cedar' }
    expect(describePolicySource('default', config, globalConfig)).toContain('sandboxes.default.policy')
  })

  it('describes default policy source', async () => {
    const { describePolicySource } = await import('./policy')
    const config: SandboxConfig = { root: '/workspace/project' }
    expect(describePolicySource('default', config, globalConfig)).toContain('default')
  })
})
