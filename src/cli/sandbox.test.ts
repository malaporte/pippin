import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ResolvedGlobalConfig } from './config'
import type { WorkspaceConfig } from '../shared/types'
import { DEFAULT_SANDBOX_DOCKERFILE } from './default-dockerfile'

const childProcessMocks = {
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}

const configMocks = {
  readGlobalConfig: vi.fn(),
  expandHome: vi.fn((value: string) => value),
}

const stateMocks = {
  validateState: vi.fn(),
  readState: vi.fn(),
  writeState: vi.fn(),
  removeState: vi.fn(),
  listStates: vi.fn(),
  allocatePort: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  writeLockPort: vi.fn(),
  isLockHeld: vi.fn(),
  isProcessAlive: vi.fn(),
  isServerHealthy: vi.fn(),
}

const policyMocks = {
  resolvePolicy: vi.fn(),
}

const toolMocks = {
  resolveToolRequirements: vi.fn(),
}

const leashMocks = {
  ensureLeash: vi.fn().mockResolvedValue('/usr/local/bin/leash'),
}

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('./config', () => configMocks)
vi.mock('./state', () => stateMocks)
vi.mock('./policy', () => policyMocks)
vi.mock('./tools', () => toolMocks)
vi.mock('./leash', () => leashMocks)
vi.mock('./spinner', () => ({
  Spinner: class {
    start(): void {}
    update(): void {}
    stop(): void {}
  },
}))

describe('sandbox image resolution', () => {
  let tmpDir: string
  let serverBinary: string

  beforeEach(() => {
    childProcessMocks.spawn.mockReset()
    childProcessMocks.spawnSync.mockReset()
    childProcessMocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    configMocks.readGlobalConfig.mockReset()
    configMocks.readGlobalConfig.mockReturnValue(defaultGlobalConfig())
    stateMocks.validateState.mockReset()
    stateMocks.readState.mockReset()
    stateMocks.writeState.mockReset()
    stateMocks.removeState.mockReset()
    stateMocks.listStates.mockReset()
    stateMocks.listStates.mockReturnValue([])
    stateMocks.allocatePort.mockReset()
    stateMocks.allocatePort.mockResolvedValue(9111)
    stateMocks.acquireLock.mockReset()
    stateMocks.acquireLock.mockReturnValue(true)
    stateMocks.releaseLock.mockReset()
    stateMocks.writeLockPort.mockReset()
    stateMocks.isLockHeld.mockReset()
    stateMocks.isProcessAlive.mockReset()
    stateMocks.isProcessAlive.mockReturnValue(false)
    stateMocks.isServerHealthy.mockReset()
    stateMocks.isServerHealthy.mockResolvedValue(true)
    policyMocks.resolvePolicy.mockReset()
    policyMocks.resolvePolicy.mockReturnValue(undefined)
    toolMocks.resolveToolRequirements.mockReset()
    toolMocks.resolveToolRequirements.mockReturnValue({
      dotfiles: [],
      environment: [],
      sshAgent: false,
      gpgAgent: false,
      hostPrepares: [],
      envResolvers: {},
      envMultiResolvers: [],
      warnings: [],
    })
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-sandbox-')))
    serverBinary = path.join(tmpDir, 'pippin-server-linux-arm64')
    fs.writeFileSync(serverBinary, 'test-server')
    process.env.PIPPIN_SERVER_BINARY = serverBinary
  })

  afterEach(() => {
    vi.useRealTimers()
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    delete process.env.PIPPIN_SERVER_BINARY
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

    const image = await __test__.resolveImage(tmpDir, workspaceConfig, defaultGlobalConfig())

    expect(image).toBe('custom/workspace:latest')
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled()
  })

  it('builds the bundled default image when no override is configured', async () => {
    const expectedHash = crypto.createHash('sha256').update(DEFAULT_SANDBOX_DOCKERFILE).digest('hex').slice(0, 12)

    // docker image inspect → not found
    childProcessMocks.spawn.mockImplementationOnce(() =>
      createSimpleProcess({ exitCode: 1 }))
    // docker build → success
    childProcessMocks.spawn.mockImplementationOnce(() =>
      createSimpleProcess({ exitCode: 0 }))

    const { __test__ } = await import('./sandbox')
    const image = await __test__.resolveImage(tmpDir, {}, defaultGlobalConfig())

    expect(image).toBe(`pippin-custom:${expectedHash}`)
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2)

    const inspectCall = childProcessMocks.spawn.mock.calls[0]
    expect(inspectCall[0]).toBe('docker')
    expect(inspectCall[1]).toEqual(['image', 'inspect', `pippin-custom:${expectedHash}`])

    const buildCall = childProcessMocks.spawn.mock.calls[1]
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

    // Each buildDockerImage call does: inspect (not found) + build (success) = 2 spawn calls
    childProcessMocks.spawn
      .mockImplementationOnce(() => createSimpleProcess({ exitCode: 0 }))  // inspect → found
      .mockImplementationOnce(() => createSimpleProcess({ exitCode: 0 }))  // inspect → found

    const { __test__ } = await import('./sandbox')
    const fromFile = await __test__.buildDockerImage({ kind: 'path', dockerfilePath })
    const fromInline = await __test__.buildDockerImage({ kind: 'inline', dockerfileText: DEFAULT_SANDBOX_DOCKERFILE })

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
    // Each computeConfigHash call triggers resolveImage → buildDockerImage
    // which does a docker image inspect via spawn
    childProcessMocks.spawn
      .mockImplementationOnce(() => createSimpleProcess({ exitCode: 0 }))  // inspect → found
      .mockImplementationOnce(() => createSimpleProcess({ exitCode: 0 }))  // inspect → found

    const { __test__ } = await import('./sandbox')

    const withoutInit = await __test__.computeConfigHash(tmpDir, {}, defaultGlobalConfig())
    const withInit = await __test__.computeConfigHash(tmpDir, { sandbox: { init: 'bun install' } }, defaultGlobalConfig())

    expect(withInit).not.toBe(withoutInit)
  })

  it('derives the workspace container name from the directory name with a path hash suffix', async () => {
    const { __test__ } = await import('./sandbox')

    // The container name is the normalized basename plus a short hash of the
    // full resolved path, so two workspaces with the same directory name but
    // different parent paths produce distinct container names.
    const hashOf = (p: string) => crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 8)

    expect(__test__.getWorkspaceContainerName('/tmp/Stale-sandbox')).toBe(`stale-sandbox-${hashOf('/tmp/Stale-sandbox')}`)
    expect(__test__.getWorkspaceContainerName('/tmp/Feature Branch')).toBe(`feature-branch-${hashOf('/tmp/Feature Branch')}`)

    // Different parent paths produce different names even with the same basename
    const nameA = __test__.getWorkspaceContainerName('/repos/alpha/my-project')
    const nameB = __test__.getWorkspaceContainerName('/repos/beta/my-project')
    expect(nameA).not.toBe(nameB)
    expect(nameA).toMatch(/^my-project-[0-9a-f]{8}$/)
    expect(nameB).toMatch(/^my-project-[0-9a-f]{8}$/)
  })

  it('removes a stale container matching the current workspace name', async () => {
    const workspacePath = '/tmp/Stale-sandbox'
    const expectedName = `stale-sandbox-${crypto.createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 8)}`

    childProcessMocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'container-id\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })

    const { __test__ } = await import('./sandbox')
    const removed = __test__.removeWorkspaceContainer(workspacePath)

    expect(removed).toBe(true)
    expect(childProcessMocks.spawnSync).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['ps', '-a', '-q', '--filter', `name=^/${expectedName}$`],
      expect.objectContaining({ timeout: 10_000 }),
    )
    expect(childProcessMocks.spawnSync).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', '-fv', 'container-id'],
      expect.objectContaining({ timeout: 10_000 }),
    )
  })

  it('retries sandbox startup once after a workspace container name conflict', async () => {
    const workspaceRoot = path.join(tmpDir, 'Stale-sandbox')
    fs.mkdirSync(workspaceRoot)

    const expectedName = `stale-sandbox-${crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 8)}`
    const conflict = `Error response from daemon: Conflict. The container name "/${expectedName}" is already in use by container "abc123".`
    stateMocks.isServerHealthy
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'ps' && args[4] === `name=^/${expectedName}$`) {
        return { status: 0, stdout: 'stale-id\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'rm') {
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    // spawn is called for: docker inspect (resolveImage), leash process,
    // docker inspect (retry resolveImage), leash process (retry),
    // docker inspect (computeConfigHash → resolveImage)
    childProcessMocks.spawn.mockImplementation(
      (command: string, args: string[]) => {
        if (command === 'docker') {
          return createSimpleProcess({ exitCode: 0 })
        }
        // First leash call fails with conflict, second succeeds
        if (!firstLeashCalled) {
          firstLeashCalled = true
          return createLeashProcess({ stderr: conflict, exitCode: 1, pid: 1111 })
        }
        return createLeashProcess({ pid: 2222 })
      },
    )
    let firstLeashCalled = false

    const { __test__ } = await import('./sandbox')
    await expect(__test__.startSandbox(workspaceRoot, {})).resolves.toBe(9111)

    // spawn is called for docker inspect (resolveImage) + leash process on
    // each attempt, plus a final docker inspect for computeConfigHash.
    // Verify the leash binary was spawned exactly twice (initial + retry).
    const leashSpawns = childProcessMocks.spawn.mock.calls.filter(
      (call: unknown[]) => call[0] !== 'docker',
    )
    expect(leashSpawns).toHaveLength(2)

    expect(stateMocks.writeState).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot,
      port: 9111,
      leashPid: 2222,
    }))
  })
})

function createLeashProcess(options: { stderr?: string; exitCode?: number; pid?: number }) {
  const stderr = new EventEmitter()
  const processEmitter = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    pid: number
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  }

  processEmitter.stderr = stderr
  processEmitter.pid = options.pid ?? 1234
  processEmitter.kill = vi.fn()
  processEmitter.unref = vi.fn()

  ;(stderr as EventEmitter & { removeAllListeners: typeof stderr.removeAllListeners; destroy: ReturnType<typeof vi.fn> }).destroy = vi.fn()

  if (options.stderr || options.exitCode !== undefined) {
    setTimeout(() => {
      if (options.stderr) {
        stderr.emit('data', Buffer.from(options.stderr))
      }
      if (options.exitCode !== undefined) {
        processEmitter.emit('exit', options.exitCode)
      }
    }, 0)
  }

  return processEmitter
}

/** Lightweight mock for spawnAsync's spawn calls (docker inspect / docker build) */
function createSimpleProcess(options: { exitCode?: number; stdout?: string; stderr?: string }) {
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const processEmitter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: ReturnType<typeof vi.fn>
  }

  processEmitter.stdout = stdoutEmitter
  processEmitter.stderr = stderrEmitter
  processEmitter.pid = 9999
  processEmitter.kill = vi.fn()

  setTimeout(() => {
    if (options.stdout) {
      stdoutEmitter.emit('data', Buffer.from(options.stdout))
    }
    if (options.stderr) {
      stderrEmitter.emit('data', Buffer.from(options.stderr))
    }
    processEmitter.emit('close', options.exitCode ?? 0)
  }, 0)

  return processEmitter
}
