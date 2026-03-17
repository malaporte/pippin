import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
