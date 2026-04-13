import { EXEC_PATH, HEALTH_PATH } from '../../shared/types'
import { readGlobalConfig } from '../config'
import { DEFAULT_SANDBOX_NAME, resolveSandbox, validateCwd } from '../sandbox-config'
import { ensureSandbox } from '../sandbox'
import type { ClientMessage, ServerMessage } from '../../shared/types'

const DEFAULT_SHELL = 'bash'

function buildGradientPrefix(): string {
  const text = '[pippin]'
  const startR = 102, startG = 255, startB = 102
  const endR = 0, endG = 255, endB = 255

  let result = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? i / (text.length - 1) : 0
    const r = Math.round(startR + (endR - startR) * t)
    const g = Math.round(startG + (endG - startG) * t)
    const b = Math.round(startB + (endB - startB) * t)
    result += `\\[\\e[38;2;${r};${g};${b}m\\]${text[i]}`
  }
  result += '\\[\\e[0m\\]'
  return result
}

function buildPS1(): string {
  return `${buildGradientPrefix()} ${process.env.PS1 || '\\w > '}`
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
  return { globalConfig, sandboxName, sandbox }
}

export async function shellCommand(sandboxName?: string): Promise<void> {
  const cwd = process.cwd()
  const { sandbox, sandboxName: resolvedSandboxName } = requireSandbox(sandboxName)

  const validatedCwd = validateCwd(cwd, sandbox.config)
  if (!validatedCwd) {
    process.stderr.write(`pippin: cwd '${cwd}' is not accessible in sandbox "${resolvedSandboxName}"\n`)
    process.stderr.write(`pippin: sandbox root is '${sandbox.config.root}'\n`)
    process.exit(1)
  }

  const port = await ensureSandbox(resolvedSandboxName, sandbox.config)
  const shell = sandbox.config.shell ?? DEFAULT_SHELL
  const ps1 = buildPS1()

  const params = new URLSearchParams({ cmd: shell })
  params.set('cwd', validatedCwd)
  params.set('tty', '1')

  const cols = process.stdout.columns
  const rows = process.stdout.rows
  if (cols) params.set('cols', String(cols))
  if (rows) params.set('rows', String(rows))
  if (process.env.TERM) params.set('env.TERM', process.env.TERM)

  params.set('env.PIPPIN_PS1', ps1)
  params.set('env.PROMPT_COMMAND', 'PS1="$PIPPIN_PS1"; unset PROMPT_COMMAND')

  const wsUrl = `ws://127.0.0.1:${port}${EXEC_PATH}?${params.toString()}`
  let exitCode = 1
  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

    process.stdin.on('data', (chunk: Buffer) => {
      const msg: ClientMessage = { type: 'stdin', data: chunk.toString('base64') }
      ws.send(JSON.stringify(msg))
    })

    // Do not forward stdin EOF as close_stdin — pippin shell always uses a PTY,
    // and sending Ctrl+D when the host's stdin closes (e.g. in a non-TTY context)
    // would cause the shell to exit immediately. The user can exit by typing
    // `exit` or pressing Ctrl+D themselves, which arrives as a stdin data chunk.

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
