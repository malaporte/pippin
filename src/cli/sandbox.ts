import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { ensureLeash } from './leash'
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
  writeLockPort,
  isLockHeld,
  isProcessAlive,
  isServerHealthy,
} from './state'
import { Spinner } from './spinner'
import { resolvePolicy } from './policy'
import { resolveToolRequirements, resolvePnpmStorePath } from './tools'
import { DEFAULT_SANDBOX_DOCKERFILE } from './default-dockerfile'
import type { WorkspaceConfig, MountEntry, SandboxState, DotfileEntry } from '../shared/types'

const HEALTH_MAX_ATTEMPTS = 60
const HEALTH_INTERVAL_MS = 1000

type DockerfileBuildSource =
  | { kind: 'path'; dockerfilePath: string }
  | { kind: 'inline'; dockerfileText: string; label?: string }

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
  if (existing) {
    // Detect config drift: compare running sandbox's config fingerprint
    // against what the current configuration would produce.
    if (existing.configHash) {
      const globalConfig = readGlobalConfig()
      const currentHash = await computeConfigHash(workspaceRoot, workspaceConfig, globalConfig)

      if (existing.configHash === currentHash) {
        return existing.port // Config unchanged — reuse existing sandbox
      }

      // Config has drifted — auto-restart
      process.stderr.write('pippin: sandbox configuration changed, restarting…\n')
      await stopSandbox(workspaceRoot)
      // Fall through to start a new sandbox
    } else {
      // Legacy state without configHash — don't force-restart; the hash will
      // be recorded on the next natural start.
      return existing.port
    }
  }

  // Acquire lock to prevent concurrent starts. If another process holds the
  // lock, wait for it. If the lock holder crashes without writing state, we
  // re-attempt the lock ourselves instead of timing out.
  const MAX_LOCK_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    if (acquireLock(workspaceRoot)) {
      try {
        return await startSandbox(workspaceRoot, workspaceConfig)
      } finally {
        releaseLock(workspaceRoot)
      }
    }

    // Another process holds the lock — wait for it to finish
    const result = await waitForSandbox(workspaceRoot)
    if (result !== null) {
      return result
    }

    // Lock holder finished without producing a valid state (crashed).
    // Loop back and try to acquire the lock ourselves.
    if (attempt < MAX_LOCK_ATTEMPTS - 1) {
      process.stderr.write('pippin: previous sandbox start failed, retrying…\n')
    }
  }

  process.stderr.write('pippin: sandbox failed to start after multiple attempts\n')
  process.exit(1)
}

/** Start a new sandbox container for the given workspace */
async function startSandbox(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  retryAttempt = 0,
  logPreflightCleanup = true,
): Promise<number> {
  const globalConfig = readGlobalConfig()

  // Clean up the workspace-named container first. Leash derives Docker
  // container names from the working directory, so stale containers from a
  // previous session can collide even when pippin state has already expired.
  const workspaceContainerName = getWorkspaceContainerName(workspaceRoot)
  if (logPreflightCleanup && removeWorkspaceContainer(workspaceRoot) && workspaceContainerName) {
    process.stderr.write(`pippin: removed stale sandbox container ${workspaceContainerName} before startup\n`)
  } else if (!logPreflightCleanup) {
    removeWorkspaceContainer(workspaceRoot)
  }

  const port = await allocatePort(globalConfig.portRangeStart)
  writeLockPort(workspaceRoot, port)
  const controlPort = port + 1
  const idleTimeout = workspaceConfig.sandbox?.idle_timeout ?? globalConfig.idleTimeout

  // Resolve the custom Docker image (if configured)
  const resolvedImage = await resolveImage(workspaceRoot, workspaceConfig, globalConfig)

  // Resolve the Cedar policy file (if configured)
  const resolvedPolicy = resolvePolicy(workspaceRoot, workspaceConfig, globalConfig)

  // Resolve SSH agent forwarding (workspace overrides global)
  const explicitSshAgent = resolveSshAgent(workspaceConfig, globalConfig)

  // Resolve tool recipes and merge their requirements into the effective config.
  // Tools from both global and workspace configs are unioned.
  const tools = [...new Set([...globalConfig.tools, ...(workspaceConfig.sandbox?.tools ?? [])])]
  const toolReqs = resolveToolRequirements(tools)

  // Print warnings for unknown tool names
  for (const unknown of toolReqs.warnings) {
    process.stderr.write(`pippin: warning: unknown tool "${unknown}" (no built-in recipe)\n`)
  }

  // Merge: explicit config takes priority, tool recipes add to it
  const effectiveDotfiles = mergeAndDedup(globalConfig.dotfiles, toolReqs.dotfiles)
  const effectiveEnvironment = [...new Set([...globalConfig.environment, ...toolReqs.environment])]
  const effectiveSshAgent = explicitSshAgent || toolReqs.sshAgent
  const effectiveGpgAgent = toolReqs.gpgAgent

  // Prepare the share directory with the pippin-server binary
  const shareDir = prepareShareDir(workspaceRoot)

  // Resolve the user's shell environment before starting the spinner — the
  // login shell spawn must not happen while we hold the TTY in spinner mode.
  const shellEnv = getShellEnv()

  // Run host-side prepare functions for tool recipes. These can inject env vars
  // and override dotfile mounts with dynamically generated files (e.g. Snowflake
  // extracts a keychain token and generates a modified config.toml).
  const dotfileOverrides = new Map<string, string>() // original path -> generated path
  const toolExtraMounts: Array<{ path: string; readonly?: boolean }> = []
  for (const prepare of toolReqs.hostPrepares) {
    try {
      const result = prepare(shellEnv)
      if (!result) continue
      if (result.env) {
        for (const [key, value] of Object.entries(result.env)) {
          if (key in shellEnv) continue
          shellEnv[key] = value
          if (!effectiveEnvironment.includes(key)) {
            effectiveEnvironment.push(key)
          }
        }
      }
      if (result.dotfileOverrides) {
        for (const [original, generated] of Object.entries(result.dotfileOverrides)) {
          dotfileOverrides.set(original, generated)
        }
      }
      if (result.extraMounts) {
        for (const mount of result.extraMounts) {
          toolExtraMounts.push(mount)
        }
      }
    } catch (e) {
      // Prepare failed — skip silently; `pippin doctor` will surface missing credentials.
      process.stderr.write(`pippin: hostPrepare failed: ${e}\n`)
    }
  }

  // Run env resolvers for tool recipes (e.g. `gh auth token` for GH_TOKEN).
  // Only runs when the env var is not already present in the shell environment.
  for (const [envVar, command] of Object.entries(toolReqs.envResolvers)) {
    if (envVar in shellEnv) continue
    try {
      const result = spawnSync('sh', ['-c', command], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const value = result.stdout?.trim()
      if (result.status === 0 && value) {
        shellEnv[envVar] = value
        // Ensure the resolved var is in the forwarding list so buildLeashArgs
        // picks it up and passes it to the container.
        if (!effectiveEnvironment.includes(envVar)) {
          effectiveEnvironment.push(envVar)
        }
      }
    } catch {
      // Resolver failed — skip silently; `pippin doctor` will surface missing credentials.
    }
  }

  // Run multi-var resolvers (commands that output KEY=VALUE lines).
  // Used for tools like AWS where a single command resolves multiple credentials.
  for (const command of toolReqs.envMultiResolvers) {
    try {
      const result = spawnSync('sh', ['-c', command], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split('\n')) {
          const idx = line.indexOf('=')
          if (idx <= 0) continue
          const key = line.slice(0, idx)
          const value = line.slice(idx + 1)
          // Don't overwrite env vars that are already set
          if (key in shellEnv) continue
          shellEnv[key] = value
          if (!effectiveEnvironment.includes(key)) {
            effectiveEnvironment.push(key)
          }
        }
      }
    } catch {
      // Resolver failed — skip silently; `pippin doctor` will surface missing credentials.
    }
  }

  // Detect if the workspace is inside a Git worktree — if so, we need to
  // mount the main repository so that Git commands inside the sandbox can
  // access the shared object store, refs, and config.
  const worktreeMainRepo = resolveWorktreeMainRepo(workspaceRoot)

  // Build the leash command
  const args = buildLeashArgs(port, controlPort, workspaceConfig, effectiveDotfiles, effectiveEnvironment, shellEnv, effectiveSshAgent, effectiveGpgAgent, dotfileOverrides, worktreeMainRepo, toolExtraMounts, resolvedImage, resolvedPolicy)

  // Resolve the leash binary — auto-installs if not found
  const leashBinary = await ensureLeash()

  const spinner = new Spinner(`starting sandbox for ${workspaceRoot}`)
  spinner.start()

  // Tell leash to use a unique container name that includes a hash of the
  // full workspace path.  Without this, leash derives the name from
  // path.Base(cwd) which collides when two workspaces share the same
  // directory basename (e.g. two git worktrees both named "worktree-setup").
  // Leash respects TARGET_CONTAINER / LEASH_CONTAINER env vars as overrides
  // for the default basename-derived names.
  const uniqueWorkspaceName = getWorkspaceContainerName(workspaceRoot)

  const leashProcess = spawn(leashBinary, args, {
    cwd: workspaceRoot,
    env: {
      ...shellEnv,
      LEASH_SHARE_DIR: shareDir,
      PIPPIN_IDLE_TIMEOUT: String(idleTimeout),
      ...(uniqueWorkspaceName ? {
        TARGET_CONTAINER: uniqueWorkspaceName,
        LEASH_CONTAINER: `${uniqueWorkspaceName}-leash`,
      } : {}),
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

    if (retryAttempt === 0 && isContainerNameConflictError(stderr, workspaceRoot)) {
      if (workspaceContainerName) {
        process.stderr.write(`pippin: removing stale sandbox container ${workspaceContainerName} and retrying...\n`)
      }
      removeWorkspaceContainer(workspaceRoot)
      return startSandbox(workspaceRoot, workspaceConfig, retryAttempt + 1, false)
    }

    if (retryAttempt === 0 && isPortInUseError(stderr)) {
      process.stderr.write('pippin: port conflict detected, retrying with a new port…\n')
      removeWorkspaceContainer(workspaceRoot)
      return startSandbox(workspaceRoot, workspaceConfig, retryAttempt + 1, false)
    }

    process.stderr.write(`pippin: sandbox failed to start\n`)
    if (stderr.trim()) {
      process.stderr.write(stderr)
    }

    // Show the in-container server log if available — this is the primary
    // diagnostic when pippin-server crashes silently inside the sandbox.
    // Try reading docker logs from the target container first, then fall
    // back to the host-side share directory log file.
    const logContainerName = workspaceContainerName ?? 'pippin'
    try {
      const result = spawnSync('docker', ['logs', '--tail', '50', logContainerName], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const dockerLog = [result.stdout, result.stderr].filter(Boolean).join('').trim()
      if (dockerLog) {
        process.stderr.write(`\n--- container log (docker logs ${logContainerName}) ---\n`)
        process.stderr.write(dockerLog + '\n')
        process.stderr.write('--- end container log ---\n')
      }
    } catch {
      // Container may already be removed
    }

    process.exit(1)
  }

  // Detach from the child process so the CLI can exit while leash keeps
  // running in the background.  We must destroy the piped stderr stream
  // *and* unref the child — otherwise the open pipe / process handle keeps
  // the Node event loop alive and the CLI hangs after printing its output.
  leashProcess.stderr?.removeAllListeners()
  leashProcess.stderr?.destroy()
  leashProcess.unref()

  // Write state
  const configHash = await computeConfigHash(workspaceRoot, workspaceConfig, globalConfig)
  const state: SandboxState = {
    workspaceRoot,
    port,
    controlPort,
    leashPid: leashProcess.pid!,
    startedAt: new Date().toISOString(),
    image: resolvedImage,
    policy: resolvedPolicy,
    configHash,
  }
  writeState(state)

  return port
}

/**
 * Wait for another process to finish starting the sandbox, then return the port.
 * Returns null if the lock holder finished without producing a valid state
 * (e.g. it crashed), so the caller can re-attempt.
 */
async function waitForSandbox(workspaceRoot: string): Promise<number | null> {
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

    // If the lock is no longer held, the other process finished (or crashed)
    // without producing a valid state. Return null so the caller can retry.
    if (!isLockHeld(workspaceRoot)) {
      spinner.stop()
      return null
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

  removeWorkspaceContainer(workspaceRoot)
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
 *   5. bundled default dockerfile  (built into a tagged image)
 */
async function resolveImage(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): Promise<string | undefined> {
  // Workspace-level image takes top priority
  if (workspaceConfig.sandbox?.image) {
    return workspaceConfig.sandbox.image
  }

  // Workspace-level dockerfile
  if (workspaceConfig.sandbox?.dockerfile) {
    const dockerfilePath = path.resolve(workspaceRoot, expandHome(workspaceConfig.sandbox.dockerfile))
    return await buildDockerImage({ kind: 'path', dockerfilePath })
  }

  // Global-level image
  if (globalConfig.image) {
    return globalConfig.image
  }

  // Global-level dockerfile
  if (globalConfig.dockerfile) {
    const dockerfilePath = path.resolve(expandHome(globalConfig.dockerfile))
    return await buildDockerImage({ kind: 'path', dockerfilePath })
  }

  return await buildDockerImage({
    kind: 'inline',
    dockerfileText: DEFAULT_SANDBOX_DOCKERFILE,
    label: 'bundled default sandbox image',
  })
}

/**
 * Build a Docker image from a Dockerfile, tagged by content hash.
 * Skips the build if an image with the same hash tag already exists.
 * Returns the image tag string.
 */
async function buildDockerImage(source: DockerfileBuildSource): Promise<string> {
  let content: Buffer
  let dockerfilePath: string
  let context: string
  let cleanupDir: string | undefined

  if (source.kind === 'path') {
    if (!fs.existsSync(source.dockerfilePath)) {
      process.stderr.write(`pippin: dockerfile not found: ${source.dockerfilePath}\n`)
      process.exit(1)
    }

    dockerfilePath = source.dockerfilePath
    content = fs.readFileSync(dockerfilePath)
    context = path.dirname(dockerfilePath)
  } else {
    content = Buffer.from(source.dockerfileText, 'utf-8')
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-dockerfile-'))
    dockerfilePath = path.join(cleanupDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, content)
    context = cleanupDir
  }

  // Compute a content hash of the Dockerfile
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
  const tag = `pippin-custom:${hash}`

  // Check if this image already exists
  const { exitCode: inspectCode } = await spawnAsync('docker', ['image', 'inspect', tag], { timeout: 10_000 })

  if (inspectCode === 0) {
    // Image already exists with this hash — skip build
    return tag
  }

  const spinner = new Spinner(source.kind === 'inline'
    ? (source.label ?? 'building bundled sandbox image')
    : 'building custom sandbox image')
  spinner.start()

  try {
    const { exitCode, stdout, stderr } = await spawnAsync(
      'docker', ['build', '-t', tag, '-f', dockerfilePath, context],
      { timeout: 300_000 },
    )

    if (exitCode !== 0) {
      process.stderr.write(`pippin: failed to build ${source.kind === 'inline' ? 'bundled sandbox image' : 'custom sandbox image'}\n`)
      if (stderr?.trim()) {
        process.stderr.write(stderr)
      }
      if (stdout?.trim()) {
        process.stderr.write(stdout)
      }
      process.exit(1)
    }
  } finally {
    spinner.stop()
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true })
    }
  }

  return tag
}

/**
 * Resolve whether SSH agent forwarding should be enabled.
 * Workspace config takes precedence over global config.
 */
function resolveSshAgent(
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): boolean {
  if (typeof workspaceConfig.sandbox?.ssh_agent === 'boolean') {
    return workspaceConfig.sandbox.ssh_agent
  }
  return globalConfig.sshAgent
}

/**
 * Detect if the workspace root lives inside a Git worktree and return the
 * path to the main repository root, or null if it's not a worktree.
 *
 * In a worktree the `.git` entry is a *file* (not a directory) containing:
 *   gitdir: /path/to/main-repo/.git/worktrees/<name>
 *
 * Git commands need access to the main repository's `.git` directory (the
 * shared object store, refs, etc.), so the caller should mount the main repo
 * into the sandbox alongside the worktree.
 *
 * We walk up from `workspaceRoot` to find the `.git` entry, since the
 * workspace root may be a subdirectory inside a worktree.
 */
function resolveWorktreeMainRepo(workspaceRoot: string): string | null {
  // Walk up from workspaceRoot looking for a .git entry
  let dir = path.resolve(workspaceRoot)
  while (true) {
    const dotGit = path.join(dir, '.git')
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(dotGit)
    } catch {
      // No .git here — keep walking up
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
      continue
    }

    if (stat.isDirectory()) {
      // Regular repo — not a worktree
      return null
    }

    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(dotGit, 'utf-8').trim()
      const match = content.match(/^gitdir:\s*(.+)$/m)
      if (!match) return null

      // Resolve the gitdir path (may be relative to the worktree)
      const gitdir = path.resolve(dir, match[1])

      // Walk up from the gitdir to find the .git directory.
      // e.g. gitdir = /repo/.git/worktrees/my-branch → .git dir = /repo/.git
      //      → main repo root = /repo
      let g = gitdir
      while (g !== path.dirname(g)) {
        if (path.basename(g) === '.git') {
          const mainRepo = path.dirname(g)
          // Only return if the main repo is a different directory
          if (mainRepo !== path.resolve(workspaceRoot)) {
            return mainRepo
          }
          return null
        }
        g = path.dirname(g)
      }
    }

    return null
  }
}

/**
 * Compute a deterministic fingerprint of the sandbox-relevant configuration.
 * Used to detect when the config has changed since the sandbox was started,
 * so we can auto-restart instead of silently running with stale settings.
 *
 * Inputs hashed: resolved image tag, resolved policy path + file content,
 * global dotfile mounts, workspace mounts, and forwarded env var names.
 */
async function computeConfigHash(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): Promise<string> {
  const image = await resolveImage(workspaceRoot, workspaceConfig, globalConfig)
  const policy = resolvePolicy(workspaceRoot, workspaceConfig, globalConfig)

  const parts: string[] = [
    `image:${image ?? ''}`,
    `policy:${policy ?? ''}`,
    `init:${workspaceConfig.sandbox?.init ?? ''}`,
  ]

  // Include policy file content so edits to the .cedar file are detected
  if (policy) {
    try {
      const content = fs.readFileSync(policy)
      parts.push(`policy-content:${crypto.createHash('sha256').update(content).digest('hex')}`)
    } catch { /* file unreadable — hash will change if it becomes readable later */ }
  }

  // Global dotfile mounts (sorted for determinism)
  const dotfileParts: string[] = []
  for (const d of globalConfig.dotfiles) {
    const expanded = expandHome(d.path)
    if (fs.existsSync(expanded)) {
      dotfileParts.push(`dotfile:${expanded}:${d.readonly ? 'ro' : 'rw'}`)
    }
  }
  parts.push(...dotfileParts.sort())

  // Workspace mounts (sorted for determinism)
  const mountParts: string[] = []
  for (const m of workspaceConfig.sandbox?.mounts ?? []) {
    const expanded = expandHome(m.path)
    if (fs.existsSync(expanded)) {
      mountParts.push(`mount:${expanded}:${m.readonly ? 'ro' : 'rw'}`)
    }
  }
  parts.push(...mountParts.sort())

  // Forwarded environment variable names (sorted)
  const envParts = [...globalConfig.environment].sort()
  for (const e of envParts) {
    parts.push(`env:${e}`)
  }

  // SSH agent forwarding
  const sshAgent = resolveSshAgent(workspaceConfig, globalConfig)
  parts.push(`sshAgent:${sshAgent}`)

  // Tool declarations (sorted for determinism)
  const tools = [...new Set([...globalConfig.tools, ...(workspaceConfig.sandbox?.tools ?? [])])]
  parts.push(...tools.sort().map((t) => `tool:${t}`))

  // GPG agent forwarding (derived from tool recipes)
  const toolReqs = resolveToolRequirements(tools)
  parts.push(`gpgAgent:${toolReqs.gpgAgent}`)

  // Git worktree main repo mount (auto-detected)
  const worktreeMainRepo = resolveWorktreeMainRepo(workspaceRoot)
  if (worktreeMainRepo) {
    parts.push(`worktree-main:${worktreeMainRepo}`)
  }

  // pnpm store path — include so that moving the store triggers a sandbox restart
  if (tools.includes('pnpm')) {
    const shellEnv = getShellEnv()
    const pnpmStore = resolvePnpmStorePath(shellEnv)
    parts.push(`pnpm-store:${pnpmStore ?? ''}`)
  }

  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Merge two dotfile lists, deduplicating by expanded path.
 * First list (explicit user config) takes priority over second (tool recipes).
 */
function mergeAndDedup(
  explicit: DotfileEntry[],
  fromRecipes: DotfileEntry[],
): DotfileEntry[] {
  const seen = new Set<string>()
  const result: DotfileEntry[] = []

  for (const entry of [...explicit, ...fromRecipes]) {
    const expanded = expandHome(entry.path)
    if (seen.has(expanded)) continue
    seen.add(expanded)
    result.push(entry)
  }

  return result
}

/** Build the leash CLI arguments */
function buildLeashArgs(
  port: number,
  controlPort: number,
  workspaceConfig: WorkspaceConfig,
  dotfiles: { path: string; readonly?: boolean }[],
  environment: string[],
  shellEnv: Record<string, string>,
  sshAgent: boolean,
  gpgAgent: boolean,
  dotfileOverrides: Map<string, string>,
  worktreeMainRepo: string | null,
  toolExtraMounts: Array<{ path: string; readonly?: boolean }>,
  image?: string,
  policy?: string,
): string[] {
  const args: string[] = [
    '-p', `127.0.0.1:${port}:${port}`,
    '-l', `127.0.0.1:${controlPort}`,
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

  // Add dotfile mounts from global config (and tool recipes, already merged).
  // If a hostPrepare function generated an override for a dotfile path,
  // mount the generated file at the original path instead.
  //
  // Dotfile paths are specified relative to ~ (e.g. ~/.gitconfig).
  // On the host, ~ expands to /Users/martin, but inside the container
  // the user is root and HOME=/root.  We mount with destination paths
  // under /root so that tools find their config at the expected location.
  const containerHome = '/root'
  const hostHome = os.homedir()
  const mountedPaths = new Set<string>()
  for (const dotfile of dotfiles) {
    const expanded = expandHome(dotfile.path)
    const overrideSrc = dotfileOverrides.get(dotfile.path)
    const hostPath = overrideSrc ?? expanded
    if (!fs.existsSync(hostPath)) continue
    if (mountedPaths.has(expanded)) continue
    mountedPaths.add(expanded)
    // Map ~/foo → /root/foo inside the container
    const containerPath = expanded.startsWith(hostHome)
      ? containerHome + expanded.slice(hostHome.length)
      : expanded
    const mountSpec = dotfile.readonly
      ? `${hostPath}:${containerPath}:ro`
      : `${hostPath}:${containerPath}`
    args.push('-v', mountSpec)
  }

  // Add extra mounts from workspace config
  const extraMounts = workspaceConfig.sandbox?.mounts ?? []
  for (const mount of extraMounts) {
    const expanded = expandHome(mount.path)
    if (!fs.existsSync(expanded)) continue
    if (mountedPaths.has(expanded)) continue
    mountedPaths.add(expanded)
    // Map ~/foo → /root/foo inside the container
    const containerPath = expanded.startsWith(hostHome)
      ? containerHome + expanded.slice(hostHome.length)
      : expanded
    const mountSpec = mount.readonly
      ? `${expanded}:${containerPath}:ro`
      : `${expanded}:${containerPath}`
    args.push('-v', mountSpec)
  }

  // If the workspace is a Git worktree, mount the main repository so that
  // Git commands can access the shared object store, refs, and config.
  // Mount at the original host path (not remapped to /root) because the
  // worktree's .git file contains an absolute gitdir reference to the host
  // path, and leash mounts the workspace CWD at its original host path.
  if (worktreeMainRepo && !mountedPaths.has(worktreeMainRepo)) {
    mountedPaths.add(worktreeMainRepo)
    args.push('-v', `${worktreeMainRepo}:${worktreeMainRepo}`)
  }

  // Add extra mounts from tool recipes (e.g. the pnpm content-addressable store).
  // These are discovered dynamically at sandbox start time by hostPrepare functions.
  for (const mount of toolExtraMounts) {
    const expanded = expandHome(mount.path)
    if (!fs.existsSync(expanded)) continue
    if (mountedPaths.has(expanded)) continue
    mountedPaths.add(expanded)
    // Map ~/foo → /root/foo inside the container
    const containerPath = expanded.startsWith(hostHome)
      ? containerHome + expanded.slice(hostHome.length)
      : expanded
    const mountSpec = mount.readonly
      ? `${expanded}:${containerPath}:ro`
      : `${expanded}:${containerPath}`
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

  // SSH agent forwarding via Docker Desktop's host-services socket
  if (sshAgent) {
    const agentSock = '/run/host-services/ssh-auth.sock'
    args.push('-v', `${agentSock}:${agentSock}`)
    args.push('-e', `SSH_AUTH_SOCK=${agentSock}`)

    // Mount the host's known_hosts file so SSH doesn't prompt for host
    // key verification inside the non-interactive container.
    // Skip if already mounted by a tool recipe or dotfile config.
    const knownHosts = path.join(os.homedir(), '.ssh', 'known_hosts')
    if (fs.existsSync(knownHosts) && !mountedPaths.has(knownHosts)) {
      mountedPaths.add(knownHosts)
      const containerKnownHosts = knownHosts.startsWith(hostHome)
        ? containerHome + knownHosts.slice(hostHome.length)
        : knownHosts
      args.push('-v', `${knownHosts}:${containerKnownHosts}:ro`)
    }
  }

  // GPG agent forwarding — mount the host's gpg-agent socket so that
  // GPG commit signing works inside the container without needing a
  // pinentry program or direct access to private key files.
  if (gpgAgent) {
    try {
      const result = spawnSync('gpgconf', ['--list-dirs', 'agent-socket'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const hostSocket = result.stdout?.trim()
      if (result.status === 0 && hostSocket && fs.existsSync(hostSocket)) {
        const containerSocket = containerHome + '/.gnupg/S.gpg-agent'
        args.push('-v', `${hostSocket}:${containerSocket}`)
      }
    } catch { /* gpgconf not available — skip silently */ }
  }

  // The command to run inside the container.
  // We use a shell wrapper to build a combined CA bundle (system CAs + the
  // leash MITM proxy CA) so that tools like the AWS CLI, Python requests, and
  // Node.js trust TLS connections that pass through leash's proxy.
  // It also creates the Snowflake credential cache if the host extracted a
  // keychain token (via the snowflake recipe's hostPrepare).
  const COMBINED_CA = '/tmp/combined-ca.pem'
  const SF_CACHE_DIR = '$HOME/.cache/snowflake'
  const SF_CACHE_FILE = `${SF_CACHE_DIR}/credential_cache_v1.json`
  const workspaceInit = workspaceConfig.sandbox?.init?.trim()
  const bootstrap = [
    // Create a combined CA bundle from the system store + leash MITM CA.
    // If leash's CA isn't present (e.g. running without leash), just copy
    // the system bundle so the env vars still point at something valid.
    `if [ -f /leash/ca-cert.pem ]; then cat /etc/ssl/certs/ca-certificates.crt /leash/ca-cert.pem > ${COMBINED_CA}; else cp /etc/ssl/certs/ca-certificates.crt ${COMBINED_CA}; fi`,
    `export SSL_CERT_FILE=${COMBINED_CA}`,
    `export AWS_CA_BUNDLE=${COMBINED_CA}`,
    `export REQUESTS_CA_BUNDLE=${COMBINED_CA}`,
    `export NODE_EXTRA_CA_CERTS=${COMBINED_CA}`,
    // Install the leash MITM CA into the system certificate store so that
    // native binaries using the OS trust store (e.g. GitHub Copilot CLI)
    // also trust connections proxied through leash.
    `if [ -f /leash/ca-cert.pem ] && command -v update-ca-certificates >/dev/null 2>&1; then cp /leash/ca-cert.pem /usr/local/share/ca-certificates/leash-mitm.crt && update-ca-certificates >/dev/null 2>&1; fi`,
    // If the Snowflake recipe injected a cached ID token, create the
    // file-based credential cache that the Python connector reads on Linux.
    // The cache dir must be 0700 and the file 0600 for the connector to
    // accept them.
    `if [ -n "$SNOWFLAKE_ID_TOKEN" ] && [ -n "$SNOWFLAKE_TOKEN_HASH_KEY" ]; then mkdir -p ${SF_CACHE_DIR} && chmod 700 ${SF_CACHE_DIR} && printf '{"tokens":{"%s":"%s"}}' "$SNOWFLAKE_TOKEN_HASH_KEY" "$SNOWFLAKE_ID_TOKEN" > ${SF_CACHE_FILE} && chmod 600 ${SF_CACHE_FILE}; fi`,
    // GPG requires its homedir to have permissions 700. When Docker creates
    // /root/.gnupg implicitly to satisfy bind-mount paths (e.g. the agent
    // socket or pubring files), it uses 755. Fix that up at startup so that
    // gpg-agent forwarding works without the "unsafe permissions" warning.
    `if [ -d /root/.gnupg ]; then chmod 700 /root/.gnupg; fi`,
    ...(workspaceInit ? [workspaceInit] : []),
    'exec /leash/pippin-server',
  ].join(' && ')
  args.push('--', 'sh', '-c', bootstrap)

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
  // Skip copy if file content is identical (compared by SHA-256 hash)
  try {
    const srcHash = crypto.createHash('sha256').update(fs.readFileSync(serverBinary)).digest('hex')
    const dstHash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
    if (srcHash === dstHash) return shareDir
  } catch {
    // Destination doesn't exist — proceed with copy
  }

  fs.copyFileSync(serverBinary, dest)
  fs.chmodSync(dest, 0o755)

  return shareDir
}

/** Find the pippin-server binary for the current container architecture */
export function resolveServerBinary(): string | null {
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

  // Check the installed binary directory first. GitHub installs place the
  // server binary alongside the `pippin` executable in the user's bin dir.
  const execDir = path.dirname(process.execPath)

  // Walk up from this source file to find the project root's dist/ directory
  // for local source runs, and also check the compiled CLI's output dir.
  // Prefer dist/ over execDir so that freshly-built binaries take priority
  // over stale copies that may live alongside the Bun/pippin executable.
  const candidates = [
    path.join(import.meta.dirname, '..', '..', 'dist', binaryName),
    path.join(import.meta.dirname, binaryName),
    path.join(execDir, binaryName),
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

function getWorkspaceContainerName(workspaceRoot: string): string | null {
  const resolved = path.resolve(workspaceRoot)
  const base = path.basename(resolved).trim()
  if (!base) return null

  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!normalized) return null

  // Append a short hash of the full path to avoid collisions between
  // workspaces that share the same directory basename (e.g. two git
  // worktrees both named "worktree-setup" under different repositories).
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8)
  return `${normalized}-${hash}`
}

function removeContainerByName(containerName: string): boolean {
  try {
    const result = spawnSync('docker', ['ps', '-a', '-q', '--filter', `name=^/${containerName}`], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const ids = (result.stdout || '').trim().split('\n').filter(Boolean)
    if (ids.length === 0) return false

    const removed = spawnSync('docker', ['rm', '-fv', ...ids], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    return removed.status === 0
  } catch {
    return false
  }
}

function removeWorkspaceContainer(workspaceRoot: string): boolean {
  const containerName = getWorkspaceContainerName(workspaceRoot)
  if (!containerName) return false
  // Use a prefix match so we also catch leash-suffixed variants
  // (e.g. "${name}1", "${name}2") and the leash sidecar ("${name}-leash").
  return removeContainerByName(containerName)
}

function isContainerNameConflictError(stderr: string, workspaceRoot: string): boolean {
  const containerName = getWorkspaceContainerName(workspaceRoot)
  if (!containerName) return false

  return stderr.includes('is already in use by container')
    && stderr.toLowerCase().includes(containerName.toLowerCase())
}

function isPortInUseError(stderr: string): boolean {
  return /port\s+\d+\s+is already in use/.test(stderr)
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

export const __test__ = {
  resolveImage,
  buildDockerImage,
  buildLeashArgs,
  computeConfigHash,
  startSandbox,
  getWorkspaceContainerName,
  removeWorkspaceContainer,
  isContainerNameConflictError,
  isPortInUseError,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Async wrapper around child_process.spawn that collects stdout/stderr */
function spawnAsync(
  command: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    let timer: ReturnType<typeof setTimeout> | undefined
    if (options.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, options.timeout)
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      })
    })
  })
}
