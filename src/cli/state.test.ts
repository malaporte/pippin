import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('state helpers', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-state-')))
    vi.stubEnv('HOME', tmpDir)
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('hashes sandbox names deterministically', async () => {
    const { sandboxHash } = await import('./state')
    expect(sandboxHash('default')).toBe(sandboxHash('default'))
    expect(sandboxHash('default')).not.toBe(sandboxHash('work'))
  })

  it('writes and reads sandbox state', async () => {
    const { writeState, readState } = await import('./state')
    writeState({ sandboxName: 'default', workspaceRoot: '/project/foo', port: 9300, leashPid: process.pid, startedAt: new Date().toISOString() })
    const state = readState('default')
    expect(state?.sandboxName).toBe('default')
    expect(state?.workspaceRoot).toBe('/project/foo')
  })
})
