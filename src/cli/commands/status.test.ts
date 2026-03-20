import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readGlobalConfig: vi.fn(),
}))

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config')
  return {
    ...actual,
    readGlobalConfig: mocks.readGlobalConfig,
  }
})

describe('status sandbox image source', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.readGlobalConfig.mockReset()
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
  })

  it('reports bundled default image when no override is configured', async () => {
    const { __test__ } = await import('./status')
    expect(__test__.describeSandboxImageSource('/workspace/project', {})).toBe('bundled default sandbox image')
  })

  it('reports workspace dockerfile when present', async () => {
    const { __test__ } = await import('./status')
    expect(__test__.describeSandboxImageSource('/workspace/project', {
      sandbox: { dockerfile: './Dockerfile.pippin' },
    })).toBe('workspace dockerfile /workspace/project/Dockerfile.pippin')
  })

  it('reports global image when no workspace override exists', async () => {
    mocks.readGlobalConfig.mockReturnValue({
      idleTimeout: 900,
      portRangeStart: 9111,
      dotfiles: [],
      environment: [],
      hostCommands: [],
      sshAgent: false,
      tools: [],
      shell: 'bash',
      image: 'custom/global:latest',
      dockerfile: undefined,
      policy: undefined,
    })

    const { __test__ } = await import('./status')
    expect(__test__.describeSandboxImageSource('/workspace/project', {})).toBe('global image custom/global:latest')
  })
})
