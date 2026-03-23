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

/** Write sandbox state for a workspace (atomic via temp file + rename) */
export function writeState(state: SandboxState): void {
  ensureStateDir()
  const target = stateFilePath(state.workspaceRoot)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, target)
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
      const content = fs.readFileSync(lockFilePath(workspaceRoot), 'utf-8').trim()
      const pid = parseInt(content.split(':')[0], 10)
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

/**
 * Write the allocated port into the lock file so that concurrent starts
 * for other workspaces can see which ports are in-flight.
 * Must be called while the lock is held.
 */
export function writeLockPort(workspaceRoot: string, port: number): void {
  try {
    fs.writeFileSync(lockFilePath(workspaceRoot), `${process.pid}:${port}`)
  } catch {
    // Best-effort — the lock file may have been removed
  }
}

/** Check if the lock for a workspace is currently held by a live process */
export function isLockHeld(workspaceRoot: string): boolean {
  try {
    const content = fs.readFileSync(lockFilePath(workspaceRoot), 'utf-8').trim()
    const pid = parseInt(content.split(':')[0], 10)
    return !isNaN(pid) && isProcessAlive(pid)
  } catch {
    return false
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
 * skipping ports already in use by tracked sandboxes and ports
 * reserved by in-flight sandbox starts (recorded in lock files).
 */
export function allocatePort(portRangeStart: number): number {
  const usedPorts = new Set(listStates().map((s) => s.port))

  // Also check lock files for ports reserved by in-flight starts
  try {
    const files = fs.readdirSync(STATE_DIR)
    for (const file of files) {
      if (!file.endsWith('.lock')) continue
      try {
        const content = fs.readFileSync(path.join(STATE_DIR, file), 'utf-8').trim()
        const parts = content.split(':')
        if (parts.length >= 2) {
          const port = parseInt(parts[1], 10)
          if (!isNaN(port)) {
            usedPorts.add(port)
          }
        }
      } catch {
        // Lock file may have been removed; skip
      }
    }
  } catch {
    // STATE_DIR may not exist yet; ignore
  }

  let port = portRangeStart
  while (usedPorts.has(port)) {
    port++
  }
  return port
}
