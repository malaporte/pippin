import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { SandboxState } from '../shared/types'

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'pippin', 'sandboxes')

/** Derive a deterministic short hash from a workspace root path */
export function workspaceHash(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)
}

function stateFilePath(workspaceRoot: string): string {
  return path.join(STATE_DIR, `${workspaceHash(workspaceRoot)}.json`)
}

function lockFilePath(workspaceRoot: string): string {
  return path.join(STATE_DIR, `${workspaceHash(workspaceRoot)}.lock`)
}

/** Ensure the state directory exists */
export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
}

/** Read the sandbox state for a workspace, or null if not tracked */
export function readState(workspaceRoot: string): SandboxState | null {
  try {
    const text = fs.readFileSync(stateFilePath(workspaceRoot), 'utf-8')
    const parsed = JSON.parse(text) as SandboxState
    if (parsed.workspaceRoot && parsed.port && parsed.leashPid) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Write sandbox state for a workspace */
export function writeState(state: SandboxState): void {
  ensureStateDir()
  fs.writeFileSync(stateFilePath(state.workspaceRoot), JSON.stringify(state, null, 2) + '\n')
}

/** Remove sandbox state for a workspace */
export function removeState(workspaceRoot: string): void {
  try {
    fs.unlinkSync(stateFilePath(workspaceRoot))
  } catch {
    // Already gone
  }
  releaseLock(workspaceRoot)
}

/** List all tracked sandbox states */
export function listStates(): SandboxState[] {
  try {
    const files = fs.readdirSync(STATE_DIR)
    const states: SandboxState[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const text = fs.readFileSync(path.join(STATE_DIR, file), 'utf-8')
        const parsed = JSON.parse(text) as SandboxState
        if (parsed.workspaceRoot && parsed.port && parsed.leashPid) {
          states.push(parsed)
        }
      } catch {
        // Corrupt state file; skip
      }
    }
    return states
  } catch {
    return []
  }
}

/** Check if a process with the given PID is alive */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Check if the pippin-server at the given port is healthy */
export async function isServerHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const body = await res.json() as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

/**
 * Validate a sandbox state: check that the process is alive and the
 * server is healthy. Removes stale state files automatically.
 */
export async function validateState(workspaceRoot: string): Promise<SandboxState | null> {
  const state = readState(workspaceRoot)
  if (!state) return null

  if (!isProcessAlive(state.leashPid)) {
    removeState(workspaceRoot)
    return null
  }

  const healthy = await isServerHealthy(state.port)
  if (!healthy) {
    removeState(workspaceRoot)
    return null
  }

  return state
}

/**
 * Acquire an exclusive lock for a workspace to prevent concurrent
 * sandbox starts. Returns true if the lock was acquired.
 */
export function acquireLock(workspaceRoot: string): boolean {
  ensureStateDir()
  try {
    const fd = fs.openSync(lockFilePath(workspaceRoot), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    // Lock file already exists — check if the holder is still alive
    try {
      const pid = parseInt(fs.readFileSync(lockFilePath(workspaceRoot), 'utf-8').trim(), 10)
      if (!isNaN(pid) && isProcessAlive(pid)) {
        return false
      }
      // Stale lock — remove and retry
      fs.unlinkSync(lockFilePath(workspaceRoot))
      return acquireLock(workspaceRoot)
    } catch {
      return false
    }
  }
}

/** Release the lock for a workspace */
export function releaseLock(workspaceRoot: string): void {
  try {
    fs.unlinkSync(lockFilePath(workspaceRoot))
  } catch {
    // Already gone
  }
}

/**
 * Allocate the next available port starting from portRangeStart,
 * skipping ports already in use by tracked sandboxes.
 */
export function allocatePort(portRangeStart: number): number {
  const usedPorts = new Set(listStates().map((s) => s.port))
  let port = portRangeStart
  while (usedPorts.has(port)) {
    port++
  }
  return port
}
