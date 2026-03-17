import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// We need to mock the STATE_DIR to use a temp directory for tests.
// Rather than mocking, we test the pure functions that don't depend on STATE_DIR.

import { workspaceHash, allocatePort, isProcessAlive } from './state'

describe('workspaceHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = workspaceHash('/Users/martin/Developer')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns the same hash for the same path', () => {
    const a = workspaceHash('/Users/martin/Developer')
    const b = workspaceHash('/Users/martin/Developer')
    expect(a).toBe(b)
  })

  it('returns different hashes for different paths', () => {
    const a = workspaceHash('/Users/martin/Developer')
    const b = workspaceHash('/Users/martin/Work')
    expect(a).not.toBe(b)
  })
})

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for a nonexistent PID', () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessAlive(99999999)).toBe(false)
  })
})

describe('allocatePort', () => {
  // allocatePort reads state files from disk — tested indirectly.
  // With no state files, it should return the start port.
  it('returns the start port when no sandboxes are tracked', () => {
    // This relies on no state files existing in the test environment.
    // In a real test suite you'd mock listStates — for now this is a
    // sanity check that it returns a valid number.
    const port = allocatePort(9111)
    expect(port).toBeGreaterThanOrEqual(9111)
  })
})

// ---------------------------------------------------------------------------
// Tests that require a temporary STATE_DIR
// ---------------------------------------------------------------------------

describe('state file operations (isolated)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-state-')))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Each test gets a fresh module import so STATE_DIR re-evaluates against the mocked homedir.
  // We append a unique query string so Vite doesn't cache the previous import.
  async function loadState() {
    const v = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return import(/* @vite-ignore */ `./state.ts?v=${v}`)
  }

  it('writeState creates a JSON file and readState returns the state', async () => {
    const { writeState, readState } = await loadState()
    const state = {
      workspaceRoot: '/project/foo',
      port: 9200,
      leashPid: process.pid,
      startedAt: new Date().toISOString(),
    }

    writeState(state)
    const result = readState('/project/foo')
    expect(result).not.toBeNull()
    expect(result!.workspaceRoot).toBe('/project/foo')
    expect(result!.port).toBe(9200)
    expect(result!.leashPid).toBe(process.pid)
  })

  it('readState returns null when no file exists', async () => {
    const { readState } = await loadState()
    expect(readState('/does/not/exist')).toBeNull()
  })

  it('removeState deletes the state file', async () => {
    const { writeState, readState, removeState } = await loadState()
    const state = {
      workspaceRoot: '/project/bar',
      port: 9201,
      leashPid: process.pid,
      startedAt: new Date().toISOString(),
    }

    writeState(state)
    expect(readState('/project/bar')).not.toBeNull()

    removeState('/project/bar')
    expect(readState('/project/bar')).toBeNull()
  })

  it('removeState is a no-op when no file exists', async () => {
    const { removeState } = await loadState()
    // Should not throw
    expect(() => removeState('/not/tracked')).not.toThrow()
  })

  it('listStates returns all written states', async () => {
    const { writeState, listStates } = await loadState()
    writeState({ workspaceRoot: '/a', port: 9300, leashPid: process.pid, startedAt: new Date().toISOString() })
    writeState({ workspaceRoot: '/b', port: 9301, leashPid: process.pid, startedAt: new Date().toISOString() })

    const states = listStates()
    const roots = states.map((s: { workspaceRoot: string }) => s.workspaceRoot)
    expect(roots).toContain('/a')
    expect(roots).toContain('/b')
  })

  it('listStates skips corrupt JSON files', async () => {
    const { ensureStateDir, listStates, workspaceHash: wh } = await loadState()
    ensureStateDir()
    const stateDir = path.join(tmpDir, '.local', 'state', 'pippin', 'sandboxes')
    fs.writeFileSync(path.join(stateDir, 'corrupt.json'), 'not-json{{')

    const states = listStates()
    // The corrupt file should be silently skipped
    expect(Array.isArray(states)).toBe(true)
  })

  it('listStates returns [] when state directory does not exist', async () => {
    const { listStates } = await loadState()
    // tmpDir exists but STATE_DIR subpath does not yet
    expect(listStates()).toEqual([])
  })

  it('allocatePort skips ports in use by tracked sandboxes', async () => {
    const { writeState, allocatePort: ap } = await loadState()
    writeState({ workspaceRoot: '/p1', port: 9400, leashPid: process.pid, startedAt: new Date().toISOString() })
    writeState({ workspaceRoot: '/p2', port: 9401, leashPid: process.pid, startedAt: new Date().toISOString() })

    const port = ap(9400)
    expect(port).toBe(9402)
  })
})

// ---------------------------------------------------------------------------
// Lock file tests
// ---------------------------------------------------------------------------

describe('lock file operations (isolated)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-lock-')))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function loadState() {
    const v = Date.now()
    return import(/* @vite-ignore */ `./state.ts?v=${v}`)
  }

  it('acquireLock returns true the first time', async () => {
    const { acquireLock } = await loadState()
    expect(acquireLock('/workspace/proj')).toBe(true)
  })

  it('acquireLock returns false when lock is already held by a live process', async () => {
    const { acquireLock } = await loadState()
    expect(acquireLock('/workspace/proj')).toBe(true)
    // Same module instance → same state dir → lock file present → current PID is alive
    expect(acquireLock('/workspace/proj')).toBe(false)
  })

  it('releaseLock removes the lock so it can be re-acquired', async () => {
    const { acquireLock, releaseLock } = await loadState()
    expect(acquireLock('/workspace/proj')).toBe(true)
    releaseLock('/workspace/proj')
    expect(acquireLock('/workspace/proj')).toBe(true)
  })

  it('releaseLock is a no-op when no lock exists', async () => {
    const { releaseLock } = await loadState()
    expect(() => releaseLock('/no/lock/here')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// isServerHealthy
// ---------------------------------------------------------------------------

describe('isServerHealthy', () => {
  it('returns false for a port where nothing is listening', async () => {
    const { isServerHealthy } = await import('./state')
    // Port 1 is reserved and will always fail to connect
    const result = await isServerHealthy(1)
    expect(result).toBe(false)
  })
})
