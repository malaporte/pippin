import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execCommand: vi.fn(),
  checkForUpdate: vi.fn(),
}))

vi.mock('./commands/exec', () => ({
  execCommand: mocks.execCommand,
}))

vi.mock('./update-check', () => ({
  checkForUpdate: mocks.checkForUpdate,
}))

vi.mock('./commands/init', () => ({ initCommand: vi.fn() }))
vi.mock('./commands/monitor', () => ({ monitorCommand: vi.fn() }))
vi.mock('./commands/policy', () => ({ policyCommand: vi.fn() }))
vi.mock('./commands/shell', () => ({ shellCommand: vi.fn() }))
vi.mock('./commands/status', () => ({ statusCommand: vi.fn() }))
vi.mock('./commands/restart', () => ({ restartCommand: vi.fn() }))
vi.mock('./commands/stop', () => ({ stopCommand: vi.fn() }))
vi.mock('./commands/update', () => ({ updateCommand: vi.fn() }))
vi.mock('./commands/doctor', () => ({ doctorCommand: vi.fn() }))

async function runCli(argv: string[]) {
  vi.resetModules()
  mocks.execCommand.mockReset()
  mocks.checkForUpdate.mockResolvedValue(null)

  const original = process.argv
  const originalExit = process.exit

  process.argv = ['node', 'pippin', ...argv]

  let exitCode: number | undefined
  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`process.exit(${exitCode})`)
  }) as typeof process.exit

  try {
    await import(/* @vite-ignore */ './index.ts?' + argv.join('_'))
  } catch (e) {
    // swallow process.exit throws
    if (!(e instanceof Error) || !e.message.startsWith('process.exit')) throw e
  } finally {
    process.argv = original
    process.exit = originalExit
  }

  return { exitCode }
}

describe('pippin -c routing', () => {
  it('routes -c <cmd> to execCommand', async () => {
    await runCli(['-c', 'git fetch origin'])
    expect(mocks.execCommand).toHaveBeenCalledWith('git fetch origin')
  })

  it('routes -c with compound command', async () => {
    await runCli(['-c', 'git fetch origin && git rebase origin/main'])
    expect(mocks.execCommand).toHaveBeenCalledWith('git fetch origin && git rebase origin/main')
  })

  it('exits with error when -c has no argument', async () => {
    const { exitCode } = await runCli(['-c'])
    expect(exitCode).toBe(1)
    expect(mocks.execCommand).not.toHaveBeenCalled()
  })
})

describe('pippin unknown command', () => {
  it('exits with error for unknown subcommand', async () => {
    const { exitCode } = await runCli(['notacommand'])
    expect(exitCode).toBe(1)
    expect(mocks.execCommand).not.toHaveBeenCalled()
  })
})
