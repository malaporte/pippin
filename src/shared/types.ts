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

// --- Workspace Config (.pippin.toml) ---

export interface MountEntry {
  path: string
  readonly?: boolean
}

export interface WorkspaceConfig {
  sandbox?: {
    idle_timeout?: number
    mounts?: MountEntry[]
    /** Override the Docker image used for the sandbox container */
    image?: string
    /** Path to a Dockerfile to build and use for the sandbox container */
    dockerfile?: string
    /** Path to a Cedar policy file for sandbox enforcement (relative to workspace root) */
    policy?: string
    /** Shell to use for `pippin shell` (e.g. "bash", "zsh", "sh") */
    shell?: string
  }
}

// --- Global Config (~/.config/pippin/config.json) ---

export interface DotfileEntry {
  path: string
  readonly?: boolean
}

export interface GlobalConfig {
  idleTimeout?: number
  portRangeStart?: number
  dotfiles?: DotfileEntry[]
  environment?: string[]
  /** Override the Docker image used for the sandbox container */
  image?: string
  /** Path to a Dockerfile to build and use for the sandbox container */
  dockerfile?: string
  /** Path to a Cedar policy file for sandbox enforcement (global default) */
  policy?: string
  /** Shell to use for `pippin shell` (e.g. "bash", "zsh", "sh"). Defaults to "bash". */
  shell?: string
}

// --- Sandbox State ---

export interface SandboxState {
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
