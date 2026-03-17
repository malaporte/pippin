import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { readGlobalConfig, expandHome } from './config'
import type { ResolvedGlobalConfig } from './config'
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
import { resolvePolicy } from './policy'
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

  // Resolve the custom Docker image (if configured)
  const resolvedImage = resolveImage(workspaceRoot, workspaceConfig, globalConfig)

  // Resolve the Cedar policy file (if configured)
  const resolvedPolicy = resolvePolicy(workspaceRoot, workspaceConfig, globalConfig)

  // Prepare the share directory with the pippin-server binary
  const shareDir = prepareShareDir(workspaceRoot)

  // Resolve the user's shell environment before starting the spinner — the
  // login shell spawn must not happen while we hold the TTY in spinner mode.
  const shellEnv = getShellEnv()

  // Build the leash command
  const args = buildLeashArgs(port, controlPort, workspaceConfig, globalConfig.dotfiles, globalConfig.environment, shellEnv, resolvedImage, resolvedPolicy)

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
    image: resolvedImage,
    policy: resolvedPolicy,
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

/**
 * Resolve the Docker image to use for the sandbox.
 *
 * Priority (first match wins):
 *   1. workspace sandbox.image
 *   2. workspace sandbox.dockerfile  (built into a tagged image)
 *   3. global image
 *   4. global dockerfile             (built into a tagged image)
 *   5. undefined  → leash uses its default image
 */
function resolveImage(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): string | undefined {
  // Workspace-level image takes top priority
  if (workspaceConfig.sandbox?.image) {
    return workspaceConfig.sandbox.image
  }

  // Workspace-level dockerfile
  if (workspaceConfig.sandbox?.dockerfile) {
    const dockerfilePath = path.resolve(workspaceRoot, expandHome(workspaceConfig.sandbox.dockerfile))
    return buildDockerImage(dockerfilePath)
  }

  // Global-level image
  if (globalConfig.image) {
    return globalConfig.image
  }

  // Global-level dockerfile
  if (globalConfig.dockerfile) {
    const dockerfilePath = path.resolve(expandHome(globalConfig.dockerfile))
    return buildDockerImage(dockerfilePath)
  }

  return undefined
}

/**
 * Build a Docker image from a Dockerfile, tagged by content hash.
 * Skips the build if an image with the same hash tag already exists.
 * Returns the image tag string.
 */
function buildDockerImage(dockerfilePath: string): string {
  if (!fs.existsSync(dockerfilePath)) {
    process.stderr.write(`pippin: dockerfile not found: ${dockerfilePath}\n`)
    process.exit(1)
  }

  // Compute a content hash of the Dockerfile
  const content = fs.readFileSync(dockerfilePath)
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
  const tag = `pippin-custom:${hash}`

  // Check if this image already exists
  const inspect = spawnSync('docker', ['image', 'inspect', tag], {
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  if (inspect.status === 0) {
    // Image already exists with this hash — skip build
    return tag
  }

  // Build the image
  const context = path.dirname(dockerfilePath)
  const spinner = new Spinner('building custom sandbox image')
  spinner.start()

  const build = spawnSync('docker', ['build', '-t', tag, '-f', dockerfilePath, context], {
    encoding: 'utf-8',
    timeout: 300_000, // 5 minute timeout for builds
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  spinner.stop()

  if (build.status !== 0) {
    process.stderr.write(`pippin: failed to build custom sandbox image\n`)
    if (build.stderr?.trim()) {
      process.stderr.write(build.stderr)
    }
    if (build.stdout?.trim()) {
      process.stderr.write(build.stdout)
    }
    process.exit(1)
  }

  return tag
}

/** Build the leash CLI arguments */
function buildLeashArgs(
  port: number,
  controlPort: number,
  workspaceConfig: WorkspaceConfig,
  dotfiles: { path: string; readonly?: boolean }[],
  environment: string[],
  shellEnv: Record<string, string>,
  image?: string,
  policy?: string,
): string[] {
  const args: string[] = [
    '-p', `${port}:${port}`,
    '-l', `:${controlPort}`,
    '-I',
  ]

  // Use a custom image if configured
  if (image) {
    args.push('--image', image)
  }

  // Use a Cedar policy file if configured
  if (policy) {
    args.push('--policy', policy)
  }

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

  // Forward host environment variables from the global config
  for (const name of environment) {
    if (name in shellEnv) {
      args.push('-e', `${name}=${shellEnv[name]}`)
    }
  }

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

  // Also clean up containers from custom images tracked in sandbox states
  for (const state of listStates()) {
    if (state.image && !images.includes(state.image)) {
      images.push(state.image)
    }
  }

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
