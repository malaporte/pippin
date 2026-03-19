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
import { resolveToolRequirements } from './tools'
import type { WorkspaceConfig, MountEntry, SandboxState, DotfileEntry } from '../shared/types'

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
  if (existing) {
    // Detect config drift: compare running sandbox's config fingerprint
    // against what the current configuration would produce.
    if (existing.configHash) {
      const globalConfig = readGlobalConfig()
      const currentHash = computeConfigHash(workspaceRoot, workspaceConfig, globalConfig)

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

  // Build the leash command
  const args = buildLeashArgs(port, controlPort, workspaceConfig, effectiveDotfiles, effectiveEnvironment, shellEnv, effectiveSshAgent, effectiveGpgAgent, dotfileOverrides, resolvedImage, resolvedPolicy)

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

  // Detach from the child process so the CLI can exit while leash keeps
  // running in the background.  We must destroy the piped stderr stream
  // *and* unref the child — otherwise the open pipe / process handle keeps
  // the Node event loop alive and the CLI hangs after printing its output.
  leashProcess.stderr?.removeAllListeners()
  leashProcess.stderr?.destroy()
  leashProcess.unref()

  // Write state
  const configHash = computeConfigHash(workspaceRoot, workspaceConfig, globalConfig)
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
 * Compute a deterministic fingerprint of the sandbox-relevant configuration.
 * Used to detect when the config has changed since the sandbox was started,
 * so we can auto-restart instead of silently running with stale settings.
 *
 * Inputs hashed: resolved image tag, resolved policy path + file content,
 * global dotfile mounts, workspace mounts, and forwarded env var names.
 */
function computeConfigHash(
  workspaceRoot: string,
  workspaceConfig: WorkspaceConfig,
  globalConfig: ResolvedGlobalConfig,
): string {
  const image = resolveImage(workspaceRoot, workspaceConfig, globalConfig)
  const policy = resolvePolicy(workspaceRoot, workspaceConfig, globalConfig)

  const parts: string[] = [
    `image:${image ?? ''}`,
    `policy:${policy ?? ''}`,
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
  const bootstrap = [
    // Create a combined CA bundle from the system store + leash MITM CA.
    // If leash's CA isn't present (e.g. running without leash), just copy
    // the system bundle so the env vars still point at something valid.
    `if [ -f /leash/ca-cert.pem ]; then cat /etc/ssl/certs/ca-certificates.crt /leash/ca-cert.pem > ${COMBINED_CA}; else cp /etc/ssl/certs/ca-certificates.crt ${COMBINED_CA}; fi`,
    `export SSL_CERT_FILE=${COMBINED_CA}`,
    `export AWS_CA_BUNDLE=${COMBINED_CA}`,
    `export REQUESTS_CA_BUNDLE=${COMBINED_CA}`,
    `export NODE_EXTRA_CA_CERTS=${COMBINED_CA}`,
    // If the Snowflake recipe injected a cached ID token, create the
    // file-based credential cache that the Python connector reads on Linux.
    // The cache dir must be 0700 and the file 0600 for the connector to
    // accept them.
    `if [ -n "$SNOWFLAKE_ID_TOKEN" ] && [ -n "$SNOWFLAKE_TOKEN_HASH_KEY" ]; then mkdir -p ${SF_CACHE_DIR} && chmod 700 ${SF_CACHE_DIR} && printf '{"tokens":{"%s":"%s"}}' "$SNOWFLAKE_TOKEN_HASH_KEY" "$SNOWFLAKE_ID_TOKEN" > ${SF_CACHE_FILE} && chmod 600 ${SF_CACHE_FILE}; fi`,
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
