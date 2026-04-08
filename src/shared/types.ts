/** Default port for the pippin server (start of auto-allocation range) */
export const DEFAULT_PORT = 9111

/** Default host the pippin server binds to */
export const DEFAULT_HOST = '0.0.0.0'

/** Health check endpoint path */
export const HEALTH_PATH = '/health'

/** Command execution endpoint path (upgrades to WebSocket) */
export const EXEC_PATH = '/exec'

/** Default idle timeout in seconds before the server self-terminates */
export const DEFAULT_IDLE_TIMEOUT = 900

/** Default init timeout in seconds when no install command is present */
export const DEFAULT_INIT_TIMEOUT = 60

/** Default init timeout in seconds when an init command is present */
export const DEFAULT_INSTALL_INIT_TIMEOUT = 300

// --- Client -> Server Messages ---

interface StdinMessage {
  type: 'stdin'
  data: string
}

interface ResizeMessage {
  type: 'resize'
  cols: number
  rows: number
}

interface SignalMessage {
  type: 'signal'
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
}

interface CloseStdinMessage {
  type: 'close_stdin'
}

export type ClientMessage = StdinMessage | ResizeMessage | SignalMessage | CloseStdinMessage

// --- Server -> Client Messages ---

interface StdoutMessage {
  type: 'stdout'
  data: string
}

interface StderrMessage {
  type: 'stderr'
  data: string
}

interface ExitMessage {
  type: 'exit'
  code: number
}

interface ErrorMessage {
  type: 'error'
  message: string
}

export type ServerMessage = StdoutMessage | StderrMessage | ExitMessage | ErrorMessage

// --- Health Check Response ---

export interface HealthResponse {
  status: 'ok'
  version: string
  activeSessions: number
}

// --- Exec Request (query params on WebSocket upgrade) ---

export interface ExecParams {
  cmd: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** When true, the server allocates a PTY for the session (enables TUI apps) */
  tty?: boolean
}

// --- Mount Entry ---

export interface MountEntry {
  path: string
  readonly?: boolean
}

// --- Sandbox Config (per-named-sandbox section in ~/.config/pippin/config.json) ---

export interface SandboxConfig {
  /** Required: absolute or ~-prefixed path to mount as the sandbox root */
  root: string
  dotfiles?: DotfileEntry[]
  environment?: string[]
  idle_timeout?: number
  /** Maximum seconds to wait for the sandbox to become healthy on startup */
  init_timeout?: number
  /** Shell command to run inside the container each time a fresh sandbox starts */
  init?: string
  /** Extra volume mounts beyond the root */
  mounts?: MountEntry[]
  /** Override the Docker image used for the sandbox container */
  image?: string
  /** Path to a Dockerfile to build and use for the sandbox container */
  dockerfile?: string
  /** Absolute or ~-prefixed path to a Cedar policy file for sandbox enforcement */
  policy?: string
  /** Shell to use for `pippin shell` (e.g. "bash", "zsh", "sh") */
  shell?: string
  /** Commands that should run directly on the host instead of in the sandbox (matched by first token) */
  host_commands?: string[]
  /** Forward the Docker Desktop SSH agent socket into the container so git/ssh can authenticate */
  ssh_agent?: boolean
  /** Tools to auto-configure in the sandbox (e.g. "git", "gh", "aws"). Pippin mounts credentials and sets env vars automatically. */
  tools?: string[]
}

// --- Global Config (~/.config/pippin/config.json) ---

export interface DotfileEntry {
  path: string
  readonly?: boolean
}

export interface GlobalConfig {
  portRangeStart?: number
  /** Named sandbox configurations. The "default" sandbox is used when no --sandbox flag is given. */
  sandboxes?: Record<string, SandboxConfig>
}

// --- Sandbox State ---

export interface SandboxState {
  /** The name of the sandbox (e.g. "default") */
  sandboxName: string
  /** The resolved absolute root path mounted into the sandbox */
  workspaceRoot: string
  port: number
  /** Port the leash Control UI is bound to. Present for sandboxes started after monitor support was added. */
  controlPort?: number
  leashPid: number
  startedAt: string
  /** The Docker image used for this sandbox (if a custom image was configured) */
  image?: string
  /** The Cedar policy file used for this sandbox (if a policy was configured) */
  policy?: string
  /** SHA-256 fingerprint of the resolved sandbox configuration (image, policy, mounts, env) for drift detection */
  configHash?: string
}
