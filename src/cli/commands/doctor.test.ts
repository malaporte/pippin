import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readGlobalConfig: vi.fn(),
  findWorkspace: vi.fn(),
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
})
