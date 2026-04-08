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
import type { SandboxConfig, SandboxState, DotfileEntry } from '../shared/types'
import { DEFAULT_INIT_TIMEOUT, DEFAULT_INSTALL_INIT_TIMEOUT } from '../shared/types'

const HEALTH_INTERVAL_MS = 1000

type DockerfileBuildSource =
  | { kind: 'path'; dockerfilePath: string }
  | { kind: 'inline'; dockerfileText: string; label?: string }

type GpgSocketInfo = {
  hostSocket: string
  containerSocket: string
  source: 'agent-extra-socket' | 'agent-socket'
  fingerprint: string
}

/**
 * Ensure a sandbox is running for the given named sandbox. Starts one if needed.
 * Returns the port number for connecting to the pippin-server.
 */
export async function ensureSandbox(
  sandboxName: string,
  sandboxConfig: SandboxConfig,
): Promise<number> {
  const existing = await validateState(sandboxName)
  if (existing) {
    if (existing.configHash) {
      const globalConfig = readGlobalConfig()
      const currentHash = await computeConfigHash(sandboxConfig, globalConfig)

      if (existing.configHash === currentHash) {
        return existing.port
      }

      process.stderr.write('pippin: sandbox configuration changed, restarting...\n')
      await stopSandbox(sandboxName)
    } else {
      return existing.port
    }
  }

  const MAX_LOCK_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    if (acquireLock(sandboxName)) {
      try {
        return await startSandbox(sandboxName, sandboxConfig)
      } finally {
        releaseLock(sandboxName)
      }
    }

    const result = await waitForSandbox(sandboxName)
    if (result !== null) {
      return result
    }

    if (attempt < MAX_LOCK_ATTEMPTS - 1) {
      process.stderr.write('pippin: previous sandbox start failed, retrying...\n')
    }
  }

  process.stderr.write('pippin: sandbox failed to start after multiple attempts\n')
  process.exit(1)
}

async function startSandbox(
  sandboxName: string,
  sandboxConfig: SandboxConfig,
  retryAttempt = 0,
  logPreflightCleanup = true,
): Promise<number> {
  const globalConfig = readGlobalConfig()
  const sandboxRoot = path.resolve(expandHome(sandboxConfig.root))

  const containerName = getSandboxContainerName(sandboxName)
  if (logPreflightCleanup && removeSandboxContainer(sandboxName) && containerName) {
    process.stderr.write(`pippin: removed stale sandbox container ${containerName} before startup\n`)
  } else if (!logPreflightCleanup) {
    removeSandboxContainer(sandboxName)
  }

  const port = await allocatePort(globalConfig.portRangeStart)
  writeLockPort(sandboxName, port)
  const controlPort = port + 1
  const idleTimeout = sandboxConfig.idle_timeout ?? 900
  const resolvedImage = await resolveImage(sandboxConfig, globalConfig)
  const resolvedPolicy = resolvePolicy(sandboxName, sandboxConfig, globalConfig)
  const explicitSshAgent = resolveSshAgent(sandboxConfig)
  const initCommand = sandboxConfig.init?.trim()

  const tools = [...new Set(sandboxConfig.tools ?? [])]
  const toolReqs = resolveToolRequirements(tools)

  for (const unknown of toolReqs.warnings) {
    process.stderr.write(`pippin: warning: unknown tool "${unknown}" (no built-in recipe)\n`)
  }

  const effectiveDotfiles = mergeAndDedup(sandboxConfig.dotfiles ?? [], toolReqs.dotfiles)
  const effectiveEnvironment = [...new Set([...(sandboxConfig.environment ?? []), ...toolReqs.environment])]
  const effectiveSshAgent = explicitSshAgent || toolReqs.sshAgent
  const effectiveGpgAgent = toolReqs.gpgAgent
  const shareDir = prepareShareDir(sandboxName)
  const shellEnv = getShellEnv()

  const dotfileOverrides = new Map<string, string>()
  const toolExtraMounts: Array<{ path: string; containerPath?: string; readonly?: boolean }> = []
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
        toolExtraMounts.push(...result.extraMounts)
      }
    } catch (e) {
      process.stderr.write(`pippin: hostPrepare failed: ${e}\n`)
    }
  }

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
        if (!effectiveEnvironment.includes(envVar)) {
          effectiveEnvironment.push(envVar)
        }
      }
    } catch {
    }
  }

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
          if (key in shellEnv) continue
          shellEnv[key] = value
          if (!effectiveEnvironment.includes(key)) {
            effectiveEnvironment.push(key)
          }
        }
      }
    } catch {
    }
  }

  const args = buildLeashArgs(
    port,
    controlPort,
    sandboxConfig,
    effectiveDotfiles,
    effectiveEnvironment,
    shellEnv,
    effectiveSshAgent,
    effectiveGpgAgent,
    dotfileOverrides,
    toolExtraMounts,
    initCommand,
    resolvedImage,
    resolvedPolicy,
    toolReqs.containerEnvironment,
  )

  const spinnerMessage = initCommand
    ? `starting sandbox ${sandboxName} (running sandbox.init)`
    : `starting sandbox ${sandboxName}`
  if (initCommand) {
    process.stderr.write(`pippin: ${spinnerMessage}: ${initCommand}\n`)
  }
  const spinner = new Spinner(spinnerMessage)
  spinner.start()

  const leashBinary = await ensureLeash()
  const uniqueSandboxName = getSandboxContainerName(sandboxName)

  const leashProcess = spawn(leashBinary, args, {
    cwd: sandboxRoot,
    env: {
      ...shellEnv,
      LEASH_SHARE_DIR: shareDir,
      PIPPIN_IDLE_TIMEOUT: String(idleTimeout),
      ...(uniqueSandboxName ? {
        TARGET_CONTAINER: uniqueSandboxName,
        LEASH_CONTAINER: `${uniqueSandboxName}-leash`,
      } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const stderrChunks: Buffer[] = []
  leashProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  let unexpectedExit = false
  leashProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      unexpectedExit = true
    }
  })

  let healthy = false
  const defaultInitTimeout = initCommand ? DEFAULT_INSTALL_INIT_TIMEOUT : DEFAULT_INIT_TIMEOUT
  const initTimeoutSecs = sandboxConfig.init_timeout ?? defaultInitTimeout
  const maxHealthAttempts = Math.ceil((initTimeoutSecs * 1000) / HEALTH_INTERVAL_MS)
  for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
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
    try { leashProcess.kill('SIGTERM') } catch {}

    const stderr = Buffer.concat(stderrChunks).toString()

    if (retryAttempt === 0 && isContainerNameConflictError(stderr, sandboxName)) {
      if (containerName) {
        process.stderr.write(`pippin: removing stale sandbox container ${containerName} and retrying...\n`)
      }
      removeSandboxContainer(sandboxName)
      return startSandbox(sandboxName, sandboxConfig, retryAttempt + 1, false)
    }

    if (retryAttempt === 0 && isPortInUseError(stderr)) {
      process.stderr.write('pippin: port conflict detected, retrying with a new port...\n')
      removeSandboxContainer(sandboxName)
      return startSandbox(sandboxName, sandboxConfig, retryAttempt + 1, false)
    }

    process.stderr.write('pippin: sandbox failed to start\n')
    if (stderr.trim()) {
      process.stderr.write(stderr)
    }

    const logContainerName = containerName ?? 'pippin'
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
    }

    const bootstrapLogPath = path.join(shareDir, 'bootstrap.log')
    try {
      const bootstrapLog = fs.readFileSync(bootstrapLogPath, 'utf-8').trim()
      if (bootstrapLog) {
        process.stderr.write(`\n--- bootstrap log (${bootstrapLogPath}) ---\n`)
        process.stderr.write(bootstrapLog + '\n')
        process.stderr.write('--- end bootstrap log ---\n')
      }
    } catch {
    }

    process.exit(1)
  }

  const startupStderr = Buffer.concat(stderrChunks).toString()
  if (startupStderr.trim()) {
    process.stderr.write(startupStderr)
  }

  leashProcess.stderr?.removeAllListeners()
  leashProcess.stderr?.destroy()
  leashProcess.unref()

  const configHash = await computeConfigHash(sandboxConfig, globalConfig)
  const state: SandboxState = {
    sandboxName,
    workspaceRoot: sandboxRoot,
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

async function waitForSandbox(sandboxName: string): Promise<number | null> {
  const spinner = new Spinner('waiting for sandbox')
  spinner.start()

  for (let i = 0; i < DEFAULT_INSTALL_INIT_TIMEOUT; i++) {
    spinner.update(`waiting for sandbox (${i + 1}s)`)
    await sleep(HEALTH_INTERVAL_MS)

    const state = await validateState(sandboxName)
    if (state) {
      spinner.stop()
      return state.port
    }

    if (!isLockHeld(sandboxName)) {
      spinner.stop()
      return null
    }
  }

  spinner.stop()
  process.stderr.write('pippin: timed out waiting for sandbox to start\n')
  process.exit(1)
}

export async function stopSandbox(sandboxName: string): Promise<void> {
  const state = readState(sandboxName)
  if (!state) return

  const spinner = new Spinner(`stopping sandbox ${sandboxName}`)
  spinner.start()

  if (isProcessAlive(state.leashPid)) {
    try { process.kill(state.leashPid, 'SIGTERM') } catch {}

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && isProcessAlive(state.leashPid)) {
      await sleep(200)
    }

    if (isProcessAlive(state.leashPid)) {
      try { process.kill(state.leashPid, 'SIGKILL') } catch {}
    }
  }

  removeSandboxContainer(sandboxName)
  removeState(sandboxName)
  spinner.stop()
}

export async function stopAllSandboxes(): Promise<void> {
  const states = listStates()
  for (const state of states) {
    await stopSandbox(state.sandboxName)
  }
}

async function resolveImage(
  sandboxConfig: SandboxConfig,
  globalConfig: ResolvedGlobalConfig,
): Promise<string | undefined> {
  const sandboxRoot = path.resolve(expandHome(sandboxConfig.root))

  if (sandboxConfig.image) {
    return sandboxConfig.image
  }

  if (sandboxConfig.dockerfile) {
    const dockerfilePath = path.resolve(sandboxRoot, expandHome(sandboxConfig.dockerfile))
    return await buildDockerImage({ kind: 'path', dockerfilePath })
  }

  return await buildDockerImage({
    kind: 'inline',
    dockerfileText: DEFAULT_SANDBOX_DOCKERFILE,
    label: 'bundled default sandbox image',
  })
}

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

  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
  const tag = `pippin-custom:${hash}`

  const { exitCode: inspectCode } = await spawnAsync('docker', ['image', 'inspect', tag], { timeout: 10_000 })
  if (inspectCode === 0) {
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
      if (stderr?.trim()) process.stderr.write(stderr)
      if (stdout?.trim()) process.stderr.write(stdout)
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

function resolveSshAgent(
  sandboxConfig: SandboxConfig,
): boolean {
  return sandboxConfig.ssh_agent ?? false
}

async function computeConfigHash(
  sandboxConfig: SandboxConfig,
  globalConfig: ResolvedGlobalConfig,
): Promise<string> {
  const sandboxRoot = path.resolve(expandHome(sandboxConfig.root))
  const image = await resolveImage(sandboxConfig, globalConfig)
  const policy = resolvePolicy('', sandboxConfig, globalConfig)

  const parts: string[] = [
    `root:${sandboxRoot}`,
    `image:${image ?? ''}`,
    `policy:${policy ?? ''}`,
    `init:${sandboxConfig.init?.trim() ?? ''}`,
  ]

  if (policy) {
    try {
      const content = fs.readFileSync(policy)
      parts.push(`policy-content:${crypto.createHash('sha256').update(content).digest('hex')}`)
    } catch {}
  }

  const dotfileParts: string[] = []
  for (const d of sandboxConfig.dotfiles ?? []) {
    const expanded = expandHome(d.path)
    if (fs.existsSync(expanded)) {
      dotfileParts.push(`dotfile:${expanded}:${d.readonly ? 'ro' : 'rw'}`)
    }
  }
  parts.push(...dotfileParts.sort())

  const mountParts: string[] = []
  for (const m of sandboxConfig.mounts ?? []) {
    const expanded = expandHome(m.path)
    if (fs.existsSync(expanded)) {
      mountParts.push(`mount:${expanded}:${m.readonly ? 'ro' : 'rw'}`)
    }
  }
  parts.push(...mountParts.sort())

  for (const e of [...(sandboxConfig.environment ?? [])].sort()) {
    parts.push(`env:${e}`)
  }

  for (const forward of sandboxConfig.host_port_forwards ?? []) {
    parts.push(`host-port-forward:${forward.host_port}->${forward.sandbox_port ?? forward.host_port}`)
  }

  const sshAgent = resolveSshAgent(sandboxConfig)
  parts.push(`sshAgent:${sshAgent}`)

  const tools = [...new Set(sandboxConfig.tools ?? [])]
  parts.push(...tools.sort().map((t) => `tool:${t}`))

  const toolReqs = resolveToolRequirements(tools)
  parts.push(`gpgAgent:${toolReqs.gpgAgent}`)
  if (toolReqs.gpgAgent) {
    const gpgSocket = resolveGpgSocketInfo('/root')
    parts.push(`gpgSocket:${gpgSocket?.fingerprint ?? 'unavailable'}`)
  }

  if (tools.includes('pnpm')) {
    const shellEnv = getShellEnv()
    const pnpmStore = resolvePnpmStorePath(shellEnv)
    parts.push(`pnpm-store:${pnpmStore ?? ''}`)
  }

  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

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

function buildLeashArgs(
  port: number,
  controlPort: number,
  sandboxConfig: SandboxConfig,
  dotfiles: { path: string; readonly?: boolean }[],
  environment: string[],
  shellEnv: Record<string, string>,
  sshAgent: boolean,
  gpgAgent: boolean,
  dotfileOverrides: Map<string, string>,
  toolExtraMounts: Array<{ path: string; containerPath?: string; readonly?: boolean }>,
  initCommand?: string,
  image?: string,
  policy?: string,
  containerEnvironment?: Record<string, string>,
): string[] {
  const args: string[] = [
    '-p', `127.0.0.1:${port}:${port}`,
    '-l', `127.0.0.1:${controlPort}`,
    '-I',
  ]

  if (image) args.push('--image', image)
  if (policy) args.push('--policy', policy)

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
    const containerPath = expanded.startsWith(hostHome)
      ? containerHome + expanded.slice(hostHome.length)
      : expanded
    const mountSpec = dotfile.readonly
      ? `${hostPath}:${containerPath}:ro`
      : `${hostPath}:${containerPath}`
    args.push('-v', mountSpec)
  }

  for (const mount of sandboxConfig.mounts ?? []) {
    const expanded = expandHome(mount.path)
    if (!fs.existsSync(expanded)) continue
    if (mountedPaths.has(expanded)) continue
    mountedPaths.add(expanded)
    const mountSpec = mount.readonly
      ? `${expanded}:${expanded}:ro`
      : `${expanded}:${expanded}`
    args.push('-v', mountSpec)
  }

  for (const mount of toolExtraMounts) {
    const expanded = expandHome(mount.path)
    if (!fs.existsSync(expanded)) continue
    if (mountedPaths.has(expanded)) continue
    mountedPaths.add(expanded)
    const containerPath = mount.containerPath
      ? expandHome(mount.containerPath)
      : expanded.startsWith(hostHome)
        ? containerHome + expanded.slice(hostHome.length)
        : expanded
    const mountSpec = mount.readonly
      ? `${expanded}:${containerPath}:ro`
      : `${expanded}:${containerPath}`
    args.push('-v', mountSpec)
  }

  args.push('-e', `PIPPIN_PORT=${port}`)

  for (const [name, value] of Object.entries(containerEnvironment ?? {})) {
    args.push('-e', `${name}=${value}`)
  }

  for (const name of environment) {
    if (name in shellEnv) {
      args.push('-e', `${name}=${shellEnv[name]}`)
    }
  }

  if (sshAgent) {
    const agentSock = '/run/host-services/ssh-auth.sock'
    args.push('-v', `${agentSock}:${agentSock}`)
    args.push('-e', `SSH_AUTH_SOCK=${agentSock}`)

    const knownHosts = path.join(os.homedir(), '.ssh', 'known_hosts')
    if (fs.existsSync(knownHosts) && !mountedPaths.has(knownHosts)) {
      mountedPaths.add(knownHosts)
      const containerKnownHosts = knownHosts.startsWith(hostHome)
        ? containerHome + knownHosts.slice(hostHome.length)
        : knownHosts
      args.push('-v', `${knownHosts}:${containerKnownHosts}:ro`)
    }
  }

  if (gpgAgent) {
    const gpgSocket = resolveGpgSocketInfo(containerHome)
    if (gpgSocket) {
      args.push('-v', `${gpgSocket.hostSocket}:${gpgSocket.containerSocket}`)
    } else {
      process.stderr.write('pippin: warning: could not locate a usable gpg-agent socket; git commit signing may fail in the sandbox\n')
    }
  }

  const COMBINED_CA = '/tmp/combined-ca.pem'
  const SF_CACHE_DIR = '$HOME/.cache/snowflake'
  const SF_CACHE_FILE = `${SF_CACHE_DIR}/credential_cache_v1.json`
  const hostPortForwards = sandboxConfig.host_port_forwards ?? []
  const bootstrap = [
    `if [ -f /leash/ca-cert.pem ]; then cat /etc/ssl/certs/ca-certificates.crt /leash/ca-cert.pem > ${COMBINED_CA}; else cp /etc/ssl/certs/ca-certificates.crt ${COMBINED_CA}; fi`,
    `export SSL_CERT_FILE=${COMBINED_CA}`,
    `export AWS_CA_BUNDLE=${COMBINED_CA}`,
    `export REQUESTS_CA_BUNDLE=${COMBINED_CA}`,
    `export NODE_EXTRA_CA_CERTS=${COMBINED_CA}`,
    `if [ -f /leash/ca-cert.pem ] && command -v update-ca-certificates >/dev/null 2>&1; then cp /leash/ca-cert.pem /usr/local/share/ca-certificates/leash-mitm.crt && update-ca-certificates >/dev/null 2>&1; fi`,
    `if [ -n "$SNOWFLAKE_ID_TOKEN" ] && [ -n "$SNOWFLAKE_TOKEN_HASH_KEY" ]; then mkdir -p ${SF_CACHE_DIR} && chmod 700 ${SF_CACHE_DIR} && printf '{"tokens":{"%s":"%s"}}' "$SNOWFLAKE_TOKEN_HASH_KEY" "$SNOWFLAKE_ID_TOKEN" > ${SF_CACHE_FILE} && chmod 600 ${SF_CACHE_FILE}; fi`,
    `if [ -d /root/.gnupg ]; then chmod 700 /root/.gnupg; fi`,
    ...(hostPortForwards.length > 0
      ? ['command -v socat >/dev/null 2>&1']
      : []),
    ...hostPortForwards.map((forward) => {
      const sandboxPort = forward.sandbox_port ?? forward.host_port
      return `(socat TCP-LISTEN:${sandboxPort},bind=127.0.0.1,reuseaddr,fork TCP:host.docker.internal:${forward.host_port} &)`
    }),
    ...(initCommand
      ? [
          'BOOTSTRAP_LOG=/leash/bootstrap.log',
          `if ! ( ${initCommand} ) >"$BOOTSTRAP_LOG" 2>&1; then echo "pippin: warning: sandbox init command failed (continuing anyway)" >&2; cat "$BOOTSTRAP_LOG" >&2; fi`,
        ]
      : []),
    'exec /leash/pippin-server',
  ].join(' && ')
  args.push('--', 'sh', '-c', bootstrap)

  return args
}

function prepareShareDir(sandboxName: string): string {
  const shareDir = path.join(
    os.homedir(),
    '.local',
    'state',
    'pippin',
    'share',
    sandboxName,
  )

  fs.mkdirSync(shareDir, { recursive: true })

  try {
    for (const file of fs.readdirSync(shareDir)) {
      if (file === 'pippin-server') continue
      try { fs.unlinkSync(path.join(shareDir, file)) } catch {}
    }
  } catch {}

  const serverBinary = resolveServerBinary()
  if (!serverBinary) {
    process.stderr.write('pippin: could not find pippin-server binary\n')
    process.stderr.write('pippin: run `bun run build:server` to compile it\n')
    process.exit(1)
  }

  const dest = path.join(shareDir, 'pippin-server')
  try {
    const srcHash = crypto.createHash('sha256').update(fs.readFileSync(serverBinary)).digest('hex')
    const dstHash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
    if (srcHash === dstHash) return shareDir
  } catch {}

  fs.copyFileSync(serverBinary, dest)
  fs.chmodSync(dest, 0o755)

  return shareDir
}

export function resolveServerBinary(): string | null {
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
  const execDir = path.dirname(process.execPath)
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
    }
  }

  return null
}

function getSandboxContainerName(sandboxName: string): string | null {
  const normalized = sandboxName.trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || null
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

function removeSandboxContainer(sandboxName: string): boolean {
  const containerName = getSandboxContainerName(sandboxName)
  if (!containerName) return false
  return removeContainerByName(containerName)
}

function isContainerNameConflictError(stderr: string, sandboxName: string): boolean {
  const containerName = getSandboxContainerName(sandboxName)
  if (!containerName) return false
  return stderr.includes('is already in use by container')
    && stderr.toLowerCase().includes(containerName.toLowerCase())
}

function isPortInUseError(stderr: string): boolean {
  return /port\s+\d+\s+is already in use/.test(stderr)
}

function getShellEnv(): Record<string, string> {
  const shell = process.env.SHELL || '/bin/sh'
  try {
    const result = spawnSync(shell, ['-l', '-c', 'env'], {
      encoding: 'utf-8',
      timeout: 5000,
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
  resolveGpgSocketInfo,
  startSandbox,
  getSandboxContainerName,
  removeSandboxContainer,
  isContainerNameConflictError,
  isPortInUseError,
}

export function resolveGpgSocketInfo(containerHome: string): GpgSocketInfo | null {
  for (const dir of ['agent-extra-socket', 'agent-socket'] as const) {
    try {
      const result = spawnSync('gpgconf', ['--list-dirs', dir], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const hostSocket = result.stdout?.trim()
      if (result.status !== 0 || !hostSocket || !fs.existsSync(hostSocket)) continue

      const stat = fs.lstatSync(hostSocket)
      return {
        hostSocket,
        containerSocket: `${containerHome}/.gnupg/S.gpg-agent`,
        source: dir,
        fingerprint: `${dir}:${hostSocket}:${stat.ino}:${Math.trunc(stat.mtimeMs)}`,
      }
    } catch {
      continue
    }
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
