import { EXEC_PATH, HEALTH_PATH } from '../../shared/types'
import { resolveWorkspace, validateCwd } from '../workspace'
import { expandHome, readGlobalConfig } from '../config'
import { ensureSandbox } from '../sandbox'
import type { ClientMessage, ServerMessage, MountEntry } from '../../shared/types'

/** Default shell when none is configured */
const DEFAULT_SHELL = 'bash'

/**
 * Build a gradient-colored "[pippin]" string for use in PS1.
 *
 * The gradient goes from green (rgb 102,255,102) → cyan (rgb 0,255,255)
 * across each character. Each color escape is wrapped in \[...\] so bash
 * readline does not count them toward line length.
 */
function buildGradientPrefix(): string {
  const text = '[pippin]'

  // Gradient endpoints: green → cyan
  const startR = 102, startG = 255, startB = 102
  const endR = 0,     endG = 255,   endB = 255

  let result = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? i / (text.length - 1) : 0
    const r = Math.round(startR + (endR - startR) * t)
    const g = Math.round(startG + (endG - startG) * t)
    const b = Math.round(startB + (endB - startB) * t)

    // \[ and \] are bash PS1 markers for non-printing sequences
    result += `\\[\\e[38;2;${r};${g};${b}m\\]${text[i]}`
  }

  // Reset color after the prefix
  result += '\\[\\e[0m\\]'

  return result
}

/**
 * Build the PS1 value for the pippin shell.
 *
 * Prepends the gradient-colored [pippin] to the host's PS1 (if available),
 * falling back to a sensible default.
 */
function buildPS1(): string {
  const prefix = buildGradientPrefix()

  // Read the host's PS1; fall back to '\w > ' if unset
  const hostPS1 = process.env.PS1 || '\\w > '

  return `${prefix} ${hostPS1}`
}

/** Open an interactive shell inside the sandbox */
export async function shellCommand(): Promise<void> {
  const cwd = process.cwd()
  const workspace = resolveWorkspace(cwd)

  // Expand ~ in extra mounts for CWD validation
  const extraMounts: MountEntry[] = (workspace.config.sandbox?.mounts ?? []).map((m) => ({
    ...m,
    path: expandHome(m.path),
  }))

  const validatedCwd = validateCwd(cwd, workspace.root, extraMounts)
  if (!validatedCwd) {
    process.stderr.write(
      `pippin: cwd '${cwd}' is not accessible in the sandbox\n` +
      `pippin: workspace root is '${workspace.root}'\n`,
    )
    process.exit(1)
  }

  const port = await ensureSandbox(workspace.root, workspace.config)

  // Resolve the shell: workspace config > global config > default
  const globalConfig = readGlobalConfig()
  const shell = workspace.config.sandbox?.shell ?? globalConfig.shell ?? DEFAULT_SHELL

  // Build the pippin-branded PS1
  const ps1 = buildPS1()

  // Build WebSocket URL — always TTY for an interactive shell
  const params = new URLSearchParams({ cmd: shell })
  params.set('cwd', validatedCwd)
  params.set('tty', '1')

  const cols = process.stdout.columns
  const rows = process.stdout.rows
  if (cols) params.set('cols', String(cols))
  if (rows) params.set('rows', String(rows))

  // Forward TERM so the PTY session uses the correct terminal type
  if (process.env.TERM) {
    params.set('env.TERM', process.env.TERM)
  }

  // Use PROMPT_COMMAND to override PS1 before every prompt. This runs after
  // the shell's rc files, so it survives any PS1 set by bashrc.
  // The env var PIPPIN_PS1 carries the desired prompt value; PROMPT_COMMAND
  // copies it into PS1 on the first prompt, then disables itself.
  params.set('env.PIPPIN_PS1', ps1)
  params.set('env.PROMPT_COMMAND', 'PS1="$PIPPIN_PS1"; unset PROMPT_COMMAND')

  const wsUrl = `ws://127.0.0.1:${port}${EXEC_PATH}?${params.toString()}`

  // Connect and run
  let exitCode = 1

  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }

    process.stdin.on('data', (chunk: Buffer) => {
      const msg: ClientMessage = { type: 'stdin', data: chunk.toString('base64') }
      ws.send(JSON.stringify(msg))
    })

    process.stdin.on('end', () => {
      const msg: ClientMessage = { type: 'close_stdin' }
      ws.send(JSON.stringify(msg))
    })

    if (process.stdout.isTTY) {
      process.stdout.on('resize', () => {
        const msg: ClientMessage = {
          type: 'resize',
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }
        ws.send(JSON.stringify(msg))
      })
    }

    process.stdin.resume()
  })

  ws.addEventListener('message', (event) => {
    try {
      const msg: ServerMessage = JSON.parse(String(event.data))

      switch (msg.type) {
        case 'stdout': {
          const bytes = new Uint8Array(Buffer.from(msg.data, 'base64'))
          process.stdout.write(bytes)
          break
        }
        case 'stderr': {
          const bytes = new Uint8Array(Buffer.from(msg.data, 'base64'))
          process.stderr.write(bytes)
          break
        }
        case 'exit': {
          exitCode = msg.code
          break
        }
        case 'error': {
          process.stderr.write(`pippin: ${msg.message}\n`)
          break
        }
      }
    } catch {
      // Malformed message; ignore
    }
  })

  ws.addEventListener('close', () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.exit(exitCode)
  })

  ws.addEventListener('error', () => {
    const healthUrl = `http://127.0.0.1:${port}${HEALTH_PATH}`
    process.stderr.write(`pippin: failed to connect to sandbox at ${healthUrl}\n`)
    process.stderr.write('pippin: try running `pippin status` to check the sandbox\n')
    process.exit(1)
  })

  // Forward signals to the container process
  process.on('SIGINT', () => {
    const msg: ClientMessage = { type: 'signal', signal: 'SIGINT' }
    ws.send(JSON.stringify(msg))
  })

  process.on('SIGTERM', () => {
    const msg: ClientMessage = { type: 'signal', signal: 'SIGTERM' }
    ws.send(JSON.stringify(msg))
    ws.close()
  })

  // Keep the process alive until the WebSocket closes
  await new Promise(() => {})
}
