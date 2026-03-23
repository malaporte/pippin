import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ResolvedGlobalConfig } from './config'
import type { WorkspaceConfig } from '../shared/types'
import { DEFAULT_SANDBOX_DOCKERFILE } from './default-dockerfile'

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('node:child_process', () => childProcessMocks)

describe('sandbox image resolution', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    childProcessMocks.spawn.mockReset()
    childProcessMocks.spawnSync.mockReset()
    childProcessMocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-sandbox-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function defaultGlobalConfig(): ResolvedGlobalConfig {
    return {
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
    }
  }

  it('prefers a workspace image over any dockerfile fallback', async () => {
    const { __test__ } = await import('./sandbox')
    const workspaceConfig: WorkspaceConfig = { sandbox: { image: 'custom/workspace:latest' } }

    const image = __test__.resolveImage(tmpDir, workspaceConfig, defaultGlobalConfig())

    expect(image).toBe('custom/workspace:latest')
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled()
  })

  it('builds the bundled default image when no override is configured', async () => {
    childProcessMocks.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'built', stderr: '' })

    const { __test__ } = await import('./sandbox')
    const image = __test__.resolveImage(tmpDir, {}, defaultGlobalConfig())
    const expectedHash = crypto.createHash('sha256').update(DEFAULT_SANDBOX_DOCKERFILE).digest('hex').slice(0, 12)

    expect(image).toBe(`pippin-custom:${expectedHash}`)
    expect(childProcessMocks.spawnSync).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['image', 'inspect', `pippin-custom:${expectedHash}`],
      expect.objectContaining({ timeout: 10_000 }),
    )

    const buildCall = childProcessMocks.spawnSync.mock.calls[1]
    expect(buildCall[0]).toBe('docker')
    expect(buildCall[1][0]).toBe('build')
    expect(buildCall[1][2]).toBe(`pippin-custom:${expectedHash}`)

    const dockerfilePath = buildCall[1][4] as string
    const contextPath = buildCall[1][5] as string
    expect(path.basename(dockerfilePath)).toBe('Dockerfile')
    expect(path.dirname(dockerfilePath)).toBe(contextPath)
    expect(fs.existsSync(contextPath)).toBe(false)
  })

  it('uses the same image tag for file and inline dockerfiles with identical content', async () => {
    const dockerfilePath = path.join(tmpDir, 'Dockerfile.pippin')
    fs.writeFileSync(dockerfilePath, DEFAULT_SANDBOX_DOCKERFILE)

    const { __test__ } = await import('./sandbox')
    const fromFile = __test__.buildDockerImage({ kind: 'path', dockerfilePath })
    const fromInline = __test__.buildDockerImage({ kind: 'inline', dockerfileText: DEFAULT_SANDBOX_DOCKERFILE })

    expect(fromFile).toBe(fromInline)
    expect(fromFile).toMatch(/^pippin-custom:[0-9a-f]{12}$/)
  })

  it('includes workspace init in the bootstrap command', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildLeashArgs(
      9111,
      9112,
      { sandbox: { init: 'bun install' } },
      [],
      [],
      {},
      false,
      false,
      new Map(),
      null,
      undefined,
      undefined,
    )

    expect(args.slice(-4, -1)).toEqual(['--', 'sh', '-c'])
    expect(args.at(-1)).toContain('bun install')
    expect(args.at(-1)).toContain('exec /leash/pippin-server')
  })

  it('omits workspace init from the bootstrap command when not configured', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildLeashArgs(
      9111,
      9112,
      {},
      [],
      [],
      {},
      false,
      false,
      new Map(),
      null,
      undefined,
      undefined,
    )

    expect(args.at(-1)).not.toContain('bun install')
    expect(args.at(-1)).toContain('exec /leash/pippin-server')
  })

  it('changes the config hash when workspace init changes', async () => {
    const { __test__ } = await import('./sandbox')

    const withoutInit = __test__.computeConfigHash(tmpDir, {}, defaultGlobalConfig())
    const withInit = __test__.computeConfigHash(tmpDir, { sandbox: { init: 'bun install' } }, defaultGlobalConfig())

    expect(withInit).not.toBe(withoutInit)
  })
})
