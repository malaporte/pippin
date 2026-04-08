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
  isServerHealthy: vi.fn(),
}

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('./config', () => configMocks)
vi.mock('./state', () => stateMocks)
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

  it('starts localhost proxies for configured host port forwards', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildDockerRunArgs(
      9111,
      'default',
      '/workspace/project',
      {
        root: '/workspace/project',
        host_port_forwards: [
          { host_port: 6379 },
          { host_port: 3306, sandbox_port: 13306 },
        ],
      },
      '/tmp/pippin-share',
      [],
      [],
      {},
      false,
      false,
      new Map(),
      [],
      undefined,
      undefined,
      {},
      900,
    )

    expect(args.at(-1)).toContain('command -v socat >/dev/null 2>&1')
    expect(args.at(-1)).toContain('socat TCP-LISTEN:6379,bind=127.0.0.1,reuseaddr,fork TCP:host.docker.internal:6379 &')
    expect(args.at(-1)).toContain('socat TCP-LISTEN:13306,bind=127.0.0.1,reuseaddr,fork TCP:host.docker.internal:3306 &')
  })

  it('does not add localhost proxies when host port forwards are absent', async () => {
    const { __test__ } = await import('./sandbox')
    const args = __test__.buildDockerRunArgs(
      9111,
      'default',
      '/workspace/project',
      { root: '/workspace/project', image: 'custom:latest' },
      '/tmp/pippin-share',
      [],
      [],
      {},
      false,
      false,
      new Map(),
      [],
      undefined,
      'custom:latest',
      {},
      900,
    )

    expect(args.at(-1)).not.toContain('command -v socat >/dev/null 2>&1')
    expect(args.at(-1)).not.toContain('host.docker.internal')
  })
})
