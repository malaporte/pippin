import { EXEC_PATH, HEALTH_PATH } from '../../shared/types'
import { resolveWorkspace, validateCwd } from '../workspace'
import { expandHome, readGlobalConfig } from '../config'
import { ensureSandbox } from '../sandbox'
import type { ClientMessage, ServerMessage, MountEntry } from '../../shared/types'

/**
 * Check whether `cmd` should run on the host rather than in the sandbox.
 * Matches the first token of the command against the merged hostCommands set.
 */
function isHostCommand(cmd: string, hostCommands: Set<string>): boolean {
  const firstToken = cmd.trimStart().split(/\s+/)[0]
  if (!firstToken) return false
  return hostCommands.has(firstToken)
}

/** Execute a command directly on the host (bypassing the sandbox) */
async function execOnHost(cmd: string): Promise<void> {
  const proc = Bun.spawn(['sh', '-c', cmd], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  process.exit(exitCode)
}

/** Execute a command inside the sandbox */
export async function execCommand(cmd: string): Promise<void> {
  const cwd = process.cwd()
  const globalConfig = readGlobalConfig()
  const workspace = resolveWorkspace(cwd, globalConfig.workspaces)

  // Merge host commands from global and workspace configs (union)
  const hostCommands = new Set<string>([
    ...globalConfig.hostCommands,
    ...(workspace.config.sandbox?.host_commands ?? []),
  ])

  if (isHostCommand(cmd, hostCommands)) {
    await execOnHost(cmd)
    return
  }

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

  // Build WebSocket URL
  const params = new URLSearchParams({ cmd })
  params.set('cwd', validatedCwd)

  if (process.stdout.isTTY) {
    params.set('tty', '1')
    const cols = process.stdout.columns
    const rows = process.stdout.rows
    if (cols) params.set('cols', String(cols))
    if (rows) params.set('rows', String(rows))

    // Forward TERM so the PTY session uses the correct terminal type
    if (process.env.TERM) {
      params.set('env.TERM', process.env.TERM)
    }
  }

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
