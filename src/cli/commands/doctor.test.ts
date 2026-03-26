import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readGlobalConfig: vi.fn(),
  findWorkspace: vi.fn(),
  resolveGpgSocketInfo: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}))

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config')
  return {
    ...actual,
    readGlobalConfig: mocks.readGlobalConfig,
  }
})

vi.mock('../workspace', () => ({
  findWorkspace: mocks.findWorkspace,
}))

vi.mock('../sandbox', () => ({
  resolveServerBinary: vi.fn(() => '/tmp/pippin-server-linux-arm64'),
  resolveGpgSocketInfo: mocks.resolveGpgSocketInfo,
}))

describe('doctor sandbox image selection', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.readGlobalConfig.mockReset()
    mocks.findWorkspace.mockReset()
    mocks.readGlobalConfig.mockReturnValue({
      idleTimeout: 900,
      portRangeStart: 9111,
      dotfiles: [],
      environment: [],
      hostCommands: [],
      sshAgent: false,
      tools: [],
      shell: 'bash',
      image: undefined,
      dockerfile: undefined,
      policy: undefined,
    })
    mocks.findWorkspace.mockReturnValue(undefined)
    mocks.resolveGpgSocketInfo.mockReset()
    mocks.spawnSync.mockReset()
    mocks.spawnSync.mockImplementation((command: string) => {
      if (command === 'gpg-connect-agent') {
        return { status: 0, stdout: 'D 2.4.9\nOK\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })
  })

  it('reports bundled default image when no override is configured', async () => {
    const { __test__ } = await import('./doctor')

    expect(__test__.checkSandboxImageSelection()).toEqual({
      ok: true,
      label: 'Sandbox image',
      detail: 'using bundled default sandbox image',
    })
  })

  it('reports workspace image when present', async () => {
    mocks.findWorkspace.mockReturnValue({
      root: '/workspace/project',
      config: { sandbox: { image: 'custom/workspace:latest' } },
    })

    const { __test__ } = await import('./doctor')
    expect(__test__.checkSandboxImageSelection().detail).toBe('workspace image custom/workspace:latest')
  })

  it('reports global dockerfile when no workspace override exists', async () => {
    mocks.readGlobalConfig.mockReturnValue({
      idleTimeout: 900,
      portRangeStart: 9111,
      dotfiles: [],
      environment: [],
      hostCommands: [],
      sshAgent: false,
      tools: [],
      shell: 'bash',
      image: undefined,
      dockerfile: '~/.config/pippin/Dockerfile',
      policy: undefined,
    })

    const { __test__ } = await import('./doctor')
    expect(__test__.checkSandboxImageSelection().detail).toContain('global dockerfile')
  })

  it('reports gpg socket mapping and reachability when git tool enables signing', async () => {
    mocks.findWorkspace.mockReturnValue({
      root: '/workspace/project',
      config: { sandbox: { tools: ['git'] } },
    })
    mocks.resolveGpgSocketInfo.mockReturnValue({
      hostSocket: '/Users/martin/.gnupg/S.gpg-agent.extra',
      containerSocket: '/root/.gnupg/S.gpg-agent',
      source: 'agent-extra-socket',
      fingerprint: 'test-fingerprint',
    })

    const { __test__ } = await import('./doctor')
    expect(__test__.checkGpgAgentForwarding()).toEqual([
      {
        ok: true,
        label: 'GPG agent socket',
        detail: 'agent-extra-socket /Users/martin/.gnupg/S.gpg-agent.extra -> /root/.gnupg/S.gpg-agent',
      },
      {
        ok: true,
        label: 'GPG agent reachability',
        detail: 'host gpg-agent responds to gpg-connect-agent',
      },
    ])
  })

  it('reports missing gpg socket when a configured tool requires it', async () => {
    mocks.findWorkspace.mockReturnValue({
      root: '/workspace/project',
      config: { sandbox: { tools: ['git'] } },
    })
    mocks.resolveGpgSocketInfo.mockReturnValue(null)

    const { __test__ } = await import('./doctor')
    expect(__test__.checkGpgAgentForwarding()).toEqual([
      {
        ok: false,
        label: 'GPG agent socket',
        detail: 'enabled but no usable host socket found (checked agent-extra-socket, then agent-socket)',
      },
    ])
  })
})
