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
    mocks.readGlobalConfig.mockReset()
    mocks.readGlobalConfig.mockReturnValue({
      portRangeStart: 9111,
      sandboxes: {},
    })
  })

  it('reports bundled default image when no override is configured', async () => {
    const { __test__ } = await import('./status')
    expect(__test__.describeSandboxImageSource({ root: '/workspace/project' })).toBe('bundled default sandbox image')
  })

  it('reports sandbox dockerfile when present', async () => {
    const { __test__ } = await import('./status')
    expect(__test__.describeSandboxImageSource({ root: '/workspace/project', dockerfile: './Dockerfile.pippin' })).toBe('sandbox dockerfile /workspace/project/Dockerfile.pippin')
  })
})
