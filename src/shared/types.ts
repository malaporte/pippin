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
}

// --- Sandbox State ---

export interface SandboxState {
  workspaceRoot: string
  port: number
  leashPid: number
  startedAt: string
}
