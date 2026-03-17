import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { readGlobalConfig, expandHome } from './config'
import {
  validateState,
  readState,
  writeState,
  removeState,
  listStates,
  allocatePort,
  acquireLock,
  releaseLock,
  isProcessAlive,
  isServerHealthy,
} from './state'
import { Spinner } from './spinner'
import type { WorkspaceConfig, MountEntry, SandboxState } from '../shared/types'

const LEASH_CODER_IMAGE = 'public.ecr.aws/s5i7k8t3/strongdm/coder'
const LEASH_IMAGE = 'public.ecr.aws/s5i7k8t3/strongdm/leash'
const HEALTH_MAX_ATTEMPTS = 60
const HEALTH_INTERVAL_MS = 1000

/**
 * Ensure a sandbox is running for the given workspace. Starts one if needed.
 * Returns the port number for connecting to the pippin-server.
 */
export async function ensureSandbox(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
): Promise<number> {
  // Check if already running
  const existing = await validateState(workspaceRoot)
  if (existing) return existing.port

  // Acquire lock to prevent concurrent starts
  if (!acquireLock(workspaceRoot)) {
    // Another process is starting — wait for it
    return waitForSandbox(workspaceRoot)
  }

  try {
    return await startSandbox(workspaceRoot, workspaceConfig)
  } finally {
    releaseLock(workspaceRoot)
  }
}

/** Start a new sandbox container for the given workspace */
async function startSandbox(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
): Promise<number> {
  const globalConfig = readGlobalConfig()

  // Clean up any stale containers from a previous run
  removeContainers()

  const port = allocatePort(globalConfig.portRangeStart)
  const controlPort = port + 1
  const idleTimeout = workspaceConfig.sandbox?.idle_timeout ?? globalConfig.idleTimeout

  // Prepare the share directory with the pippin-server binary
  const shareDir = prepareShareDir(workspaceRoot)

  // Build the leash command
  const args = buildLeashArgs(port, controlPort, workspaceConfig, globalConfig.dotfiles)

  // Resolve the user's shell environment before starting the spinner — the
  // login shell spawn must not happen while we hold the TTY in spinner mode.
  const shellEnv = getShellEnv()

  const spinner = new Spinner(`starting sandbox for ${workspaceRoot}`)
  spinner.start()

  const leashProcess = spawn('leash', args, {
    cwd: workspaceRoot,
    env: {
      ...shellEnv,
      LEASH_SHARE_DIR: shareDir,
      PIPPIN_IDLE_TIMEOUT: String(idleTimeout),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  // Drain stderr to prevent pipe buffer deadlock
  const stderrChunks: Buffer[] = []
  leashProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  // Monitor for unexpected exit during startup
  let unexpectedExit = false
  leashProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      unexpectedExit = true
    }
  })

  // Health-check loop
  let healthy = false
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt++) {
    if (unexpectedExit) break

    spinner.update(`starting sandbox (${attempt + 1}s)`)

    await sleep(HEALTH_INTERVAL_MS)

    if (await isServerHealthy(port)) {
      healthy = true
      break
    }
  }

  spinner.stop()

  if (!healthy) {
    // Kill leash if it's still running
    try { leashProcess.kill('SIGTERM') } catch { /* already gone */ }

    const stderr = Buffer.concat(stderrChunks).toString()
    process.stderr.write(`pippin: sandbox failed to start\n`)
    if (stderr.trim()) {
      process.stderr.write(stderr)
    }
    process.exit(1)
  }

  // Write state
  const state: SandboxState = {
    workspaceRoot,
    port,
    controlPort,
    leashPid: leashProcess.pid!,
    startedAt: new Date().toISOString(),
  }
  writeState(state)

  return port
}

/** Wait for another process to finish starting the sandbox, then return the port */
async function waitForSandbox(workspaceRoot: string): Promise<number> {
  const spinner = new Spinner('waiting for sandbox')
  spinner.start()

  for (let i = 0; i < HEALTH_MAX_ATTEMPTS; i++) {
    spinner.update(`waiting for sandbox (${i + 1}s)`)
    await sleep(HEALTH_INTERVAL_MS)

    const state = await validateState(workspaceRoot)
    if (state) {
      spinner.stop()
      return state.port
    }
  }

  spinner.stop()
  process.stderr.write('pippin: timed out waiting for sandbox to start\n')
  process.exit(1)
}

/** Stop the sandbox for a specific workspace */
export async function stopSandbox(workspaceRoot: string): Promise<void> {
  const state = readState(workspaceRoot)
  if (!state) return

  const spinner = new Spinner(`stopping sandbox for ${workspaceRoot}`)
  spinner.start()

  if (isProcessAlive(state.leashPid)) {
    try { process.kill(state.leashPid, 'SIGTERM') } catch { /* already gone */ }

    // Wait up to 10 seconds for graceful exit
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && isProcessAlive(state.leashPid)) {
      await sleep(200)
    }

    // Force kill if still alive
    if (isProcessAlive(state.leashPid)) {
      try { process.kill(state.leashPid, 'SIGKILL') } catch { /* already gone */ }
    }
  }

  removeContainers()
  removeState(workspaceRoot)
  spinner.stop()
}

/** Stop all tracked sandboxes */
export async function stopAllSandboxes(): Promise<void> {
  const states = listStates()
  for (const state of states) {
    await stopSandbox(state.workspaceRoot)
  }
}

/** Build the leash CLI arguments */
function buildLeashArgs(
  port: number,
  controlPort: number,
  workspaceConfig: WorkspaceConfig,
  dotfiles: { path: string; readonly?: boolean }[],
): string[] {
  const args: string[] = [
    '-p', `${port}:${port}`,
    '-l', `:${controlPort}`,
    '-I',
  ]

  // Add dotfile mounts from global config
  for (const dotfile of dotfiles) {
    const expanded = expandHome(dotfile.path)
    if (!fs.existsSync(expanded)) continue
    const mountSpec = dotfile.readonly
      ? `${expanded}:${expanded}:ro`
      : `${expanded}:${expanded}`
    args.push('-v', mountSpec)
  }

  // Add extra mounts from workspace config
  const extraMounts = workspaceConfig.sandbox?.mounts ?? []
  for (const mount of extraMounts) {
    const expanded = expandHome(mount.path)
    if (!fs.existsSync(expanded)) continue
    const mountSpec = mount.readonly
      ? `${expanded}:${expanded}:ro`
      : `${expanded}:${expanded}`
    args.push('-v', mountSpec)
  }

  // Set the pippin-server port and idle timeout via env
  args.push('-e', `PIPPIN_PORT=${port}`)

  // The command to run inside the container
  args.push('--', '/leash/pippin-server')

  return args
}

/**
 * Prepare the share directory for a workspace sandbox.
 * Copies the pippin-server binary into the share dir so leash mounts it
 * into the container at /leash/.
 */
function prepareShareDir(workspaceRoot: string): string {
  const shareDir = path.join(
    os.homedir(),
    '.local',
    'state',
    'pippin',
    'share',
    workspaceRoot.replace(/\//g, '_').replace(/^_/, ''),
  )

  fs.mkdirSync(shareDir, { recursive: true })

  // Clean up stale leash files that may remain from a previous run
  try {
    for (const file of fs.readdirSync(shareDir)) {
      if (file === 'pippin-server') continue
      try { fs.unlinkSync(path.join(shareDir, file)) } catch { /* best effort */ }
    }
  } catch { /* empty dir or no access */ }

  // Resolve the pippin-server binary path
  const serverBinary = resolveServerBinary()
  if (!serverBinary) {
    process.stderr.write('pippin: could not find pippin-server binary\n')
    process.stderr.write('pippin: run `bun run build:server` to compile it\n')
    process.exit(1)
  }

  const dest = path.join(shareDir, 'pippin-server')
  // Skip copy if file is identical (same size)
  try {
    const srcStat = fs.statSync(serverBinary)
    const dstStat = fs.statSync(dest)
    if (srcStat.size === dstStat.size) return shareDir
  } catch {
    // Destination doesn't exist — proceed with copy
  }

  fs.copyFileSync(serverBinary, dest)
  fs.chmodSync(dest, 0o755)

  return shareDir
}

/** Find the pippin-server binary for the current container architecture */
function resolveServerBinary(): string | null {
  // Allow explicit override via environment variable
  const envPath = process.env.PIPPIN_SERVER_BINARY
  if (envPath) {
    try {
      const resolved = path.resolve(envPath)
      fs.accessSync(resolved, fs.constants.R_OK)
      return resolved
    } catch {
      return null
    }
  }

  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const binaryName = `pippin-server-linux-${arch}`

  // Walk up from this source file to find the project root's dist/ directory.
  // From src/cli/sandbox.ts: ../../dist
  // From a compiled binary the executable itself sits in dist/, so: ./
  const candidates = [
    path.join(import.meta.dirname, '..', '..', 'dist', binaryName),
    path.join(import.meta.dirname, binaryName),
  ]

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate)
      fs.accessSync(resolved, fs.constants.R_OK)
      return resolved
    } catch {
      // Not found here; try next
    }
  }

  return null
}

/** Remove stale Docker containers from leash images */
function removeContainers(): void {
  const images = [LEASH_CODER_IMAGE, LEASH_IMAGE]

  for (const image of images) {
    try {
      const result = spawnSync('docker', ['ps', '-a', '-q', '--filter', `ancestor=${image}`], {
        encoding: 'utf-8',
        timeout: 10_000,
      })

      const ids = (result.stdout || '').trim().split('\n').filter(Boolean)
      if (ids.length > 0) {
        spawnSync('docker', ['rm', '-fv', ...ids], { timeout: 10_000 })
      }
    } catch {
      // Docker may not be available; ignore
    }
  }
}

/** Resolve the user's login shell environment */
function getShellEnv(): Record<string, string> {
  const shell = process.env.SHELL || '/bin/sh'
  try {
    const result = spawnSync(shell, ['-l', '-c', 'env'], {
      encoding: 'utf-8',
      timeout: 5000,
      // Detach from the controlling TTY so the login shell cannot suspend us
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    if (result.status !== 0) return { ...process.env } as Record<string, string>

    const env: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1)
      }
    }
    return env
  } catch {
    return { ...process.env } as Record<string, string>
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
