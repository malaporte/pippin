import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import getPort from 'get-port'
import type { SandboxState } from '../shared/types'

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'pippin', 'sandboxes')

/** Derive a deterministic short hash from a sandbox name */
export function sandboxHash(sandboxName: string): string {
  return crypto.createHash('sha256').update(sandboxName).digest('hex').slice(0, 16)
}

function stateFilePath(sandboxName: string): string {
  return path.join(STATE_DIR, `${sandboxHash(sandboxName)}.json`)
}

function lockFilePath(sandboxName: string): string {
  return path.join(STATE_DIR, `${sandboxHash(sandboxName)}.lock`)
}

/** Ensure the state directory exists */
export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
}

/** Read the sandbox state for a named sandbox, or null if not tracked */
export function readState(sandboxName: string): SandboxState | null {
  try {
    const text = fs.readFileSync(stateFilePath(sandboxName), 'utf-8')
    const parsed = JSON.parse(text) as SandboxState
    if (parsed.sandboxName && parsed.workspaceRoot && parsed.port && parsed.leashPid) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Write sandbox state for a named sandbox (atomic via temp file + rename) */
export function writeState(state: SandboxState): void {
  ensureStateDir()
  const target = stateFilePath(state.sandboxName)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, target)
}

/** Remove sandbox state for a named sandbox */
export function removeState(sandboxName: string): void {
  try {
    fs.unlinkSync(stateFilePath(sandboxName))
  } catch {
    // Already gone
  }
  releaseLock(sandboxName)
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
        if (parsed.sandboxName && parsed.workspaceRoot && parsed.port && parsed.leashPid) {
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
export async function validateState(sandboxName: string): Promise<SandboxState | null> {
  const state = readState(sandboxName)
  if (!state) return null

  if (!isProcessAlive(state.leashPid)) {
    removeState(sandboxName)
    return null
  }

  const healthy = await isServerHealthy(state.port)
  if (!healthy) {
    removeState(sandboxName)
    return null
  }

  return state
}

/**
 * Acquire an exclusive lock for a sandbox to prevent concurrent
 * sandbox starts. Returns true if the lock was acquired.
 */
export function acquireLock(sandboxName: string): boolean {
  ensureStateDir()
  try {
    const fd = fs.openSync(lockFilePath(sandboxName), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    // Lock file already exists — check if the holder is still alive
    try {
      const content = fs.readFileSync(lockFilePath(sandboxName), 'utf-8').trim()
      const pid = parseInt(content.split(':')[0], 10)
      if (!isNaN(pid) && isProcessAlive(pid)) {
        return false
      }
      // Stale lock — remove and retry
      fs.unlinkSync(lockFilePath(sandboxName))
      return acquireLock(sandboxName)
    } catch {
      return false
    }
  }
}

/**
 * Write the allocated port into the lock file so that concurrent starts
 * for other sandboxes can see which ports are in-flight.
 * Must be called while the lock is held.
 */
export function writeLockPort(sandboxName: string, port: number): void {
  try {
    fs.writeFileSync(lockFilePath(sandboxName), `${process.pid}:${port}`)
  } catch {
    // Best-effort — the lock file may have been removed
  }
}

/** Check if the lock for a sandbox is currently held by a live process */
export function isLockHeld(sandboxName: string): boolean {
  try {
    const content = fs.readFileSync(lockFilePath(sandboxName), 'utf-8').trim()
    const pid = parseInt(content.split(':')[0], 10)
    return !isNaN(pid) && isProcessAlive(pid)
  } catch {
    return false
  }
}

/** Release the lock for a sandbox */
export function releaseLock(sandboxName: string): void {
  try {
    fs.unlinkSync(lockFilePath(sandboxName))
  } catch {
    // Already gone
  }
}

/**
 * Collect ports reserved by pippin (tracked sandboxes + in-flight lock files).
 * Returns a Set containing both the primary port and its control port (port+1)
 * for each reservation, so that neither slot can be reused.
 */
function reservedPorts(): Set<number> {
  const used = new Set<number>()

  for (const s of listStates()) {
    used.add(s.port)
    used.add(s.port + 1)
  }

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
            used.add(port)
            used.add(port + 1)
          }
        }
      } catch {
        // Lock file may have been removed; skip
      }
    }
  } catch {
    // STATE_DIR may not exist yet; ignore
  }

  return used
}

/**
 * Allocate the next available port starting from portRangeStart,
 * skipping ports already in use by tracked sandboxes, ports reserved
 * by in-flight sandbox starts (recorded in lock files), and ports
 * that are actually bound on the host OS.
 *
 * Both the primary port and the control port (port+1) are verified
 * to be free before returning.
 */
export async function allocatePort(portRangeStart: number): Promise<number> {
  const excluded = reservedPorts()

  let candidate = portRangeStart
  while (candidate < portRangeStart + 1000) {
    if (excluded.has(candidate) || excluded.has(candidate + 1)) {
      candidate++
      continue
    }

    // Verify both the primary port and control port are actually free on the host
    const primary = await getPort({ port: candidate, host: '127.0.0.1' })
    if (primary !== candidate) {
      candidate++
      continue
    }

    const control = await getPort({ port: candidate + 1, host: '127.0.0.1' })
    if (control !== candidate + 1) {
      candidate++
      continue
    }

    return candidate
  }

  // Fallback: let get-port pick any available port
  return getPort({ host: '127.0.0.1' })
}
