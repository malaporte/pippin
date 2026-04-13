import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { ServerMessage, ClientMessage } from '../shared/types'
import type { ServerWebSocket, Subprocess } from 'bun'

/** A pipe-based session (non-TTY) */
interface PipeSession {
  id: string
  mode: 'pipe'
  process: ChildProcess
  ws: ServerWebSocket<SessionData>
}

/** A PTY-based session (TTY / interactive) */
interface PtySession {
  id: string
  mode: 'pty'
  process: Subprocess
  ws: ServerWebSocket<SessionData>
}

type Session = PipeSession | PtySession

export interface SessionData {
  sessionId: string
}

const sessions = new Map<string, Session>()

let nextId = 0

function generateId(): string {
  return `sess_${++nextId}_${Date.now()}`
}

/** Callback invoked when the active session count changes */
let onSessionCountChange: ((count: number) => void) | null = null

/** Register a listener for session count changes (used by idle timer) */
export function setSessionCountListener(listener: (count: number) => void): void {
  onSessionCountChange = listener
}

function notifyCountChange(): void {
  onSessionCountChange?.(sessions.size)
}

export interface CreateSessionOptions {
  cmd: string
  cwd?: string
  env?: Record<string, string>
  tty?: boolean
  cols?: number
  rows?: number
}

/** Start a command execution session, wiring the process to a WebSocket */
export function createSession(
  ws: ServerWebSocket<SessionData>,
  options: CreateSessionOptions,
): string {
  if (options.tty) {
    return createPtySession(ws, options)
  }
  return createPipeSession(ws, options)
}

/** Create a pipe-based session (original behavior, for non-TTY contexts) */
function createPipeSession(
  ws: ServerWebSocket<SessionData>,
  options: CreateSessionOptions,
): string {
  const sessionId = generateId()

  const mergedEnv = { ...process.env, ...options.env }

  const child = spawn('sh', ['-c', options.cmd], {
    cwd: options.cwd || process.cwd(),
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  const session: PipeSession = { id: sessionId, mode: 'pipe', process: child, ws }
  sessions.set(sessionId, session)
  notifyCountChange()

  child.stdout?.on('data', (chunk: Buffer) => {
    send(ws, { type: 'stdout', data: chunk.toString('base64') })
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    send(ws, { type: 'stderr', data: chunk.toString('base64') })
  })

  child.on('close', (code) => {
    send(ws, { type: 'exit', code: code ?? 1 })
    sessions.delete(sessionId)
    notifyCountChange()
    ws.close()
  })

  child.on('error', (err) => {
    send(ws, { type: 'error', message: err.message })
    sessions.delete(sessionId)
    notifyCountChange()
    ws.close()
  })

  return sessionId
}

/** Create a PTY-based session (for interactive/TUI apps) */
function createPtySession(
  ws: ServerWebSocket<SessionData>,
  options: CreateSessionOptions,
): string {
  const sessionId = generateId()

  const mergedEnv = { ...process.env, ...options.env }
  // Ensure TERM is set for TUI apps; default to xterm-256color if not provided
  if (!mergedEnv.TERM) {
    mergedEnv.TERM = 'xterm-256color'
  }

  const cols = options.cols || 80
  const rows = options.rows || 24

  let child: Subprocess
  try {
    child = Bun.spawn(['sh', '-c', options.cmd], {
      cwd: options.cwd || process.cwd(),
      env: mergedEnv,
      terminal: {
        cols,
        rows,
        name: mergedEnv.TERM,
        // PTY combines stdout and stderr into a single data stream
        data(_term, data) {
          send(ws, { type: 'stdout', data: Buffer.from(data).toString('base64') })
        },
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send(ws, { type: 'error', message: `Failed to allocate PTY: ${message}` })
    send(ws, { type: 'exit', code: 1 })
    ws.close()
    return sessionId
  }

  const session: PtySession = { id: sessionId, mode: 'pty', process: child, ws }
  sessions.set(sessionId, session)
  notifyCountChange()

  // Use the exited promise instead of onExit callback to avoid potential
  // crashes during PTY teardown in Bun's native terminal implementation.
  child.exited.then((exitCode) => {
    try {
      child.terminal?.close()
    } catch {
      // Terminal may already be closed
    }
    send(ws, { type: 'exit', code: exitCode ?? 1 })
    sessions.delete(sessionId)
    notifyCountChange()
    ws.close()
  })

  return sessionId
}

/** Handle an incoming client message for a session */
export function handleMessage(sessionId: string, msg: ClientMessage): void {
  const session = sessions.get(sessionId)
  if (!session) return

  if (session.mode === 'pty') {
    handlePtyMessage(session, msg)
  } else {
    handlePipeMessage(session, msg)
  }
}

function handlePipeMessage(session: PipeSession, msg: ClientMessage): void {
  switch (msg.type) {
    case 'stdin': {
      const buf = Buffer.from(msg.data, 'base64')
      session.process.stdin?.write(buf)
      break
    }
    case 'close_stdin': {
      session.process.stdin?.end()
      break
    }
    case 'signal': {
      const signalMap: Record<string, NodeJS.Signals> = {
        SIGINT: 'SIGINT',
        SIGTERM: 'SIGTERM',
        SIGKILL: 'SIGKILL',
      }
      const sig = signalMap[msg.signal]
      if (sig && session.process.pid) {
        try {
          // Negative PID kills the entire process group (sh + its children)
          process.kill(-session.process.pid, sig)
        } catch {
          session.process.kill(sig)
        }
      }
      break
    }
    case 'resize': {
      // Resize is only meaningful for PTY sessions; no-op for pipe-based execution
      break
    }
  }
}

function handlePtyMessage(session: PtySession, msg: ClientMessage): void {
  const terminal = session.process.terminal
  if (!terminal) return

  switch (msg.type) {
    case 'stdin': {
      const buf = Buffer.from(msg.data, 'base64')
      terminal.write(buf)
      break
    }
    case 'close_stdin': {
      // For PTY sessions, ignore close_stdin — the PTY is interactive and
      // the host's stdin closing does not mean the user wants to exit the shell.
      // Writing \x04 (Ctrl+D) here would cause bash to exit immediately.
      break
    }
    case 'signal': {
      // Send the signal to the subprocess
      const signalMap: Record<string, NodeJS.Signals> = {
        SIGINT: 'SIGINT',
        SIGTERM: 'SIGTERM',
        SIGKILL: 'SIGKILL',
      }
      const sig = signalMap[msg.signal]
      if (sig) {
        session.process.kill(sig)
      }
      break
    }
    case 'resize': {
      terminal.resize(msg.cols, msg.rows)
      break
    }
  }
}

/** Clean up a session when the WebSocket closes */
export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return

  try {
    if (session.mode === 'pty') {
      session.process.terminal?.close()
      session.process.kill()
    } else {
      if (session.process.pid) {
        process.kill(-session.process.pid, 'SIGTERM')
      } else {
        session.process.kill('SIGTERM')
      }
    }
  } catch {
    // Process may have already exited
  }

  sessions.delete(sessionId)
  notifyCountChange()
}

/** Get the number of active sessions */
export function getActiveSessionCount(): number {
  return sessions.size
}

/** Kill all active sessions (for graceful shutdown) */
export function destroyAllSessions(): void {
  for (const [id] of sessions) {
    destroySession(id)
  }
}

function send(ws: ServerWebSocket<SessionData>, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // WebSocket may have closed
  }
}
