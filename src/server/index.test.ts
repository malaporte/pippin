import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Integration tests for the HTTP + WebSocket server
//
// These tests spawn a real `bun` process running src/server/index.ts so the
// Bun-native APIs (Bun.serve) are available in the server process. The test
// runner (Vitest/Node) communicates with it via fetch + WebSocket.
// ---------------------------------------------------------------------------

const SERVER_PORT = 19222
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}`

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.ts',
)

let serverProcess: ChildProcess

/** Wait for the server to respond to /health, with a timeout. */
async function waitForServer(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`)
}

beforeAll(async () => {
  serverProcess = spawn('bun', [serverEntry], {
    env: {
      ...process.env,
      PIPPIN_PORT: String(SERVER_PORT),
      PIPPIN_HOST: '127.0.0.1',
      PIPPIN_IDLE_TIMEOUT: '99999',
    },
    stdio: 'pipe',
  })

  await waitForServer()
}, 10_000)

afterAll(() => {
  serverProcess?.kill('SIGTERM')
})

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await fetch(`${SERVER_URL}/health`)
    expect(res.status).toBe(200)

    const body = await res.json() as { status: string; version: string; activeSessions: number }
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('string')
    expect(typeof body.activeSessions).toBe('number')
  })

  it('sets content-type to application/json', async () => {
    const res = await fetch(`${SERVER_URL}/health`)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('reports zero active sessions at startup', async () => {
    const body = await fetch(`${SERVER_URL}/health`).then((r) => r.json()) as { activeSessions: number }
    expect(body.activeSessions).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 for an unknown path', async () => {
    const res = await fetch(`${SERVER_URL}/unknown`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /exec — missing cmd parameter
// ---------------------------------------------------------------------------

describe('GET /exec without WebSocket upgrade', () => {
  it('returns 400 when cmd is missing', async () => {
    const res = await fetch(`${SERVER_URL}/exec`)
    expect(res.status).toBe(400)

    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/missing cmd/)
  })
})

// ---------------------------------------------------------------------------
// WebSocket /exec — end-to-end command execution
// ---------------------------------------------------------------------------

/** Collect WebSocket messages until the connection closes or timeout. */
function runOverWebSocket(
  url: string,
  onOpen?: (ws: WebSocket) => void,
  timeoutMs = 5000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = []
    const ws = new WebSocket(url)

    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`WebSocket timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    ws.onopen = () => onOpen?.(ws)
    ws.onmessage = (e) => messages.push(e.data as string)
    ws.onclose = () => { clearTimeout(timer); resolve(messages) }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WS error: ${String(e)}`)) }
  })
}

describe('WebSocket /exec', () => {
  it('receives stdout and exit(0) for a simple command', async () => {
    const url = `${WS_URL}/exec?cmd=${encodeURIComponent('printf hello')}`
    const messages = await runOverWebSocket(url)

    const parsed = messages.map((m) => JSON.parse(m) as { type: string; data?: string; code?: number })

    const stdout = parsed.filter((m) => m.type === 'stdout')
    expect(stdout.length).toBeGreaterThan(0)

    const combined = stdout.map((m) => Buffer.from(m.data!, 'base64').toString()).join('')
    expect(combined).toContain('hello')

    const exitMsg = parsed.find((m) => m.type === 'exit')
    expect(exitMsg).toBeDefined()
    expect(exitMsg!.code).toBe(0)
  })

  it('receives exit(42) for a failing command', async () => {
    const url = `${WS_URL}/exec?cmd=${encodeURIComponent('exit 42')}`
    const messages = await runOverWebSocket(url)
    const parsed = messages.map((m) => JSON.parse(m) as { type: string; code?: number })
    const exitMsg = parsed.find((m) => m.type === 'exit')
    expect(exitMsg).toBeDefined()
    expect(exitMsg!.code).toBe(42)
  })

  it('respects the cwd query parameter', async () => {
    const url = `${WS_URL}/exec?cmd=${encodeURIComponent('pwd')}&cwd=${encodeURIComponent('/tmp')}`
    const messages = await runOverWebSocket(url)
    const parsed = messages.map((m) => JSON.parse(m) as { type: string; data?: string })
    const combined = parsed
      .filter((m) => m.type === 'stdout')
      .map((m) => Buffer.from(m.data!, 'base64').toString())
      .join('')
    // /tmp may resolve to /private/tmp on macOS
    expect(combined.trim()).toMatch(/\/tmp/)
  })

  it('passes env vars via env.KEY query params', async () => {
    const url =
      `${WS_URL}/exec?cmd=${encodeURIComponent('printf $PIPPIN_TEST_VAR')}&env.PIPPIN_TEST_VAR=integration_ok`
    const messages = await runOverWebSocket(url)
    const parsed = messages.map((m) => JSON.parse(m) as { type: string; data?: string })
    const combined = parsed
      .filter((m) => m.type === 'stdout')
      .map((m) => Buffer.from(m.data!, 'base64').toString())
      .join('')
    expect(combined).toContain('integration_ok')
  })

  it('handles stdin sent from the client (cat echo)', async () => {
    const url = `${WS_URL}/exec?cmd=${encodeURIComponent('cat')}`
    const messages = await runOverWebSocket(url, (ws) => {
      ws.send(JSON.stringify({ type: 'stdin', data: Buffer.from('ping\n').toString('base64') }))
      ws.send(JSON.stringify({ type: 'close_stdin' }))
    })

    const parsed = messages.map((m) => JSON.parse(m) as { type: string; data?: string })
    const combined = parsed
      .filter((m) => m.type === 'stdout')
      .map((m) => Buffer.from(m.data!, 'base64').toString())
      .join('')
    expect(combined).toContain('ping')
  })

  it('sends stderr output', async () => {
    const url = `${WS_URL}/exec?cmd=${encodeURIComponent('printf err_msg >&2')}`
    const messages = await runOverWebSocket(url)
    const parsed = messages.map((m) => JSON.parse(m) as { type: string; data?: string })
    const stderrMsgs = parsed.filter((m) => m.type === 'stderr')
    const combined = stderrMsgs.map((m) => Buffer.from(m.data!, 'base64').toString()).join('')
    expect(combined).toContain('err_msg')
  })

  it('activeSessions goes up during a session and back to 0 after', async () => {
    const beforeBody = await fetch(`${SERVER_URL}/health`).then((r) => r.json()) as { activeSessions: number }
    const before = beforeBody.activeSessions

    let openResolve!: () => void
    const openPromise = new Promise<void>((r) => { openResolve = r })
    let closeResolve!: () => void
    const closePromise = new Promise<void>((r) => { closeResolve = r })

    const ws = new WebSocket(`${WS_URL}/exec?cmd=${encodeURIComponent('sleep 5')}`)
    ws.onopen = () => openResolve()
    ws.onclose = () => closeResolve()

    await openPromise
    // Give the server a moment to register the session
    await new Promise((r) => setTimeout(r, 50))

    const duringBody = await fetch(`${SERVER_URL}/health`).then((r) => r.json()) as { activeSessions: number }
    expect(duringBody.activeSessions).toBeGreaterThan(before)

    ws.close()
    await closePromise
    // Give the server a moment to deregister the session
    await new Promise((r) => setTimeout(r, 100))

    const afterBody = await fetch(`${SERVER_URL}/health`).then((r) => r.json()) as { activeSessions: number }
    expect(afterBody.activeSessions).toBe(before)
  })
})
