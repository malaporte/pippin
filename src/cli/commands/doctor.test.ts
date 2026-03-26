import { describe, expect, it, vi } from 'vitest'

vi.mock('../leash', () => ({
  findLeash: () => '/usr/local/bin/leash',
  getLeashVersion: () => '1.0.0',
}))

vi.mock('../config', () => ({
  readGlobalConfig: () => ({ tools: [], dotfiles: [], environment: [], sshAgent: false }),
  expandHome: (value: string) => value,
}))

vi.mock('../workspace', () => ({
  findWorkspace: () => null,
  resolveWorkspace: () => ({ root: '/workspace/project', config: {} }),
}))

vi.mock('../sandbox', () => ({
  resolveGpgSocketInfo: () => null,
  resolveInstallPlan: () => ({ source: 'none', fingerprintParts: [] }),
  resolveServerBinary: () => '/tmp/pippin-server-linux-arm64',
}))

vi.mock('../policy', () => ({
  resolvePolicy: () => undefined,
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

let doctorTestModule: typeof import('./doctor')

async function loadDoctor() {
  if (!doctorTestModule) {
    // @ts-expect-error test-only query suffix avoids other files' module mocks
    doctorTestModule = await import(/* @vite-ignore */ './doctor.ts?doctor-test') as typeof import('./doctor')
  }
  return doctorTestModule
}

describe('doctor auto-install reporting', () => {
  it('reports detected auto-install commands', async () => {
    const { __test__ } = await loadDoctor()

    expect(__test__.describeAutoInstallPlan({
      source: 'detected',
      command: 'pnpm install',
      tool: 'pnpm',
      fingerprintParts: [],
    })).toEqual({
      ok: true,
      label: 'Auto-install',
      detail: 'detected pnpm: pnpm install',
    })
  })

  it('reports auto-install warnings as failures', async () => {
    const { __test__ } = await loadDoctor()

    expect(__test__.describeAutoInstallPlan({
      source: 'none',
      warning: 'found conflicting lockfiles in /workspace/project; skipping sandbox auto-install',
      fingerprintParts: [],
    })).toEqual({
      ok: false,
      label: 'Auto-install',
      detail: 'found conflicting lockfiles in /workspace/project; skipping sandbox auto-install',
    })
  })

  it('reports disabled auto-install', async () => {
    const { __test__ } = await loadDoctor()

    expect(__test__.describeAutoInstallPlan({
      source: 'disabled',
      fingerprintParts: [],
    })).toEqual({
      ok: true,
      label: 'Auto-install',
      detail: 'disabled by workspace config',
    })
  })
})
