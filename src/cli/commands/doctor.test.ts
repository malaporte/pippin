import { describe, expect, it, vi } from 'vitest'

vi.mock('../config', () => ({
  readGlobalConfig: () => ({
    sandboxes: { default: { root: '/workspace/project' } },
    portRangeStart: 9111,
  }),
  expandHome: (value: string) => value,
}))

vi.mock('../sandbox-config', () => ({
  DEFAULT_SANDBOX_NAME: 'default',
  resolveSandbox: () => ({ name: 'default', config: { root: '/workspace/project' } }),
}))

vi.mock('../sandbox', () => ({
  resolveGpgSocketInfo: () => null,
  resolveServerBinary: () => '/tmp/pippin-server-linux-arm64',
}))

vi.mock('../tools', () => ({
  RECIPES: {},
  KNOWN_TOOLS: [],
  resolveToolRequirements: () => ({
    dotfiles: [],
    environment: [],
    envResolvers: {},
    envMultiResolvers: [],
    extraMounts: [],
    dotfileOverrides: new Map(),
    sshAgent: false,
    gpgAgent: false,
    warnings: [],
  }),
}))

describe('doctor sandboxes', () => {
  it('exports sandbox checks for tests', async () => {
    const { __test__ } = await import('./doctor')
    expect(__test__.checkSandboxes).toBeTypeOf('function')
  })
})
