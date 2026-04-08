import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('./config', () => configMocks)
vi.mock('./state', () => stateMocks)
vi.mock('./policy', () => ({ resolvePolicy: vi.fn() }))
vi.mock('./tools', () => ({
  resolveToolRequirements: vi.fn(() => ({
    dotfiles: [],
    environment: [],
    envResolvers: {},
    envMultiResolvers: [],
    hostPrepares: [],
    sshAgent: false,
    gpgAgent: false,
    warnings: [],
    containerEnvironment: {},
  })),
  resolvePnpmStorePath: vi.fn(),
}))
vi.mock('./leash', () => ({ ensureLeash: vi.fn().mockResolvedValue('/usr/local/bin/leash') }))
vi.mock('./spinner', () => ({ Spinner: class { start() {} update() {} stop() {} } }))

describe('sandbox helpers', () => {
  beforeEach(() => {
    configMocks.readGlobalConfig.mockReturnValue({
      portRangeStart: 9111,
      sandboxes: {},
    })
  })

  it('builds stable container names from sandbox names', async () => {
    const { __test__ } = await import('./sandbox')
    expect(__test__.getSandboxContainerName('default')).toBe('default')
    expect(__test__.getSandboxContainerName('My Work')).toBe('my-work')
  })

  it('detects port conflicts', async () => {
    const { __test__ } = await import('./sandbox')
    expect(__test__.isPortInUseError('port 9111 is already in use')).toBe(true)
  })

  it('starts redis in bootstrap for the bundled default image', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildLeashArgs(
      9111,
      9112,
      { root: '/workspace/project' },
      [],
      [],
      {},
      false,
      false,
      new Map(),
      [],
      undefined,
      true,
    )

    expect(args.at(-1)).toContain('redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir /tmp --pidfile /tmp/redis-server.pid --logfile /tmp/redis-server.log')
  })

  it('does not start redis in bootstrap for a custom image', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildLeashArgs(
      9111,
      9112,
      { root: '/workspace/project', image: 'custom:latest' },
      [],
      [],
      {},
      false,
      false,
      new Map(),
      [],
      undefined,
      false,
      'custom:latest',
    )

    expect(args.at(-1)).not.toContain('redis-server --daemonize yes')
  })

  it('does not start redis in bootstrap for a custom dockerfile', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildLeashArgs(
      9111,
      9112,
      { root: '/workspace/project', dockerfile: './Dockerfile.pippin' },
      [],
      [],
      {},
      false,
      false,
      new Map(),
      [],
      undefined,
      false,
      'pippin-custom:abcd1234',
    )

    expect(args.at(-1)).not.toContain('redis-server --daemonize yes')
  })
})
