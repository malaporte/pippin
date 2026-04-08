import { EXEC_PATH, HEALTH_PATH } from '../../shared/types'
import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox, validateCwd } from '../sandbox-config'
import { ensureSandbox } from '../sandbox'
import type { ClientMessage, ServerMessage } from '../../shared/types'

function isHostCommand(cmd: string, hostCommands: Set<string>): boolean {
  const firstToken = cmd.trimStart().split(/\s+/)[0]
  if (!firstToken) return false
  return hostCommands.has(firstToken)
}

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

function requireSandbox(name: string | undefined) {
  const sandboxName = name ?? DEFAULT_SANDBOX_NAME
  const globalConfig = readGlobalConfig()
  const sandbox = resolveSandbox(sandboxName, globalConfig.sandboxes)
  if (!sandbox) {
    process.stderr.write(`pippin: sandbox "${sandboxName}" is not configured\n`)
    if (sandboxName === DEFAULT_SANDBOX_NAME) {
      process.stderr.write('pippin: configure a "default" sandbox in ~/.config/pippin/config.json\n')
    }
    process.exit(1)
  }
  return { sandboxName, sandbox }
}

export async function execCommand(cmd: string, sandboxName?: string): Promise<void> {
  const cwd = process.cwd()
  const { sandbox, sandboxName: resolvedSandboxName } = requireSandbox(sandboxName)

  const hostCommands = new Set<string>(sandbox.config.host_commands ?? [])

  if (isHostCommand(cmd, hostCommands)) {
    await execOnHost(cmd)
    return
  }

  const validatedCwd = validateCwd(cwd, sandbox.config)
  if (!validatedCwd) {
    process.stderr.write(`pippin: cwd '${cwd}' is not accessible in sandbox "${resolvedSandboxName}"\n`)
    process.stderr.write(`pippin: sandbox root is '${sandbox.config.root}'\n`)
    process.exit(1)
  }

  const port = await ensureSandbox(resolvedSandboxName, sandbox.config)

  const params = new URLSearchParams({ cmd })
  params.set('cwd', validatedCwd)

  if (process.stdout.isTTY) {
    params.set('tty', '1')
    const cols = process.stdout.columns
    const rows = process.stdout.rows
    if (cols) params.set('cols', String(cols))
    if (rows) params.set('rows', String(rows))

    if (process.env.TERM) {
      params.set('env.TERM', process.env.TERM)
    }
  }

  const wsUrl = `ws://127.0.0.1:${port}${EXEC_PATH}?${params.toString()}`
  let exitCode = 1
  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

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
        case 'stdout':
          process.stdout.write(new Uint8Array(Buffer.from(msg.data, 'base64')))
          break
        case 'stderr':
          process.stderr.write(new Uint8Array(Buffer.from(msg.data, 'base64')))
          break
        case 'exit':
          exitCode = msg.code
          break
        case 'error':
          process.stderr.write(`pippin: ${msg.message}\n`)
          break
      }
    } catch {
    }
  })

  ws.addEventListener('close', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.exit(exitCode)
  })

  ws.addEventListener('error', () => {
    const healthUrl = `http://127.0.0.1:${port}${HEALTH_PATH}`
    process.stderr.write(`pippin: failed to connect to sandbox at ${healthUrl}\n`)
    process.stderr.write('pippin: try running `pippin status` to check the sandbox\n')
    process.exit(1)
  })

  process.on('SIGINT', () => {
    const msg: ClientMessage = { type: 'signal', signal: 'SIGINT' }
    ws.send(JSON.stringify(msg))
  })

  process.on('SIGTERM', () => {
    const msg: ClientMessage = { type: 'signal', signal: 'SIGTERM' }
    ws.send(JSON.stringify(msg))
    ws.close()
  })

  await new Promise(() => {})
}
